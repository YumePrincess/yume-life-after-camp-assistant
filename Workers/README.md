# Workers：Cloudflare Worker + Assets + D1

## 准备

1. 在 `account.example.com` 的 OIDC 服务注册客户端：
   - Redirect URI：`https://lifeafter.example.com/auth/oidc/callback`
   - Post logout URI：`https://lifeafter.example.com/`
   - Scope：`openid email profile`
   - 将 `OIDC_ALLOWED_SUBJECTS` 配置为允许登录的 OIDC `sub` 值（多个值用逗号分隔）。
2. 安装依赖：`npm install`
3. 创建 D1：

   ```sh
   npx wrangler d1 create yume-camp-assistant
   ```

4. 复制 `wrangler.example.jsonc` 为 `wrangler.jsonc`，填入 D1
   `database_id` 和 OIDC Client ID。
5. 配置 secrets：

   ```sh
   # 启用 OIDC 且使用 client_secret_post/basic 时设置
   npx wrangler secret put OIDC_CLIENT_SECRET

   # 必需的运行时 secrets
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put AGENT_SHARED_TOKEN

   # 如需关闭 OIDC，以管理员临时 Key 登录
   npx wrangler secret put ADMIN_TEMPORARY_KEY
   ```

   `OIDC_ENABLED` 在 `wrangler.jsonc` 中控制 OIDC 开关。启用时，使用 `OIDC_CLIENT_SECRET`
   并将 `OIDC_ALLOWED_SUBJECTS` 设为提供方返回的精确 `sub` 值；示例配置中的
   `REPLACE_WITH_OIDC_SUB` 必须替换。禁用时设置 `OIDC_ENABLED` 为 `false`，再将至少
   32 位随机值保存为 Wrangler Secret `ADMIN_TEMPORARY_KEY`。Wrangler 管理 Key 与后台生成的
   Key 共用登录页的 Key 输入框，OIDC 开启时也可用该输入框登录；配置的管理 Key 不过期，只有轮换该 Secret 后才会失效，
   登录会话有效 7 天。`SESSION_SECRET` 与 `AGENT_SHARED_TOKEN` 也使用至少 32 字节的随机值。

6. 应用 migration（只执行未应用的迁移，保留现有业务数据）：

   ```sh
   npx wrangler d1 migrations apply yume-camp-assistant --remote --config wrangler.jsonc
   ```

   已发布的 SQL 迁移保持不变；修补使用新的编号。互动中心旧库升级及 0043 删除废弃日志表的说明见 [chat/README.md](chat/README.md#旧库升级命令)。不要清库或重跑历史建表 SQL。

7. 验证并部署：

   ```sh
   npm run check
   npm run deploy
   ```

自定义域名已经在示例配置中声明为 `lifeafter.example.com`。Cron 表达式使用 UTC，
Worker 内部再按 `automationConfig.timezone` 判定任务是否到期。

## 构建时 Workers 插件

业务功能来自 `plugins/<plugin-id>/`。每个目录必须包含：

- `plugin.json`：版本、任务、后台模块和 Key 权限声明；
- `server.ts`：可选后端实现，通过
  `/api/{public|agent|admin}/plugins/<plugin-id>/...` 提供插件 API；
- 可选 `admin.js`：导出 `mount(context)`，构建器会复制并让后台按需加载。

`npm run dev`、`npm test`、`npm run typecheck` 和 `npm run deploy` 都会先运行
`scripts/generate-plugin-registry.mjs`。因此增删插件目录后无需修改 Worker 核心导入；
生成器会校验重复任务、重复权限和重复后台模块，并生成服务端静态注册表与网页资源。
Cloudflare Workers 运行时不扫描文件系统，插件变更仍需重新构建和部署。

SMTP、任务日志、OIDC/Key、身份识别码、Agent 设备与命令队列属于核心能力。
更新科技、更新贡献、更新斩杀预警、更新成员资料、更新周活跃点、报名交易之城和营地巡逻为 27.3.0（Build 27176）内置插件。
后台停用插件会停止新定时任务、拒绝手工任务和对应快照，并从 Key 权限目录移除其
权限；尚未领取的该插件任务会被标记为中断。删除插件目录或部署新注册表不会删除
D1 中任何旧插件业务数据、设置或运行日志，重新加入同 ID 插件后仍可读取旧数据。

## Workers 面板连接 GitHub

仓库是多目录项目，Workers Builds 请使用：

- Root directory：`Workers`
- Build command：`npm run check`（也可使用 `npm run build`）
- Deploy command：`npm run deploy`
- Production branch：实际生产分支（通常是 `main`）

不要在 Build command 中重复执行 `npm install`；Workers Builds 会先执行
`npm clean-install`。重复安装通常不会导致失败，但会浪费构建时间。

必须把 `Workers/wrangler.jsonc` 提交到 Git。它只包含 Worker 名称、D1 绑定 ID、
OIDC Client ID、开关和 `sub` allowlist 等非 secret 部署配置；`OIDC_CLIENT_SECRET`、
`ADMIN_TEMPORARY_KEY`、`SESSION_SECRET`、`AGENT_SHARED_TOKEN` 只保存在 Wrangler Secrets
或 Workers 面板的运行时 Variables and Secrets。不要把临时管理 Key 写入 `vars`。
`worker-configuration.d.ts` 仍然不提交，`npm run check` 会在每次干净构建中先用
Wrangler 生成，再执行 TypeScript、测试和部署 dry-run。

面板中的 Worker 名称必须与 `wrangler.jsonc` 的 `name`
（当前为 `yume-camp-assistant`）一致。Build variables 只在构建期间可见，
运行时 secret 必须配置在 Worker 的 Variables and Secrets，而不是 Builds 的
Build variables。

## 网页界面

公共首页、登录页和全部管理模块沿用 Build 27142 的功能基础，统一使用
`public/mrzh-ui.css` 中与微信小程序 `pages/mrzh` 对应的玻璃材质、卡片和响应式布局。
内部信息卡共用外层底面，不重复叠加玻璃背景与模糊；管理后台按工作台、营地成员、
身份访问和系统设置分组，手机端使用可收起的管理菜单。

公共首页的八张功能卡与小程序保持相同顺序，营地群位于第二张，管理入口位于最后一张。
功能卡在窄屏显示两列，900px 起显示三列，1200px 起最多显示四列；顶部英文沿用小程序的短标签。
网页时间统一显示为 `YYYY/MM/DD HH:mm (UTC±偏移)`，保留配置时区、隐藏秒数；旧接口的时间展示字段也会在前端规范化。
参与状态沿用小程序的 `POST /api/public/vote-participation`：在首页数据和登录信息就绪后查询，
进入科技投票、投票与抽签子页时重新检查；并发期间若账户、投票期或提交版本变化，会丢弃旧响应并补查最新状态。
普通状态缓存最多保鲜 30 秒，查询失败不会缓存为“未参与”。
营地群内容可在后台「基础设置 → 营地资料」直接编辑 Markdown。内容保存在现有
`camp_config` 设置中，默认二维码图片使用本站静态资源；无需引用 `data.json`。
支持标题、文本、换行、HTTPS 链接和图片，也支持以 `/` 开头的本站静态资源路径。
例如 `![微信群二维码](https://example.com/images/camp-groups/wx.png)`。
默认二维码是可扫描的示例占位图，管理员可在文本框中替换成实际群二维码。
营地群内容随公共首页数据一并返回，不单独请求外部接口。
首次载入展示与小程序一致的三环动画和进度条，等待页面、字体、背景和首屏接口完成后淡出；
公共页还等待登录参与状态，后台等待插件模块。懒加载图片不阻塞首屏。
失败资源在页面显示原有错误提示后结束等待；超过 20 秒提供重新载入和继续查看入口。

## 科技目录

管理后台的科技 JSON 每项支持：

```json
{
  "key": "mobile_guard",
  "name": "移动守卫",
  "iconUrl": "/images/tech/mobile-guard.webp",
  "description": "在网页和小程序展示的科技说明。",
  "category": "military",
  "lane": "core",
  "enabledForVoting": true,
  "sortOrder": 10,
  "uiLabel": "移动守卫"
}
```

图标建议放在 `public/images/tech/`，使用同源根路径可避免第三方资源失效。
`uiLabel` 用于游戏内 OCR 名称匹配；扣费数字不是目录字段，也不会参与自动化判断。

科技名称末尾的全角或半角括号表示前置科技，例如
`加速印刷（墙纸印刷师）`。投票选择后置科技时，服务端会把前置科技一并计入
每人最多 6 票的限制；两端前台也会同步联选。生成次日预测时：

- 后置科技票数低于前置科技，只开启前置科技；
- 后置科技与前置科技需要作为组合加入时，若剩余名额放不下，两项均跳过并顺延；
- 固定科技同样会自动带入前置科技；
- 0 票科技不会为了填满位置而被自动加入，未投票且未设固定科技时预测可为空。

公共 API 始终按票数降序返回科技；网页和小程序投票页每 10 秒刷新一次并重排。

科技投票每天按配置时区开放，默认 `06:30–24:00`。管理员可在“营地与公共展示”
中修改开放和截止时间；网页与小程序会显示时段和当前开放状态，公共投票 API 也会
在时段外拒绝写入，而不只是由前端隐藏按钮。

## API 边界

- `/api/public/*`：公共展示和投票。
- `/api/admin/*`：OIDC/临时 Key session + 同源检查 + CSRF + 逐项权限检查。
- `/api/agent/*`：Mac Agent 的 Bearer token，仅由 Mac 主动请求。
- `/auth/oidc/*`：Authorization Code + PKCE。

当前实现不需要 Cloudflare Containers，因此没有待关闭的容器，也不会产生容器最低配置费用。
任务的长时间等待（如 19:20–21:25）发生在本地 Mac Agent，Worker 只保存状态和指令。

## 多 Agent 设备

每台 Mac 使用自动生成、不会因改名而变化的 `agentId`，并在 App 中维护可编辑的
设备名称。D1 会保留所有上线过的心跳记录；管理后台可选择唯一的启用设备，只有
该设备能够从命令队列领取任务。切换启用设备与重定向未领取命令在同一个 D1 batch
中完成。后台只能删除非启用设备；删除仅移除心跳记录，设备之后再次上线会自动
重新出现，但不会抢占当前启用状态。

## 微信小程序

在微信公众平台将 `https://lifeafter.example.com` 加入：

- request 合法域名；
- web-view 业务域名。

管理后台仍使用网页 OIDC，会话 cookie 不写入小程序本地存储。

## 身份、临时 Key 与偏好同步

- OIDC 支持静默自动登录、会话状态检测，以及退出本站时同步退出
  `account.example.com`。
- 系统管理员可生成任意多个带名称/编号的临时 Key；数据库只保存 SHA-256，
  明文仅创建时显示一次。Key 由随机字母、数字和符号组成，长度显著超过 20 位。
- Key 权限按管理菜单逐模块细分；可单独授予各模块查看权，以及配置、执行、
  中断、成员操作、Key 管理、识别码审批、识别码管理和 SMTP 管理等写权限。
  `Demo` 权限可查看完整后台但不能执行任何写操作；OIDC 用户始终拥有最高权限。
  关闭“开放临时 Key 登录”只阻止新登录，不删除 Key；重新开放后，
  未过期且未撤销的 Key 仍可登录。
- 网页支持简体中文、繁体中文、English、Français、日本語，以及
  `auto/light/dark`。语言和主题按站点分别保存在 localStorage，不使用跨子域 Cookie。
  同一站点的其他标签页会通过浏览器 storage 事件同步变更。

## 身份识别码与 SMTP

- 身份识别码为唯一、非连续的随机 8 位数字；投票只接受未取消的识别码。
- 新申请、延期和重新发行都由管理员审批。延期可从有效期届满前 7 天（含边界时刻）
  开始申请，沿用原识别码和申请编号；延期审批中的过期码只有一次临时投票机会。
- 同一邮箱或玩家名称只允许一个有效识别码，也只允许一项待审批申请。新申请命中
  有效识别码时会引导使用“忘记识别码”找回；任一类型申请待审批时，不能重复提交
  或改交其他类型。
- 已过期但尚未被收回的识别码仍拒绝新申请，并引导申请延期；延期被拒后旧码会
  标记失效，此后才允许以相同邮箱或玩家名称重新提交新申请。
- 重新发行申请提交后旧识别码立即失效；审批通过后发送新识别码，审批拒绝不会
  恢复旧识别码。延期申请被拒后现有识别码也会被收回。上述拒绝或管理员取消后，
  玩家可重新发起新申请并取得新的申请编号。
- “忘记识别码”使用申请编号、申请时预留邮箱、玩家名称中的一项或多项精确
  匹配，识别码只发送到数据库中原先预留的邮箱，不会在 API 响应中返回。
- 公开识别码检查采用匿名化来源限流和识别码值限流。D1 只保存由
  `SESSION_SECRET` 派生的 HMAC 摘要，不保存来源 IP 或受测识别码明文。
- SMTP 在管理后台配置，密码使用 `SESSION_SECRET` 派生的 AES-GCM 密钥加密后
  存入 D1；支持 465 TLS 与 587 STARTTLS，不使用端口 25。
- 新部署必须应用全部 migration；现有部署至少要继续应用
  `0011_activity_warnings_and_identity_reissue.sql`、
  `0012_temporary_key_permissions.sql`、`0013_identity_uniqueness.sql` 与
  `0018_worker_plugin_states.sql`。
  `0013` 会在 D1 层阻止并发请求绕过邮箱、玩家名称的待审批/有效唯一约束。
  生产迁移仍使用准备步骤中的
  `wrangler d1 migrations apply ... --remote` 命令。

## D1 业务配置（无需修改 Wrangler）

管理后台保存的 `automationConfig` 包含每个动作的启用状态与执行时间，以及：

- `agentPolling.activeSeconds`：Mac 有任务运行时的轮询间隔；
- `agentPolling.idleSeconds`：没有可计算的任务计划时的备用懒惰轮询间隔；
- `agentPolling.scheduledWindowMinutes`：每个已启用任务计划时间前后的活跃窗口，默认 `15` 分钟，可在管理后台修改；
- `agentPolling.windows`：旧版分时窗口配置，继续保存在配置中以兼容旧数据，但不再决定自动任务唤醒时间；
- `campConfig.specialDailyRefreshTime`：预留的特殊每日刷新时间，默认 `00:00`，当前不被任何任务调用；
- `gameWatchdog`：健康检查、动作超时、冻结判定、最大重启次数和冷却；
- `tasks`：只包含更新科技、更新贡献、更新斩杀预警、更新成员资料和营地巡逻。

Agent 从所有已启用任务的 `time`/`times` 自动计算活跃窗口：窗口内按 `activeSeconds` 与
健康检查保持 Workers-Agent 交互，窗口外进入 lazy，并直接等待下一个窗口开始，以避免每 15/30 秒
重复请求。任务运行中始终保持活跃。Mac Agent 左下角的“恢复活跃/解除活跃”按钮可临时切换手动活跃状态；
定时窗口仍会自动唤醒。进入非 lazy 窗口后，Agent 先请求 `/api/agent/next-command` 获取 Workers 返回的
最新任务时间和轮询策略，再发送当前状态；这样后台刚修改计划时不会依赖旧的本地时间缓存。

旧版 `agentPolling.windows` 的 `id`、`name`、`start`/`end`、`weekdays` 字段仍会被校验并保存，
但不再作为自动唤醒依据。任务仍由 scheduler 按任务计划独立入队，活跃窗口只负责保证 Agent 能及时接取。

默认计划为：更新科技 02:00、更新成员资料 02:15、更新贡献 02:30、
更新斩杀预警 02:45；营地巡逻沿用后台当前设置。单个 MuMu 界面一次只执行一个
任务。所有字段都在 D1 中修改，`wrangler` 只保存部署绑定和 secrets。

## 成员与斩杀预警

- `contribution_sync` 只更新三项贡献字段，不会删除当前成员。
- `inactivity_sync` 只更新离线时间，并生成最新斩杀预警名单。
- `member_profile_sync` 在完整人数校验成功后更新职业、庄园、同居和营地职位，
  同时以完整成员页刷新当前名单；未出现在本次完整成员页中的旧成员会移出当前列表。
- 斩杀预警只读取市政厅沙盘“活跃”页，并按“在线情况”倒序。
- 预警只用于展示；Worker、管理后台与 Mac Agent 均不提供自动或手动踢出功能。

## 聊天消息通知

网页浏览器和 iOS 16.4+ 主屏幕 Web Clip 使用标准 Web Push，不需要 Firebase 或原生推送项目。用户在互动中心点击“开启通知”并允许系统权限后，订阅会保存到现有的用户 Inbox Durable Object；首次使用自动生成并持久保存该用户的 VAPID 密钥，不新增外部服务或数据库绑定。请使用 HTTPS。iOS 必须通过主屏幕上的全屏 Web Clip / Web App 打开；普通 WKWebView、Android 原生 WebView 不在此适配范围。

首页所有栏目共用常驻的消息监听，前台显示可点击的新消息提醒；Service Worker 独立显示系统通知。点击通知回到 `/#chat` 并打开对应会话。系统推送不依赖页面或 WebSocket 是否在线，也不再因前台状态缓存而跳过投递。推送保留群静音、提及/回复例外；登录失效或退出后，服务端停止该会话的推送并清理订阅。关闭通知会移除服务端订阅和浏览器订阅，失效的推送地址自动清理。网页与系统通知共用发送者、会话名称和消息概览；概览最多 160 个 Unicode 字符，超长时省略，不发送长消息全文。网页通知卡片固定为 104px 高，正文最多显示两行，名称与概览超出时显示省略号；系统通知的外观尺寸由操作系统管理。

嵌入式聊天通过同源顶层窗口申请权限和注册推送；注册失败显示连接状态并提供重试，恢复网络或页面焦点时补注册。

`public/sw.js` 仅负责消息通知，不拦截请求或缓存页面。`manifest.webmanifest` 提供主屏幕安装信息。部署后需在真实浏览器和 iPhone 上首次授权，后台投递受系统通知权限、专注模式及网络状态控制。
