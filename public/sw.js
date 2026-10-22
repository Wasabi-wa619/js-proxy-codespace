/*
 * プロキシ用 Service Worker (スコープ: /)
 * client.js のフックをすり抜けたリクエスト (CSS 内の画像、innerHTML で入った <img>、
 * ルート相対パス "/api/..." など) を捕まえて /p/<URL> に振り向ける最後の砦。
 */
'use strict';

const PREFIX = '/p/';
const PROXIED_RE = /^\/p\/(https?|wss?):\/\/?/i;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

function toTarget(u) {
  try {
    const x = new URL(u);
    if (x.origin !== self.location.origin) return null;
    const m = /^\/p\/(https?|wss?):\/\/?(.*)$/i.exec(x.pathname);
    if (!m) return null;
    return new URL(m[1].toLowerCase() + '://' + m[2] + x.search + x.hash);
  } catch {
    return null;
  }
}

async function contextOrigin(event) {
  const req = event.request;
  if (event.clientId) {
    const client = await self.clients.get(event.clientId);
    const t = client && toTarget(client.url);
    if (t) return t.origin;
  }
  const ref = toTarget(req.referrer);
  return ref ? ref.origin : null;
}

async function forward(event, proxiedPath) {
  const req = event.request;
  if (req.mode === 'navigate') return Response.redirect(proxiedPath, 307);
  const init = {
    method: req.method,
    headers: new Headers(req.headers),
    credentials: 'same-origin',
    redirect: req.redirect === 'manual' ? 'manual' : 'follow',
    referrer: req.referrer,
    cache: req.cache === 'only-if-cached' ? 'default' : req.cache,
  };
  init.headers.set('x-px-dest', req.destination || 'empty');
  if (req.method !== 'GET' && req.method !== 'HEAD') init.body = await req.blob();
  return fetch(proxiedPath, init);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }

  if (url.origin !== self.location.origin) {
    // 他オリジンへの直接リクエスト -> プロキシ経由にする
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    event.respondWith(forward(event, PREFIX + url.href));
    return;
  }

  // すでにプロキシ形式 / プロキシ自身のファイル -> そのまま
  if (PROXIED_RE.test(url.pathname) || url.pathname.startsWith('/__px/')) return;

  // ルート相対パス (/api/foo 等) -> どのサイトのページから来たか調べて振り向ける
  if (req.mode === 'navigate') {
    // 画面遷移はプロキシ中のページから来た時だけ振り向ける。
    // それ以外 (アドレスバーに入力してホームへ戻る等) はブラウザに任せる
    const ref = toTarget(req.referrer);
    if (ref) event.respondWith(forward(event, PREFIX + ref.origin + url.pathname + url.search));
    return;
  }
  event.respondWith(
    contextOrigin(event).then((origin) =>
      origin ? forward(event, PREFIX + origin + url.pathname + url.search) : fetch(req),
    ),
  );
});
