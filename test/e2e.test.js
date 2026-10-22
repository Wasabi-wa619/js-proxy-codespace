// 実際の Chromium でプロキシ経由のページを開いて動作を確かめる
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { startSites } from './fixtures.js';

process.env.ALLOW_PRIVATE = '1'; // テストサイトが localhost にあるため
process.env.LOG_LEVEL = 'quiet';
process.env.LOG_FILE = '/dev/null';
const { createServer } = await import('../src/server.js');

let sites, proxy, P, browser;

before(async () => {
  sites = await startSites();
  proxy = createServer();
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
  P = `http://localhost:${proxy.address().port}`;
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined });
});

after(async () => {
  await browser?.close();
  proxy?.closeAllConnections();
  proxy?.close();
  sites?.close();
});

async function newPage() {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // SW を有効にしてから開く (ホーム画面と同じ流れ)
  await page.goto(P + '/');
  await page.evaluate(() => navigator.serviceWorker.ready);
  return { page, ctx, errors };
}

const prox = (u) => `${P}/p/${u}`;

test('ページ内の JS から見える URL と各種通信', async () => {
  const { page, ctx, errors } = await newPage();
  await page.goto(prox(sites.A + '/'));
  await page.waitForFunction(() => window.results && window.results.done, null, { timeout: 15000 });
  const r = await page.evaluate(() => window.results);

  assert.equal(r.error, undefined);
  assert.equal(r.href, sites.A + '/');
  assert.equal(r.host, new URL(sites.A).host);
  assert.equal(r.pathname, '/');
  assert.equal(r.origin, sites.A);
  assert.equal(r.docURL, sites.A + '/');
  assert.equal(r.linkHref, sites.A + '/page2.html');
  assert.equal(r.extHost, new URL(sites.B).hostname);
  assert.match(r.cookieVisible, /jsc=1/);
  assert.equal(r.api.ok, 1);
  assert.match(r.api.cookie, /jsc=1/);
  assert.equal(r.api.referer, sites.A + '/');
  assert.deepEqual(r.cors, { from: 'B' });
  assert.equal(r.xhr.ok, 1);
  assert.match(r.xhr.cookie, /srv=abc/, 'サーバーが Set-Cookie した値が次のリクエストで送られる');
  assert.match(r.xhr.cookie, /__Host-h=1/, '__Host- Cookie は元の名前で届く');
  assert.equal(r.ws, 'pong:ping');
  assert.equal(r.iframe.ok, 1);
  assert.equal(r.pushed, '/virtual/path?x=1');
  assert.equal(new URL(page.url()).pathname, `/p/${sites.A}/virtual/path`);

  // CSS の背景画像・ルート相対の img・innerHTML で入れた別オリジン img が読めている
  const imgs = await page.evaluate(() => [
    document.getElementById('img1').naturalWidth,
    document.getElementById('img2').naturalWidth,
    getComputedStyle(document.body).backgroundImage,
  ]);
  assert.equal(imgs[0], 2);
  await page.waitForFunction(() => document.getElementById('img2').naturalWidth === 3);
  assert.match(imgs[2], new RegExp(`/p/${sites.A.replace(/[.:/]/g, '\\$&')}/bg\\.svg`));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('リンククリックで別オリジンのページもプロキシ経由で開く', async () => {
  const { page, ctx } = await newPage();
  await page.goto(prox(sites.A + '/'));
  await page.click('#ext');
  await page.waitForSelector('#b');
  assert.equal(page.url(), prox(sites.B + '/b.html'));
  assert.equal(await page.evaluate(() => window.bHref), sites.B + '/b.html');
  await ctx.close();
});

test('location.href = ... / location.assign(別オリジン) での遷移', async () => {
  const { page, ctx } = await newPage();
  await page.goto(prox(sites.A + '/nav.html'));
  await page.waitForSelector('#p2');
  assert.equal(page.url(), prox(sites.A + '/page2.html'));

  await page.goto(prox(sites.A + '/nav-abs.html'));
  await page.waitForSelector('#b');
  assert.equal(page.url(), prox(sites.B + '/b.html'));
  await ctx.close();
});

test('リダイレクト・フォーム POST・Shift_JIS', async () => {
  const { page, ctx } = await newPage();
  await page.goto(prox(sites.A + '/redirect'));
  await page.waitForSelector('#b');
  assert.equal(page.url(), prox(sites.B + '/b.html'));

  await page.goto(prox(sites.A + '/form.html'));
  await page.click('#send');
  await page.waitForSelector('#body');
  assert.equal(await page.textContent('#body'), 'q=hello');

  await page.goto(prox(sites.A + '/sjis.html'));
  assert.equal(await page.textContent('#t'), 'こんにちは');
  await ctx.close();
});

test('SW なしでもルート相対パスはサーバー側で救済される', async () => {
  const ctx = await browser.newContext({ serviceWorkers: 'block' });
  const page = await ctx.newPage();
  await page.goto(prox(sites.A + '/'));
  await page.waitForFunction(() => window.results && window.results.done, null, { timeout: 15000 });
  const r = await page.evaluate(() => window.results);
  assert.equal(r.error, undefined);
  assert.equal(r.api.ok, 1);
  assert.equal(await page.evaluate(() => document.getElementById('img1').naturalWidth), 2);
  await ctx.close();
});

test('ホーム画面から URL を入力して開ける', async () => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(P + '/');
  await page.fill('#url', sites.B + '/b.html');
  await page.press('#url', 'Enter');
  await page.waitForSelector('#b');
  assert.equal(page.url(), prox(sites.B + '/b.html'));
  await ctx.close();
});

test('サイトを開いた後でもホーム画面に戻れる', async () => {
  const { page, ctx } = await newPage();
  await page.goto(prox(sites.A + '/page2.html'));
  await page.waitForSelector('#p2');
  await page.goto(P + '/');
  await page.waitForSelector('#url');
  assert.equal(page.url(), P + '/');
  await ctx.close();
});

test('真っ白なページの原因 (JS エラー・読み込み失敗) がログに残る', async () => {
  const { page, ctx } = await newPage();
  const before = await (await fetch(P + '/__px/logs.json')).json();
  const after = before.length ? before[before.length - 1].id : 0;
  await page.goto(prox(sites.A + '/broken.html'));
  const deadline = Date.now() + 8000;
  let msgs = [];
  while (Date.now() < deadline) {
    msgs = (await (await fetch(`${P}/__px/logs.json?after=${after}`)).json()).map((e) => e.msg);
    if (msgs.some((m) => m.includes('画面に何も表示されていません'))) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const all = msgs.join('\n');
  assert.match(all, /404 GET http:\/\/127\.0\.0\.1:\d+\/missing\.js/);
  assert.match(all, /JS エラー: .*undefinedFunction/);
  assert.match(all, /画面に何も表示されていません/);
  await ctx.close();
});
