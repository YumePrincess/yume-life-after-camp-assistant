# 部署指南

语言： [English（默认）](DEPLOYMENT.md) · 简体中文 · [繁體中文](DEPLOYMENT.zh-TW.md) ·
[Français](DEPLOYMENT.fr.md) · [日本語](DEPLOYMENT.ja.md)

本指南介绍如何将营地网站和 API 部署到 Cloudflare Workers，并连接可选的 Mac Agent。
请为本次安装创建独立的 D1 数据库和 R2 存储桶；预览环境不要连接其他站点的数据。

## 为什么使用 Workers？可以免费部署吗？

Workers 无需预先配置或维护常驻服务器。网站、API 和静态资源可一同部署，由 Cloudflare
运行边缘代码，并通过绑定连接托管式 D1、R2 和 Durable Objects。首次部署或预览可直接使用
`workers.dev` 地址，无需先配置自定义域名。项目不要求购买 Workers 付费套餐：小型营地在
Workers、D1、Durable Objects 和 R2 的当前免费额度内，可使用 Workers Free 免费部署。免费
额度有限且可能变化；超出额度或启用付费/第三方服务可能产生费用。部署前请查看
[Workers 限额](https://developers.cloudflare.com/workers/platform/limits/)、
[Workers 价格](https://developers.cloudflare.com/workers/platform/pricing/)和
[R2 价格](https://developers.cloudflare.com/r2/pricing/)。

## 1. 准备 Cloudflare

需要 Cloudflare 账号、Node.js 22 或更新版本和终端。在仓库根目录执行：

```sh
cd Workers
npm install
cp wrangler.example.jsonc wrangler.jsonc
```

编辑 `wrangler.jsonc`：

1. 设置唯一的 Worker `name`。临时使用 `workers.dev` 时保留 `workers_dev: true`；自定义域名请等 DNS 区域就绪后再配置。
2. 在 Cloudflare 创建 D1 数据库和 R2 桶，将 D1 ID 与数据库名称填入 `DB`，将 R2 桶名填入 `FILES`。保留 `migrations_dir: "migrations"`。
3. 保留四个 Durable Object 绑定、迁移、静态 Assets 绑定和定时触发器。预览部署不要复用生产资源。

可用 Wrangler 创建资源：

```sh
npx wrangler d1 create yume-camp-assistant
npx wrangler r2 bucket create yume-camp-assistant-files
```

### Wrangler 配置字段清单

| 字段 | 需要配置的内容 |
| --- | --- |
| `name` | 设置唯一 Worker 名称；它是 `workers.dev` 地址的第一部分。 |
| `workers_dev` / `preview_urls` | 使用 `workers.dev` 时保留 `workers_dev: true`、`preview_urls: false`，启用正式 Worker 地址并关闭每个版本的预览地址。 |
| `routes` | 使用 `workers.dev` 时不添加此项。以后使用 Cloudflare DNS 区域中的自定义域名时，再添加域名路由并设为 `custom_domain: true`。 |
| `DB` | 保留 `binding: "DB"`；把 `database_name` 和 `database_id` 改成你创建的 D1 数据库名称与 ID。保留 `migrations_dir: "migrations"`，迁移命令中的数据库名称也要一致。 |
| `FILES` | 保留 `binding: "FILES"`；将 `bucket_name` 改为你创建的 R2 存储桶名称。 |
| `vars.ENVIRONMENT` | 设置环境标签，例如 `production` 或 `preview`；隔离测试部署请使用 `preview`。 |
| `vars.STORAGE_PREFIX` | R2 对象键的前缀。多个安装共用一个桶时，请为每个安装设置不同前缀。 |
| `vars.OIDC_ENABLED` | 仅用 Key 登录时设为 `false`；配置了 OIDC 提供方后设为 `true`。 |
| 其他 `vars.OIDC_*` | 仅在启用 OIDC 时配置：`OIDC_ISSUER`、`OIDC_CLIENT_ID`、`OIDC_REDIRECT_URI`、`OIDC_POST_LOGOUT_REDIRECT_URI`、`OIDC_ALLOWED_SUBJECTS`、`OIDC_SCOPES`、`OIDC_EMAIL_CLAIM`、`OIDC_AUTO_LOGIN`、`OIDC_TOKEN_AUTH_METHOD` 和 `OIDC_SESSION_CHECK_INTERVAL_SECONDS`。回调地址为 `<站点地址>/auth/oidc/callback`；允许列表填写 `sub` 值，不是邮箱。 |
| `secrets` | 将下文列出的秘密值添加为 Wrangler Secret。不要把秘密值写入 `vars` 或提交到仓库。 |
| `assets`、`durable_objects`、`migrations`、`triggers`、`observability` | 默认保留静态资源绑定、4 个 Durable Object 绑定、迁移标记、定时触发器和日志配置；只有有意调整应用架构时才修改。 |

示例配置默认不包含 `routes`，部署后使用 Wrangler 输出的 `workers.dev`
地址。如需添加自定义域名，请在 DNS 区域已就绪后加入如下配置，并替换成自己账户中的域名：

```jsonc
"routes": [{ "pattern": "camp.example.com", "custom_domain": true }]
```

## 2. 配置管理员登录

OIDC 为可选功能。后台可使用 OIDC 或 Key 登录，两种 Key 共用同一登录入口。**仅使用 Key：**

1. 在 `wrangler.jsonc` 中将 `OIDC_ENABLED` 设为 `false`。
2. 将永久管理员 Key 作为 Worker Secret 保存。除非轮换该 Secret，否则 Key 不会过期：

   ```sh
   npx wrangler secret put ADMIN_TEMPORARY_KEY
   ```

3. 为必需的运行时 Secret 分别生成至少 32 字节的随机值：

   ```sh
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put AGENT_SHARED_TOKEN
   ```

`SESSION_SECRET` 用于签名会话及加密服务端秘密信息；部署期间应保持不变，轮换后现有会话和已加密数据会失效。`AGENT_SHARED_TOKEN` 用于验证本机 Agent，必须原样填入 Mac 应用。仅使用 Key 登录时必须配置 `ADMIN_TEMPORARY_KEY`；仅使用 OIDC 时该项可选。只有提供方所选的 Token 认证方式需要客户端秘密时，才配置 `OIDC_CLIENT_SECRET`。

登录后台时，在 Key 输入框中输入 `ADMIN_TEMPORARY_KEY`，与后台创建的 Key 使用同一入口。Wrangler 配置的 Key 永不过期；轮换 Secret 后旧 Key 失效。后台创建的 Key 支持名称、有效期、撤销和按模块授权。

如需 OIDC，将 `OIDC_ENABLED` 设为 `true`，配置提供方 issuer、Client ID、回调地址和退出后地址；若所选 Token 认证方式需要 Client Secret，则通过 `OIDC_CLIENT_SECRET` 保存。`OIDC_ALLOWED_SUBJECTS` 填写允许的 OIDC `sub` 值，多个值用逗号分隔，不是邮箱地址。所有秘密信息必须保存在 Wrangler Secrets 或 Cloudflare 面板中，不要写入 `vars` 或提交到仓库。

## 3. 运行迁移并部署

将所有待执行的 D1 migration 应用到新数据库，然后检查并部署：

```sh
npx wrangler d1 migrations apply yume-camp-assistant --remote --config wrangler.jsonc
npm run check
npm run deploy
```

Wrangler 会打印 Worker 地址。`workers_dev: true` 时地址形式为
`https://<worker-name>.<account-subdomain>.workers.dev`。检查首页和 `/login`，然后用永久 Key 登录 `/admin`。在后台设置营地名称、服务器、时区、公共内容和自动化排程。若需要身份申请/找回邮件，可在后台配置 SMTP。自定义域名和公共 DNS 均为可选。

如需在微信小程序 WebView 中使用，请在微信公众平台将部署后的 HTTPS 主机名加入 request 和 web-view 合法域名。

## 4. 安装 Mac Agent

Agent 需要 Apple 芯片 Mac、macOS 26 或更新版本、中国大陆版 MuMu Android 模拟器、《明日之后》中国大陆服务器客户端和 Android platform-tools。自动化流程针对这些中国大陆版本设计；海外版本的游戏或模拟器可能有不同界面和流程，使用者需自行修改相关源代码。请从 MuMu 自带的应用商店下载《明日之后》，并在游戏设置中将默认的释放鼠标按键 `~` 改为 `=`；Agent 使用 `=`。Agent 连接 MuMu 本机回环 ADB 端口；不要将 ADB 暴露到公网。

在中国大陆直连网络环境下，可选本地视觉模型可能无法完成下载；如需使用，请自行解决网络访问或模型文件获取问题。

自动化 Agent 目前仅支持 macOS 26 及更新版本的 Apple 芯片 Mac。我们可能不会为 Windows 或其他平台开发额外 Agent。

本项目开源版本的 Agent 自动化游戏操作功能截至 2026 年 11 月 22 日已测试通过。未来《明日之后》更新可能改变键位、操作流程或操作位置；项目方可能不会因此提供修复或版本更新。

### 使用原生应用

在 `MacApp/` 构建应用，或安装发布版 `.dmg`：

```sh
cd MacApp
./scripts/build-app.sh
```

首次打开时完成设置向导：

1. **Workers 地址：**粘贴 Wrangler 部署后输出的完整 HTTPS 地址，例如 `https://<worker>.<account-subdomain>.workers.dev`。不要添加 `/admin`。
2. **Agent 设备名称：**设置便于识别的名称；有多台 Mac 时分别使用不同名称。
3. **MuMu 容器名称：**填写 MuMu 中显示的准确容器名称。Agent 会按名称定位容器并自动发现其本机回环 ADB 端口。
4. **Agent Token：**填写 Worker Secret `AGENT_SHARED_TOKEN` 的相同值。
5. **本机调试 Token：**为 Agent 的本机控制 API 填写一个独立随机 Token，不要复用 Worker Token；该值仅保存在此 Mac。
6. **管理页面访问 Key（可选）：**如需让应用内的管理页面直接使用 Key，填写 `ADMIN_TEMPORARY_KEY` 或后台创建的 Key。留空后仍可在管理页面打开时手动登录。
7. 设备 ID 由应用自动生成，不需要修改；显示的时区跟随 Workers 后台的营地时区。检查信息后选择“保存、安装并完成”，应用会写入本机配置和凭据、注册后台 LaunchAgent 并检查运行状态。

完成后可查看日志、启动或停止 Agent、运行可用任务、管理插件、修复安装并打开网页管理后台。Agent 上线后不会自行执行游戏任务；请在管理后台按需配置并启用任务。

### 使用命令行安装

在 `Mac/` 根据 `config.example.json` 创建本机配置，填入服务器地址和相同的 `AGENT_SHARED_TOKEN`，然后安装并检查：

```sh
cd Mac
cp config.example.json config.json
./scripts/manage-local-agent.sh install
./scripts/manage-local-agent.sh status
```

请妥善保护 `config.json`。本地模型、模拟器配置、故障排查和任务校准见
[`Mac/README.md`](../Mac/README.md) 与 [`MacApp/README.md`](../MacApp/README.md)。

## 5. 开始运营

全新安装时，所有自动定时任务默认关闭。请先检查模拟器配置、排程和营地数据，再逐项启用所需任务。

1. 更新真实公告和营地群说明；邀请成员前替换示例二维码图片。
2. 配置身份识别码申请条件和管理员审批流程。
3. 设置科技投票时段、投票资格、日常投票/抽签和固定科技规则。目前科技投票目录并不完整，因为我们的营地尚未解锁所有科技；如需缺少的选项，请自行在源码中补充，我们不承诺后续版本会补齐目录。
4. 选择启用的 Agent 设备，只开启营地已准备好使用的自动化任务。先手工运行并检查结果，再依赖定时任务。
5. 在后台查看任务历史、成员/贡献快照、预警和聊天设置。

本项目不托管游戏账号，也不提供踢出成员功能。完整功能目录、许可证和第三方素材说明见根目录 [README](../README.md)。
