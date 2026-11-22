# Yume Camp Assistant.app

`Yume Camp Assistant.app` 是仅支持 Apple Silicon（M 系列）的本地执行器。Workers、MuMu、macOS Node.js 和 Android platform-tools ADB 均为外部组件；安装向导会检测并引导安装，App 只随包提供 OCR/视觉依赖和任务插件。

Node.js 不再打包进 App。安装向导会检查本机的 arm64 Node.js 22；“概览 → 更新运行环境”在需要时会把同版本 Node.js 下载到 `~/Library/Application Support/Yume Life After Mac Agent/Runtime/current/Toolchain/node`，不写入 App 包。其他内置运行时仍随 App 更新。

Qwen 模型也不打包进 App。模型运行时保存于 `~/Library/Application Support/Yume Life After Mac Agent/ModelRuntime`，模型权重保存于 `~/Library/Application Support/Yume Life After Mac Agent/Models/Qwen3-VL-2B-Instruct-4bit`。安装向导和更新向导会检查并提示准备或下载；也可以直接把旧 `.local-model/models/Qwen3-VL-2B-Instruct-4bit` 目录复制到该位置以跳过权重下载，首次使用仍可能需要安装 Python/MLX 依赖。

中国大陆直连网络环境下，可选本地模型可能无法完成下载；如需使用，请自行解决网络访问或模型文件获取问题。

## 首次使用

1. 双击 `Yume Camp Assistant.app`。
2. 在“设置”中填写 Workers 地址、可编辑的设备名称、Agent Token 和本地调试 Token，然后保存。稳定的设备 ID 由 App 自动生成；Token 存入仅当前用户可读的本地凭据文件。
3. 点击“保存、安装并完成”后，安装向导会注册并验证后台 Agent。若后台 Agent 注册异常，可点击“修复 Agent”重新注册当前用户的 LaunchAgent 并检查健康状态；修复会保留设置，也不会启动 MuMu。状态、运行日志、手工任务和 Workers 营地管理后台都可在 App 内使用。
4. 安装向导也可以从迁移包恢复设置、插件、可选模型和可选凭据。

Agent 启动后会与 Workers 建立经过认证的持久 WebSocket 连接，并保持在线待命。
命令仍以 Workers 队列为准：新命令通过 WebSocket 触发 Agent 领取，连接中断后会
自动重连并重新检查队列；在线状态与运行中断信号也通过该通道更新。后台定时器仍按
配置时区检查任务计划，因此定时任务可能在计划检查触发后才入队，入队后的唤醒不再
依赖轮询间隔。

自动化流程针对《明日之后》中国大陆服务器和 MuMu 中国大陆版设计。请从 MuMu 模拟器自带的应用商店下载并安装游戏，然后在游戏设置中将默认的释放鼠标按键 `~` 改为 `=`；Agent 使用 `=`。海外版本的游戏或模拟器可能有不同界面和流程，使用者需自行修改相关源代码。

所有游戏点击均通过本机安装的 Android platform-tools ADB 完成。登录前和普通 Android 面板使用直接 `input tap`，不会检测游戏鼠标图标。
登录成功并以稳定 HUD 关键词确认就绪后，Agent 仅执行一次 `CtrlF`、等待 2 秒、发送 `input keyevent 70`、再等待 3 秒完成 HUD 输入初始化；登录阶段跳过 C+C 像素判断。完成后才继续后续操作；右下角拳头鼠标图标仅作参考。
之后打开营地频道→营地图标→营地卡片、巡逻建队时优先发送 `Ctrl+Tab` 切换旗帜
队伍卡片，并在最多 6 次按键后逐次校验“创建队伍/加入队伍/自动匹配/队员信息”；
只有键盘入口未确认时才使用旗帜坐标点击后备。所有任务在稳定世界 HUD 后都必须先
完成一次 keyevent 70 释放初始化；同一个后备点击步骤连续失败至少 2 次，第三次
重试前才重新检查图标并按需再次发送 keyevent 70。不会调用 macOS 输入助理、辅助功能权限、
CGCursor 可见性检测或宿主机 `~` 释放方案。
地图打开后，必须在地图画面中识别到“标志查看、查看庄园、可快捷前往地标、中心花园、我的庄园、坐标”
中的至少两项，才允许继续选择地点和快速前往；未达到条件时仅重发 M 键并重试识别。

首次安装会从 `config.example.json` 自动生成私有的 `config.json`；更新 App 时会保留现有配置、日志和用户插件，并执行最新的 runtime 配置迁移。

## 自带插件

App 默认安装 7 个插件：更新科技、更新成员资料、更新贡献、更新斩杀预警、更新周活跃点、报名交易之城和营地巡逻。斩杀预警仅展示离线风险，不提供自动或手动踢人插件。

- **停用/启用**：保留插件和设置，仅阻止 Agent 加载它。
- **内置插件**：随 App 包提供，只能停用，不能删除、卸载或被同 ID 的额外插件替换。更新时替换项目中的插件文件夹并重建 App。
- **额外插件**：插件页可一键打开 `Application Support/Yume Life After Mac Agent/Plugins`；把原始文件夹放入其中，重启 Agent 后生效。额外插件可停用或删除。
- **来源**：App 不再从 Workers 检查或下载插件；Workers 使用独立的构建时插件目录。

文件夹格式和签名规则见 `Mac/PLUGIN_FORMAT.md`。

## 更换或重置 Mac

在设置页导出 `.ylabackup` 时，可以分别勾选是否包含外置 Qwen 模型和已保存凭据。凭据敏感，请仅在可信的迁移包中包含；不勾选时不会导出。导入时保留目标 Mac 自己的设备 ID 和设备名称，不会把两台 Mac 合并成同一个 Agent。

当前构建若采用临时签名，可在本机使用。要在其他 Mac 上获得无 Gatekeeper 警告的一键体验，需要用 Developer ID Application 证书构建并公证：

```sh
YLA_CODESIGN_IDENTITY="Developer ID Application: ..." ./scripts/build-app.sh
```

## 构建

```sh
cd MacApp
./scripts/prepare-portable-runtime.sh
./scripts/build-app.sh
python3 -m venv /tmp/yla-dmg-tools
/tmp/yla-dmg-tools/bin/pip install -r scripts/requirements-dmg.txt
YLA_DMG_PYTHON=/tmp/yla-dmg-tools/bin/python ./scripts/build-dmg.sh
```

发布构建不内嵌 Node、ADB、Python、MLX 或 Qwen 生成式模型；模型和 Python/MLX 运行时由安装向导或更新向导按需放入 Application Support。

App 从 macOS 26 开始支持。OCR 首选稳定的 Vision legacy 请求（快速和准确模式都支持
中文、英文、日文）。macOS 27 的 Vision `.fast` detector 存在已复现的
`SwiftNativeNSArray` 越界崩溃，因此对外仍保持 `fast` 合同，但在该系统上使用同一
低延迟路径的稳定 detector，并在游戏启动后先完成一次 OCR 预热；预热完成后正常
识别超时保持在 3 秒。只有 legacy 无法解码时才回退到 revision-3 URL 输入。
OCR 熔断状态按模式隔离，任一模式异常都不会阻止另一模式完成 HUD 频道关键词确认。

DMG 安装窗口与背景尺寸由 `scripts/dmg-layout.json` 统一定义；构建直接写入 Finder 元数据，不启动 Finder，也不依赖桌面自动化权限。背景包含 1x/2x TIFF 图层，窗口高度包含标题栏，内容区与背景保持一致。

同一 App 生命周期只执行一次启动准备；runtime 比较会忽略 npm 对 lockfile 的格式及根 build 元数据重写，
依赖解析与可执行源文件变化仍会触发更新。运行 `./scripts/test-runtime-payload.sh` 可验证重复启动及真实代码更新的判断。
