# デプロイガイド

言語： [English（既定）](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) ·
[繁體中文](DEPLOYMENT.zh-TW.md) · [Français](DEPLOYMENT.fr.md) · 日本語

このガイドでは、キャンプサイト/API を Cloudflare Workers にデプロイし、任意のローカル Mac Agent を接続する方法を説明します。このインストール用に専用の D1 データベースと R2 バケットを作成し、プレビューを他サイトのデータに接続しないでください。

## Workers を使う理由と無料デプロイ

Workers では常時稼働サーバーの用意や保守が不要です。サイト、API、静的ファイルをまとめて
デプロイし、Cloudflare がエッジランタイムを運用します。D1、R2、Durable Objects はバインディング
から利用できます。`workers.dev` を使えば独自ドメインを設定する前に初回デプロイやプレビューを
公開できます。有料の Workers プランは必須ではありません。小規模なキャンプなら、Workers、D1、
Durable Objects、R2 の現在の無料枠内で Workers Free を利用できます。無料枠には上限があり、
変更される場合があります。上限超過や有料機能、外部サービスには費用がかかることがあります。
事前に[Workers の制限](https://developers.cloudflare.com/workers/platform/limits/)、
[Workers の料金](https://developers.cloudflare.com/workers/platform/pricing/)、
[R2 の料金](https://developers.cloudflare.com/r2/pricing/)をご確認ください。

## 1. Cloudflare の準備

Cloudflare アカウント、Node.js 22 以降、ターミナルが必要です。リポジトリのルートから実行します。

```sh
cd Workers
npm install
cp wrangler.example.jsonc wrangler.jsonc
```

`wrangler.jsonc` を編集します。

1. 一意の Worker `name` を指定します。一時的な `workers.dev` URL を使う場合は `workers_dev: true` を維持します。カスタムドメインは DNS ゾーンの準備後に追加してください。
2. Cloudflare で D1 データベースと R2 バケットを作成します。D1 ID とデータベース名を `DB` に、R2 バケット名を `FILES` に設定し、`migrations_dir: "migrations"` を維持します。
3. 4 つの Durable Object バインディング、マイグレーション、静的 Assets バインディング、スケジュールトリガーを残します。プレビューに本番リソースを使用しないでください。

Wrangler でリソースを作成できます。

```sh
npx wrangler d1 create yume-camp-assistant
npx wrangler r2 bucket create yume-camp-assistant-files
```

### Wrangler の設定項目

| 項目 | 設定内容 |
| --- | --- |
| `name` | 一意の Worker 名を設定します。`workers.dev` URL の先頭部分になります。 |
| `workers_dev` / `preview_urls` | `workers.dev` を使う場合は `workers_dev: true` と `preview_urls: false` を維持します。 |
| `routes` | `workers.dev` だけを使う場合は追加しません。Cloudflare DNS のカスタムドメインを使う場合に、後から `custom_domain: true` の route を追加します。 |
| `DB` | `binding: "DB"` は維持し、作成した D1 の `database_name` と `database_id` を入力します。`migrations_dir: "migrations"` は維持し、migration コマンドにも同じ DB 名を指定します。 |
| `FILES` | `binding: "FILES"` は維持し、作成した R2 バケット名を `bucket_name` に設定します。 |
| `vars.ENVIRONMENT` | `production` または `preview` を設定します。分離したテスト環境には `preview` を使います。 |
| `vars.STORAGE_PREFIX` | R2 オブジェクトキーの接頭辞です。複数のインストールで同じバケットを使う場合、各環境に異なる値を設定します。 |
| `vars.OIDC_ENABLED` | Key のみでログインする場合は `false`、OIDC を設定した場合は `true` にします。 |
| その他の `vars.OIDC_*` | OIDC を使う場合のみ設定します：`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_REDIRECT_URI`、`OIDC_POST_LOGOUT_REDIRECT_URI`、`OIDC_ALLOWED_SUBJECTS`、`OIDC_SCOPES`、`OIDC_EMAIL_CLAIM`、`OIDC_AUTO_LOGIN`、`OIDC_TOKEN_AUTH_METHOD`、`OIDC_SESSION_CHECK_INTERVAL_SECONDS`。コールバック URL は `<サイト URL>/auth/oidc/callback` です。許可リストにはメールではなく `sub` を指定します。 |
| `secrets` | 下記の秘密値を Wrangler Secret として登録します。値を `vars` やコミット対象ファイルに保存しないでください。 |
| `assets`、`durable_objects`、`migrations`、`triggers`、`observability` | 提供された静的 Assets、4 つの Durable Object、migration tag、スケジュール trigger、ログ設定を維持します。アーキテクチャを変更する場合のみ編集します。 |

サンプル設定には `routes` がなく、通常のデプロイでは Wrangler が表示する
`workers.dev` URL を使います。カスタムドメインを追加する場合は DNS を準備してから、
自分のドメインに置き換えて次の設定を追加します。

```jsonc
"routes": [{ "pattern": "camp.example.com", "custom_domain": true }]
```

## 2. 管理者認証の設定

OIDC は任意です。管理画面では OIDC または Key を利用でき、Key は同じログイン欄で使用します。**Key のみを使う場合：**

1. `wrangler.jsonc` の `OIDC_ENABLED` を `false` にします。
2. 永続管理 Key を Worker Secret として設定します。この Secret をローテーションするまで有効です。

   ```sh
   npx wrangler secret put ADMIN_TEMPORARY_KEY
   ```

3. 必須のランタイム Secret ごとに 32 バイト以上の独立したランダム値を設定します。

   ```sh
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put AGENT_SHARED_TOKEN
   ```

`SESSION_SECRET` はセッション署名とサーバー側の秘密情報の暗号化に使います。セッションや暗号化データが無効になるため、デプロイ間で値を維持してください。`AGENT_SHARED_TOKEN` はローカル Agent の認証用で、Mac アプリに同じ値を入力します。Key のみでログインする場合は `ADMIN_TEMPORARY_KEY` が必要です。OIDC のみの場合は省略できます。`OIDC_CLIENT_SECRET` はプロバイダーの Token 認証方式が必要とする場合にだけ設定します。

ログイン画面の Key 欄には `ADMIN_TEMPORARY_KEY` を入力します。Wrangler の管理 Key は期限切れにならず、Secret をローテーションすると無効になります。管理画面で作成する Key には名前、有効期限、失効設定、モジュール別権限を設定できます。

OIDC を使う場合は `OIDC_ENABLED` を `true` にし、プロバイダーの issuer、Client ID、コールバック URL、ログアウト後 URL を設定します。トークン認証方式が必要とする場合は Client Secret を `OIDC_CLIENT_SECRET` に保存します。`OIDC_ALLOWED_SUBJECTS` には許可する OIDC `sub` 値をカンマ区切りで指定します。メールアドレスではありません。すべての Secret は Wrangler Secrets または Cloudflare ダッシュボードに保存し、`vars` やコミット対象ファイルに入れないでください。

## 3. マイグレーションとデプロイ

新しい D1 データベースに未適用の migration をすべて適用し、チェックしてデプロイします。

```sh
npx wrangler d1 migrations apply yume-camp-assistant --remote --config wrangler.jsonc
npm run check
npm run deploy
```

Wrangler が Worker URL を表示します。`workers_dev: true` の URL は
`https://<worker-name>.<account-subdomain>.workers.dev` の形式です。ホームと `/login` を確認し、永続 Key で `/admin` にログインします。管理画面でキャンプ名、サーバー、タイムゾーン、公開情報、スケジュールを設定します。ID の申請や復旧メールが必要な場合は管理画面で SMTP を設定します。カスタムドメインと公開 DNS は任意です。

WeChat ミニプログラムの WebView で使う場合は、デプロイした HTTPS ホスト名を WeChat プラットフォームの request と web-view の許可リストに追加します。

## 4. Mac Agent のインストール

Agent は Apple Silicon Mac、macOS 26 以降、中国大陸版 MuMu Android エミュレーター、《明日之后》中国大陸サーバー版クライアント、Android platform-tools を必要とします。自動化ワークフローはこれら中国大陸版を対象にしています。海外版のゲーム/エミュレーターでは画面や手順が異なる場合があるため、利用者自身で該当するソースコードを変更してください。MuMu のローカル loopback ADB ポートを使い、ADB をインターネットに公開しないでください。LifeAfter は MuMu 内蔵のアプリストアからダウンロードしてください。ゲーム内設定で、既定のマウス解放キー `~` を `=` に変更してください。Agent は `=` を使用します。

中国大陸の直接接続ネットワークでは、任意のローカルビジョンモデルをダウンロードできない場合があります。利用する場合は、ネットワーク接続またはモデルファイルの取得を各自で解決してください。

自動化 Agent の対応環境は現在、macOS 26 以降の Apple Silicon Mac のみです。Windows やその他のプラットフォーム向け Agent は開発しない場合があります。

オープンソース版 Agent のゲーム自動化機能は、2026 年 11 月 22 日時点でテストに合格しています。その後の LifeAfter の更新でキー割り当て、操作手順、操作位置が変わる場合があります。本プロジェクトは、そうした変更に対する修正や更新版を提供しない可能性があります。

### ネイティブアプリを使う

`MacApp/` でアプリをビルドするか、リリース `.dmg` をインストールします。

```sh
cd MacApp
./scripts/build-app.sh
```

初回起動時はセットアップアシスタントに従います。

1. **Workers URL：** Wrangler が表示した HTTPS URL をそのまま貼り付けます。例：`https://<worker>.<account-subdomain>.workers.dev`。`/admin` は追加しません。
2. **Agent device name：** 識別しやすい名前を設定します。複数の Mac では異なる名前を使います。
3. **MuMu container name：** MuMu に表示されるコンテナ名を正確に入力します。Agent は名前で対象を特定し、本機 loopback ADB ポートを自動検出します。
4. **Agent token：** Worker Secret `AGENT_SHARED_TOKEN` と同じ値を入力します。
5. **Local debug token：** Agent のローカル制御 API 用に別のランダム Token を設定します。Worker Token は再利用せず、この Mac に保存します。
6. **Admin access Key（任意）：** アプリ内管理画面で Key を使う場合は `ADMIN_TEMPORARY_KEY` または管理画面で作成した Key を入力します。空欄でも、管理画面を開いた後に手動ログインできます。
7. デバイス ID はアプリが自動生成するため変更不要です。表示されるタイムゾーンは Workers のキャンプ設定に従います。設定を確認して **Save, Install and Finish** を選ぶと、アプリがローカル設定と認証情報を保存し、LaunchAgent を登録して状態を確認します。

以降はアプリでログを確認し、Agent やタスクの開始/停止、プラグイン管理、修復、Web 管理画面への移動を行えます。Agent がオンラインになっただけではゲームタスクは実行されません。必要なタスクのみ管理画面で設定・有効化してください。

### コマンドラインでインストール

`Mac/` で `config.example.json` をコピーし、サーバー URL と同じ `AGENT_SHARED_TOKEN` を設定してからインストール/確認します。

```sh
cd Mac
cp config.example.json config.json
./scripts/manage-local-agent.sh install
./scripts/manage-local-agent.sh status
```

`config.json` は適切に保護してください。ローカルモデル、エミュレーター設定、トラブルシューティング、タスク校正については [`Mac/README.md`](../Mac/README.md) と [`MacApp/README.md`](../MacApp/README.md) を参照してください。

## 5. キャンプの運用

新規インストール時は、すべての自動スケジュールタスクが無効です。エミュレーター設定、実行時刻、キャンプデータを確認してから、必要なタスクだけを個別に有効にしてください。

1. 実際のお知らせとグループ案内を登録し、メンバーを招待する前にサンプル QR コード画像を差し替えます。
2. ID 申請条件と管理者の審査手順を設定します。
3. テクノロジー投票時間、参加資格、日常投票/抽選、固定テクノロジーを設定します。現在の投票カタログは、私たちのキャンプで未解放の技術があるため不完全です。不足する項目は利用者自身でソースコードに追加してください。今後のリリースで全項目を補完することは約束できません。
4. Agent デバイスを 1 台選び、準備できた自動化のみ有効にします。まず手動実行で結果を確認してからスケジュールに依存してください。
5. 管理画面でタスク履歴、メンバー/貢献スナップショット、警告、チャット設定を確認します。

ゲームアカウントのホスティングやメンバー追放機能はありません。全機能、ライセンス、第三者素材についてはルートの [README](../README.md) を参照してください。
