# Mac Agent 安装与运行

## 运行方式

Agent 仅连接本机 MuMu 中文版实际报告的回环 ADB 端口。当前
`Life After CN Auto` 容器报告为 `127.0.0.1:16480`；每次启动、重启后 Agent
都会执行 `mumutool info <index>` 并用最新 `adb_port` 覆盖运行时连接。不要把
`mac-studio-cf.example.com` 或任何公网 ADB 地址写进 `config.json`；公网映射只适合临时诊断，
不参与生产任务。Worker 与 Mac 之间采用 Mac 主动发起的 HTTPS 长轮询，因此不会
向 Worker 泄露家庭公网直连地址，也无需从公网访问 ADB。

Mac Agent 每轮先请求 `/api/agent/next-command`，确认 Workers 返回的最新任务计划
时间和轮询策略，再发送当前状态心跳。首次启动尚未取得服务端配置时使用
`config.json` 的 `server.pollSeconds`（示例为 5 秒）作为回退；此后 Worker 每次
响应 `pollAfterSeconds`：

- 任务运行中或手动“恢复活跃”时使用 `activeSeconds`（默认 2 秒）；
- 已启用任务计划时间前后默认 15 分钟的窗口内使用 `activeSeconds`，并保持健康检查；
- 其他时间进入 lazy，直接等待下一个任务窗口的开始，不再每 15/30 秒重复请求；
- 没有可计算任务时间时才使用 `idleSeconds` 作为备用间隔。

活跃窗口由管理后台任务计划中所有已启用任务的 `time`/`times` 自动计算。
`agentPolling.scheduledWindowMinutes` 可在后台修改（默认 15，范围 1–240），
无需修改本机配置或 `wrangler`。旧版 `agentPolling.windows` 仍会保留并校验，但
不再决定自动任务唤醒时间。

Agent 进入 lazy 后仍驻留在后台，Worker 会下发下一个窗口开始时间，定时任务窗口
到达时自动恢复请求；进入窗口的第一轮会先拉取最新任务计划，避免后台刚改时间而
本机仍使用旧缓存。Mac Agent 左下角的“恢复活跃”按钮可立即恢复持续轮询和健康
检查；按钮变为“解除活跃”后再次点击即可回到 lazy。停止 Agent 或退出负责它的
LaunchAgent 后不会执行定时任务，需先启动 Agent。

`server.agentId` 是 App 首次配置时生成的稳定设备 ID，`server.agentName` 是可在
App 设置中随时修改的显示名称。Workers 可以同时记录多台 Agent，但只有管理后台
选中的唯一启用设备能领取命令；待命设备仍会发送心跳，因此被后台删除后再次上线
时会自动重新出现。

ADB 模拟鼠标使用：

```sh
adb -s 127.0.0.1:16480 shell input mouse tap X Y
```

它直接注入 Android 输入，不需要 MuMu Root，也不会占用 macOS 鼠标。自动化前，请从 MuMu 模拟器自带的应用商店下载并安装《明日之后》中国大陆服务器客户端，然后进入游戏设置，将默认的释放鼠标按键 `~` 改为 `=`。Agent 使用 `=`；若仍保留游戏默认按键，鼠标释放相关的自动化操作可能无法按预期执行。

## 一次性安装

1. 启动 MuMu 中国大陆版，并从 MuMu 自带的应用商店安装《明日之后》中国大陆服务器客户端；进入游戏设置，将释放鼠标按键从默认的 `~` 改成 `=`。Agent 会从 `mumutool info` 自动读取 ADB 端口。当前实例的诊断端口是 `16480`。
2. 生成 OCR 工具：

   ```sh
   ./scripts/build-vision.sh
   ```

3. 安装营地聊天所需的 Unicode 输入法：

   ```sh
   ./scripts/install-adb-keyboard.sh
   ```

   脚本从 F-Droid 下载开源 ADB Keyboard。Agent 发送“清理已完成”时临时切换，
   发送后恢复原输入法。

4. 复制 `config.example.json` 为 `config.json`，填写：
   - 与 Worker `AGENT_SHARED_TOKEN` 相同的 `server.agentToken`；
   - 足够长的本机 `debug.token`；
   - 正确的 MuMu `instanceName`。当前为 `Life After CN Auto`，解析到实例 `3`；
     `instanceIndex` 仅作校验和旧配置回退，不再作为首选标识。
5. 运行诊断：

   ```sh
   npm run doctor
   ```

6. 前台试运行：

   ```sh
   npm run once
   ```

### `Invalid agent token` 排查

Worker 只会校验当前 `wrangler.jsonc` 中名为
`yume-camp-assistant` 的运行时 secret。若心跳返回
`invalid_agent_token`，先确认 secret 名称存在：

```sh
cd ../Workers
npx wrangler secret list --config wrangler.jsonc
```

Cloudflare 不提供 secret 明文回读，因此即使名称存在，也无法据此证明字节内容
与 `Mac/config.json` 一致。请在 Workers 面板的 Variables and Secrets 重新保存
`AGENT_SHARED_TOKEN`，或运行：

```sh
npx wrangler secret put AGENT_SHARED_TOKEN --config wrangler.jsonc
```

交互提示中只粘贴 `server.agentToken` 的原始内容，不要包含 JSON 双引号、逗号或
首尾空格。重新部署本项目代码后，缺少/过短的 secret 会返回
`agent_token_not_configured`（503），真实不匹配才返回
`invalid_agent_token`（403），便于区分配置缺失与内容不一致。

7. 校准全部 `flows` 后注册为当前登录用户可由 App 控制的 LaunchAgent：

   ```sh
   ./scripts/install-launch-agent.sh
   ```

更新现有安装时，推荐使用 App 的“更新运行环境”向导；它会替换当前 runtime、
保留 `config.json`/日志/用户插件、执行配置迁移、重建 OCR 并重新注册后台 Agent。
命令行等价流程为：

```sh
./scripts/manage-local-agent.sh update
```

更新后可用 `npm run agent:health` 检查本机端点，或用 `npm run agent:status` 检查
LaunchAgent 和进程状态。升级不会删除已有凭据、模型、校准配置或日志。

## 手动启动与停止

安装 LaunchAgent 后，无需重启 Mac 即可手动控制同一个后台 Agent：

```sh
npm run agent:status
npm run agent:start
npm run agent:stop
npm run agent:restart
npm run agent:logs
```

`agent:stop` 会从当前登录会话卸载服务并发送 `SIGTERM`，使正在运行的工作流进入
中断与清理流程；不会删除 plist。为避免 Mac 重启后 App 尚未打开就执行定时任务，
LaunchAgent 使用 `RunAtLoad=false`、`KeepAlive=false`，只有打开 Mac Agent 或明确执行
`agent:start` 时才会启动 runtime。`agent:start` 会重新加载既有 plist；首次使用前仍需运行
`npm run agent:install`。

启动脚本和日志均保留在外置项目目录：

- `Mac/scripts/agent-launcher.sh`
- `Mac/logs/agent.log`
- `Mac/logs/agent-error.log`

为避免 launchd 在创建进程前直接打开外置卷上的工作目录或日志而返回
`EX_CONFIG`，plist 直接启动外置盘源码入口；Node 启动后再由
`src/file-logger.mjs` 打开同一外置盘上的日志。`agent:status` 只有在服务状态为
`running`、存在 PID 且 `127.0.0.1:8091` 健康端点可访问时才会报告完整在线；
`spawn scheduled`、`EX_CONFIG` 等已加载但未运行的状态会返回失败。

## 卸载 Agent

要完整撤销 `./scripts/install-launch-agent.sh` 的安装，请执行：

```sh
npm run agent:uninstall
```

卸载脚本会先停止并从当前图形登录会话移除 `zone.yume.lifeafter.macagent.runtime`，再删除
`~/Library/LaunchAgents/zone.yume.lifeafter.macagent.runtime.plist`。升级安装时会自动清理旧版
`zone.yume.mrzh-agent` 的 launchd 项；项目源码、`config.json`、
日志、已构建的 OCR 工具和下载的 APK 默认保留，不会误删校准或凭据数据。

如需恢复，重新执行：

```sh
npm run agent:install
```

## 模拟器生命周期

默认配置为：

```json
{
  "mumu": {
    "stopEmulatorAfterTask": true
  }
}
```

每项任务开始时，Agent 先用 `mumutool info all` 按 `instanceName` 精确解析容器，
再用 `mumutool open <resolvedIndex>` 后台启动模拟器并等待
ADB。任务成功或被管理员明确中断时，`finally` 清理流程会：

1. `am force-stop` 关闭明日之后；
2. `mumutool close <resolvedIndex>` 停止模拟器；
3. 删除本任务产生的全部 OCR/校准临时截图。

普通页面识别、OCR 或流程错误也会执行同一套 `finally` 收尾；
默认 `mumu.keepRunningOnTaskError: false`，因此不会把 MuMu 停留在错误页面。
Agent 会尝试返回中心出入口，随后关闭游戏并停止容器，同时删除本任务临时截图。
只有临时调试校准时显式改为 `true` 才会保留错误现场。

Agent 启动时还会删除 `snapshots/` 中超过 24 小时的异常遗留 PNG。首次打开沙盘
“数据”页时，游戏可能弹出一次截图权限提示；请手动确认一次，之后自动任务不会再被
该提示阻塞。

## 登录后的活动宣传页

游戏完成资源加载后、登录角色前可能出现带右上角 X 的“系统公告 / 更新公告 /
游戏公告”。Agent 将其与登录后的活动宣传页分开处理：仅在尚未点击登录时匹配公告
标题，并点击 1920×1200 实测关闭点 `(1742, 155)`。若公告改版且 OCR 无法识别，
本地视觉模型只记录此类公告候选；关闭 X 必须由 OCR 明确读到公告标题，避免模型
把服务器登录页误判后点击右上区域。

角色登录后可能出现当期活动宣传页与《明日希望报》，共 0–2 张；两者都可以缺席。
当期活动主题、标题和主视觉会变动，因此 Agent 不依赖某一期活动名称，而是循环检查：

1. 已识别到“配方 / 背包 / 营地”或 HUD 结构时立即结束，不额外点击；
2. 非 HUD 全屏主视觉同时出现“立即前往 / 前往查看 / 前往活动 / 活动时间”之一时，
   点击 1920×1200 实测安全点 `(960, 1035)`；该点位位于游戏画面底部，不落入 MuMu
   状态栏；
3. OCR 直接识别到《明日希望报》时按宣传页关闭；
4. OCR 未读出稳定标题时，由本地视觉模型区分全屏活动海报、希望报与 HUD。模型需
   连续达到高置信度，且只能触发同一个固定安全点；登录后模型误标的
   `prelogin_announcement` 会按全屏活动宣传页归一处理，不会点击右上角；
5. 最多关闭两张，之后仍未进入 HUD 则停止猜测并交给看门狗恢复。

`postLoginPromotions` 可配置底部点击点、同一画面的单轮关闭重试次数、重试冷却、活动特征文字和 HUD 就绪文字。宣传页数量不设硬上限；只要仍明确识别为活动宣传页或《明日希望报》，就会继续通过底部安全区域关闭。
宣传页判断截图使用瞬时 OCR/本地视觉模型，读取后立即删除。

## 可选本地视觉模型

本机使用 Qwen3-VL 2B Instruct 的 MLX 4-bit 视觉版本
`mlx-community/Qwen3-VL-2B-Instruct-4bit` 与 MLX-VLM。模型、Python
虚拟环境、PID 和日志都隔离在 `Mac/.local-model/`，不会写入系统 Python。服务仅
监听 `127.0.0.1:8092`，任务期间复用已加载模型以降低单帧延迟，任务结束后停止。

在中国大陆直连网络环境下，可选模型可能无法完成下载；如需使用，请自行解决网络访问或模型文件获取问题。
模型采用 `guarded` 受限模式：置信度达到 0.95 时，可执行允许列表中的固定操作或
确认 HUD/地图状态；打开地图统一发送 `input keyevent 41`（M 键），不点击地图/天气图标；关闭遮挡页仍按识别结果点击对应关闭/返回位置。地图打开后须在地图画面中识别到“标志查看、查看庄园、可快捷前往地标、中心花园、我的庄园、坐标”中的至少两项，所有执行仍映射到配置中的已校准动作，不接受未经校准的模型
生成坐标。安装及控制：

```sh
./scripts/manage-local-agent.sh install
./scripts/manage-local-agent.sh start
./scripts/manage-local-agent.sh status
./scripts/manage-local-agent.sh stop
./scripts/manage-local-agent.sh update
./scripts/manage-local-agent.sh uninstall
```

这是本地 Agent 的统一全功能入口；也可以使用对应 npm 命令：
`npm run agent:install`、`agent:update`、`agent:start`、`agent:stop`、
`agent:restart`、`agent:status`、`agent:health`、`agent:repair`、
`agent:logs` 和 `agent:uninstall`。运行
`./scripts/manage-local-agent.sh help` 可随时查看完整说明。

也可使用 `model install|start|stop|status|update|uninstall|logs` 只管理模型。
`deps` 安装/更新 Node、ADB、Python 3.12、npm 依赖、Vision OCR 和 MLX-VLM；
`once` 临时启动模型后运行一次 Agent，并在退出时停止模型。卸载会移除 LaunchAgent
和 `Mac/.local-model/`，保留源码与 `config.json`。

模型在后台补充页面分类，登录阶段推理不会阻塞 OCR 和确定性操作循环。科技、
巡逻队满员状态、日程与寻路可使用 AI 辅助判断并执行已校准动作；Agent 不包含
任何成员移除流程。架构与安全边界
见 [`LOCAL_VISION_MODEL.md`](./LOCAL_VISION_MODEL.md)。

## 游戏无响应恢复

每个任务使用管理后台的 `gameWatchdog` 策略。Agent 周期检查游戏 PID、Android
ANR/“应用无响应”状态；界面 OCR 动作超时、截图/ADB 超时、游戏进程意外退出也
视为可恢复异常。确认异常后会：

1. 普通游戏 ANR/退出先用 `am force-stop` 结束游戏并重启；
2. ADB 离线、界面连续冻结达到管理后台阈值（默认 60 秒），或游戏级恢复后再次
   失败时，优先执行与故障页“重启”按钮等价的
   `mumutool restart <resolvedIndex>`；
3. 容器重启 60 秒仍未恢复时，按稳定进程名强制结束
   匹配 `MuMuEmulator --index <resolvedIndex>` 的设备进程和失效的
   `MuMuPlayer` 管理进程，再重新打开配置的实例；
4. 重新读取容器 `adb_port`，等待新的 `127.0.0.1:<port>` 恢复，再启动并登录角色，
   从当前独立动作起点重跑。

最大重启次数默认 2 次，管理员中断不会触发重启。超过上限后任务失败并照常关闭
游戏、MuMu 和清理截图。恢复逻辑不使用 PID 或内存占用判断；PID 和占用在每次
启动后均可变化。

ADB 输入复用现有连接，不在正常轮询中反复断开。单次鼠标输入最多等待 5 秒；
只有输入超时或连接失效时才执行一次断开、重连和重试。第二次仍失败时立即交给
游戏看门狗，不会向冻结界面堆叠重复点击。画面监视只执行截图和 OCR，不控制
macOS 鼠标。截图、输入和看门狗健康检查共用一个串行 ADB 队列，避免多个 shell
请求同时争用当前动态解析的本机 ADB 连接。

巡逻队伍优先通过 `Ctrl+Tab` 切换到旗帜队伍卡片；每次按键后都在校准的队伍卡片
区域确认“创建队伍/加入队伍/自动匹配/队员信息”等关键词，最多 6 次。只有键盘
入口 6 次均未确认时，才使用左侧旗帜固定坐标作为后备，并在点击前后识别并关闭
“任务/当前/导航/追踪”任务导航卡片；不通过公告板的“前往组队”创建。公告板只
用于队伍满 4 人且达到接取时间后打开巡逻路线；落点正好在公告板时点击“营地巡逻”，落在 NPC
英格雷附近时走“交谈 → 查看巡逻队当前进程”，其他落点继续使用巡逻/公告板
指引寻路。重新登录或建队后若询问是否加入队伍语音频道，固定发送 Esc 取消。

巡逻接取成功后固定连续点击两次返回，完全退出巡逻页面，再把队伍目标改为
“限时活动 → 保卫古籍”并分享到营地频道。之后按后台配置的分享间隔（默认
10 分钟）重复分享；巡逻任务期间游戏与 MuMu 容器保持运行，达到后台配置的结束
时间后任务才完成。旧版营地聊天指令监听、剪贴板读取和队伍踢人功能均已废弃，
不会读取或响应 `T...` 等消息。

## 科技安全顺序

科技任务不增量修改，固定执行：

1. 打开待生效科技配置；
2. 从右侧两行末槽开始逐槽检查；
3. 已配置槽点击移除；空槽若打开左侧选择器则立即返回；
4. 确认完成清空阶段并生成仅供本次任务校验的临时截图；
5. 固定科技优先、投票科技按票数补齐；
6. 提交前生成临时截图，但不匹配动态扣费数字；
7. 点击完成。

找不到目标 `uiLabel`、界面不在预期状态或 OCR 置信度不足时，任务会安全失败，
不会继续猜坐标提交；任务 `finally` 仍会删除截图。

## 8091 本机诊断端点

Agent 只监听 `127.0.0.1:8091`，并要求 Bearer token：

```sh
curl -H "Authorization: Bearer <debug.token>" \
  http://127.0.0.1:8091/health

curl -X POST -H "Authorization: Bearer <debug.token>" \
  http://127.0.0.1:8091/abort

curl -X POST -H "Authorization: Bearer <debug.token>" \
  http://127.0.0.1:8091/shutdown
```

如需从外部访问，应让 Mac 上的 Cloudflare Tunnel 将
`mac-studio-cf.example.com` 转发到 `http://127.0.0.1:8091` 并启用 Access；
不要把 8091 改为监听 `0.0.0.0`。

## 界面校准

`config.example.json` 中科技、公告板传送、市政厅沙盘、成员与公职页面坐标来自
1920×1200 的当前 MuMu 画面。贡献表和成员表都会滚动至列表末尾，并按成员名去重，
默认最多读取 40 页，覆盖 100 名以上成员。巡逻仍须在对应活动开放时间的实际界面
逐项验收；空数组代表尚未校准，Agent 会安全失败并指出流程名，不会在未知画面上盲点。

市政厅沙盘路径已校准为：地图选择“市政厅”→点击地图上的“快速前往”→
`营地数据中心/营地管理`→成员信息→“活跃”→点击“在线情况”一次。点击后最久
未上线者在顶部，Agent 继续滚动并读取 `N天前/N个月前/N年前` 等原始文本，同时
折算天数上传。正式流程不访问已废弃的“幸存者”页。

贡献读取使用小区域混合识别：本机 Vision accurate OCR 只裁剪数值表格（单页约
0.6 秒），按已校准列边界拆分相邻或溢出的长数字；2B 模型只补全带装饰符号的姓名，
不参与贡献数值判断。实机对 108 名成员完整滚动为 13 页、约 73 秒，首行溢出值
`17929600` 已正确保留首位。模型只启动一次并跨页复用；相似姓名不会模糊合并，
仅按完整姓名精确去重。可用 `npm run test:cityhall` 只校准市政厅落点，或在贡献页
顶部使用 `npm run test:contribution-current` 做不关游戏/MuMu 的高速读取诊断。
