// E2E テスト用の「ターゲットサイト」。オリジン違いのサイトを2つ立てる。
import http from 'node:http';
import { WebSocketServer } from 'ws';

function listen(server, host) {
  return new Promise((resolve) => server.listen(0, host, () => resolve(server.address().port)));
}

export async function startSites() {
  // B: 別オリジン (localhost:<port>)
  const b = http.createServer((req, res) => {
    if (req.url === '/b.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<!doctype html><title>Site B</title><h1 id="b">B page</h1><script>window.bHref = location.href</script>');
    }
    if (req.url === '/cors.json') {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
      return res.end(JSON.stringify({ from: 'B' }));
    }
    if (req.url === '/pixel.svg') {
      res.writeHead(200, { 'content-type': 'image/svg+xml' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="3" height="3"><rect width="3" height="3"/></svg>');
    }
    res.writeHead(404).end();
  });
  const bPort = await listen(b, 'localhost');
  const B = `http://localhost:${bPort}`;

  // A: メインのテストサイト (127.0.0.1:<port>)
  const a = http.createServer((req, res) => {
    const html = (body, headers = {}) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    const url = new URL(req.url, 'http://x');
    switch (url.pathname) {
      case '/':
        return html(`<!doctype html><html><head><title>Site A</title>
<link rel="stylesheet" href="/style.css">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'">
</head><body>
<img id="img1" src="/img.svg">
<a id="link" href="/page2.html">page2</a>
<a id="ext" href="${B}/b.html">external</a>
<div id="dyn"></div>
<script src="/app.js" integrity="sha384-bogus"></script>
</body></html>`, { 'content-security-policy': "default-src 'none'", 'x-frame-options': 'DENY' });
      case '/style.css':
        res.writeHead(200, { 'content-type': 'text/css' });
        return res.end(`body { background: url("/bg.svg") }`);
      case '/img.svg':
      case '/bg.svg':
        res.writeHead(200, { 'content-type': 'image/svg+xml' });
        return res.end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2"/></svg>');
      case '/app.js':
        res.writeHead(200, { 'content-type': 'application/javascript' });
        return res.end(`
window.results = {};
const r = window.results;
r.href = location.href;
r.host = window.location.host;
r.pathname = document.location.pathname;
r.origin = window.origin;
r.docURL = document.URL;
r.linkHref = document.getElementById('link').href;
r.extHost = document.getElementById('ext').hostname;
document.cookie = 'jsc=1; path=/';
r.cookieVisible = document.cookie;
(async () => {
  r.api = await (await fetch('/api/data')).json();
  r.cors = await (await fetch('${B}/cors.json')).json();
  r.xhr = await new Promise((ok) => {
    const x = new XMLHttpRequest();
    x.open('GET', '/api/data');
    x.onload = () => ok(JSON.parse(x.responseText));
    x.send();
  });
  r.ws = await new Promise((ok) => {
    const ws = new WebSocket('ws://' + location.host + '/ws');
    ws.onopen = () => ws.send('ping');
    ws.onmessage = (e) => { ok(e.data); ws.close(); };
    ws.onerror = () => ok('error');
  });
  document.getElementById('dyn').innerHTML = '<img id="img2" src="${B}/pixel.svg">';
  const f = document.createElement('iframe');
  document.body.appendChild(f);
  r.iframe = await (await f.contentWindow.fetch('/api/data')).json();
  history.pushState({}, '', '/virtual/path?x=1');
  r.pushed = location.pathname + location.search;
  r.done = true;
})().catch((e) => { r.error = String(e); r.done = true; });
`);
      case '/api/data':
        res.writeHead(200, {
          'content-type': 'application/json',
          'set-cookie': ['srv=abc; Path=/; HttpOnly', '__Host-h=1; Path=/; Secure'],
        });
        return res.end(JSON.stringify({ ok: 1, cookie: req.headers.cookie || '', referer: req.headers.referer || '' }));
      case '/page2.html':
        return html('<!doctype html><title>Page 2</title><h1 id="p2">page 2</h1>');
      case '/nav.html':
        return html('<!doctype html><title>nav</title><script>setTimeout(function(){ location.href = "/page2.html" }, 50)</script>');
      case '/nav-abs.html':
        return html(`<!doctype html><title>nav</title><script>setTimeout(function(){ window.location.assign("${B}/b.html") }, 50)</script>`);
      case '/redirect':
        res.writeHead(302, { location: `${B}/b.html` });
        return res.end();
      case '/sjis.html': {
        res.writeHead(200, { 'content-type': 'text/html; charset=Shift_JIS' });
        // "こんにちは" を Shift_JIS で
        const sjis = Buffer.from([0x82, 0xb1, 0x82, 0xf1, 0x82, 0xc9, 0x82, 0xbf, 0x82, 0xcd]);
        return res.end(Buffer.concat([Buffer.from('<!doctype html><title>sjis</title><p id="t">'), sjis, Buffer.from('</p>')]));
      }
      case '/broken.html':
        return html('<!doctype html><title>broken</title><body><div id="app"></div><script src="/missing.js"></script><script>undefinedFunction()</script></body>');
      case '/form.html':
        return html('<!doctype html><form method="post" action="/submit"><input name="q" value="hello"><button id="send">send</button></form>');
      case '/submit': {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => html(`<!doctype html><title>submitted</title><p id="body">${body}</p>`));
        return;
      }
      default:
        res.writeHead(404).end('not found');
    }
  });
  const wss = new WebSocketServer({ noServer: true });
  a.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => ws.on('message', (m) => ws.send('pong:' + m)));
  });
  const aPort = await listen(a, '127.0.0.1');
  const A = `http://127.0.0.1:${aPort}`;

  return {
    A,
    B,
    close() {
      a.closeAllConnections?.();
      b.closeAllConnections?.();
      a.close();
      b.close();
    },
  };
}
