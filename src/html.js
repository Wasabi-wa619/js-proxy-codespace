import { RewritingStream } from 'parse5-html-rewriting-stream';
import { rewriteUrl, rewriteSrcset } from './url.js';
import { rewriteCss } from './css.js';
import { rewriteJs } from './js.js';

// タグごとに URL を持つ属性
const URL_ATTRS = {
  a: ['href'],
  area: ['href'],
  link: ['href'],
  base: ['href'],
  img: ['src', 'lowsrc', 'longdesc'],
  image: ['href', 'xlink:href'],
  use: ['href', 'xlink:href'],
  script: ['src'],
  iframe: ['src'],
  frame: ['src'],
  embed: ['src'],
  source: ['src'],
  track: ['src'],
  audio: ['src'],
  video: ['src', 'poster'],
  input: ['src', 'formaction'],
  button: ['formaction'],
  form: ['action'],
  object: ['data'],
  body: ['background'],
  table: ['background'],
  td: ['background'],
  blockquote: ['cite'],
  q: ['cite'],
};
const SRCSET_TAGS = new Set(['img', 'source']);
// 内容を書き換えると壊れる・意味がなくなる属性
const DROP_ATTRS = new Set(['integrity', 'nonce', 'referrerpolicy', 'ping']);
const JS_TYPES = new Set([
  '',
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'application/ecmascript',
  'text/jscript',
  'module',
]);

/**
 * HTML を書き換える
 * @param {string} html
 * @param {string} pageUrl ターゲットページのURL
 * @param {{inject?: string}} [opts] inject: <head> 直後に挿入する HTML (client.js の script タグ)
 * @returns {Promise<string>}
 */
export function rewriteHtml(html, pageUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const rw = new RewritingStream();
    let base = pageUrl;
    let injected = !opts.inject;
    let rawText = null; // { tag, type, chunks } script/style の中身を貯める
    const url = (v) => rewriteUrl(v, base);

    const inject = () => {
      if (!injected) {
        injected = true;
        rw.emitRaw(opts.inject);
      }
    };

    rw.on('startTag', (tag) => {
      const name = tag.tagName;
      if (!injected && name !== 'html' && name !== 'head') inject();

      if (name === 'meta') {
        const get = (n) => tag.attrs.find((a) => a.name === n)?.value?.toLowerCase();
        const equiv = get('http-equiv');
        if (equiv === 'content-security-policy' || get('name') === 'referrer') return;
        if (equiv === 'refresh') {
          const c = tag.attrs.find((a) => a.name === 'content');
          if (c) c.value = c.value.replace(/(url\s*=\s*['"]?)([^'"]+)/i, (_, p, u) => p + url(u.trim()));
        }
      }

      if (name === 'base') {
        const href = tag.attrs.find((a) => a.name === 'href');
        if (href) {
          try {
            base = new URL(href.value, pageUrl).href;
          } catch {}
        }
      }

      tag.attrs = tag.attrs.filter((a) => !DROP_ATTRS.has(a.name));
      const urlAttrs = URL_ATTRS[name];
      for (const a of tag.attrs) {
        if (urlAttrs?.includes(a.name)) {
          a.value = /^\s*javascript:/i.test(a.value)
            ? 'javascript:' + rewriteJs(a.value.replace(/^\s*javascript:/i, ''), { handler: true })
            : url(a.value);
        } else if (a.name === 'srcset' || a.name === 'imagesrcset') {
          if (SRCSET_TAGS.has(name) || name === 'link') a.value = rewriteSrcset(a.value, url);
        } else if (a.name === 'style') {
          a.value = rewriteCss(a.value, base);
        } else if (a.name === 'srcdoc' && name === 'iframe') {
          // srcdoc は同期的に書き換えたいので簡易的に属性だけ処理する
          a.value = rewriteFragmentSync(a.value, base, opts.inject);
        } else if (a.name.startsWith('on') && a.name.length > 2) {
          a.value = rewriteJs(a.value, { handler: true });
        }
      }

      rw.emitStartTag(tag);
      if (name === 'head') inject();

      if (name === 'script' || name === 'style') {
        const type = (tag.attrs.find((a) => a.name === 'type')?.value || '').trim().toLowerCase();
        if (!tag.selfClosing) rawText = { tag: name, type, chunks: [] };
      }
    });

    rw.on('text', (_, raw) => {
      if (rawText) rawText.chunks.push(raw);
      else rw.emitRaw(raw);
    });

    rw.on('endTag', (tag, raw) => {
      if (rawText && tag.tagName === rawText.tag) {
        let body = rawText.chunks.join('');
        if (rawText.tag === 'style') body = rewriteCss(body, base);
        else if (JS_TYPES.has(rawText.type)) body = rewriteJs(body, { module: rawText.type === 'module' });
        else if (rawText.type === 'importmap') body = rewriteImportMap(body, base);
        rawText = null;
        rw.emitRaw(body);
      }
      rw.emitRaw(raw);
    });

    const out = [];
    rw.on('data', (c) => out.push(c));
    rw.on('end', () => {
      if (rawText) out.push(rawText.chunks.join(''));
      let result = out.join('');
      if (!injected) result = opts.inject + result;
      resolve(result);
    });
    rw.on('error', reject);
    rw.end(html);
  });
}

function rewriteImportMap(json, base) {
  try {
    const map = JSON.parse(json);
    const fix = (obj) => {
      if (!obj || typeof obj !== 'object') return obj;
      const res = {};
      for (const [k, v] of Object.entries(obj)) res[k] = typeof v === 'string' ? rewriteUrl(v, base) : fix(v);
      return res;
    };
    if (map.imports) map.imports = fix(map.imports);
    if (map.scopes) {
      const scopes = {};
      for (const [k, v] of Object.entries(map.scopes)) scopes[rewriteUrl(k, base)] = fix(v);
      map.scopes = scopes;
    }
    return JSON.stringify(map);
  } catch {
    return json;
  }
}

// iframe srcdoc 用: 属性値として埋め込まれた HTML を正規表現で簡易的に書き換える
function rewriteFragmentSync(html, base, inject) {
  const out = html.replace(
    /(\s(?:src|href|action|poster|formaction)\s*=\s*)(["'])(.*?)\2/gi,
    (_, p, q, v) => p + q + rewriteUrl(v, base) + q,
  );
  return (inject || '') + out;
}
