FALSE FRONT — ソースコード一式(フラット構成)

GitHubにそのままアップロードできるよう、フォルダを使わず全ファイルを同じ階層に置いています。

動作環境
- Node.js 22.18以上(推奨 24)
- npm または pnpm

セットアップ
1. `npm install`
2. ソロ作戦: `npm run dev` で起動(http://localhost:5173)
3. 2人協力プレイ: 別ターミナルで `PORT=8080 npm run server` を起動してから `npm run dev`
   (開発時は /api が自動で localhost:8080 に転送されます。変更する場合は API_PORT を指定)
4. 本番ビルド: `npm run build`(出力は dist/)。協力プレイを本番で使う場合は /api をAPIサーバーへ転送するリバースプロキシが必要です。
5. テスト: `npm test` / 型チェック: `npm run typecheck`

ファイル構成
- フロント: index.html, main.tsx, App.tsx, index.css, home.tsx(タイトル), room.tsx(ロビー), game.tsx(戦術画面), not-found.tsx
- ゲームエンジン: engine.ts(サーバーとも共用)
- UI部品: toast.tsx, toaster.tsx, tooltip.tsx, card.tsx, error-boundary.tsx, use-toast.ts, utils.ts
- APIクライアント: api-client.ts(通信処理・型・フック)
- APIサーバー: server.ts(起動), app.ts, logger.ts, rooms.ts(ルーム管理), routes-*.ts, api-zod.ts(入力検証)
- API仕様: openapi.yaml(参考。api-client.ts と api-zod.ts はここから生成されたものです)
- テスト: engine.test.mjs, match.test.mjs, rooms.test.mjs
- 変更履歴: CHANGES-第1回.md, CHANGES-第2回.md

注意
- オンラインルームはAPIサーバーのメモリ上に保持され、サーバー再起動で消えます。サーバーは1インスタンスで動かしてください。
- データベースは不要です。環境変数の値や認証情報は含まれていません。
- Replit用設定(.replit など)、未使用のUI部品、モックアップ用サンドボックス、pnpm-lock.yaml は含めていません。
