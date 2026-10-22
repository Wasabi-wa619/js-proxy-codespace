'use strict';

const SEARCH_URL = 'https://duckduckgo.com/html/?q=';

const form = document.getElementById('go');
const input = document.getElementById('url');
const status = document.getElementById('status');

function toUrl(text) {
  const s = text.trim();
  if (/^https?:\/\//i.test(s)) return s;
  // スペースを含まず "." を含むならドメインとみなす
  if (!/\s/.test(s) && /^[^/]+\.[a-z]{2,}(?::\d+)?(\/.*)?$/i.test(s)) return 'https://' + s;
  return SEARCH_URL + encodeURIComponent(s);
}

// SW が有効になってから移動すると、最初のページから取りこぼしなく中継できる
const swReady = (async () => {
  if (!('serviceWorker' in navigator)) {
    status.textContent = 'Service Worker が使えない環境です (https か localhost で開いてください)。一部のサイトは正しく動きません。';
    return;
  }
  try {
    await navigator.serviceWorker.register('/__px/sw.js', { scope: '/' });
    await navigator.serviceWorker.ready;
  } catch (e) {
    status.textContent = 'Service Worker の登録に失敗しました: ' + e.message;
  }
})();

async function go(text) {
  const url = toUrl(text);
  status.textContent = '読み込み中…';
  await Promise.race([swReady, new Promise((r) => setTimeout(r, 3000))]);
  location.href = '/p/' + url;
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  go(input.value);
});

document.querySelectorAll('[data-url]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    go(a.dataset.url);
  });
});
