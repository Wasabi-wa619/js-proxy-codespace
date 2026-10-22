// プロキシURLの形式: /p/<ターゲットの絶対URL>
//   例) /p/https://example.com/path?q=1
// パス形式なので、ページ内の相対URL (img/a.png や ../x) はブラウザがそのまま正しく解決できる。

export const PREFIX = '/p/';

// 一部のリバースプロキシ (Codespaces 等) が "//" を "/" に潰すことがあるので "https:/" も受け付ける
const PROXIED_PATH_RE = /^\/p\/(https?|wss?):\/\/?(.*)$/is;

const SKIP_SCHEMES_RE = /^\s*(data|blob|javascript|about|mailto|tel|sms|intent|chrome|chrome-extension|moz-extension):/i;

/** "/p/https://..." 形式のパス(+クエリ)をターゲットURL文字列に戻す。該当しなければ null */
export function decodeProxyPath(pathAndQuery) {
  const m = PROXIED_PATH_RE.exec(pathAndQuery);
  if (!m) return null;
  let scheme = m[1].toLowerCase();
  if (scheme === 'ws') scheme = 'http';
  if (scheme === 'wss') scheme = 'https';
  try {
    return new URL(`${scheme}://${m[2]}`);
  } catch {
    return null;
  }
}

/** 完全なプロキシURL (Referer ヘッダーなど) からターゲットURLを取り出す */
export function decodeProxyUrl(fullUrl) {
  try {
    const u = new URL(fullUrl);
    return decodeProxyPath(u.pathname + u.search + u.hash);
  } catch {
    return null;
  }
}

export function isProxiedPath(s) {
  return PROXIED_PATH_RE.test(s);
}

/**
 * ターゲットページ内に現れたURLをプロキシ経由のURLに書き換える。
 * 書き換え不要/不能なもの (#hash, data:, javascript: など) はそのまま返す。
 */
export function rewriteUrl(value, base) {
  if (value == null) return value;
  const raw = String(value);
  const s = raw.trim();
  if (s === '' || s[0] === '#' || SKIP_SCHEMES_RE.test(s) || isProxiedPath(s)) return raw;
  let abs;
  try {
    abs = new URL(s, base);
  } catch {
    return raw;
  }
  if (!/^(https?|wss?):$/.test(abs.protocol)) return raw;
  return PREFIX + abs.href;
}

/** srcset="a.png 1x, b.png 2x" のURL部分だけを書き換える (URL内のカンマにも対応) */
export function rewriteSrcset(value, rewrite) {
  if (!value) return value;
  const s = String(value);
  const out = [];
  let i = 0;
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let start = i;
    while (i < s.length && !/\s/.test(s[i])) i++;
    let url = s.slice(start, i);
    let descriptor = '';
    if (url.endsWith(',')) {
      url = url.replace(/,+$/, '');
    } else {
      start = i;
      let depth = 0;
      while (i < s.length) {
        const c = s[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
        else if (c === ',' && depth <= 0) break;
        i++;
      }
      descriptor = s.slice(start, i).trim();
      i++;
    }
    out.push(descriptor ? `${rewrite(url)} ${descriptor}` : rewrite(url));
  }
  return out.join(', ');
}
