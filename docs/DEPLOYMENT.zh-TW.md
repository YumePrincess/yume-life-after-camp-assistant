# 部署指南

語言： [English（預設）](DEPLOYMENT.md) · [简体中文](DEPLOYMENT.zh-CN.md) · 繁體中文 ·
[Français](DEPLOYMENT.fr.md) · [日本語](DEPLOYMENT.ja.md)

本指南說明如何將營地網站與 API 部署至 Cloudflare Workers，並連接選用的 Mac Agent。
請為此安裝建立獨立的 D1 資料庫與 R2 儲存桶；預覽環境不要連接其他站點的資料。

## 為什麼使用 Workers？可以免費部署嗎？

Workers 不必預先配置或維護常駐伺服器。網站、API 與靜態資源可一併部署，由 Cloudflare
執行邊緣程式碼，並透過綁定連接託管式 D1、R2 與 Durable Objects。首次部署或預覽可直接使用
`workers.dev` 網址，不必先設定自訂網域。專案不要求購買 Workers 付費方案：小型營地在
Workers、D1、Durable Objects 與 R2 的目前免費額度內，可使用 Workers Free 免費部署。免費
額度有限且可能變更；超出額度或啟用付費/第三方服務可能產生費用。部署前請查看
[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、
[Workers 價格](https://developers.cloudflare.com/workers/platform/pricing/)與
[R2 價格](https://developers.cloudflare.com/r2/pricing/)。

## 1. 準備 Cloudflare

需要 Cloudflare 帳號、Node.js 22 或更新版本及終端機。在儲存庫根目錄執行：

```sh
cd Workers
npm install
cp wrangler.example.jsonc wrangler.jsonc
```

編輯 `wrangler.jsonc`：

1. 設定唯一的 Worker `name`。暫時使用 `workers.dev` 時保留 `workers_dev: true`；自訂網域請等 DNS 區域就緒後再設定。
2. 在 Cloudflare 建立 D1 資料庫和 R2 儲存桶，將 D1 ID 與資料庫名稱填入 `DB`，將 R2 桶名稱填入 `FILES`。保留 `migrations_dir: "migrations"`。
3. 保留四個 Durable Object 綁定、遷移、靜態 Assets 綁定和排程觸發器。預覽部署不要重用正式環境資源。

可使用 Wrangler 建立資源：

```sh
npx wrangler d1 create yume-camp-assistant
npx wrangler r2 bucket create yume-camp-assistant-files
```

### Wrangler 設定欄位清單

| 欄位 | 需要設定的內容 |
| --- | --- |
| `name` | 設定唯一 Worker 名稱；它是 `workers.dev` 網址的第一部分。 |
| `workers_dev` / `preview_urls` | 使用 `workers.dev` 時保留 `workers_dev: true`、`preview_urls: false`，啟用正式 Worker 網址並關閉每個版本的預覽網址。 |
| `routes` | 使用 `workers.dev` 時不要加入此項。日後使用 Cloudflare DNS 區域中的自訂網域時，再加入網域路由並設為 `custom_domain: true`。 |
| `DB` | 保留 `binding: "DB"`；將 `database_name` 和 `database_id` 改為建立的 D1 資料庫名稱及 ID。保留 `migrations_dir: "migrations"`，遷移指令中的資料庫名稱也要一致。 |
| `FILES` | 保留 `binding: "FILES"`；將 `bucket_name` 改為建立的 R2 儲存桶名稱。 |
| `vars.ENVIRONMENT` | 設定環境標籤，例如 `production` 或 `preview`；隔離測試部署請使用 `preview`。 |
| `vars.STORAGE_PREFIX` | R2 物件鍵的前綴。多個安裝共用一個儲存桶時，請為每個安裝設定不同前綴。 |
| `vars.OIDC_ENABLED` | 僅用 Key 登入時設為 `false`；設定 OIDC 提供者後設為 `true`。 |
| 其他 `vars.OIDC_*` | 僅在啟用 OIDC 時設定：`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_REDIRECT_URI`、`OIDC_POST_LOGOUT_REDIRECT_URI`、`OIDC_ALLOWED_SUBJECTS`、`OIDC_SCOPES`、`OIDC_EMAIL_CLAIM`、`OIDC_AUTO_LOGIN`、`OIDC_TOKEN_AUTH_METHOD` 和 `OIDC_SESSION_CHECK_INTERVAL_SECONDS`。回呼網址為 `<站點網址>/auth/oidc/callback`；允許清單填 `sub` 值，不是電子郵件。 |
| `secrets` | 將下文列出的秘密值加入 Wrangler Secret。不要把秘密值寫入 `vars` 或提交至儲存庫。 |
| `assets`、`durable_objects`、`migrations`、`triggers`、`observability` | 預設保留靜態資源綁定、4 個 Durable Object 綁定、遷移標記、排程觸發器和記錄設定；只有刻意調整應用架構時才修改。 |

範例設定預設不含 `routes`，部署後使用 Wrangler 輸出的 `workers.dev`
網址。若要加入自訂網域，請等 DNS 區域就緒後加入下列設定，並替換為自己帳戶中的網域：

```jsonc
"routes": [{ "pattern": "camp.example.com", "custom_domain": true }]
```

## 2. 設定管理員登入

OIDC 為選用功能。後台可用 OIDC 或 Key 登入，兩種 Key 共用同一登入入口。**僅使用 Key：**

1. 在 `wrangler.jsonc` 將 `OIDC_ENABLED` 設為 `false`。
2. 將永久管理員 Key 儲存為 Worker Secret。除非輪替該 Secret，否則 Key 不會過期：

   ```sh
   npx wrangler secret put ADMIN_TEMPORARY_KEY
   ```

3. 分別為必要執行期 Secret 產生至少 32 位元組的隨機值：

   ```sh
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put AGENT_SHARED_TOKEN
   ```

`SESSION_SECRET` 用於簽署工作階段及加密伺服器秘密資訊；部署期間應保持不變，輪替後現有工作階段與已加密資料會失效。`AGENT_SHARED_TOKEN` 用於驗證本機 Agent，必須原樣填入 Mac 應用程式。僅使用 Key 登入時必須設定 `ADMIN_TEMPORARY_KEY`；僅使用 OIDC 時此項可選。只有提供者所選的 Token 驗證方式需要用戶端秘密時，才設定 `OIDC_CLIENT_SECRET`。

登入後台時，在 Key 欄位輸入 `ADMIN_TEMPORARY_KEY`，與後台建立的 Key 使用同一入口。Wrangler 設定的 Key 永不過期；輪替 Secret 後舊 Key 失效。後台建立的 Key 支援名稱、期限、撤銷及模組權限。

若要使用 OIDC，將 `OIDC_ENABLED` 設為 `true`，設定提供者 issuer、Client ID、回呼網址及登出後網址；若 Token 驗證方式需要 Client Secret，請透過 `OIDC_CLIENT_SECRET` 儲存。`OIDC_ALLOWED_SUBJECTS` 填入允許的 OIDC `sub` 值，多個值以逗號分隔，不是電子郵件。所有秘密資料都應存於 Wrangler Secrets 或 Cloudflare 後台，不要寫入 `vars` 或提交至儲存庫。

## 3. 套用遷移並部署

將所有待處理的 D1 migration 套用至新資料庫，接著檢查並部署：

```sh
npx wrangler d1 migrations apply yume-camp-assistant --remote --config wrangler.jsonc
npm run check
npm run deploy
```

Wrangler 會列出 Worker 網址。`workers_dev: true` 時，格式為
`https://<worker-name>.<account-subdomain>.workers.dev`。檢查首頁與 `/login`，再使用永久 Key 登入 `/admin`。在後台設定營地名稱、伺服器、時區、公開內容及自動化排程。需要身份申請/找回郵件時，可在後台設定 SMTP。自訂網域及公開 DNS 為選用項目。

若要在微信小程式 WebView 使用，請在微信公眾平台將部署後的 HTTPS 主機名稱加入 request 和 web-view 合法網域。

## 4. 安裝 Mac Agent

Agent 需要 Apple 晶片 Mac、macOS 26 或更新版本、中國大陸版 MuMu Android 模擬器、《明日之後》中國大陸伺服器用戶端和 Android platform-tools。自動化流程是針對這些中國大陸版本設計；海外版本的遊戲或模擬器可能有不同介面和流程，使用者需自行修改相關原始碼。請從 MuMu 內建的應用程式商店下載《明日之後》，並在遊戲設定中將預設的釋放滑鼠按鍵 `~` 改為 `=`；Agent 使用 `=`。Agent 透過本機迴路 ADB 埠連接 MuMu；不要將 ADB 暴露至公網。

在中國大陸直連網路環境下，選用的本機視覺模型可能無法完成下載；如需使用，請自行處理網路連線或模型檔案取得問題。

自動化 Agent 目前僅支援 macOS 26 及更新版本的 Apple 晶片 Mac。我們可能不會為 Windows 或其他平台開發額外 Agent。

本專案開源版本的 Agent 自動化遊戲操作功能截至 2026 年 11 月 22 日已測試通過。未來《明日之後》更新可能改變按鍵、操作流程或操作位置；專案方可能不會因此提供修復或版本更新。

### 使用原生應用程式

在 `MacApp/` 建置應用程式，或安裝發布版 `.dmg`：

```sh
cd MacApp
./scripts/build-app.sh
```

首次開啟時完成設定輔助程式：

1. **Workers 網址：**貼上 Wrangler 部署後輸出的完整 HTTPS 網址，例如 `https://<worker>.<account-subdomain>.workers.dev`。不要加上 `/admin`。
2. **Agent 裝置名稱：**設定容易辨識的名稱；多台 Mac 請分別使用不同名稱。
3. **MuMu 容器名稱：**輸入 MuMu 中顯示的正確容器名稱。Agent 會依名稱定位容器並自動探索其本機迴路 ADB 埠。
4. **Agent Token：**輸入 Worker Secret `AGENT_SHARED_TOKEN` 的相同值。
5. **本機除錯 Token：**為 Agent 本機控制 API 輸入獨立隨機 Token，不要重用 Worker Token；此值僅保存在這台 Mac。
6. **管理頁面存取 Key（選用）：**若要讓應用程式內的管理頁面直接使用 Key，請輸入 `ADMIN_TEMPORARY_KEY` 或後台建立的 Key。留空仍可在開啟管理頁面時手動登入。
7. 裝置 ID 由應用程式自動產生，不必修改；顯示的時區會跟隨 Workers 後台的營地時區。檢查資料後選擇「儲存、安裝並完成」，應用程式會寫入本機設定與憑據、註冊背景 LaunchAgent 並檢查狀態。

完成後可查看記錄、啟動或停止 Agent、執行可用任務、管理外掛、修復安裝及開啟網頁管理後台。Agent 上線後不會自行執行遊戲任務；請在管理後台按需設定並啟用任務。

### 透過命令列安裝

在 `Mac/` 根據 `config.example.json` 建立本機設定，填入伺服器網址和相同的 `AGENT_SHARED_TOKEN`，然後安裝及檢查：

```sh
cd Mac
cp config.example.json config.json
./scripts/manage-local-agent.sh install
./scripts/manage-local-agent.sh status
```

請妥善保護 `config.json`。本機模型、模擬器設定、疑難排解和任務校準請參閱
[`Mac/README.md`](../Mac/README.md) 與 [`MacApp/README.md`](../MacApp/README.md)。

## 5. 開始營運

全新安裝時，所有自動排程任務預設關閉。請先檢查模擬器設定、排程和營地資料，再逐項啟用所需任務。

1. 更新實際公告與營地群說明；邀請成員前請替換示範 QR Code 圖片。
2. 設定身份識別碼申請條件和管理員審核流程。
3. 設定科技投票時段、投票資格、日常投票/抽籤和固定科技規則。目前科技投票目錄尚未完整，因為我們的營地尚未解鎖所有科技；如需缺少的選項，請自行在原始碼中補充，我們不承諾後續版本會補齊目錄。
4. 選擇啟用的 Agent 裝置，只啟用營地已準備好的自動化任務。先手動執行並檢查結果，再依賴排程。
5. 在後台檢查任務歷史、成員/貢獻快照、預警和聊天設定。

本專案不託管遊戲帳號，也不提供踢除成員功能。完整功能目錄、授權和第三方素材說明請參閱根目錄 [README](../README.md)。
