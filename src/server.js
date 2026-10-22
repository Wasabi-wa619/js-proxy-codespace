import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { fetch } from 'undici';

import { PREFIX, decodeProxyPath, decodeProxyUrl, rewriteUrl } from './url.js';
import { rewriteHtml } from './html.js';
import { rewriteCss } from './css.js';
import { rewriteJs } from './js.js';
import { rewriteSetCookie, restoreCookieHeader, readCookie, INTERNAL_COOKIE_PREFIX } from './cookies.js';
import { agent, assertHostAllowed, safeLookup, BlockedError } from './net.js';
import { log, getEntries, LOG_FILE } from './log.js';

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MAX_REWRITE_BYTES = 30 * 1024 * 1024;
const LAST_ORIGIN_COOKIE = INTERNAL_COOKIE_PREFIX + 'origin';

// ---------------------------------------------------------------- 静的ファイル

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const staticFiles = new Map();
function loadStatic(name) {
  const file = path.join(PUBLIC_DIR, name);
  const body = fs.readFileSync(file);
  const etag = '"' + createHash('sha1').update(body).digest('base64url').slice(0, 16) + '"';
  return { body, etag, type: MIME[path.extname(name)] || 'application/octet-stream' };
}
function getStatic(name) {
  // 開発中に public/ を編集してもすぐ反映されるよう、本番以外は毎回読み直す
  if (process.env.NODE_ENV !== 'production' || !staticFiles.has(name)) staticFiles.set(name, loadStatic(name));
  return staticFiles.get(name);
}

function serveStatic(req, res, name, extraHeaders = {}) {
  let f;
  try {
    f = getStatic(name);
  } catch {
    return sendError(res, 404, 'Not Found');
  }
  const headers = { 'content-type': f.type, etag: f.etag, 'cache-control': 'no-cache', ...extraHeaders };
  if (req.headers['if-none-match'] === f.etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, { ...headers, 'content-length': f.body.length });
  res.end(req.method === 'HEAD' ? undefined : f.body);
}

function clientScriptTag() {
  return `<script src="/__px/client.js?v=${getStatic('client.js').etag.slice(1, 9)}"></script>`;
}

// ---------------------------------------------------------------- エラー表示

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function sendError(res, status, message, req) {
  if (res.headersSent) return res.destroy();
  const wantsHtml = req && /text\/html/.test(req.headers.accept || '');
  const body = wantsHtml
    ? `<!doctype html><meta charset="utf-8"><title>${status}</title>` +
      `<body style="font-family:system-ui,sans-serif;padding:2rem;line-height:1.6">` +
      `<h1>${status}</h1><p>${escapeHtml(message)}</p><p><a href="/">トップに戻る</a></p>`
    : message;
  res.writeHead(status, {
    'content-type': wantsHtml ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------- ヘッダー処理

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

function isForwardingHeader(name) {
  return (
    name === 'forwarded' ||
    name === 'via' ||
    name === 'x-real-ip' ||
    name.startsWith('x-forwarded-') ||
    name.startsWith('x-original-') ||
    name.startsWith('x-github-') ||
    name.startsWith('x-ms-') ||
    name.startsWith('x-arr-') ||
    name.startsWith('x-px-')
  );
}

function isSecureProxy(req) {
  return req.socket.encrypted || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/** ブラウザ → サイト のリクエストヘッダーを組み立てる */
function buildRequestHeaders(req, target) {
  const out = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k) || isForwardingHeader(k)) continue;
    if (k === 'cookie' || k === 'referer' || k === 'origin' || k === 'accept-encoding') continue;
    if (k === 'service-worker') continue;
    out[k] = v;
  }
  // undici が展開できる形式だけを要求する
  out['accept-encoding'] = 'gzip, deflate, br';

  const cookie = restoreCookieHeader(req.headers.cookie);
  if (cookie) out.cookie = cookie;

  const ref = req.headers.referer ? decodeProxyUrl(req.headers.referer) : null;
  if (ref) {
    // ブラウザ既定の strict-origin-when-cross-origin 相当
    out.referer = ref.origin === target.origin ? ref.href.replace(/#.*$/, '') : ref.origin + '/';
  }
  if (req.headers.origin) {
    out.origin = ref ? ref.origin : target.origin;
  }
  return out;
}

const STRIP_RESPONSE_HEADERS = new Set([
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'strict-transport-security',
  'content-encoding',
  'content-length',
  'cross-origin-embedder-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'report-to',
  'reporting-endpoints',
  'nel',
  'alt-svc',
  'clear-site-data', // これを通すとプロキシのオリジン全体のデータが消える
  'service-worker-allowed',
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-headers',
  'access-control-allow-methods',
  'access-control-expose-headers',
  'link',
  'set-cookie',
  'origin-agent-cluster',
  'document-policy',
  'referrer-policy',
  ...HOP_BY_HOP,
]);

function buildResponseHeaders(upstream, target, req) {
  const out = {};
  for (const [k, v] of upstream.headers) {
    if (STRIP_RESPONSE_HEADERS.has(k)) continue;
    out[k] = v;
  }
  if (out.location) out.location = rewriteUrl(out.location, target.href);
  if (out.refresh) out.refresh = out.refresh.replace(/(url\s*=\s*)(\S+)/i, (_, p, u) => p + rewriteUrl(u, target.href));
  const secure = isSecureProxy(req);
  const cookies = upstream.headers.getSetCookie().map((c) => rewriteSetCookie(c, target, secure));
  if (cookies.length) out['set-cookie'] = cookies;
  return out;
}

// ---------------------------------------------------------------- 文字コード

function charsetFromContentType(ct) {
  const m = /charset\s*=\s*["']?([\w.:-]+)/i.exec(ct || '');
  return m ? m[1].toLowerCase() : null;
}

function decodeBody(buf, ct, kind) {
  let charset = charsetFromContentType(ct);
  if (!charset && kind === 'html') {
    const head = buf.subarray(0, 4096).toString('latin1');
    const m = /<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head);
    if (m) charset = m[1].toLowerCase();
  }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) charset = 'utf-8';
  if (charset) {
    try {
      return new TextDecoder(charset).decode(buf);
    } catch {
      // 未知の文字コードは下のフォールバックへ
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {}
  if (kind !== 'html') return null; // JS/CSS は書き換えずに素通しする
  for (const enc of ['shift_jis', 'euc-jp']) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(buf);
    } catch {}
  }
  return new TextDecoder('windows-1252').decode(buf);
}

function withUtf8(ct) {
  const base = (ct || '').split(';')[0].trim() || 'text/plain';
  return `${base}; charset=utf-8`;
}

// ---------------------------------------------------------------- 種類判定

const DOCUMENT_DESTS = new Set(['document', 'iframe', 'frame', 'embed', 'object', '']);
const SCRIPT_DESTS = new Set(['script', 'worker', 'sharedworker', 'audioworklet', 'paintworklet']);
const NON_HTML_DESTS = new Set(['script', 'style', 'image', 'font', 'audio', 'video', 'track', 'manifest', 'worker', 'sharedworker']);

function classify(ct, dest) {
  const type = (ct || '').split(';')[0].trim().toLowerCase();
  if (dest === 'style' || type === 'text/css') return 'css';
  if (SCRIPT_DESTS.has(dest)) return 'js';
  if (/(java|ecma)script/.test(type) && dest !== 'empty') return 'js';
  if ((type === 'text/html' || type === 'application/xhtml+xml') && !NON_HTML_DESTS.has(dest)) return 'html';
  return null;
}

// ---------------------------------------------------------------- プロキシ本体

async function handleProxy(req, res, target) {
  if (!/^https?:$/.test(target.protocol)) return sendError(res, 400, '対応していないURLです', req);
  if (target.host === req.headers.host) return sendError(res, 400, 'プロキシ自身は開けません', req);
  // サイト独自の Service Worker を登録させない (プロキシの SW と衝突するため)
  if (req.headers['service-worker'] === 'script') return sendError(res, 403, 'Service Worker はプロキシ経由では使えません');

  try {
    assertHostAllowed(target.hostname);
  } catch (e) {
    return sendError(res, 403, e.message, req);
  }

  // SW 経由のリクエストは Sec-Fetch-Dest が失われるので x-px-dest で受け取る
  const dest = String(req.headers['x-px-dest'] ?? req.headers['sec-fetch-dest'] ?? '').toLowerCase();
  const hasBody = !['GET', 'HEAD'].includes(req.method);
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  let upstream;
  try {
    upstream = await fetch(target.href, {
      method: req.method,
      headers: buildRequestHeaders(req, target),
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
      dispatcher: agent,
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) return;
    const cause = e.cause || e;
    if (cause instanceof BlockedError) return sendError(res, 403, cause.message, req);
    log.error(`接続失敗 ${req.method} ${target.href}: ${cause.code || ''} ${cause.message}`);
    return sendError(res, 502, `接続できませんでした: ${target.host} (${cause.code || cause.message})`, req);
  }

  const headers = buildResponseHeaders(upstream, target, req);
  const status = upstream.status;
  const noBody = req.method === 'HEAD' || status === 204 || status === 304 || (status >= 100 && status < 200);
  const kind = noBody || status === 206 ? null : classify(headers['content-type'], dest);
  const isDocument = kind === 'html' && DOCUMENT_DESTS.has(dest);
  const detail = `  ↳ 応答 ${status} ${headers['content-type'] || '(content-type なし)'}` +
    (headers.location ? ` → リダイレクト先 ${headers.location}` : '') +
    (kind ? ` [${kind} を書き換え${isDocument ? ' + client.js 挿入' : ''}]` : '');
  if (isDocument || status >= 300) log.info(detail);
  else log.debug(detail);

  if (isDocument) {
    const c = `${LAST_ORIGIN_COOKIE}=${encodeURIComponent(target.origin)}; Path=/; SameSite=Lax`;
    headers['set-cookie'] = [...(headers['set-cookie'] || []), c];
  }

  if (noBody || !upstream.body) {
    res.writeHead(status, headers);
    return res.end();
  }

  const declaredLength = Number(upstream.headers.get('content-length'));
  if (!kind || declaredLength > MAX_REWRITE_BYTES) {
    res.writeHead(status, headers);
    Readable.fromWeb(upstream.body)
      .on('error', () => res.destroy())
      .pipe(res);
    return;
  }

  let buf;
  try {
    buf = Buffer.from(await upstream.arrayBuffer());
  } catch (e) {
    if (!controller.signal.aborted) sendError(res, 502, `読み込み中に切断されました: ${e.message}`, req);
    return;
  }

  let text = decodeBody(buf, headers['content-type'], kind);
  if (text == null) {
    res.writeHead(status, { ...headers, 'content-length': buf.length });
    return res.end(buf);
  }

  try {
    if (kind === 'html') {
      text = await rewriteHtml(text, target.href, { inject: isDocument ? clientScriptTag() : '' });
    } else if (kind === 'css') {
      text = rewriteCss(text, target.href);
    } else if (kind === 'js') {
      text = rewriteJs(text, { prologue: true });
    }
  } catch (e) {
    log.error(`書き換え失敗 (${kind}) ${target.href}: ${e.stack || e.message}`);
  }

  const out = Buffer.from(text, 'utf8');
  if (isDocument) {
    log.info(`  ↳ 送信 ${out.length.toLocaleString()} バイト (元 ${buf.length.toLocaleString()} バイト)`);
    if (buf.length === 0) log.warn('  ↳ サイトから空のページが返ってきました');
  }
  headers['content-type'] = withUtf8(headers['content-type'] || (kind === 'js' ? 'text/javascript' : `text/${kind}`));
  headers['content-length'] = out.length;
  if (isDocument) headers['referrer-policy'] = 'same-origin';
  delete headers.etag; // 中身を変えたので元の ETag は使えない (304 で古い書き換え結果が残るのを防ぐ)
  res.writeHead(status, headers);
  res.end(out);
}

/** /p/ 以外へのリクエスト (ルート相対URLの取りこぼし) をどのサイト宛か推測する */
function guessTargetOrigin(req) {
  const ref = req.headers.referer ? decodeProxyUrl(req.headers.referer) : null;
  if (ref) return ref.origin;
  // 画面遷移以外なら最後に開いたサイトとみなす
  // ホーム画面 (/) は対象外 (戻れなくなるため)
  const dest = req.headers['sec-fetch-dest'];
  const pathname = (req.url || '/').split('?')[0];
  if (dest && dest !== 'document' && dest !== 'iframe' && pathname !== '/' && pathname !== '/index.html') {
    const last = readCookie(req.headers.cookie, LAST_ORIGIN_COOKIE);
    if (last) {
      try {
        return new URL(decodeURIComponent(last)).origin;
      } catch {}
    }
  }
  return null;
}

// ---------------------------------------------------------------- WebSocket

function handleUpgrade(req, socket, head) {
  const target = decodeProxyPath(req.url);
  const fail = (code, msg) => {
    socket.end(`HTTP/1.1 ${code} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  if (!target || (req.headers.upgrade || '').toLowerCase() !== 'websocket') return fail(400, 'Bad Request');
  try {
    assertHostAllowed(target.hostname);
  } catch {
    return fail(403, 'Forbidden');
  }

  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (k === 'host' || k === 'cookie' || k === 'origin' || k === 'referer' || isForwardingHeader(k)) continue;
    headers[k] = v;
  }
  headers.host = target.host;
  headers.origin = target.origin;
  const cookie = restoreCookieHeader(req.headers.cookie);
  if (cookie) headers.cookie = cookie;

  const secure = target.protocol === 'https:';
  const upstreamReq = (secure ? https : http).request({
    host: target.hostname,
    port: target.port || (secure ? 443 : 80),
    path: target.pathname + target.search,
    method: 'GET',
    headers,
    lookup: safeLookup,
    servername: secure ? target.hostname : undefined,
    timeout: 15_000,
  });

  upstreamReq.on('upgrade', (upRes, upSocket, upHead) => {
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) {
      const name = upRes.rawHeaders[i];
      if (name.toLowerCase() === 'set-cookie') continue;
      lines.push(`${name}: ${upRes.rawHeaders[i + 1]}`);
    }
    socket.write(lines.join('\r\n') + '\r\n\r\n');
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSocket.write(head);
    upSocket.pipe(socket).pipe(upSocket);
    upSocket.on('error', () => socket.destroy());
    socket.on('error', () => upSocket.destroy());
    upSocket.on('close', () => socket.destroy());
    socket.on('close', () => upSocket.destroy());
  });
  upstreamReq.on('response', (upRes) => {
    fail(upRes.statusCode, upRes.statusMessage || 'Error');
    upRes.resume();
  });
  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('timeout')));
  upstreamReq.on('error', (e) => {
    log.error(`WebSocket 接続失敗 ${target.href}: ${e.message}`);
    fail(502, 'Bad Gateway');
  });
  socket.on('error', () => upstreamReq.destroy());
  upstreamReq.end();
}

// ---------------------------------------------------------------- ルーティング

// ログ画面のポーリングなど、毎秒来るものはログに出さない
const UNLOGGED = new Set(['/__px/health', '/__px/logs.json', '/__px/log']);

function logRequest(req, res, started) {
  const dest = String(req.headers['x-px-dest'] ?? req.headers['sec-fetch-dest'] ?? '') || 'fetch';
  const target = decodeProxyPath(req.url || '');
  const shown = target ? target.href : req.url;
  const ms = Date.now() - started;
  const msg = `${res.statusCode} ${req.method} ${shown} (${dest}, ${ms}ms)`;
  if (res.statusCode >= 500) log.error(msg);
  else if (res.statusCode >= 400) log.warn(msg);
  else if (dest === 'document' || dest === 'iframe') log.info(msg);
  else log.debug(msg);
}

/** ブラウザ側 (client.js / ホーム画面) からのエラー報告を受け取る */
function handleClientLog(req, res) {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => {
    body += c;
    if (body.length > 16_384) req.destroy();
  });
  req.on('end', () => {
    try {
      const { level, msg, page } = JSON.parse(body);
      const text = `[ブラウザ] ${String(msg).slice(0, 2000)}${page ? `  @ ${page}` : ''}`;
      if (level === 'error') log.error(text);
      else if (level === 'warn') log.warn(text);
      else log.info(text);
    } catch {}
    res.writeHead(204);
    res.end();
  });
}

function onRequest(req, res) {
  const url = req.url || '/';
  const pathname = url.split('?')[0];
  const started = Date.now();
  if (!UNLOGGED.has(pathname)) {
    res.on('finish', () => logRequest(req, res, started));
    res.on('close', () => {
      if (!res.writableFinished) log.warn(`中断 ${req.method} ${decodeProxyPath(url)?.href || url} (ブラウザ側が ${Date.now() - started}ms で切断)`);
    });
  }

  if (pathname === '/__px/health') {
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return res.end('ok');
  }
  if (pathname === '/__px/log' && req.method === 'POST') return handleClientLog(req, res);
  if (pathname === '/__px/logs.json') {
    const after = Number(new URL(url, 'http://x').searchParams.get('after')) || 0;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(getEntries(after)));
  }
  if (pathname === '/__px/logs') return serveStatic(req, res, 'logs.html');

  if (url.startsWith(PREFIX)) {
    const target = decodeProxyPath(url);
    if (!target) return sendError(res, 400, 'URL の形式が正しくありません', req);
    return handleProxy(req, res, target).catch((e) => {
      log.error(`[proxy] 予期しないエラー ${target.href}: ${e.stack || e.message}`);
      sendError(res, 500, '内部エラー: ' + e.message, req);
    });
  }

  if (pathname === '/__px/sw.js') return serveStatic(req, res, 'sw.js', { 'service-worker-allowed': '/' });
  if (pathname.startsWith('/__px/')) {
    const name = pathname.slice('/__px/'.length);
    if (!/^[\w.-]+$/.test(name)) return sendError(res, 404, 'Not Found');
    return serveStatic(req, res, name);
  }

  const origin = guessTargetOrigin(req);
  if (origin) {
    log.debug(`ルート相対パス ${url} を ${origin} 宛てとみなして転送`);
    res.writeHead(307, { location: PREFIX + origin + url, 'cache-control': 'no-store' });
    return res.end();
  }
  if (pathname === '/' || pathname === '/index.html') return serveStatic(req, res, 'index.html');
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    return res.end();
  }
  sendError(res, 404, 'ページが見つかりません', req);
}

export function createServer() {
  const server = http.createServer(onRequest);
  server.on('upgrade', handleUpgrade);
  server.on('clientError', (err, socket) => socket.destroy());
  return server;
}

function publicUrl() {
  const { CODESPACE_NAME, GITHUB_CODESPACES_PORT_FORWARDING_DOMAIN: domain } = process.env;
  if (CODESPACE_NAME && domain) return `https://${CODESPACE_NAME}-${PORT}.${domain}/`;
  return `http://localhost:${PORT}/`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  process.on('uncaughtException', (e) => log.error(`[process] uncaughtException: ${e.stack || e}`));
  process.on('unhandledRejection', (e) => log.error(`[process] unhandledRejection: ${e?.stack || e}`));

  const server = createServer();
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      log.error(`ポート ${PORT} は既に使われています。前に起動したプロキシが動いていないか確認してください (別ポート: PORT=8081 npm start)`);
    } else {
      log.error(`サーバーを起動できませんでした: ${e.stack || e}`);
    }
    process.exit(1);
  });
  server.listen(PORT, HOST, () => {
    log.info(`プロキシ起動 (Node ${process.version}, ${HOST}:${PORT})`);
    log.info(`ブラウザで開く: ${publicUrl()}`);
    log.info(`ログ画面:       ${publicUrl()}__px/logs   (ファイル: ${LOG_FILE})`);
    if (process.env.UPSTREAM_PROXY) log.info(`上流プロキシ: ${process.env.UPSTREAM_PROXY}`);
  });
}
