# js-proxy-codespace

JavaScript を使うサイトもそのまま動かせる Web プロキシです (Node.js 製、ビルド不要)。

## 使い方

### GitHub Codespaces

1. このリポジトリで Codespace を作成 (依存パッケージは自動でインストールされます)
2. ターミナルで `npm start`
3. 「ポート」タブの 8080 を開き、URL か検索ワードを入力

### ローカル

```sh
npm install
npm start          # http://localhost:8080
```

| 環境変数 | 既定値 | 説明 |
| --- | --- | --- |
| `PORT` | `8080` | 待ち受けポート |
| `HOST` | `0.0.0.0` | 待ち受けアドレス |
| `ALLOW_PRIVATE` | なし | `1` にすると localhost や LAN 内のアドレスへの接続を許可 (既定はブロック) |
| `UPSTREAM_PROXY` | なし | `http://host:port` を指定すると、さらに上流の HTTP プロキシ経由で接続 (社内プロキシなど) |
| `NODE_ENV` | なし | `production` にすると `public/` のファイルをキャッシュする |

> Service Worker を使うため、`https://` か `http://localhost` で開いてください (Codespaces の転送 URL は https なので OK)。

## うまく表示されないとき

1. **ターミナル**: `npm start` を実行したターミナルに、開いたページごとに `200 GET https://... (123ms)` のようなログが出ます。何も出ていなければリクエストがプロキシに届いていません
2. **ホーム画面の赤いメッセージ**: サーバーにつながらない場合はホーム画面に表示されます。VS Code のプレビューや `index.html` の直接表示ではなく、「ポート」タブの 8080 番の URL から開いてください
3. **ブラウザの開発者ツール** (F12) の Console / Network タブのエラー

## 仕組み

プロキシ URL は `/p/<元のURL>` 形式です (例: `/p/https://example.com/news`)。
パスに元の URL をそのまま入れているので、ページ内の相対リンクはブラウザが自然に解決できます。

| 層 | ファイル | 役割 |
| --- | --- | --- |
| サーバー | `src/server.js` | リクエスト中継、リダイレクト・Cookie・WebSocket の中継、CSP / X-Frame-Options 等の除去、文字コード変換 (Shift_JIS 等 → UTF-8) |
| | `src/html.js` `src/css.js` | HTML 属性・CSS の URL 書き換え、`client.js` の挿入 |
| | `src/js.js` | JS を構文解析し `location` 参照をラッパー経由に書き換え (`window.location` はブラウザ側で上書きできないため) |
| | `src/cookies.js` | Cookie の Path を `/p/<サイト>/` にずらしてサイトごとに分離 |
| | `src/net.js` | 内部ネットワークへのアクセス防止 (SSRF 対策) |
| ブラウザ | `public/client.js` | `fetch` / XHR / WebSocket / `location` / DOM 属性 / `document.cookie` / `history` / `postMessage` 等をフック |
| | `public/sw.js` | フックをすり抜けたリクエストを Service Worker で拾って `/p/` に振り向ける |

## テスト

```sh
npm test           # 書き換え処理の単体テスト
npm run test:e2e   # Chromium で実際にページを開く E2E テスト (Playwright のブラウザが必要)
```

E2E は手元で 2 つのテスト用サイト (別オリジン) を立て、リンク遷移・`location` 書き換え・fetch/XHR・WebSocket・Cookie・リダイレクト・フォーム POST・Shift_JIS などを確認します。
Chromium の場所を指定したい場合は `CHROMIUM_PATH=/path/to/chrome npm run test:e2e`。

## 既知の制限

- **Google / YouTube / X などの大手サイトのログイン**は、ボット検知や複雑な認証フローのため動かないことがあります
- `Domain=.example.com` の Cookie はサブドメイン間 (`www.` と `accounts.` など) で共有されません
- `eval` / `new Function` で実行されるコード内の `location` は書き換えられません
- Navigation API に対応していないブラウザでは、まれに `location` 経由の遷移がプロキシの外に出ることがあります
- 公開しているポートでは誰でも使えるプロキシになります。Codespaces のポートは「Private」のままにしてください
