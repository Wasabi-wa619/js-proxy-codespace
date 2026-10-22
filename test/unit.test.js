import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rewriteUrl, rewriteSrcset, decodeProxyPath } from '../src/url.js';
import { rewriteCss } from '../src/css.js';
import { rewriteHtml } from '../src/html.js';
import { rewriteJs, JS_PROLOGUE } from '../src/js.js';
import { rewriteSetCookie, restoreCookieHeader } from '../src/cookies.js';
import { isPrivateIp } from '../src/net.js';

const PAGE = 'https://example.com/dir/page.html';

test('rewriteUrl', () => {
  assert.equal(rewriteUrl('img/a.png', PAGE), '/p/https://example.com/dir/img/a.png');
  assert.equal(rewriteUrl('/root', PAGE), '/p/https://example.com/root');
  assert.equal(rewriteUrl('//cdn.test/x.js', PAGE), '/p/https://cdn.test/x.js');
  assert.equal(rewriteUrl('wss://ws.test/s', PAGE), '/p/wss://ws.test/s');
  for (const keep of ['#top', 'data:image/png;base64,xx', 'javascript:void 0', 'mailto:a@b.c', '', '/p/https://x.test/']) {
    assert.equal(rewriteUrl(keep, PAGE), keep);
  }
});

test('decodeProxyPath は潰れた // にも対応', () => {
  assert.equal(decodeProxyPath('/p/https://a.test/x?y=1').href, 'https://a.test/x?y=1');
  assert.equal(decodeProxyPath('/p/https:/a.test/x').href, 'https://a.test/x');
  assert.equal(decodeProxyPath('/p/wss://a.test/ws').href, 'https://a.test/ws');
  assert.equal(decodeProxyPath('/p/abc'), null);
});

test('rewriteSrcset (URL 内のカンマを壊さない)', () => {
  const r = (u) => rewriteUrl(u, PAGE);
  assert.equal(
    rewriteSrcset('a.png 1x, https://img.test/w_100,h_100/b.png 2x', r),
    '/p/https://example.com/dir/a.png 1x, /p/https://img.test/w_100,h_100/b.png 2x',
  );
});

test('rewriteCss', () => {
  const css = `a{background:url(x.png)} b{background:url("/y.png")} @import 'z.css'; c{background:url(data:image/png;base64,AA)}`;
  assert.equal(
    rewriteCss(css, PAGE),
    `a{background:url(/p/https://example.com/dir/x.png)} b{background:url("/p/https://example.com/y.png")} @import '/p/https://example.com/dir/z.css'; c{background:url(data:image/png;base64,AA)}`,
  );
});

test('rewriteHtml', async () => {
  const html = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
<base href="/base/">
<link rel="stylesheet" href="s.css" integrity="sha256-x">
<style>body{background:url(bg.png)}</style>
</head><body>
<a href="https://other.test/a?b=1&amp;c=2" onclick="location.href='/x'">a</a>
<img srcset="a.png 1x, b.png 2x" src="/i.png">
<form action="/post"></form>
<script>var u = location.href;</script>
<script type="application/ld+json">{"location":"x"}</script>
</body></html>`;
  const out = await rewriteHtml(html, PAGE, { inject: '<script src="/__px/client.js"></script>' });
  assert.match(out, /<head><script src="\/__px\/client\.js"><\/script>/);
  assert.doesNotMatch(out, /Content-Security-Policy/);
  assert.doesNotMatch(out, /integrity/);
  assert.match(out, /<base href="\/p\/https:\/\/example\.com\/base\/">/);
  assert.match(out, /href="\/p\/https:\/\/example\.com\/base\/s\.css"/);
  assert.match(out, /url\(\/p\/https:\/\/example\.com\/base\/bg\.png\)/);
  assert.match(out, /href="\/p\/https:\/\/other\.test\/a\?b=1&amp;c=2"/);
  assert.match(out, /onclick="__pxL\(location\)\.href='\/x'"/);
  assert.match(out, /srcset="\/p\/https:\/\/example\.com\/base\/a\.png 1x, \/p\/https:\/\/example\.com\/base\/b\.png 2x"/);
  assert.match(out, /action="\/p\/https:\/\/example\.com\/post"/);
  assert.match(out, /var u = __pxL\(location\)\.href;/);
  assert.match(out, /\{"location":"x"\}/, 'JSON の script は触らない');
});

test('rewriteHtml: head が無くても先頭に挿入する', async () => {
  const out = await rewriteHtml('<p>hi</p>', PAGE, { inject: '<script src="/c.js"></script>' });
  assert.equal(out, '<script src="/c.js"></script><p>hi</p>');
});

test('rewriteJs', () => {
  const cases = [
    ['location.href = "/a"', '__pxL(location).href = "/a"'],
    ['window.location = u', '__pxSet(window,u)'],
    ['location = u', 'location = __pxA(location,u)'],
    ['x = document.location.host', 'x = __pxL(document.location).host'],
    ['({location})', '({location:__pxL(location)})'],
    ['function f(location) { var location; }', 'function f(location) { var location; }'],
    ['const { location } = window', 'const { location } = window'],
    ['a = { location: 1 }; a.location++', 'a = { location: 1 }; a.location++'],
    ['a?.location.href', 'a?.location.href'],
    ['var s = "location"', 'var s = "location"'],
  ];
  for (const [src, expected] of cases) assert.equal(rewriteJs(src), expected, src);
});

test('rewriteJs: prologue は "use strict" の後ろに入る', () => {
  assert.equal(rewriteJs('"use strict";f()', { prologue: true }), '"use strict";;' + JS_PROLOGUE + 'f()');
  assert.equal(rewriteJs('import x from "y"; x()', { prologue: true }), JS_PROLOGUE + 'import x from "y"; x()');
});

test('rewriteJs: 構文エラーでも落ちない', () => {
  assert.equal(rewriteJs('location.href = ('), 'location.href = (');
});

test('Cookie の書き換えと復元', () => {
  const t = new URL('https://example.com/a/b');
  assert.equal(
    rewriteSetCookie('sid=1; Domain=.example.com; Path=/; Secure; HttpOnly; SameSite=None', t, true),
    'sid=1; Path=/p/https://example.com/; Secure; HttpOnly; SameSite=None',
  );
  assert.equal(rewriteSetCookie('sid=1; Secure; SameSite=None', t, false), 'sid=1; Path=/p/https://example.com/');
  assert.equal(rewriteSetCookie('__Host-x=1; Path=/; Secure', t, true), '__PXH_x=1; Path=/p/https://example.com/; Secure');
  assert.equal(restoreCookieHeader('__PXH_x=1; a=2; __px_origin=zz'), '__Host-x=1; a=2');
});

test('isPrivateIp', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fd00::1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});
