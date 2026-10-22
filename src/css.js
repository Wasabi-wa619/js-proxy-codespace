import { rewriteUrl } from './url.js';

const URL_FN_RE = /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)'"\s]*))\s*\)/gi;
const IMPORT_RE = /@import\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/gi;

/** CSS 内の url(...) と @import "..." をプロキシ経由に書き換える */
export function rewriteCss(css, base) {
  return css
    .replace(URL_FN_RE, (all, dq, sq, bare) => {
      const v = dq ?? sq ?? bare ?? '';
      if (!v) return all;
      const q = dq != null ? '"' : sq != null ? "'" : '';
      return `url(${q}${rewriteUrl(v, base)}${q})`;
    })
    .replace(IMPORT_RE, (all, dq, sq) => {
      const q = dq != null ? '"' : "'";
      return `@import ${q}${rewriteUrl(dq ?? sq, base)}${q}`;
    });
}
