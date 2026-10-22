import { PREFIX } from './url.js';

// ブラウザから見ると全サイトがプロキシと同じオリジンになる。
// そこで Cookie の Path を /p/<サイトのオリジン>/... にずらし、サイトごとに分離する。
// __Host- / __Secure- 接頭辞付きは Path や Secure の制約で拒否されるので名前を付け替える。
const RENAMES = [
  ['__Host-', '__PXH_'],
  ['__Secure-', '__PXS_'],
];

export const INTERNAL_COOKIE_PREFIX = '__px_';

function toStoredName(name) {
  for (const [from, to] of RENAMES) if (name.startsWith(from)) return to + name.slice(from.length);
  return name;
}

function toOriginalName(name) {
  for (const [from, to] of RENAMES) if (name.startsWith(to)) return from + name.slice(to.length);
  return name;
}

/**
 * サーバーからの Set-Cookie をプロキシ用に書き換える
 * @param {string} header Set-Cookie の値1つ
 * @param {URL} target リクエスト先URL
 * @param {boolean} secureProxy プロキシ自体が https で配信されているか
 */
export function rewriteSetCookie(header, target, secureProxy) {
  const parts = header.split(';');
  const pair = parts.shift();
  const eq = pair.indexOf('=');
  const name = eq === -1 ? '' : pair.slice(0, eq).trim();
  const value = eq === -1 ? pair : pair.slice(eq + 1);
  let path = '/';
  const attrs = [];
  for (const raw of parts) {
    const a = raw.trim();
    if (!a) continue;
    const k = a.split('=')[0].trim().toLowerCase();
    if (k === 'domain' || k === 'partitioned') continue;
    if (k === 'path') {
      const p = a.slice(a.indexOf('=') + 1).trim();
      if (p.startsWith('/')) path = p;
      continue;
    }
    if (!secureProxy && (k === 'secure' || k === 'samesite')) continue;
    attrs.push(a);
  }
  attrs.unshift(`Path=${PREFIX}${target.origin}${path}`);
  const n = name ? toStoredName(name) + '=' : '';
  return [`${n}${value}`, ...attrs].join('; ');
}

/** ブラウザから届いた Cookie ヘッダーをサイト向けに戻す (内部用 Cookie は除外) */
export function restoreCookieHeader(header) {
  if (!header) return '';
  return header
    .split(';')
    .map((c) => c.trim())
    .filter((c) => c && !c.startsWith(INTERNAL_COOKIE_PREFIX))
    .map((c) => {
      const eq = c.indexOf('=');
      return eq === -1 ? c : toOriginalName(c.slice(0, eq)) + c.slice(eq);
    })
    .join('; ');
}

export function readCookie(header, name) {
  for (const c of (header || '').split(';')) {
    const eq = c.indexOf('=');
    if (eq !== -1 && c.slice(0, eq).trim() === name) return c.slice(eq + 1).trim();
  }
  return null;
}
