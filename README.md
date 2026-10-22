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
| `LOG_LEVEL` | なし | `quiet` にするとターミナルにはページ遷移とエラーだけを出す (既定は全リクエスト) |
| `LOG_FILE` | `./proxy.log` | ログファイルの保存先 |
| `NODE_ENV` | なし | `production` にすると `public/` のファイルをキャッシュする |

> Service Worker を使うため、`https://` か `http://localhost` で開いてください (Codespaces の転送 URL は https なので OK)。

## うまく表示されないとき (ログの見方)

ログは次の3か所で同じ内容を確認できます。

| 場所 | 見方 |
| --- | --- |
| ターミナル | `npm start` を実行したターミナルにそのまま出ます |
| ブラウザ | ホーム画面の「ログを見る」、または `/__px/logs` を開く (1秒ごとに自動更新) |
| ファイル | `proxy.log` (`tail -f proxy.log` で追いかけられます) |

ログの例と読み方:

```
INFO  [ブラウザ] ホーム画面: 「nodejs.org/en」を https://nodejs.org/en として開きます   ← Enter が押された
INFO  [ブラウザ] ホーム画面: Service Worker: 有効
INFO    ↳ 応答 200 text/html; charset=utf-8 [html を書き換え + client.js 挿入]          ← サイトからの応答
INFO  200 GET https://nodejs.org/en (document, 610ms)                                 ← ブラウザへ返した結果
INFO  [ブラウザ] 表示完了: Node.js — Run JavaScript Everywhere / 文字数 1620          ← 画面に中身が出た
```

- **Enter を押しても「ホーム画面: ...を開きます」が出ない** → ホーム画面がプロキシから配信されていません。「ポート」タブの 8080 番の URL から開いてください
- **`接続失敗 ... ENOTFOUND` / `ETIMEDOUT`** → Codespace からそのサイトに接続できていません
- **`WARN 403` / `ERROR 502`** → サイト側に拒否された、または接続エラー。直前の行に理由が出ます
- **`[ブラウザ] JS エラー: ...` / `読み込み失敗: ...`** → ページの JS が動いていません。真っ白になる原因の多くはこれです
- **`画面に何も表示されていません`** → 表示後 2 秒経っても body が空でした。その直前の JS エラーを確認してください

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
