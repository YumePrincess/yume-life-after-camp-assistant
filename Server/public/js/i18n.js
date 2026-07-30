(() => {
  "use strict";
  const P = window.YumePreferences;
  const originalText = new WeakMap();
  const originalPlaceholder = new WeakMap();
  const originalAttributes = new WeakMap();
  const originalTitle = document.title;
  const languageNames = {
    auto: "Auto",
    "zh-cn": "简体中文",
    "zh-tw": "繁體中文",
    en: "English",
    fr: "Français",
    ja: "日本語"
  };
  const translations = {
    en: {
      "明日之后“愿”营地助手": "LifeAfter “Wish” Camp Assistant",
      "管理后台": "Admin console",
      "营地管理后台": "Camp admin console",
      "进入管理后台": "Open admin console",
      "使用 Yume Account 登录": "Continue with Yume Account",
      "或使用临时 Key": "or use a temporary key",
      "临时 Key": "Temporary key",
      "使用 Key 登录": "Sign in with key",
      "返回公共首页": "Back to public page",
      "执行器与任务控制": "Agent and task control",
      "刷新": "Refresh",
      "退出登录": "Sign out",
      "管理菜单": "Admin menu",
      "控制台": "Console",
      "基础设置": "General settings",
      "任务计划": "Task schedules",
      "执行策略": "Agent policy",
      "科技管理": "Technology",
      "访问密钥": "Access keys",
      "成员管理": "Members",
      "运行记录": "Run history",
      "营地与公共展示": "Camp and public display",
      "自动任务时间": "Automation schedules",
      "科技目录、投票与固定科技": "Technology catalog, voting and fixed choices",
      "保存基础设置": "Save general settings",
      "保存任务计划": "Save task schedules",
      "保存执行策略": "Save agent policy",
      "保存科技配置": "Save technology settings",
      "当前配置已同步": "Settings are up to date",
      "任务运行记录": "Task history",
      "临时 Key": "Temporary keys",
      "名称或用途": "Name or purpose",
      "有效期至": "Expires at",
      "权限（全部不选即为仅预览）": "Permissions (none means preview only)",
      "生成 Key": "Generate key",
      "复制": "Copy",
      "次日科技投票": "Next-day technology vote",
      "游戏昵称（可选）": "In-game name (optional)",
      "提交投票": "Submit vote",
      "营地公告": "Camp notice",
      "营地公职": "Camp officers",
      "成员信息与贡献": "Members and contributions",
      "最近自动任务": "Recent automation",
      "营地名称": "Camp name",
      "服务器名称": "Server name",
      "站点名称": "Site name",
      "时区": "Time zone",
      "每日刷新": "Daily reset",
      "科技投票开放时间": "Technology voting opens",
      "科技投票截止时间": "Technology voting closes",
      "营地科技类型": "Camp technology type",
      "公开展示成员信息": "Show member information publicly",
      "开放临时 Key 登录": "Enable temporary-key sign-in",
      "公共公告": "Public notice",
      "营地亮点（每行一项）": "Camp highlights (one per line)",
      "启用": "Enabled",
      "执行时间": "Run time",
      "成员同步": "Member sync",
      "营地巡逻": "Camp patrol",
      "开始": "Start",
      "停止": "Stop",
      "最晚启动": "Latest start",
      "科技切换": "Technology switch",
      "任务": "Task",
      "状态": "Status",
      "进度": "Progress",
      "消息": "Message",
      "时间": "Time",
      "任务事件": "Task events",
      "关闭": "Close",
      "修改配置": "Edit settings",
      "执行任务": "Run tasks",
      "中断任务": "Interrupt tasks",
      "管理 Key": "Manage keys",
      "军事": "Military",
      "农业": "Agriculture",
      "工业": "Industry",
      "欢迎来到营地助手。": "Welcome to the camp assistant.",
      "中国大陆服务器": "Mainland China server",
      "军事科技": "Military technology",
      "农业科技": "Agricultural technology",
      "工业科技": "Industrial technology",
      "其他科技": "Other technologies",
      "每人最多选择 6 项科技。": "Each person may select up to 6 technologies.",
      "前置科技：{name}": "Prerequisite: {name}",
      "已同时选择前置科技：{name}": "Prerequisite selected too: {name}",
      "选择该科技及其前置科技后将超过 6 票。":
        "This technology and its prerequisite would exceed the 6-vote limit.",
      "取消前置科技时，依赖它的科技也会一并取消。":
        "Technologies that depend on the removed prerequisite were also deselected.",
      "全部可选科技（每人最多 6 票）": "All voting options (up to 6 votes per person)",
      "固定科技适用日期": "Fixed-technology day",
      "先选择日期，再从目录中设置当日固定科技；筛选只影响当前显示，不会改变已保存配置。":
        "Choose a date, then set its fixed technologies from the catalog. Filters only change what is shown and never alter saved settings.",
      "目录内置 53 项已核对科技和固定图标资产。实际切换时会先清空两行已有科技，再按固定科技优先、投票结果补足的顺序重建并点击完成。当前第一行为农业科技，农业行和其他科技行上限均为 6。":
        "The catalog contains 53 verified technologies and bundled icons. On each switch, both rows are cleared, fixed choices are restored first, and votes fill the remaining slots before confirmation. Row 1 is currently Agriculture; both rows allow up to 6.",
      "53 项科技": "53 technologies",
      "科技目录": "Technology catalog",
      "搜索科技": "Search technologies",
      "搜索科技名称或描述": "Search by technology name or description",
      "科技类别": "Technology category",
      "全部类别": "All categories",
      "投票概览": "Voting overview",
      "当前票数": "Current votes",
      "没有符合筛选条件的科技。": "No technologies match these filters.",
      "显示 {count} / {total} 项科技": "Showing {count} of {total} technologies",
      "空位": "Empty slot",
      "农业科技行": "Agricultural row",
      "其他科技行": "Other-technology row",
      "开放投票": "Open for voting",
      "固定": "Fixed",
      "等待首次同步": "Waiting for first sync",
      "管理员尚未开放科技投票。": "Technology voting is not open yet.",
      "公职数据等待同步。": "Officer data is waiting to sync.",
      "暂时没有成员同步数据。": "No member data has been synced yet.",
      "暂无自动任务记录。": "No automation runs yet.",
      "游戏昵称（可选）": "In-game name (optional)",
      "便于营地成员识别": "Helps camp members identify you",
      "搜索成员": "Search members",
      "搜索姓名、职业或同居": "Search name, profession or roommate",
      "返回营地助手首页": "Back to camp assistant",
      "类型科技（第一行）": "Type technology (row 1)",
      "通用科技（第二行）": "General technology (row 2)",
      "其他科技（第二行）": "Other technologies (row 2)",
      "农业科技（第一行）": "Agricultural technology (row 1)",
      "科技": " technology",
      "票": "votes",
      "公职": "Officer",
      "待同步": "Waiting to sync",
      "排队": "Queued",
      "已领取": "Claimed",
      "执行中": "Running",
      "中断中": "Cancelling",
      "已中断": "Interrupted",
      "成功": "Succeeded",
      "部分完成": "Partially completed",
      "失败": "Failed",
      "已超时": "Timed out",
      "已跳过": "Skipped",
      "共 {count} 人投票 · 截止 {closesAt}": "{count} voters · closes {closesAt}",
      "开放时间 {opensAt}–{closesAt} {timezone} · 共 {count} 人投票":
        "Open {opensAt}–{closesAt} {timezone} · {count} voters",
      "当前不在科技投票开放时间内。": "Technology voting is currently closed.",
      "更新于 {date}": "Updated {date}",
      "已同步 {date}": "Synced {date}",
      "尚未收到本地 Agent 心跳。": "No heartbeat from the local agent yet.",
      "按固定科技与投票结果开启次日科技":
        "Enable next-day technologies from fixed choices and vote results",
      "立即执行": "Run now",
      "更新科技": "Update technologies",
      "操作": "Actions",
      "更新职业、庄园、同居与公职，并以完整成员页刷新当前名单":
        "Update profession, manor, roommate and officer data, then refresh the current roster from the complete member page",
      "取消排队": "Cancel queued task",
      "终止任务": "Terminate task",
      "终止已提交": "Termination requested",
      "排队任务已终止": "Queued task terminated",
      "终止指令已发送": "Termination request sent",
      "轮询与无响应恢复": "Polling and unresponsive-game recovery",
      "设置执行器轮询节奏和游戏恢复策略。":
        "Configure agent polling and game recovery.",
      "轮询窗口 JSON 格式错误": "Invalid polling-window JSON",
      "完整成员同步": "Full member sync",
      "完整读取贡献、离线时间、职业、庄园、同居与公职，并替换当前成员名单":
        "Read contributions, offline time, professions, manors, roommates and officers, then replace the current roster",
      "组队、困难路线与定时古籍分享":
        "Team formation, hard route, and scheduled book-defense sharing",
      "全部时间使用上方时区": "All times use the time zone above",
      "启动": "Start",
      "最早开巡逻": "Earliest patrol start",
      "结束": "End",
      "分享间隔（分钟）": "Share interval (minutes)",
      "满员检测（秒）": "Full-team check (seconds)",
      "巡逻中内联执行": "Run inside patrol",
      "执行": "Run",
      "本周截止": "This-week cutoff",
      "仅配置变更后执行": "Only after settings change",
      "已应用": "Applied",
      "活动": "Event",
      "星期（1-7）": "Weekday (1–7)",
      "等级": "Level",
      "科技配置 JSON": "Technology settings JSON",
      "营地配置、任务执行与中断操作仅向授权的 Yume Account 开放。":
        "Camp settings, task execution and interruption are limited to authorized Yume Accounts.",
      "身份提供方取消了登录。": "Sign-in was cancelled at the identity provider.",
      "← 返回公共首页": "← Back to public page",
      "科技投票会在下一次科技切换任务执行前锁定。":
        "Technology voting locks before the next technology-switch task.",
      "成员贡献、职业、庄园等级与公职信息由每日同步任务更新。":
        "Daily sync updates contributions, professions, manor levels and officers.",
      "成员": "Member",
      "职业": "Profession",
      "庄园": "Manor",
      "同居": "Roommate",
      "本周贡献": "Weekly contribution",
      "使用科技点": "Tech points used",
      "贡献物资": "Materials contributed",
      "斩杀预警": "Removal warning",
      "当前没有达到预警线的成员。": "No members currently meet the warning threshold.",
      "根据营地惯例，离线超过 {days} 天的玩家可能会被请离营地。":
        "Under camp practice, players offline for more than {days} days may be removed.",
      "斩杀预警天数": "Warning threshold (days)",
      "自动踢出达到斩杀线的成员（默认关闭）": "Automatically remove members at the threshold (off by default)",
      "自动踢出宽限 N 天": "Automatic-removal grace days",
      "轮询、无响应恢复与任务例程": "Polling, recovery and task routines",
      "任务执行中轮询（秒）": "Active-task polling (seconds)",
      "默认空闲轮询（秒）": "Default idle polling (seconds)",
      "等待 Agent 接取超时（分钟）": "Agent claim timeout (minutes)",
      "游戏无响应自动重启": "Restart the game when unresponsive",
      "营地成员完整信息": "Full camp member information",
      "按最新斩杀线执行": "Run against the latest threshold",
      "踢出营地": "Remove from camp",
      "仅贡献": "Contribution only",
      "仅斩杀预警": "Warning scan only",
      "仅成员资料与公职": "Profiles and officers only",
      "踢出成员": "Remove members",
      "明日之后“愿”营地公共信息、科技投票与成员贡献":
        "LifeAfter “Wish” camp public information, technology voting, and member contributions",
      "登录 · 明日之后“愿”营地助手": "Sign in · LifeAfter “Wish” Camp Assistant",
      "管理后台 · 明日之后“愿”营地助手": "Admin · LifeAfter “Wish” Camp Assistant",
      "选择语言": "Select language",
      "选择主题": "Select theme",
      "自动": "Auto",
      "深色": "Dark",
      "浅色": "Light",
      "愿": "愿",
      "正在连接营地…": "Connecting to the camp…",
      "正在读取最新公共信息。": "Loading the latest public information.",
      "科技类型待配置": "Technology type pending configuration",
      "数据同步中": "Syncing data",
      "投票截止时间读取中。": "Loading the voting deadline.",
      "成员信息": "Member information",
      "未命名营地": "Unnamed camp",
      "投票已保存，可在截止前再次修改。":
        "Vote saved. You can change it again before the deadline.",
      "请至少选择一项科技。": "Select at least one technology.",
      "正在提交…": "Submitting…",
      "登录状态已失效，请重新登录。": "Your sign-in state expired. Please sign in again.",
      "Yume Account 登录状态已退出，请重新登录。":
        "Your Yume Account session ended. Please sign in again.",
      "身份提供方没有返回授权码。": "The identity provider did not return an authorization code.",
      "登录令牌交换失败，请稍后重试。": "Token exchange failed. Please try again later.",
      "无法读取账号信息，请稍后重试。":
        "Account information could not be loaded. Please try again later.",
      "当前账号未被授权进入营地管理后台。":
        "This account is not authorized to access the camp admin console.",
      "登录失败，请稍后重试。": "Sign-in failed. Please try again later.",
      "临时 Key 登录失败。": "Temporary-key sign-in failed.",
      "正在验证临时 Key…": "Verifying temporary key…",
      "正在验证身份": "Verifying identity",
      "登录已失效": "Session expired",
      "正在加载…": "Loading…",
      "正在保存…": "Saving…",
      "配置已保存": "Settings saved",
      "有未保存修改": "Unsaved changes",
      "科技配置 JSON 格式错误": "Invalid technology configuration JSON",
      "轮询窗口或任务例程 JSON 格式错误":
        "Invalid polling-window or task-routine JSON",
      "任务例程": "Task routines",
      "任务例程 JSON（groups 外层依次执行，内层同一时间触发）":
        "Task routine JSON (outer groups run in order; items in a group start together)",
      "分时轮询窗口 JSON（支持跨午夜，weekdays 为周一 1 至周日 7）":
        "Time-based polling window JSON (supports midnight crossover; weekdays are Monday 1 through Sunday 7)",
      "按后台配置的先后与同组关系执行":
        "Run using the configured order and parallel groups",
      "立即执行例程": "Run routine now",
      "健康检查（秒）": "Health check (seconds)",
      "动作超时（秒）": "Action timeout (seconds)",
      "画面冻结判定（秒）": "Frozen-screen threshold (seconds)",
      "最多重启次数": "Maximum restart attempts",
      "重启冷却（秒）": "Restart cooldown (seconds)",
      "更新贡献": "Update contributions",
      "更新斩杀预警": "Update removal warning",
      "更新成员资料": "Update member profiles",
      "仅从市政厅沙盘更新三项贡献数据":
        "Update only the three contribution values from the town hall sandbox",
      "仅从市政厅沙盘活跃页更新离线时间":
        "Update only offline time from the town hall Activity page",
      "仅更新职业、庄园、同居与公职":
        "Update only profession, manor, roommate, and officer data",
      "自动斩杀": "Automatic removal",
      "处理最新识别仍达到斩杀线的成员":
        "Process members who still meet the removal threshold after the latest scan",
      "从最新名单精确选择成员后执行":
        "Select the exact member from the latest roster before running",
      "将依据最新在线情况，把当前达到“预警天数＋宽限天数”的精确名单加入踢出任务。继续吗？":
        "Using the latest online status, add the exact members who meet “warning days + grace days” to the removal task. Continue?",
      "姓名不一致，已取消踢出": "Name mismatch; removal was cancelled",
      "当前没有达到斩杀线的成员": "No members currently meet the removal threshold",
      "中断": "Interrupt",
      "中断指令已发送": "Interrupt command sent",
      "事件": "Events",
      "暂无步骤事件。": "No step events yet.",
      "在线情况": "Online status",
      "离线": "Offline",
      "离线折算天数": "Converted offline days",
      "活跃采集时间": "Activity capture time",
      "资料采集时间": "Profile capture time",
      "庄园等级": "Manor level",
      "营地称号": "Camp title",
      "科技点": "Technology points",
      "物资": "Materials",
      "搜索姓名、职业、同居、离线时间":
        "Search name, profession, roommate, or offline time",
      "仅预览": "Preview only",
      "例如：巡逻代班 01": "Example: Patrol cover 01",
      "Key 明文只在创建时显示一次": "The plain-text key is shown only once when created",
      "请立即复制，此后无法再次查看": "Copy it now; it cannot be viewed again",
      "尚未生成临时 Key。": "No temporary key has been generated.",
      "临时 Key 已复制": "Temporary key copied",
      "撤销": "Revoke",
      "已撤销": "Revoked",
      "uiLabel 必须与游戏科技页面 OCR 文本一致；执行时会先清空两行已有科技，再按固定科技优先、投票结果补足的顺序重建。第一行仅允许当前营地类型，两个分区上限均不得超过 6。":
        "uiLabel must match the OCR text on the in-game technology page. Each run clears both existing rows, then rebuilds them using fixed choices first and vote results second. Row 1 only allows the current camp type, and neither section may exceed 6.",
      "{days} 天前": "{days} days ago",
      "公共数据加载失败：{message}": "Public data failed to load: {message}",
      "在线": "Online",
      "空闲 / {date}": "Idle / {date}",
      "待应用 {week}": "Pending {week}",
      "{count} 人投票": "{count} voters",
      "{name} · {votes} 票": "{name} · {votes} votes",
      "编号 {id}": "ID {id}",
      "有效期 {date}": "Expires {date}",
      "最近使用 {date}": "Last used {date}",
      "已开启：离线达到 {threshold} 天时按最新识别名单处理；当前候选 {count} 人。":
        "Enabled: process the latest recognized roster after {threshold} offline days; {count} current candidates.",
      "默认关闭。若开启，判定线为预警 {warning} 天＋宽限 {grace} 天。":
        "Off by default. When enabled, the threshold is {warning} warning days + {grace} grace days.",
      "高风险操作：将从市政厅沙盘踢出“{name}”。请输入完整成员姓名确认：":
        "High-risk action: remove “{name}” through the town hall sandbox. Enter the full member name to confirm:",
      "踢出 {name} 的任务已入队": "Removal task for {name} queued",
      "自动斩杀任务已入队，共 {count} 人": "Automatic-removal task queued for {count} members",
      "{task}已入队": "{task} queued"
    },
    fr: {
      "明日之后“愿”营地助手": "Assistant du camp « Vœu » LifeAfter",
      "管理后台": "Administration",
      "营地管理后台": "Administration du camp",
      "进入管理后台": "Ouvrir l’administration",
      "使用 Yume Account 登录": "Continuer avec Yume Account",
      "或使用临时 Key": "ou utiliser une clé temporaire",
      "临时 Key": "Clé temporaire",
      "使用 Key 登录": "Se connecter avec la clé",
      "返回公共首页": "Retour à la page publique",
      "执行器与任务控制": "Agent et contrôle des tâches",
      "刷新": "Actualiser",
      "退出登录": "Déconnexion",
      "管理菜单": "Menu d’administration",
      "控制台": "Console",
      "基础设置": "Paramètres généraux",
      "任务计划": "Planification",
      "执行策略": "Stratégie de l’agent",
      "科技管理": "Technologies",
      "访问密钥": "Clés d’accès",
      "成员管理": "Membres",
      "运行记录": "Historique",
      "营地与公共展示": "Camp et affichage public",
      "自动任务时间": "Horaires d’automatisation",
      "科技目录、投票与固定科技": "Technologies, votes et choix fixes",
      "保存基础设置": "Enregistrer les paramètres généraux",
      "保存任务计划": "Enregistrer la planification",
      "保存执行策略": "Enregistrer la stratégie",
      "保存科技配置": "Enregistrer les technologies",
      "当前配置已同步": "Paramètres à jour",
      "任务运行记录": "Historique des tâches",
      "临时 Key": "Clés temporaires",
      "名称或用途": "Nom ou usage",
      "有效期至": "Expire le",
      "权限（全部不选即为仅预览）": "Autorisations (aucune = aperçu seul)",
      "生成 Key": "Générer une clé",
      "复制": "Copier",
      "次日科技投票": "Vote technologique du lendemain",
      "游戏昵称（可选）": "Nom en jeu (facultatif)",
      "提交投票": "Envoyer le vote",
      "营地公告": "Annonce du camp",
      "营地公职": "Responsables du camp",
      "成员信息与贡献": "Membres et contributions",
      "最近自动任务": "Automatisations récentes",
      "营地名称": "Nom du camp",
      "服务器名称": "Nom du serveur",
      "站点名称": "Nom du site",
      "时区": "Fuseau horaire",
      "每日刷新": "Réinitialisation quotidienne",
      "科技投票开放时间": "Ouverture du vote technologique",
      "科技投票截止时间": "Clôture du vote technologique",
      "营地科技类型": "Type technologique du camp",
      "公开展示成员信息": "Afficher publiquement les membres",
      "开放临时 Key 登录": "Activer la connexion par clé temporaire",
      "公共公告": "Annonce publique",
      "营地亮点（每行一项）": "Points forts (un par ligne)",
      "启用": "Activé",
      "执行时间": "Heure d’exécution",
      "成员同步": "Synchronisation des membres",
      "营地巡逻": "Patrouille du camp",
      "开始": "Début",
      "停止": "Arrêt",
      "最晚启动": "Dernier démarrage",
      "科技切换": "Changement de technologie",
      "任务": "Tâche",
      "状态": "État",
      "进度": "Progression",
      "消息": "Message",
      "时间": "Heure",
      "任务事件": "Événements de la tâche",
      "关闭": "Fermer",
      "修改配置": "Modifier la configuration",
      "执行任务": "Exécuter des tâches",
      "中断任务": "Interrompre des tâches",
      "管理 Key": "Gérer les clés",
      "军事": "Militaire",
      "农业": "Agriculture",
      "工业": "Industrie",
      "欢迎来到营地助手。": "Bienvenue dans l’assistant du camp.",
      "中国大陆服务器": "Serveur de Chine continentale",
      "军事科技": "Technologie militaire",
      "农业科技": "Technologie agricole",
      "工业科技": "Technologie industrielle",
      "其他科技": "Autres technologies",
      "每人最多选择 6 项科技。": "Chaque personne peut choisir jusqu’à 6 technologies.",
      "前置科技：{name}": "Prérequis : {name}",
      "已同时选择前置科技：{name}": "Prérequis également sélectionné : {name}",
      "选择该科技及其前置科技后将超过 6 票。":
        "Cette technologie et son prérequis dépasseraient la limite de 6 votes.",
      "取消前置科技时，依赖它的科技也会一并取消。":
        "Les technologies dépendantes ont aussi été désélectionnées.",
      "全部可选科技（每人最多 6 票）": "Toutes les technologies (6 votes maximum par personne)",
      "固定科技适用日期": "Jour des technologies fixes",
      "先选择日期，再从目录中设置当日固定科技；筛选只影响当前显示，不会改变已保存配置。":
        "Choisissez une date, puis définissez ses technologies fixes depuis le catalogue. Les filtres modifient uniquement l’affichage.",
      "目录内置 53 项已核对科技和固定图标资产。实际切换时会先清空两行已有科技，再按固定科技优先、投票结果补足的顺序重建并点击完成。当前第一行为农业科技，农业行和其他科技行上限均为 6。":
        "Le catalogue contient 53 technologies vérifiées et leurs icônes. À chaque changement, les deux rangées sont vidées, les choix fixes sont restaurés, puis les votes complètent les places avant confirmation. La première rangée est agricole et chaque rangée accepte jusqu’à 6 choix.",
      "53 项科技": "53 technologies",
      "科技目录": "Catalogue technologique",
      "搜索科技": "Rechercher des technologies",
      "搜索科技名称或描述": "Rechercher par nom ou description",
      "科技类别": "Catégorie technologique",
      "全部类别": "Toutes les catégories",
      "投票概览": "Aperçu des votes",
      "当前票数": "Votes actuels",
      "没有符合筛选条件的科技。": "Aucune technologie ne correspond à ces filtres.",
      "显示 {count} / {total} 项科技": "{count} technologies affichées sur {total}",
      "空位": "Emplacement vide",
      "农业科技行": "Ligne agricole",
      "其他科技行": "Ligne des autres technologies",
      "开放投票": "Ouvrir au vote",
      "固定": "Fixe",
      "等待首次同步": "En attente de la première synchronisation",
      "管理员尚未开放科技投票。": "Le vote technologique n’est pas encore ouvert.",
      "公职数据等待同步。": "Les responsables attendent la synchronisation.",
      "暂时没有成员同步数据。": "Aucune donnée de membre synchronisée.",
      "暂无自动任务记录。": "Aucune automatisation pour le moment.",
      "游戏昵称（可选）": "Nom en jeu (facultatif)",
      "便于营地成员识别": "Aide les membres à vous identifier",
      "搜索成员": "Rechercher un membre",
      "搜索姓名、职业或同居": "Nom, profession ou cohabitant",
      "返回营地助手首页": "Retour à l’assistant du camp",
      "类型科技（第一行）": "Technologie du type (ligne 1)",
      "通用科技（第二行）": "Technologie générale (ligne 2)",
      "其他科技（第二行）": "Autres technologies (ligne 2)",
      "农业科技（第一行）": "Technologie agricole (ligne 1)",
      "科技": " technologie",
      "票": "votes",
      "公职": "Responsable",
      "待同步": "En attente",
      "排队": "En file",
      "已领取": "Attribuée",
      "执行中": "En cours",
      "中断中": "Interruption",
      "已中断": "Interrompue",
      "成功": "Réussie",
      "部分完成": "Partiellement terminée",
      "失败": "Échouée",
      "已超时": "Expirée",
      "已跳过": "Ignorée",
      "共 {count} 人投票 · 截止 {closesAt}": "{count} votants · clôture {closesAt}",
      "开放时间 {opensAt}–{closesAt} {timezone} · 共 {count} 人投票":
        "Ouvert de {opensAt} à {closesAt} {timezone} · {count} votants",
      "当前不在科技投票开放时间内。": "Le vote technologique est actuellement fermé.",
      "更新于 {date}": "Mis à jour {date}",
      "已同步 {date}": "Synchronisé {date}",
      "尚未收到本地 Agent 心跳。": "Aucun signal de l’agent local.",
      "按固定科技与投票结果开启次日科技":
        "Activer les technologies du lendemain selon les choix fixes et les votes",
      "立即执行": "Exécuter",
      "更新科技": "Mettre à jour les technologies",
      "操作": "Actions",
      "更新职业、庄园、同居与公职，并以完整成员页刷新当前名单":
        "Mettre à jour profession, manoir, cohabitant et responsables, puis actualiser la liste depuis la page complète",
      "取消排队": "Annuler la tâche en attente",
      "终止任务": "Arrêter la tâche",
      "终止已提交": "Arrêt demandé",
      "排队任务已终止": "Tâche en attente arrêtée",
      "终止指令已发送": "Demande d’arrêt envoyée",
      "轮询与无响应恢复": "Interrogation et récupération du jeu",
      "设置执行器轮询节奏和游戏恢复策略。":
        "Configurer l’interrogation de l’agent et la récupération du jeu.",
      "轮询窗口 JSON 格式错误": "JSON des fenêtres d’interrogation invalide",
      "完整成员同步": "Synchronisation complète des membres",
      "完整读取贡献、离线时间、职业、庄园、同居与公职，并替换当前成员名单":
        "Lire contributions, absence, professions, manoirs, cohabitants et responsables, puis remplacer la liste actuelle",
      "组队、困难路线与定时古籍分享":
        "Équipe, route difficile et partage planifié des livres",
      "全部时间使用上方时区": "Toutes les heures utilisent le fuseau ci-dessus",
      "启动": "Démarrage",
      "最早开巡逻": "Début de patrouille au plus tôt",
      "结束": "Fin",
      "分享间隔（分钟）": "Intervalle de partage (minutes)",
      "满员检测（秒）": "Vérification équipe complète (secondes)",
      "巡逻中内联执行": "Exécuter dans la patrouille",
      "执行": "Exécution",
      "本周截止": "Limite de la semaine",
      "仅配置变更后执行": "Seulement après modification",
      "已应用": "Appliqué",
      "活动": "Événement",
      "星期（1-7）": "Jour (1–7)",
      "等级": "Niveau",
      "科技配置 JSON": "Configuration JSON des technologies",
      "营地配置、任务执行与中断操作仅向授权的 Yume Account 开放。":
        "La configuration et le contrôle des tâches sont réservés aux comptes Yume autorisés.",
      "身份提供方取消了登录。": "La connexion a été annulée auprès du fournisseur d’identité.",
      "← 返回公共首页": "← Retour à la page publique",
      "科技投票会在下一次科技切换任务执行前锁定。":
        "Le vote se verrouille avant le prochain changement de technologie.",
      "成员贡献、职业、庄园等级与公职信息由每日同步任务更新。":
        "La synchronisation quotidienne actualise contributions, professions, manoirs et responsables.",
      "成员": "Membre",
      "职业": "Profession",
      "庄园": "Manoir",
      "同居": "Cohabitant",
      "本周贡献": "Contribution hebdomadaire",
      "使用科技点": "Points technologiques utilisés",
      "贡献物资": "Ressources contribuées",
      "斩杀预警": "Alerte de retrait",
      "当前没有达到预警线的成员。": "Aucun membre n’atteint actuellement le seuil d’alerte.",
      "根据营地惯例，离线超过 {days} 天的玩家可能会被请离营地。":
        "Selon les usages du camp, les joueurs hors ligne depuis plus de {days} jours peuvent être exclus.",
      "斩杀预警天数": "Seuil d’alerte (jours)",
      "自动踢出达到斩杀线的成员（默认关闭）": "Exclure automatiquement au seuil (désactivé par défaut)",
      "自动踢出宽限 N 天": "Jours de grâce avant exclusion",
      "轮询、无响应恢复与任务例程": "Interrogation, récupération et routines",
      "任务执行中轮询（秒）": "Interrogation en tâche (secondes)",
      "默认空闲轮询（秒）": "Interrogation au repos (secondes)",
      "等待 Agent 接取超时（分钟）": "Délai d’attribution à l’agent (minutes)",
      "游戏无响应自动重启": "Redémarrer le jeu s’il ne répond plus",
      "营地成员完整信息": "Informations complètes des membres",
      "按最新斩杀线执行": "Exécuter selon le dernier seuil",
      "踢出营地": "Exclure du camp",
      "仅贡献": "Contributions uniquement",
      "仅斩杀预警": "Alerte uniquement",
      "仅成员资料与公职": "Profils et responsables uniquement",
      "踢出成员": "Exclure des membres",
      "明日之后“愿”营地公共信息、科技投票与成员贡献":
        "Informations publiques, vote technologique et contributions du camp « Vœu » de LifeAfter",
      "登录 · 明日之后“愿”营地助手": "Connexion · Assistant du camp « Vœu » LifeAfter",
      "管理后台 · 明日之后“愿”营地助手": "Administration · Camp « Vœu » LifeAfter",
      "选择语言": "Choisir la langue",
      "选择主题": "Choisir le thème",
      "自动": "Automatique",
      "深色": "Sombre",
      "浅色": "Clair",
      "愿": "愿",
      "正在连接营地…": "Connexion au camp…",
      "正在读取最新公共信息。": "Chargement des dernières informations publiques.",
      "科技类型待配置": "Type technologique à configurer",
      "数据同步中": "Synchronisation des données",
      "投票截止时间读取中。": "Chargement de la date limite du vote.",
      "成员信息": "Informations des membres",
      "未命名营地": "Camp sans nom",
      "投票已保存，可在截止前再次修改。":
        "Vote enregistré. Vous pouvez le modifier avant la date limite.",
      "请至少选择一项科技。": "Sélectionnez au moins une technologie.",
      "正在提交…": "Envoi…",
      "登录状态已失效，请重新登录。": "Votre session a expiré. Reconnectez-vous.",
      "Yume Account 登录状态已退出，请重新登录。":
        "Votre session Yume Account est terminée. Reconnectez-vous.",
      "身份提供方没有返回授权码。":
        "Le fournisseur d’identité n’a pas renvoyé de code d’autorisation.",
      "登录令牌交换失败，请稍后重试。":
        "Échec de l’échange du jeton. Réessayez plus tard.",
      "无法读取账号信息，请稍后重试。":
        "Impossible de lire les informations du compte. Réessayez plus tard.",
      "当前账号未被授权进入营地管理后台。":
        "Ce compte n’est pas autorisé à accéder à l’administration du camp.",
      "登录失败，请稍后重试。": "Échec de la connexion. Réessayez plus tard.",
      "临时 Key 登录失败。": "Échec de la connexion avec la clé temporaire.",
      "正在验证临时 Key…": "Vérification de la clé temporaire…",
      "正在验证身份": "Vérification de l’identité",
      "登录已失效": "Session expirée",
      "正在加载…": "Chargement…",
      "正在保存…": "Enregistrement…",
      "配置已保存": "Paramètres enregistrés",
      "有未保存修改": "Modifications non enregistrées",
      "科技配置 JSON 格式错误": "JSON de configuration technologique invalide",
      "轮询窗口或任务例程 JSON 格式错误":
        "JSON des fenêtres d’interrogation ou des routines invalide",
      "任务例程": "Routines de tâches",
      "任务例程 JSON（groups 外层依次执行，内层同一时间触发）":
        "JSON des routines (les groupes externes sont séquentiels, les éléments internes démarrent ensemble)",
      "分时轮询窗口 JSON（支持跨午夜，weekdays 为周一 1 至周日 7）":
        "JSON des fenêtres d’interrogation (minuit pris en charge ; weekdays va de lundi 1 à dimanche 7)",
      "按后台配置的先后与同组关系执行":
        "Exécuter selon l’ordre et les groupes parallèles configurés",
      "立即执行例程": "Exécuter la routine",
      "健康检查（秒）": "Contrôle de santé (secondes)",
      "动作超时（秒）": "Délai d’action (secondes)",
      "画面冻结判定（秒）": "Seuil d’écran figé (secondes)",
      "最多重启次数": "Nombre maximal de redémarrages",
      "重启冷却（秒）": "Délai entre redémarrages (secondes)",
      "更新贡献": "Mettre à jour les contributions",
      "更新斩杀预警": "Mettre à jour l’alerte de retrait",
      "更新成员资料": "Mettre à jour les profils",
      "仅从市政厅沙盘更新三项贡献数据":
        "Mettre à jour uniquement les trois contributions depuis la table de la mairie",
      "仅从市政厅沙盘活跃页更新离线时间":
        "Mettre à jour uniquement l’absence depuis la page Activité de la mairie",
      "仅更新职业、庄园、同居与公职":
        "Mettre à jour uniquement profession, manoir, cohabitant et responsables",
      "自动斩杀": "Retrait automatique",
      "处理最新识别仍达到斩杀线的成员":
        "Traiter les membres encore au seuil après la dernière analyse",
      "从最新名单精确选择成员后执行":
        "Sélectionner précisément le membre dans la dernière liste avant exécution",
      "将依据最新在线情况，把当前达到“预警天数＋宽限天数”的精确名单加入踢出任务。继续吗？":
        "Selon le dernier état en ligne, ajouter à la tâche de retrait les membres atteignant « jours d’alerte + jours de grâce ». Continuer ?",
      "姓名不一致，已取消踢出": "Nom différent ; retrait annulé",
      "当前没有达到斩杀线的成员": "Aucun membre n’atteint le seuil de retrait",
      "中断": "Interrompre",
      "中断指令已发送": "Commande d’interruption envoyée",
      "事件": "Événements",
      "暂无步骤事件。": "Aucun événement d’étape.",
      "在线情况": "État en ligne",
      "离线": "Hors ligne",
      "离线折算天数": "Jours d’absence convertis",
      "活跃采集时间": "Collecte de l’activité",
      "资料采集时间": "Collecte du profil",
      "庄园等级": "Niveau du manoir",
      "营地称号": "Titre du camp",
      "科技点": "Points technologiques",
      "物资": "Ressources",
      "搜索姓名、职业、同居、离线时间":
        "Rechercher nom, profession, cohabitant ou absence",
      "仅预览": "Aperçu uniquement",
      "例如：巡逻代班 01": "Exemple : Remplacement patrouille 01",
      "Key 明文只在创建时显示一次":
        "La clé en clair n’est affichée qu’une fois lors de sa création",
      "请立即复制，此后无法再次查看":
        "Copiez-la maintenant ; elle ne pourra plus être affichée",
      "尚未生成临时 Key。": "Aucune clé temporaire n’a été générée.",
      "临时 Key 已复制": "Clé temporaire copiée",
      "撤销": "Révoquer",
      "已撤销": "Révoquée",
      "uiLabel 必须与游戏科技页面 OCR 文本一致；执行时会先清空两行已有科技，再按固定科技优先、投票结果补足的顺序重建。第一行仅允许当前营地类型，两个分区上限均不得超过 6。":
        "uiLabel doit correspondre au texte OCR de la page technologique du jeu. Chaque exécution efface les deux lignes, puis les reconstruit avec les choix fixes avant les résultats du vote. La première ligne est limitée au type actuel du camp et chaque section est limitée à 6.",
      "{days} 天前": "il y a {days} jours",
      "公共数据加载失败：{message}": "Échec du chargement des données publiques : {message}",
      "在线": "En ligne",
      "空闲 / {date}": "Inactif / {date}",
      "待应用 {week}": "À appliquer : {week}",
      "{count} 人投票": "{count} votants",
      "{name} · {votes} 票": "{name} · {votes} votes",
      "编号 {id}": "ID {id}",
      "有效期 {date}": "Expire le {date}",
      "最近使用 {date}": "Dernière utilisation {date}",
      "已开启：离线达到 {threshold} 天时按最新识别名单处理；当前候选 {count} 人。":
        "Activé : traitement de la dernière liste après {threshold} jours hors ligne ; {count} candidats actuels.",
      "默认关闭。若开启，判定线为预警 {warning} 天＋宽限 {grace} 天。":
        "Désactivé par défaut. Une fois activé, le seuil est de {warning} jours d’alerte + {grace} jours de grâce.",
      "高风险操作：将从市政厅沙盘踢出“{name}”。请输入完整成员姓名确认：":
        "Action à risque : exclure « {name} » depuis la table de la mairie. Saisissez le nom complet pour confirmer :",
      "踢出 {name} 的任务已入队": "Tâche d’exclusion de {name} mise en file",
      "自动斩杀任务已入队，共 {count} 人":
        "Tâche d’exclusion automatique mise en file pour {count} membres",
      "{task}已入队": "{task} mis en file"
    },
    ja: {
      "明日之后“愿”营地助手": "ライフアフター「願」野営地アシスタント",
      "管理后台": "管理画面",
      "营地管理后台": "野営地管理画面",
      "进入管理后台": "管理画面を開く",
      "使用 Yume Account 登录": "Yume Accountで続行",
      "或使用临时 Key": "または一時キーを使用",
      "临时 Key": "一時キー",
      "使用 Key 登录": "キーでログイン",
      "返回公共首页": "公開ページへ戻る",
      "执行器与任务控制": "エージェントとタスク制御",
      "刷新": "更新",
      "退出登录": "ログアウト",
      "管理菜单": "管理メニュー",
      "控制台": "コンソール",
      "基础设置": "基本設定",
      "任务计划": "タスク計画",
      "执行策略": "実行ポリシー",
      "科技管理": "技術管理",
      "访问密钥": "アクセスキー",
      "成员管理": "メンバー管理",
      "运行记录": "実行履歴",
      "营地与公共展示": "野営地と公開表示",
      "自动任务时间": "自動タスク時刻",
      "科技目录、投票与固定科技": "技術一覧・投票・固定技術",
      "保存基础设置": "基本設定を保存",
      "保存任务计划": "タスク計画を保存",
      "保存执行策略": "実行ポリシーを保存",
      "保存科技配置": "技術設定を保存",
      "当前配置已同步": "設定は最新です",
      "任务运行记录": "タスク履歴",
      "临时 Key": "一時キー",
      "名称或用途": "名前または用途",
      "有效期至": "有効期限",
      "权限（全部不选即为仅预览）": "権限（未選択は閲覧のみ）",
      "生成 Key": "キーを生成",
      "复制": "コピー",
      "次日科技投票": "翌日の技術投票",
      "提交投票": "投票する",
      "营地公告": "野営地のお知らせ",
      "营地公职": "野営地役職",
      "成员信息与贡献": "メンバーと貢献",
      "最近自动任务": "最近の自動タスク",
      "营地名称": "野営地名",
      "服务器名称": "サーバー名",
      "站点名称": "サイト名",
      "时区": "タイムゾーン",
      "每日刷新": "毎日のリセット",
      "科技投票开放时间": "技術投票の開始時刻",
      "科技投票截止时间": "技術投票の締切時刻",
      "营地科技类型": "野営地技術タイプ",
      "公开展示成员信息": "メンバー情報を公開",
      "开放临时 Key 登录": "一時キーのログインを有効化",
      "公共公告": "公開のお知らせ",
      "营地亮点（每行一项）": "野営地の特徴（1行1件）",
      "启用": "有効",
      "执行时间": "実行時刻",
      "成员同步": "メンバー同期",
      "营地巡逻": "野営地パトロール",
      "开始": "開始",
      "停止": "停止",
      "最晚启动": "最終開始",
      "科技切换": "技術切り替え",
      "任务": "タスク",
      "状态": "状態",
      "进度": "進捗",
      "消息": "メッセージ",
      "时间": "時刻",
      "任务事件": "タスクイベント",
      "关闭": "閉じる",
      "修改配置": "設定変更",
      "执行任务": "タスク実行",
      "中断任务": "タスク中断",
      "管理 Key": "キー管理",
      "军事": "軍事",
      "农业": "農業",
      "工业": "工業",
      "欢迎来到营地助手。": "野営地アシスタントへようこそ。",
      "中国大陆服务器": "中国大陸サーバー",
      "军事科技": "軍事技術",
      "农业科技": "農業技術",
      "工业科技": "工業技術",
      "其他科技": "その他の技術",
      "每人最多选择 6 项科技。": "1人につき最大6件まで選択できます。",
      "前置科技：{name}": "前提技術：{name}",
      "已同时选择前置科技：{name}": "前提技術も選択しました：{name}",
      "选择该科技及其前置科技后将超过 6 票。":
        "この技術と前提技術を選ぶと6票の上限を超えます。",
      "取消前置科技时，依赖它的科技也会一并取消。":
        "前提技術を外したため、依存する技術も選択解除しました。",
      "全部可选科技（每人最多 6 票）": "投票可能な全技術（1人最大6票）",
      "固定科技适用日期": "固定技術の曜日",
      "先选择日期，再从目录中设置当日固定科技；筛选只影响当前显示，不会改变已保存配置。":
        "日付を選び、一覧からその日の固定技術を設定します。絞り込みは表示だけに作用し、保存済み設定は変更しません。",
      "目录内置 53 项已核对科技和固定图标资产。实际切换时会先清空两行已有科技，再按固定科技优先、投票结果补足的顺序重建并点击完成。当前第一行为农业科技，农业行和其他科技行上限均为 6。":
        "一覧には確認済みの53技術と固定アイコンが含まれます。切替時は両行を空にし、固定技術を優先して復元した後、投票結果で残りを補って確定します。現在の1行目は農業で、各行の上限は6件です。",
      "53 项科技": "53件の技術",
      "科技目录": "技術一覧",
      "搜索科技": "技術を検索",
      "搜索科技名称或描述": "技術名または説明で検索",
      "科技类别": "技術カテゴリ",
      "全部类别": "すべてのカテゴリ",
      "投票概览": "投票概要",
      "当前票数": "現在の票数",
      "没有符合筛选条件的科技。": "条件に一致する技術はありません。",
      "显示 {count} / {total} 项科技": "{total}件中{count}件を表示",
      "空位": "空き枠",
      "农业科技行": "農業技術行",
      "其他科技行": "その他の技術行",
      "开放投票": "投票対象",
      "固定": "固定",
      "等待首次同步": "初回同期を待機中",
      "管理员尚未开放科技投票。": "技術投票はまだ開始されていません。",
      "公职数据等待同步。": "役職データの同期を待機中です。",
      "暂时没有成员同步数据。": "メンバーデータはまだありません。",
      "暂无自动任务记录。": "自動タスクの記録はありません。",
      "游戏昵称（可选）": "ゲーム内名（任意）",
      "便于营地成员识别": "野営地メンバーが識別しやすくなります",
      "搜索成员": "メンバーを検索",
      "搜索姓名、职业或同居": "名前・職業・同居人を検索",
      "返回营地助手首页": "野営地アシスタントへ戻る",
      "类型科技（第一行）": "タイプ技術（1行目）",
      "通用科技（第二行）": "共通技術（2行目）",
      "其他科技（第二行）": "その他の技術（2行目）",
      "农业科技（第一行）": "農業技術（1行目）",
      "科技": "技術",
      "票": "票",
      "公职": "役職",
      "待同步": "同期待ち",
      "排队": "待機中",
      "已领取": "取得済み",
      "执行中": "実行中",
      "中断中": "中断処理中",
      "已中断": "中断済み",
      "成功": "成功",
      "部分完成": "一部完了",
      "失败": "失敗",
      "已超时": "タイムアウト",
      "已跳过": "スキップ",
      "共 {count} 人投票 · 截止 {closesAt}": "{count}人が投票 · 締切 {closesAt}",
      "开放时间 {opensAt}–{closesAt} {timezone} · 共 {count} 人投票":
        "受付時間 {opensAt}～{closesAt} {timezone} · {count}人が投票",
      "当前不在科技投票开放时间内。": "現在は技術投票の受付時間外です。",
      "更新于 {date}": "更新 {date}",
      "已同步 {date}": "同期済み {date}",
      "尚未收到本地 Agent 心跳。": "ローカルエージェントの応答はまだありません。",
      "按固定科技与投票结果开启次日科技":
        "固定技術と投票結果から翌日の技術を有効化",
      "立即执行": "今すぐ実行",
      "更新科技": "技術を更新",
      "操作": "操作",
      "更新职业、庄园、同居与公职，并以完整成员页刷新当前名单":
        "職業・荘園・同居人・役職を更新し、完全なメンバーページから現在の名簿を更新",
      "取消排队": "待機タスクを取り消す",
      "终止任务": "タスクを終了",
      "终止已提交": "終了要求済み",
      "排队任务已终止": "待機タスクを終了しました",
      "终止指令已发送": "終了要求を送信しました",
      "轮询与无响应恢复": "ポーリングと無応答復旧",
      "设置执行器轮询节奏和游戏恢复策略。":
        "エージェントのポーリングとゲーム復旧を設定します。",
      "轮询窗口 JSON 格式错误": "ポーリング時間帯 JSON の形式が正しくありません",
      "完整成员同步": "メンバー完全同期",
      "完整读取贡献、离线时间、职业、庄园、同居与公职，并替换当前成员名单":
        "貢献・オフライン時間・職業・荘園・同居人・役職を読み取り、現在の名簿を置き換える",
      "组队、困难路线与定时古籍分享":
        "チーム編成・困難ルート・古籍の定期共有",
      "全部时间使用上方时区": "すべて上記タイムゾーンを使用",
      "启动": "開始",
      "最早开巡逻": "パトロール最早開始",
      "结束": "終了",
      "分享间隔（分钟）": "共有間隔（分）",
      "满员检测（秒）": "満員確認（秒）",
      "巡逻中内联执行": "パトロール内で実行",
      "执行": "実行",
      "本周截止": "今週の締切",
      "仅配置变更后执行": "設定変更時のみ実行",
      "已应用": "適用済み",
      "活动": "イベント",
      "星期（1-7）": "曜日（1–7）",
      "等级": "レベル",
      "科技配置 JSON": "技術設定 JSON",
      "营地配置、任务执行与中断操作仅向授权的 Yume Account 开放。":
        "野営地設定とタスク操作は許可された Yume Account のみ利用できます。",
      "身份提供方取消了登录。": "IDプロバイダーでログインがキャンセルされました。",
      "← 返回公共首页": "← 公開ページへ戻る",
      "科技投票会在下一次科技切换任务执行前锁定。":
        "技術投票は次回の技術切り替えタスク前に締め切られます。",
      "成员贡献、职业、庄园等级与公职信息由每日同步任务更新。":
        "毎日の同期で貢献・職業・荘園レベル・役職情報を更新します。",
      "成员": "メンバー",
      "职业": "職業",
      "庄园": "荘園",
      "同居": "同居",
      "本周贡献": "週間貢献",
      "使用科技点": "使用技術点",
      "贡献物资": "貢献物資",
      "斩杀预警": "除名警告",
      "当前没有达到预警线的成员。": "現在、警告基準に達したメンバーはいません。",
      "根据营地惯例，离线超过 {days} 天的玩家可能会被请离营地。":
        "キャンプの慣例により、{days}日を超えてオフラインのプレイヤーは除名される場合があります。",
      "斩杀预警天数": "警告日数",
      "自动踢出达到斩杀线的成员（默认关闭）": "基準到達メンバーを自動除名（初期設定はオフ）",
      "自动踢出宽限 N 天": "自動除名の猶予日数",
      "轮询、无响应恢复与任务例程": "ポーリング、無応答復旧、タスクルーチン",
      "任务执行中轮询（秒）": "タスク中のポーリング（秒）",
      "默认空闲轮询（秒）": "待機中のポーリング（秒）",
      "等待 Agent 接取超时（分钟）": "エージェント取得待ちタイムアウト（分）",
      "游戏无响应自动重启": "ゲーム無応答時に自動再起動",
      "营地成员完整信息": "野営地メンバー詳細",
      "按最新斩杀线执行": "最新基準で実行",
      "踢出营地": "野営地から除名",
      "仅贡献": "貢献のみ",
      "仅斩杀预警": "警告確認のみ",
      "仅成员资料与公职": "プロフィールと役職のみ",
      "踢出成员": "メンバーを除名",
      "明日之后“愿”营地公共信息、科技投票与成员贡献":
        "ライフアフター「願」野営地の公開情報・技術投票・メンバー貢献",
      "登录 · 明日之后“愿”营地助手": "ログイン · ライフアフター「願」野営地アシスタント",
      "管理后台 · 明日之后“愿”营地助手": "管理画面 · ライフアフター「願」野営地アシスタント",
      "选择语言": "言語を選択",
      "选择主题": "テーマを選択",
      "自动": "自動",
      "深色": "ダーク",
      "浅色": "ライト",
      "愿": "願",
      "正在连接营地…": "野営地に接続しています…",
      "正在读取最新公共信息。": "最新の公開情報を読み込んでいます。",
      "科技类型待配置": "技術タイプ未設定",
      "数据同步中": "データ同期中",
      "投票截止时间读取中。": "投票締切を読み込んでいます。",
      "成员信息": "メンバー情報",
      "未命名营地": "名称未設定の野営地",
      "投票已保存，可在截止前再次修改。":
        "投票を保存しました。締切前であれば再度変更できます。",
      "请至少选择一项科技。": "技術を1つ以上選択してください。",
      "正在提交…": "送信中…",
      "登录状态已失效，请重新登录。": "ログイン状態が失効しました。再度ログインしてください。",
      "Yume Account 登录状态已退出，请重新登录。":
        "Yume Account からログアウトしました。再度ログインしてください。",
      "身份提供方没有返回授权码。": "IDプロバイダーから認可コードが返されませんでした。",
      "登录令牌交换失败，请稍后重试。": "トークン交換に失敗しました。後でもう一度お試しください。",
      "无法读取账号信息，请稍后重试。":
        "アカウント情報を取得できません。後でもう一度お試しください。",
      "当前账号未被授权进入营地管理后台。":
        "このアカウントには野営地管理画面へのアクセス権がありません。",
      "登录失败，请稍后重试。": "ログインに失敗しました。後でもう一度お試しください。",
      "临时 Key 登录失败。": "一時キーでのログインに失敗しました。",
      "正在验证临时 Key…": "一時キーを確認しています…",
      "正在验证身份": "本人確認中",
      "登录已失效": "ログイン期限切れ",
      "正在加载…": "読み込み中…",
      "正在保存…": "保存中…",
      "配置已保存": "設定を保存しました",
      "有未保存修改": "未保存の変更があります",
      "科技配置 JSON 格式错误": "技術設定 JSON の形式が正しくありません",
      "轮询窗口或任务例程 JSON 格式错误":
        "ポーリング時間帯またはタスクルーチン JSON の形式が正しくありません",
      "任务例程": "タスクルーチン",
      "任务例程 JSON（groups 外层依次执行，内层同一时间触发）":
        "タスクルーチン JSON（外側の groups は順番に実行し、同じグループ内は同時に開始）",
      "分时轮询窗口 JSON（支持跨午夜，weekdays 为周一 1 至周日 7）":
        "時間帯別ポーリング JSON（日付またぎ対応、weekdays は月曜1〜日曜7）",
      "按后台配置的先后与同组关系执行": "設定された順序と並列グループに従って実行",
      "立即执行例程": "ルーチンを今すぐ実行",
      "健康检查（秒）": "ヘルスチェック（秒）",
      "动作超时（秒）": "操作タイムアウト（秒）",
      "画面冻结判定（秒）": "画面停止判定（秒）",
      "最多重启次数": "最大再起動回数",
      "重启冷却（秒）": "再起動クールダウン（秒）",
      "更新贡献": "貢献を更新",
      "更新斩杀预警": "除名警告を更新",
      "更新成员资料": "メンバー情報を更新",
      "仅从市政厅沙盘更新三项贡献数据":
        "市役所のサンドテーブルから3つの貢献値のみ更新",
      "仅从市政厅沙盘活跃页更新离线时间":
        "市役所の「アクティブ」ページからオフライン時間のみ更新",
      "仅更新职业、庄园、同居与公职": "職業・荘園・同居人・役職のみ更新",
      "自动斩杀": "自動除名",
      "处理最新识别仍达到斩杀线的成员":
        "最新認識後も除名基準に達しているメンバーを処理",
      "从最新名单精确选择成员后执行": "最新名簿から対象メンバーを正確に選択して実行",
      "将依据最新在线情况，把当前达到“预警天数＋宽限天数”的精确名单加入踢出任务。继续吗？":
        "最新のオンライン状況に基づき「警告日数＋猶予日数」に達した正確な名簿を除名タスクへ追加します。続行しますか？",
      "姓名不一致，已取消踢出": "名前が一致しないため除名を中止しました",
      "当前没有达到斩杀线的成员": "現在、除名基準に達したメンバーはいません",
      "中断": "中断",
      "中断指令已发送": "中断指示を送信しました",
      "事件": "イベント",
      "暂无步骤事件。": "ステップイベントはありません。",
      "在线情况": "オンライン状況",
      "离线": "オフライン",
      "离线折算天数": "換算オフライン日数",
      "活跃采集时间": "アクティブ取得日時",
      "资料采集时间": "プロフィール取得日時",
      "庄园等级": "荘園レベル",
      "营地称号": "野営地称号",
      "科技点": "技術点",
      "物资": "物資",
      "搜索姓名、职业、同居、离线时间": "名前・職業・同居人・オフライン時間を検索",
      "仅预览": "閲覧のみ",
      "例如：巡逻代班 01": "例：パトロール代行 01",
      "Key 明文只在创建时显示一次": "キーの平文は作成時に一度だけ表示されます",
      "请立即复制，此后无法再次查看": "今すぐコピーしてください。後から再表示できません",
      "尚未生成临时 Key。": "一時キーはまだ生成されていません。",
      "临时 Key 已复制": "一時キーをコピーしました",
      "撤销": "取り消す",
      "已撤销": "取り消し済み",
      "uiLabel 必须与游戏科技页面 OCR 文本一致；执行时会先清空两行已有科技，再按固定科技优先、投票结果补足的顺序重建。第一行仅允许当前营地类型，两个分区上限均不得超过 6。":
        "uiLabel はゲーム内技術ページの OCR テキストと一致させてください。実行時は既存の2行を消去し、固定技術を優先して投票結果で補完します。1行目は現在の野営地タイプのみ許可され、各区分の上限は6です。",
      "{days} 天前": "{days}日前",
      "公共数据加载失败：{message}": "公開データの読み込みに失敗しました：{message}",
      "在线": "オンライン",
      "空闲 / {date}": "待機中 / {date}",
      "待应用 {week}": "適用待ち {week}",
      "{count} 人投票": "{count}人が投票",
      "{name} · {votes} 票": "{name} · {votes}票",
      "编号 {id}": "ID {id}",
      "有效期 {date}": "有効期限 {date}",
      "最近使用 {date}": "最終使用 {date}",
      "已开启：离线达到 {threshold} 天时按最新识别名单处理；当前候选 {count} 人。":
        "有効：{threshold}日オフラインで最新認識名簿を処理します。現在の候補は{count}人です。",
      "默认关闭。若开启，判定线为预警 {warning} 天＋宽限 {grace} 天。":
        "初期設定はオフです。有効時の基準は警告{warning}日＋猶予{grace}日です。",
      "高风险操作：将从市政厅沙盘踢出“{name}”。请输入完整成员姓名确认：":
        "高リスク操作：市役所のサンドテーブルから「{name}」を除名します。確認のため完全なメンバー名を入力してください：",
      "踢出 {name} 的任务已入队": "{name} の除名タスクをキューに追加しました",
      "自动斩杀任务已入队，共 {count} 人":
        "{count}人の自動除名タスクをキューに追加しました",
      "{task}已入队": "{task}をキューに追加しました"
    },
    "zh-tw": {
      "明日之后“愿”营地助手": "明日之後「願」營地助手",
      "管理后台": "管理後台",
      "营地管理后台": "營地管理後台",
      "进入管理后台": "進入管理後台",
      "使用 Yume Account 登录": "使用 Yume Account 登入",
      "或使用临时 Key": "或使用臨時 Key",
      "临时 Key": "臨時 Key",
      "使用 Key 登录": "使用 Key 登入",
      "返回公共首页": "返回公共首頁",
      "执行器与任务控制": "執行器與任務控制",
      "刷新": "重新整理",
      "退出登录": "登出",
      "管理菜单": "管理選單",
      "控制台": "控制台",
      "基础设置": "基礎設定",
      "任务计划": "任務計畫",
      "执行策略": "執行策略",
      "科技管理": "科技管理",
      "访问密钥": "存取金鑰",
      "成员管理": "成員管理",
      "运行记录": "執行記錄",
      "营地与公共展示": "營地與公共展示",
      "自动任务时间": "自動任務時間",
      "科技目录、投票与固定科技": "科技目錄、投票與固定科技",
      "保存基础设置": "儲存基礎設定",
      "保存任务计划": "儲存任務計畫",
      "保存执行策略": "儲存執行策略",
      "保存科技配置": "儲存科技設定",
      "当前配置已同步": "目前設定已同步",
      "任务运行记录": "任務執行記錄",
      "临时 Key": "臨時 Key",
      "名称或用途": "名稱或用途",
      "有效期至": "有效期至",
      "权限（全部不选即为仅预览）": "權限（全部不選即為僅預覽）",
      "生成 Key": "產生 Key",
      "复制": "複製",
      "次日科技投票": "次日科技投票",
      "提交投票": "提交投票",
      "营地公告": "營地公告",
      "营地公职": "營地公職",
      "成员信息与贡献": "成員資訊與貢獻",
      "最近自动任务": "最近自動任務",
      "营地名称": "營地名稱",
      "服务器名称": "伺服器名稱",
      "站点名称": "站點名稱",
      "时区": "時區",
      "每日刷新": "每日重設",
      "科技投票开放时间": "科技投票開放時間",
      "科技投票截止时间": "科技投票截止時間",
      "营地科技类型": "營地科技類型",
      "公开展示成员信息": "公開展示成員資訊",
      "开放临时 Key 登录": "開放臨時 Key 登入",
      "公共公告": "公共公告",
      "营地亮点（每行一项）": "營地亮點（每行一項）",
      "启用": "啟用",
      "执行时间": "執行時間",
      "成员同步": "成員同步",
      "营地巡逻": "營地巡邏",
      "开始": "開始",
      "停止": "停止",
      "最晚启动": "最晚啟動",
      "科技切换": "科技切換",
      "任务": "任務",
      "状态": "狀態",
      "进度": "進度",
      "消息": "訊息",
      "时间": "時間",
      "任务事件": "任務事件",
      "关闭": "關閉",
      "修改配置": "修改設定",
      "执行任务": "執行任務",
      "中断任务": "中斷任務",
      "管理 Key": "管理 Key",
      "军事": "軍事",
      "农业": "農業",
      "工业": "工業",
      "欢迎来到营地助手。": "歡迎來到營地助手。",
      "中国大陆服务器": "中國大陸伺服器",
      "军事科技": "軍事科技",
      "农业科技": "農業科技",
      "工业科技": "工業科技",
      "其他科技": "其他科技",
      "每人最多选择 6 项科技。": "每人最多選擇 6 項科技。",
      "前置科技：{name}": "前置科技：{name}",
      "已同时选择前置科技：{name}": "已同時選擇前置科技：{name}",
      "选择该科技及其前置科技后将超过 6 票。":
        "選擇該科技及其前置科技後將超過 6 票。",
      "取消前置科技时，依赖它的科技也会一并取消。":
        "取消前置科技時，依賴它的科技也會一併取消。",
      "全部可选科技（每人最多 6 票）": "全部可選科技（每人最多 6 票）",
      "固定科技适用日期": "固定科技適用日期",
      "先选择日期，再从目录中设置当日固定科技；筛选只影响当前显示，不会改变已保存配置。":
        "先選擇日期，再從目錄設定當日固定科技；篩選只影響目前顯示，不會變更已儲存設定。",
      "目录内置 53 项已核对科技和固定图标资产。实际切换时会先清空两行已有科技，再按固定科技优先、投票结果补足的顺序重建并点击完成。当前第一行为农业科技，农业行和其他科技行上限均为 6。":
        "目錄內建 53 項已核對科技及固定圖示資產。實際切換時會先清空兩行既有科技，再依固定科技優先、投票結果補足的順序重建並點擊完成。目前第一行為農業科技，農業行與其他科技行上限皆為 6。",
      "53 项科技": "53 項科技",
      "科技目录": "科技目錄",
      "搜索科技": "搜尋科技",
      "搜索科技名称或描述": "搜尋科技名稱或描述",
      "科技类别": "科技類別",
      "全部类别": "全部類別",
      "投票概览": "投票概覽",
      "当前票数": "目前票數",
      "没有符合筛选条件的科技。": "沒有符合篩選條件的科技。",
      "显示 {count} / {total} 项科技": "顯示 {count} / {total} 項科技",
      "空位": "空位",
      "农业科技行": "農業科技行",
      "其他科技行": "其他科技行",
      "开放投票": "開放投票",
      "固定": "固定",
      "等待首次同步": "等待首次同步",
      "管理员尚未开放科技投票。": "管理員尚未開放科技投票。",
      "公职数据等待同步。": "公職資料等待同步。",
      "暂时没有成员同步数据。": "暫時沒有成員同步資料。",
      "暂无自动任务记录。": "暫無自動任務記錄。",
      "游戏昵称（可选）": "遊戲暱稱（可選）",
      "便于营地成员识别": "便於營地成員識別",
      "搜索成员": "搜尋成員",
      "搜索姓名、职业或同居": "搜尋姓名、職業或同居",
      "返回营地助手首页": "返回營地助手首頁",
      "类型科技（第一行）": "類型科技（第一行）",
      "通用科技（第二行）": "通用科技（第二行）",
      "其他科技（第二行）": "其他科技（第二行）",
      "农业科技（第一行）": "農業科技（第一行）",
      "科技": "科技",
      "票": "票",
      "公职": "公職",
      "待同步": "待同步",
      "排队": "排隊",
      "已领取": "已領取",
      "执行中": "執行中",
      "中断中": "中斷中",
      "已中断": "已中斷",
      "成功": "成功",
      "部分完成": "部分完成",
      "失败": "失敗",
      "已超时": "已逾時",
      "已跳过": "已跳過",
      "共 {count} 人投票 · 截止 {closesAt}": "共 {count} 人投票 · 截止 {closesAt}",
      "开放时间 {opensAt}–{closesAt} {timezone} · 共 {count} 人投票":
        "開放時間 {opensAt}–{closesAt} {timezone} · 共 {count} 人投票",
      "当前不在科技投票开放时间内。": "目前不在科技投票開放時間內。",
      "更新于 {date}": "更新於 {date}",
      "已同步 {date}": "已同步 {date}",
      "尚未收到本地 Agent 心跳。": "尚未收到本機 Agent 心跳。",
      "按固定科技与投票结果开启次日科技":
        "按固定科技與投票結果開啟次日科技",
      "立即执行": "立即執行",
      "更新科技": "更新科技",
      "操作": "操作",
      "更新职业、庄园、同居与公职，并以完整成员页刷新当前名单":
        "更新職業、莊園、同居與公職，並以完整成員頁重新整理目前名單",
      "取消排队": "取消排隊",
      "终止任务": "終止任務",
      "终止已提交": "已提交終止",
      "排队任务已终止": "排隊任務已終止",
      "终止指令已发送": "終止指令已傳送",
      "轮询与无响应恢复": "輪詢與無回應復原",
      "设置执行器轮询节奏和游戏恢复策略。":
        "設定執行器輪詢節奏和遊戲復原策略。",
      "轮询窗口 JSON 格式错误": "輪詢視窗 JSON 格式錯誤",
      "完整成员同步": "完整成員同步",
      "完整读取贡献、离线时间、职业、庄园、同居与公职，并替换当前成员名单":
        "完整讀取貢獻、離線時間、職業、莊園、同居與公職，並取代目前成員名單",
      "组队、困难路线与定时古籍分享":
        "組隊、困難路線與定時古籍分享",
      "全部时间使用上方时区": "全部時間使用上方時區",
      "启动": "啟動",
      "最早开巡逻": "最早開巡邏",
      "结束": "結束",
      "分享间隔（分钟）": "分享間隔（分鐘）",
      "满员检测（秒）": "滿員檢測（秒）",
      "巡逻中内联执行": "巡邏中內聯執行",
      "执行": "執行",
      "本周截止": "本週截止",
      "仅配置变更后执行": "僅設定變更後執行",
      "已应用": "已套用",
      "活动": "活動",
      "星期（1-7）": "星期（1-7）",
      "等级": "等級",
      "科技配置 JSON": "科技設定 JSON",
      "营地配置、任务执行与中断操作仅向授权的 Yume Account 开放。":
        "營地設定、任務執行與中斷操作僅向授權的 Yume Account 開放。",
      "身份提供方取消了登录。": "身分提供者取消了登入。",
      "← 返回公共首页": "← 返回公共首頁",
      "科技投票会在下一次科技切换任务执行前锁定。":
        "科技投票會在下一次科技切換任務執行前鎖定。",
      "成员贡献、职业、庄园等级与公职信息由每日同步任务更新。":
        "成員貢獻、職業、莊園等級與公職資訊由每日同步任務更新。",
      "成员": "成員",
      "职业": "職業",
      "庄园": "莊園",
      "同居": "同居",
      "本周贡献": "本週貢獻",
      "使用科技点": "使用科技點",
      "贡献物资": "貢獻物資",
      "斩杀预警": "斬殺預警",
      "当前没有达到预警线的成员。": "目前沒有達到預警線的成員。",
      "根据营地惯例，离线超过 {days} 天的玩家可能会被请离营地。":
        "根據營地慣例，離線超過 {days} 天的玩家可能會被請離營地。",
      "斩杀预警天数": "斬殺預警天數",
      "自动踢出达到斩杀线的成员（默认关闭）": "自動踢出達到斬殺線的成員（預設關閉）",
      "自动踢出宽限 N 天": "自動踢出寬限 N 天",
      "轮询、无响应恢复与任务例程": "輪詢、無回應恢復與任務例程",
      "任务执行中轮询（秒）": "任務執行中輪詢（秒）",
      "默认空闲轮询（秒）": "預設閒置輪詢（秒）",
      "等待 Agent 接取超时（分钟）": "等待 Agent 接取逾時（分鐘）",
      "游戏无响应自动重启": "遊戲無回應自動重啟",
      "营地成员完整信息": "營地成員完整資訊",
      "按最新斩杀线执行": "按最新斬殺線執行",
      "踢出营地": "踢出營地",
      "仅贡献": "僅貢獻",
      "仅斩杀预警": "僅斬殺預警",
      "仅成员资料与公职": "僅成員資料與公職",
      "踢出成员": "踢出成員",
      "明日之后“愿”营地公共信息、科技投票与成员贡献":
        "明日之後「願」營地公共資訊、科技投票與成員貢獻",
      "登录 · 明日之后“愿”营地助手": "登入 · 明日之後「願」營地助手",
      "管理后台 · 明日之后“愿”营地助手": "管理後台 · 明日之後「願」營地助手",
      "选择语言": "選擇語言",
      "选择主题": "選擇主題",
      "自动": "自動",
      "深色": "深色",
      "浅色": "淺色",
      "愿": "願",
      "正在连接营地…": "正在連線營地…",
      "正在读取最新公共信息。": "正在讀取最新公共資訊。",
      "科技类型待配置": "科技類型待設定",
      "数据同步中": "資料同步中",
      "投票截止时间读取中。": "正在讀取投票截止時間。",
      "成员信息": "成員資訊",
      "未命名营地": "未命名營地",
      "投票已保存，可在截止前再次修改。": "投票已儲存，可在截止前再次修改。",
      "请至少选择一项科技。": "請至少選擇一項科技。",
      "正在提交…": "正在提交…",
      "登录状态已失效，请重新登录。": "登入狀態已失效，請重新登入。",
      "Yume Account 登录状态已退出，请重新登录。":
        "Yume Account 登入狀態已登出，請重新登入。",
      "身份提供方没有返回授权码。": "身分提供者沒有回傳授權碼。",
      "登录令牌交换失败，请稍后重试。": "登入權杖交換失敗，請稍後再試。",
      "无法读取账号信息，请稍后重试。": "無法讀取帳號資訊，請稍後再試。",
      "当前账号未被授权进入营地管理后台。": "目前帳號未獲授權進入營地管理後台。",
      "登录失败，请稍后重试。": "登入失敗，請稍後再試。",
      "临时 Key 登录失败。": "臨時 Key 登入失敗。",
      "正在验证临时 Key…": "正在驗證臨時 Key…",
      "正在验证身份": "正在驗證身分",
      "登录已失效": "登入已失效",
      "正在加载…": "正在載入…",
      "正在保存…": "正在儲存…",
      "配置已保存": "設定已儲存",
      "有未保存修改": "有未儲存的修改",
      "科技配置 JSON 格式错误": "科技設定 JSON 格式錯誤",
      "轮询窗口或任务例程 JSON 格式错误": "輪詢視窗或任務例程 JSON 格式錯誤",
      "任务例程": "任務例程",
      "任务例程 JSON（groups 外层依次执行，内层同一时间触发）":
        "任務例程 JSON（外層 groups 依序執行，同組內同時觸發）",
      "分时轮询窗口 JSON（支持跨午夜，weekdays 为周一 1 至周日 7）":
        "分時輪詢視窗 JSON（支援跨午夜，weekdays 為週一 1 至週日 7）",
      "按后台配置的先后与同组关系执行": "依後台設定的順序與同組關係執行",
      "立即执行例程": "立即執行例程",
      "健康检查（秒）": "健康檢查（秒）",
      "动作超时（秒）": "動作逾時（秒）",
      "画面冻结判定（秒）": "畫面凍結判定（秒）",
      "最多重启次数": "最多重新啟動次數",
      "重启冷却（秒）": "重新啟動冷卻（秒）",
      "更新贡献": "更新貢獻",
      "更新斩杀预警": "更新斬殺預警",
      "更新成员资料": "更新成員資料",
      "仅从市政厅沙盘更新三项贡献数据": "僅從市政廳沙盤更新三項貢獻資料",
      "仅从市政厅沙盘活跃页更新离线时间": "僅從市政廳沙盤活躍頁更新離線時間",
      "仅更新职业、庄园、同居与公职": "僅更新職業、莊園、同居與公職",
      "自动斩杀": "自動斬殺",
      "处理最新识别仍达到斩杀线的成员": "處理最新辨識後仍達到斬殺線的成員",
      "从最新名单精确选择成员后执行": "從最新名單精確選擇成員後執行",
      "将依据最新在线情况，把当前达到“预警天数＋宽限天数”的精确名单加入踢出任务。继续吗？":
        "將依據最新上線情況，把目前達到「預警天數＋寬限天數」的精確名單加入踢出任務。繼續嗎？",
      "姓名不一致，已取消踢出": "姓名不一致，已取消踢出",
      "当前没有达到斩杀线的成员": "目前沒有達到斬殺線的成員",
      "中断": "中斷",
      "中断指令已发送": "中斷指令已傳送",
      "事件": "事件",
      "暂无步骤事件。": "暫無步驟事件。",
      "在线情况": "上線情況",
      "离线": "離線",
      "离线折算天数": "離線折算天數",
      "活跃采集时间": "活躍採集時間",
      "资料采集时间": "資料採集時間",
      "庄园等级": "莊園等級",
      "营地称号": "營地稱號",
      "科技点": "科技點",
      "物资": "物資",
      "搜索姓名、职业、同居、离线时间": "搜尋姓名、職業、同居、離線時間",
      "仅预览": "僅預覽",
      "例如：巡逻代班 01": "例如：巡邏代班 01",
      "Key 明文只在创建时显示一次": "Key 明文只在建立時顯示一次",
      "请立即复制，此后无法再次查看": "請立即複製，此後無法再次查看",
      "尚未生成临时 Key。": "尚未產生臨時 Key。",
      "临时 Key 已复制": "臨時 Key 已複製",
      "撤销": "撤銷",
      "已撤销": "已撤銷",
      "uiLabel 必须与游戏科技页面 OCR 文本一致；执行时会先清空两行已有科技，再按固定科技优先、投票结果补足的顺序重建。第一行仅允许当前营地类型，两个分区上限均不得超过 6。":
        "uiLabel 必須與遊戲科技頁面 OCR 文字一致；執行時會先清空兩行既有科技，再依固定科技優先、投票結果補足的順序重建。第一行僅允許目前營地類型，兩個分區上限均不得超過 6。",
      "{days} 天前": "{days} 天前",
      "公共数据加载失败：{message}": "公共資料載入失敗：{message}",
      "在线": "上線",
      "空闲 / {date}": "閒置 / {date}",
      "待应用 {week}": "待套用 {week}",
      "{count} 人投票": "{count} 人投票",
      "{name} · {votes} 票": "{name} · {votes} 票",
      "编号 {id}": "編號 {id}",
      "有效期 {date}": "有效期 {date}",
      "最近使用 {date}": "最近使用 {date}",
      "已开启：离线达到 {threshold} 天时按最新识别名单处理；当前候选 {count} 人。":
        "已開啟：離線達到 {threshold} 天時依最新辨識名單處理；目前候選 {count} 人。",
      "默认关闭。若开启，判定线为预警 {warning} 天＋宽限 {grace} 天。":
        "預設關閉。若開啟，判定線為預警 {warning} 天＋寬限 {grace} 天。",
      "高风险操作：将从市政厅沙盘踢出“{name}”。请输入完整成员姓名确认：":
        "高風險操作：將從市政廳沙盤踢出「{name}」。請輸入完整成員姓名確認：",
      "踢出 {name} 的任务已入队": "踢出 {name} 的任務已排入佇列",
      "自动斩杀任务已入队，共 {count} 人": "自動斬殺任務已排入佇列，共 {count} 人",
      "{task}已入队": "{task}已排入佇列"
    }
  };

  const identityTranslations = {
    en: {
      "身份识别码（必填）": "Identity code (required)",
      "请输入身份识别码": "Enter your identity code",
      "请输入身份识别码。": "Enter your identity code.",
      "申请身份识别码": "Apply for an identity code",
      "申请延长识别码有效期": "Extend identity-code validity",
      "填写申请编号或身份识别码任一项，然后核对原申请信息。":
        "Enter either the application number or identity code, then verify the original application details.",
      "下一步：核对信息": "Next: verify details",
      "请填写申请编号或身份识别码":
        "Enter an application number or identity code.",
      "申请重新发行识别码": "Request code reissue",
      "申请重新发行身份识别码": "Request identity-code reissue",
      "请先在上方输入需要重新发行的身份识别码。":
        "Enter the identity code to reissue in the field above first.",
      "提交重新发行申请": "Submit reissue request",
      "重新发行申请已提交，申请编号：{number}。旧识别码已作废。":
        "Reissue request submitted under {number}. The old code is now invalid.",
      "申请重新发行身份识别码将作废旧识别码并更换一个新的识别码。":
        "Requesting a reissue invalidates the old code and replaces it with a new one.",
      "在识别码被盗用等情况下建议立即申请重新发行识别码。":
        "Request a reissue immediately if the code may have been stolen.",
      "新发行的识别码的有效期以审批为准。":
        "The new code’s validity period is determined during approval.",
      "申请重新发行识别码请输入玩家名称、申请时预留的邮箱、旧识别码的其一。":
        "To request a reissue, enter at least one of: player name, email saved with the application, or old identity code.",
      "旧身份识别码": "Old identity code",
      "请至少填写玩家名称、申请时预留邮箱或旧识别码中的一项。":
        "Enter at least a player name, the email saved with the application, or the old identity code.",
      "如果您是通过人工申请的识别码且预留信息不详细，请联系市长人工处理。":
        "If your code was issued manually and its saved information is incomplete, contact the mayor for manual help.",
      "投票未提交": "Vote not submitted",
      "接收识别码邮箱": "Email for receiving the code",
      "玩家名称": "Player name",
      "提交申请": "Submit application",
      "正在提交…": "Submitting…",
      "申请编号：{number}": "Application number: {number}",
      "申请已提交，申请编号：{number}。": "Application submitted. Application number: {number}.",
      "延期申请已提交，申请编号：{number}。原有效期内可正常投票；过期后审批期间可额外投票一次。":
        "Extension submitted under {number}. Voting remains normal until the original expiry; after expiry, one extra vote is allowed while approval is pending.",
      "小号及非本营地成员不得申请，否则申请将被审批拒绝。":
        "Alternate accounts and non-camp members must not apply; such applications will be rejected.",
      "忘记玩家名称请查询后再来申请，填写不实信息将被审批拒绝。":
        "Look up a forgotten player name before applying. False information will be rejected.",
      "玩家名称中的符号可以省略填写。": "Symbols in a player name may be omitted.",
      "玩家名称只有符号的，请联系市长人工申请。":
        "If the player name contains only symbols, contact the mayor for a manual application.",
      "身份识别码审批": "Identity-code approvals",
      "审批新申请及延期申请；每页显示10条。": "Review new and extension requests; 10 per page.",
      "身份识别码": "Identity codes",
      "查看、人工发行、禁用、修改有效期或重新发送识别码。":
        "View, manually issue, disable, extend or resend identity codes.",
      "SMTP 发信": "SMTP email",
      "Workers 直连 SMTP；支持 465 TLS 与 587 STARTTLS，不支持端口25。":
        "Workers connects directly to SMTP. Port 465 TLS and 587 STARTTLS are supported; port 25 is not.",
      "按申请编号搜索": "Search by application number",
      "审批状态": "Review status",
      "全部": "All",
      "待审批": "Pending",
      "已通过": "Approved",
      "已拒绝": "Rejected",
      "申请编号": "Application number",
      "类型": "Type",
      "语言": "Language",
      "提交时间": "Submitted",
      "上一页": "Previous",
      "下一页": "Next",
      "跳至": "Go to",
      "跳页": "Go",
      "玩家名称（可选）": "Player name (optional)",
      "接收邮箱（可选）": "Receiving email (optional)",
      "邮件语言": "Email language",
      "永久有效": "No expiration",
      "人工生成识别码": "Issue code manually",
      "搜索玩家或邮箱": "Search player or email",
      "识别码": "Identity code",
      "最后发信": "Last email",
      "启用 SMTP 发信": "Enable SMTP email",
      "SMTP 服务器": "SMTP server",
      "端口": "Port",
      "连接即使用 TLS（通常465）": "Use TLS on connect (usually 465)",
      "使用 STARTTLS（通常587）": "Use STARTTLS (usually 587)",
      "认证方式": "Authentication",
      "用户名": "Username",
      "密码": "Password",
      "留空则保留现有密码": "Leave blank to keep the current password",
      "发件邮箱": "From email",
      "发件名称": "From name",
      "回复邮箱（可选）": "Reply-to email (optional)",
      "保存 SMTP 配置": "Save SMTP settings",
      "测试收件邮箱": "Test recipient",
      "发送测试邮件": "Send test email",
      "审批身份识别码": "Review identity code",
      "发行有效期至": "Valid until",
      "拒绝原因（可选）": "Rejection reason (optional)",
      "通过并发送邮件": "Approve and send email",
      "拒绝并发送通知": "Reject and send notice",
      "营地公告列表（公告之间空一行；公告内可换行）":
        "Camp announcements (blank line between announcements; line breaks allowed)",
      "科技": "Technology",
      "科技类别": "Technology category",
      "公告编辑语言": "Announcement editing language",
      "管理身份识别码": "Manage identity codes",
      "管理 SMTP 发信": "Manage SMTP email",
      "管理 SMTP 配置": "Manage SMTP settings",
      "搜索申请编号、玩家或邮箱": "Search application number, player or email",
      "搜索识别码、玩家或邮箱": "Search code, player or email",
      "搜索": "Search",
      "识别码状态": "Code status",
      "过期": "Expired",
      "取消": "Cancelled",
      "恢复": "Restore",
      "已过期": "Expired",
      "尝试次数过多，请在 {seconds} 秒后重试。":
        "Too many attempts. Try again in {seconds} seconds.",
      "投票成功": "Vote successful",
      "识别码有效期：{date}": "Identity-code validity: {date}"
      ,
      "测试成功，本次提交不计票。": "Test successful. This submission was not counted.",
      "忘记识别码": "Forgot code"
      ,
      "找回身份识别码": "Recover identity code",
      "申请时预留的邮箱": "Email saved with the application",
      "请输入申请时预留的信息（至少一条）。":
        "Enter at least one item of information saved with your application.",
      "如果您是通过人工申请的识别码且预留信息不详细，请联系市长人工处理。":
        "If your code was issued manually and its saved information is incomplete, contact the mayor for manual help.",
      "找回的识别码将发送到申请时预留的邮箱，如果您更换了邮箱，请联系市长人工处理。":
        "The recovered code will be sent to the email saved with the application. If your email has changed, contact the mayor.",
      "申请编号（可选）": "Application number (optional)",
      "发送识别码到预留邮箱": "Send code to the saved email",
      "识别码已发送至预留邮箱。": "The code was sent to the saved email.",
      "识别码已发送至预留邮箱；该识别码已过期，可以申请延期。":
        "The code was sent to the saved email. It has expired and can be renewed.",
      "申请时预留的邮箱（可选）": "Email saved with the application (optional)"
    },
    fr: {
      "身份识别码（必填）": "Code d’identité (obligatoire)",
      "请输入身份识别码": "Saisissez votre code d’identité",
      "请输入身份识别码。": "Saisissez votre code d’identité.",
      "申请身份识别码": "Demander un code d’identité",
      "申请延长识别码有效期": "Prolonger la validité du code",
      "填写申请编号或身份识别码任一项，然后核对原申请信息。":
        "Saisissez le numéro de demande ou le code d’identité, puis vérifiez les informations de la demande d’origine.",
      "下一步：核对信息": "Suivant : vérifier les informations",
      "请填写申请编号或身份识别码":
        "Saisissez un numéro de demande ou un code d’identité.",
      "申请重新发行识别码": "Demander la réémission du code",
      "申请重新发行身份识别码": "Demander la réémission du code d’identité",
      "请先在上方输入需要重新发行的身份识别码。":
        "Saisissez d’abord ci-dessus le code d’identité à réémettre.",
      "提交重新发行申请": "Envoyer la demande de réémission",
      "重新发行申请已提交，申请编号：{number}。旧识别码已作废。":
        "Demande de réémission envoyée sous le numéro {number}. L’ancien code est désormais invalide.",
      "申请重新发行身份识别码将作废旧识别码并更换一个新的识别码。":
        "Une demande de réémission invalide l’ancien code et le remplace par un nouveau.",
      "在识别码被盗用等情况下建议立即申请重新发行识别码。":
        "Demandez immédiatement une réémission si le code a pu être volé.",
      "新发行的识别码的有效期以审批为准。":
        "La validité du nouveau code est définie lors de l’approbation.",
      "申请重新发行识别码请输入玩家名称、申请时预留的邮箱、旧识别码的其一。":
        "Pour demander une réémission, saisissez au moins le nom du joueur, l’e-mail enregistré ou l’ancien code.",
      "旧身份识别码": "Ancien code d’identité",
      "请至少填写玩家名称、申请时预留邮箱或旧识别码中的一项。":
        "Saisissez au moins le nom du joueur, l’e-mail enregistré ou l’ancien code.",
      "如果您是通过人工申请的识别码且预留信息不详细，请联系市长人工处理。":
        "Si votre code a été émis manuellement et que les informations enregistrées sont incomplètes, contactez le maire.",
      "投票未提交": "Vote non envoyé",
      "接收识别码邮箱": "E-mail de réception du code",
      "玩家名称": "Nom du joueur",
      "提交申请": "Envoyer la demande",
      "正在提交…": "Envoi…",
      "申请编号：{number}": "Numéro de demande : {number}",
      "申请已提交，申请编号：{number}。": "Demande envoyée. Numéro : {number}.",
      "延期申请已提交，申请编号：{number}。原有效期内可正常投票；过期后审批期间可额外投票一次。":
        "Prolongation envoyée sous le numéro {number}. Le vote reste normal jusqu’à l’expiration initiale ; après expiration, un vote supplémentaire est autorisé pendant l’examen.",
      "小号及非本营地成员不得申请，否则申请将被审批拒绝。":
        "Les comptes secondaires et les non-membres ne doivent pas postuler.",
      "忘记玩家名称请查询后再来申请，填写不实信息将被审批拒绝。":
        "Recherchez d’abord un nom oublié. Toute fausse information sera refusée.",
      "玩家名称中的符号可以省略填写。": "Les symboles du nom peuvent être omis.",
      "玩家名称只有符号的，请联系市长人工申请。":
        "Si le nom ne contient que des symboles, contactez le maire.",
      "身份识别码审批": "Approbation des codes",
      "审批新申请及延期申请；每页显示10条。": "Examinez les nouvelles demandes et prolongations, 10 par page.",
      "身份识别码": "Codes d’identité",
      "查看、人工发行、禁用、修改有效期或重新发送识别码。":
        "Consulter, émettre, désactiver, prolonger ou renvoyer les codes.",
      "SMTP 发信": "E-mail SMTP",
      "按申请编号搜索": "Rechercher par numéro",
      "审批状态": "État",
      "全部": "Tous",
      "待审批": "En attente",
      "已通过": "Approuvée",
      "已拒绝": "Refusée",
      "申请编号": "Numéro de demande",
      "类型": "Type",
      "语言": "Langue",
      "提交时间": "Envoyée",
      "上一页": "Précédente",
      "下一页": "Suivante",
      "跳至": "Aller à",
      "跳页": "Aller",
      "玩家名称（可选）": "Nom du joueur (facultatif)",
      "接收邮箱（可选）": "E-mail (facultatif)",
      "邮件语言": "Langue de l’e-mail",
      "永久有效": "Validité permanente",
      "人工生成识别码": "Émettre manuellement",
      "搜索玩家或邮箱": "Rechercher joueur ou e-mail",
      "识别码": "Code d’identité",
      "最后发信": "Dernier e-mail",
      "启用 SMTP 发信": "Activer les e-mails SMTP",
      "SMTP 服务器": "Serveur SMTP",
      "端口": "Port",
      "认证方式": "Authentification",
      "用户名": "Nom d’utilisateur",
      "密码": "Mot de passe",
      "发件邮箱": "Adresse d’envoi",
      "发件名称": "Nom d’expéditeur",
      "回复邮箱（可选）": "Adresse de réponse (facultative)",
      "保存 SMTP 配置": "Enregistrer SMTP",
      "测试收件邮箱": "Destinataire de test",
      "发送测试邮件": "Envoyer un test",
      "审批身份识别码": "Examiner le code",
      "发行有效期至": "Valable jusqu’au",
      "拒绝原因（可选）": "Motif du refus (facultatif)",
      "通过并发送邮件": "Approuver et envoyer",
      "拒绝并发送通知": "Refuser et notifier",
      "营地公告列表（公告之间空一行；公告内可换行）":
        "Annonces du camp (ligne vide entre annonces ; retours à la ligne autorisés)",
      "公告编辑语言": "Langue d’édition des annonces",
      "管理身份识别码": "Gérer les codes d’identité",
      "管理 SMTP 发信": "Gérer l’envoi SMTP",
      "管理 SMTP 配置": "Gérer la configuration SMTP",
      "搜索申请编号、玩家或邮箱": "Rechercher numéro, joueur ou e-mail",
      "搜索识别码、玩家或邮箱": "Rechercher code, joueur ou e-mail",
      "搜索": "Rechercher",
      "识别码状态": "État du code",
      "过期": "Expiré",
      "取消": "Annulé",
      "恢复": "Rétablir",
      "已过期": "Expiré",
      "尝试次数过多，请在 {seconds} 秒后重试。":
        "Trop de tentatives. Réessayez dans {seconds} secondes.",
      "投票成功": "Vote réussi",
      "识别码有效期：{date}": "Validité du code : {date}"
      ,
      "测试成功，本次提交不计票。": "Test réussi. Cet envoi n’a pas été comptabilisé.",
      "忘记识别码": "Code oublié"
      ,
      "找回身份识别码": "Récupérer le code d’identité",
      "申请时预留的邮箱": "E-mail enregistré lors de la demande",
      "请输入申请时预留的信息（至少一条）。":
        "Saisissez au moins une information enregistrée lors de la demande.",
      "如果您是通过人工申请的识别码且预留信息不详细，请联系市长人工处理。":
        "Si votre code a été émis manuellement et que les informations enregistrées sont incomplètes, contactez le maire.",
      "找回的识别码将发送到申请时预留的邮箱，如果您更换了邮箱，请联系市长人工处理。":
        "Le code récupéré sera envoyé à l’e-mail enregistré lors de la demande. Si votre adresse a changé, contactez le maire.",
      "申请编号（可选）": "Numéro de demande (facultatif)",
      "发送识别码到预留邮箱": "Envoyer le code à l’e-mail enregistré",
      "识别码已发送至预留邮箱。": "Le code a été envoyé à l’e-mail enregistré.",
      "识别码已发送至预留邮箱；该识别码已过期，可以申请延期。":
        "Le code a été envoyé. Il a expiré et peut être prolongé.",
      "申请时预留的邮箱（可选）": "E-mail enregistré lors de la demande (facultatif)"
    },
    ja: {
      "身份识别码（必填）": "本人確認コード（必須）",
      "请输入身份识别码": "本人確認コードを入力",
      "请输入身份识别码。": "本人確認コードを入力してください。",
      "申请身份识别码": "本人確認コードを申請",
      "申请延长识别码有效期": "本人確認コードの有効期限延長",
      "填写申请编号或身份识别码任一项，然后核对原申请信息。":
        "申請番号または本人確認コードのいずれかを入力し、元の申請情報を確認してください。",
      "下一步：核对信息": "次へ：情報を確認",
      "请填写申请编号或身份识别码":
        "申請番号または本人確認コードを入力してください。",
      "申请重新发行识别码": "コードの再発行を申請",
      "申请重新发行身份识别码": "本人確認コードの再発行を申請",
      "请先在上方输入需要重新发行的身份识别码。":
        "再発行する本人確認コードを上の欄に入力してください。",
      "提交重新发行申请": "再発行申請を送信",
      "重新发行申请已提交，申请编号：{number}。旧识别码已作废。":
        "申請番号 {number} で再発行を申請しました。旧コードは無効になりました。",
      "申请重新发行身份识别码将作废旧识别码并更换一个新的识别码。":
        "再発行を申請すると旧コードは無効になり、新しいコードに置き換わります。",
      "在识别码被盗用等情况下建议立即申请重新发行识别码。":
        "コードが盗用された可能性がある場合は、すぐに再発行を申請してください。",
      "新发行的识别码的有效期以审批为准。":
        "新しいコードの有効期限は審査時に決定されます。",
      "申请重新发行识别码请输入玩家名称、申请时预留的邮箱、旧识别码的其一。":
        "再発行申請では、プレイヤー名、登録メール、旧コードのいずれか1つ以上を入力してください。",
      "旧身份识别码": "旧本人確認コード",
      "请至少填写玩家名称、申请时预留邮箱或旧识别码中的一项。":
        "プレイヤー名、登録メール、旧コードのいずれか1つ以上を入力してください。",
      "如果您是通过人工申请的识别码且预留信息不详细，请联系市长人工处理。":
        "手動発行されたコードで登録情報が不十分な場合は、市長に手動対応を依頼してください。",
      "投票未提交": "投票は送信されませんでした",
      "接收识别码邮箱": "コード受信用メールアドレス",
      "玩家名称": "プレイヤー名",
      "提交申请": "申請を送信",
      "正在提交…": "送信中…",
      "申请编号：{number}": "申請番号：{number}",
      "申请已提交，申请编号：{number}。": "申請しました。申請番号：{number}。",
      "延期申请已提交，申请编号：{number}。原有效期内可正常投票；过期后审批期间可额外投票一次。":
        "申請番号 {number} で延長を申請しました。元の期限までは通常どおり投票でき、期限後は審査中に1回だけ追加投票できます。",
      "小号及非本营地成员不得申请，否则申请将被审批拒绝。":
        "サブアカウントおよび野営地外の方は申請できません。",
      "忘记玩家名称请查询后再来申请，填写不实信息将被审批拒绝。":
        "名前を確認してから申請してください。虚偽の情報は却下されます。",
      "玩家名称中的符号可以省略填写。": "プレイヤー名の記号は省略できます。",
      "玩家名称只有符号的，请联系市长人工申请。":
        "名前が記号のみの場合は市長に手動申請を依頼してください。",
      "身份识别码审批": "本人確認コード審査",
      "审批新申请及延期申请；每页显示10条。": "新規・延長申請を1ページ10件ずつ審査します。",
      "身份识别码": "本人確認コード",
      "查看、人工发行、禁用、修改有效期或重新发送识别码。":
        "コードの確認、手動発行、無効化、期限変更、再送信を行います。",
      "SMTP 发信": "SMTPメール",
      "按申请编号搜索": "申請番号で検索",
      "审批状态": "審査状態",
      "全部": "すべて",
      "待审批": "審査待ち",
      "已通过": "承認済み",
      "已拒绝": "却下済み",
      "申请编号": "申請番号",
      "类型": "種類",
      "语言": "言語",
      "提交时间": "申請日時",
      "上一页": "前へ",
      "下一页": "次へ",
      "跳至": "移動先",
      "跳页": "移動",
      "玩家名称（可选）": "プレイヤー名（任意）",
      "接收邮箱（可选）": "受信メール（任意）",
      "邮件语言": "メール言語",
      "永久有效": "無期限",
      "人工生成识别码": "コードを手動発行",
      "搜索玩家或邮箱": "プレイヤーまたはメールを検索",
      "识别码": "本人確認コード",
      "最后发信": "最終送信",
      "启用 SMTP 发信": "SMTPメールを有効化",
      "SMTP 服务器": "SMTPサーバー",
      "端口": "ポート",
      "认证方式": "認証方式",
      "用户名": "ユーザー名",
      "密码": "パスワード",
      "发件邮箱": "送信元メール",
      "发件名称": "送信者名",
      "回复邮箱（可选）": "返信先（任意）",
      "保存 SMTP 配置": "SMTP設定を保存",
      "测试收件邮箱": "テスト送信先",
      "发送测试邮件": "テストメールを送信",
      "审批身份识别码": "本人確認コードを審査",
      "发行有效期至": "有効期限",
      "拒绝原因（可选）": "却下理由（任意）",
      "通过并发送邮件": "承認してメール送信",
      "拒绝并发送通知": "却下して通知",
      "营地公告列表（公告之间空一行；公告内可换行）":
        "野営地のお知らせ（項目間は空行、項目内は改行可）",
      "公告编辑语言": "お知らせの編集言語",
      "管理身份识别码": "本人確認コードを管理",
      "管理 SMTP 发信": "SMTPメールを管理",
      "管理 SMTP 配置": "SMTP設定を管理",
      "搜索申请编号、玩家或邮箱": "申請番号・プレイヤー・メールを検索",
      "搜索识别码、玩家或邮箱": "コード・プレイヤー・メールを検索",
      "搜索": "検索",
      "识别码状态": "コードの状態",
      "过期": "期限切れ",
      "取消": "取消済み",
      "恢复": "復元",
      "已过期": "期限切れ",
      "尝试次数过多，请在 {seconds} 秒后重试。":
        "試行回数が多すぎます。{seconds}秒後に再試行してください。",
      "投票成功": "投票しました",
      "识别码有效期：{date}": "本人確認コードの有効期限：{date}"
      ,
      "测试成功，本次提交不计票。": "テストに成功しました。この送信は集計されません。",
      "忘记识别码": "コードを忘れた"
      ,
      "找回身份识别码": "本人確認コードを再送",
      "申请时预留的邮箱": "申請時に登録したメール",
      "请输入申请时预留的信息（至少一条）。":
        "申請時に登録した情報を1項目以上入力してください。",
      "如果您是通过人工申请的识别码且预留信息不详细，请联系市长人工处理。":
        "手動発行されたコードで登録情報が不十分な場合は、市長に手動対応を依頼してください。",
      "找回的识别码将发送到申请时预留的邮箱，如果您更换了邮箱，请联系市长人工处理。":
        "コードは申請時に登録したメールアドレスへ送信されます。メールアドレスを変更した場合は市長に連絡してください。",
      "申请编号（可选）": "申請番号（任意）",
      "发送识别码到预留邮箱": "登録メールにコードを送信",
      "识别码已发送至预留邮箱。": "登録メールアドレスにコードを送信しました。",
      "识别码已发送至预留邮箱；该识别码已过期，可以申请延期。":
        "コードを送信しました。このコードは期限切れのため、延長を申請できます。",
      "申请时预留的邮箱（可选）": "申請時に登録したメール（任意）"
    },
    "zh-tw": {
      "身份识别码（必填）": "身分識別碼（必填）",
      "请输入身份识别码": "請輸入身分識別碼",
      "请输入身份识别码。": "請輸入身分識別碼。",
      "申请身份识别码": "申請身分識別碼",
      "申请延长识别码有效期": "申請延長識別碼有效期",
      "填写申请编号或身份识别码任一项，然后核对原申请信息。":
        "請填寫申請編號或身分識別碼任一項，然後核對原申請資訊。",
      "下一步：核对信息": "下一步：核對資訊",
      "请填写申请编号或身份识别码":
        "請填寫申請編號或身分識別碼。",
      "申请重新发行识别码": "申請重新發行識別碼",
      "申请重新发行身份识别码": "申請重新發行身分識別碼",
      "请先在上方输入需要重新发行的身份识别码。":
        "請先在上方輸入需要重新發行的身分識別碼。",
      "提交重新发行申请": "提交重新發行申請",
      "重新发行申请已提交，申请编号：{number}。旧识别码已作废。":
        "重新發行申請已提交，申請編號：{number}。舊識別碼已作廢。",
      "申请重新发行身份识别码将作废旧识别码并更换一个新的识别码。":
        "申請重新發行身分識別碼將作廢舊識別碼並更換新的識別碼。",
      "在识别码被盗用等情况下建议立即申请重新发行识别码。":
        "識別碼遭盜用等情況下，建議立即申請重新發行。",
      "新发行的识别码的有效期以审批为准。":
        "新發行識別碼的有效期以審批結果為準。",
      "申请重新发行识别码请输入玩家名称、申请时预留的邮箱、旧识别码的其一。":
        "申請重新發行識別碼，請輸入玩家名稱、申請時預留的信箱或舊識別碼其中一項。",
      "旧身份识别码": "舊身分識別碼",
      "请至少填写玩家名称、申请时预留邮箱或旧识别码中的一项。":
        "請至少填寫玩家名稱、申請時預留的信箱或舊識別碼其中一項。",
      "如果您是通过人工申请的识别码且预留信息不详细，请联系市长人工处理。":
        "如果您是透過人工申請的識別碼且預留資訊不詳細，請聯絡市長人工處理。",
      "投票未提交": "投票未提交",
      "接收识别码邮箱": "接收識別碼信箱",
      "玩家名称": "玩家名稱",
      "提交申请": "提交申請",
      "正在提交…": "正在提交…",
      "申请编号：{number}": "申請編號：{number}",
      "申请已提交，申请编号：{number}。": "申請已提交，申請編號：{number}。",
      "延期申请已提交，申请编号：{number}。原有效期内可正常投票；过期后审批期间可额外投票一次。":
        "延期申請已提交，申請編號：{number}。原有效期內可正常投票；過期後審批期間可額外投票一次。",
      "小号及非本营地成员不得申请，否则申请将被审批拒绝。":
        "小號及非本營地成員不得申請，否則申請將被審批拒絕。",
      "忘记玩家名称请查询后再来申请，填写不实信息将被审批拒绝。":
        "忘記玩家名稱請查詢後再申請，填寫不實資訊將被審批拒絕。",
      "玩家名称中的符号可以省略填写。": "玩家名稱中的符號可以省略填寫。",
      "玩家名称只有符号的，请联系市长人工申请。":
        "玩家名稱只有符號的，請聯絡市長人工申請。",
      "身份识别码审批": "身分識別碼審批",
      "审批新申请及延期申请；每页显示10条。": "審批新申請及延期申請；每頁顯示10筆。",
      "身份识别码": "身分識別碼",
      "查看、人工发行、禁用、修改有效期或重新发送识别码。":
        "查看、人工發行、停用、修改有效期或重新寄送識別碼。",
      "SMTP 发信": "SMTP 發信",
      "按申请编号搜索": "按申請編號搜尋",
      "审批状态": "審批狀態",
      "全部": "全部",
      "待审批": "待審批",
      "已通过": "已通過",
      "已拒绝": "已拒絕",
      "申请编号": "申請編號",
      "类型": "類型",
      "语言": "語言",
      "提交时间": "提交時間",
      "上一页": "上一頁",
      "下一页": "下一頁",
      "跳至": "跳至",
      "跳页": "跳頁",
      "玩家名称（可选）": "玩家名稱（可選）",
      "接收邮箱（可选）": "接收信箱（可選）",
      "邮件语言": "郵件語言",
      "永久有效": "永久有效",
      "人工生成识别码": "人工產生識別碼",
      "搜索玩家或邮箱": "搜尋玩家或信箱",
      "识别码": "識別碼",
      "最后发信": "最後發信",
      "启用 SMTP 发信": "啟用 SMTP 發信",
      "SMTP 服务器": "SMTP 伺服器",
      "端口": "連接埠",
      "认证方式": "認證方式",
      "用户名": "使用者名稱",
      "密码": "密碼",
      "发件邮箱": "寄件信箱",
      "发件名称": "寄件名稱",
      "回复邮箱（可选）": "回覆信箱（可選）",
      "保存 SMTP 配置": "儲存 SMTP 設定",
      "测试收件邮箱": "測試收件信箱",
      "发送测试邮件": "寄送測試郵件",
      "审批身份识别码": "審批身分識別碼",
      "发行有效期至": "發行有效期至",
      "拒绝原因（可选）": "拒絕原因（可選）",
      "通过并发送邮件": "通過並寄送郵件",
      "拒绝并发送通知": "拒絕並寄送通知",
      "营地公告列表（公告之间空一行；公告内可换行）":
        "營地公告列表（公告之間空一行；公告內可換行）",
      "公告编辑语言": "公告編輯語言",
      "管理身份识别码": "管理身分識別碼",
      "管理 SMTP 发信": "管理 SMTP 發信",
      "管理 SMTP 配置": "管理 SMTP 設定",
      "搜索申请编号、玩家或邮箱": "搜尋申請編號、玩家或信箱",
      "搜索识别码、玩家或邮箱": "搜尋識別碼、玩家或信箱",
      "搜索": "搜尋",
      "识别码状态": "識別碼狀態",
      "过期": "過期",
      "取消": "取消",
      "恢复": "恢復",
      "已过期": "已過期",
      "尝试次数过多，请在 {seconds} 秒后重试。":
        "嘗試次數過多，請在 {seconds} 秒後重試。",
      "投票成功": "投票成功",
      "识别码有效期：{date}": "身分識別碼有效期：{date}"
      ,
      "测试成功，本次提交不计票。": "測試成功，本次提交不計票。",
      "忘记识别码": "忘記識別碼"
      ,
      "找回身份识别码": "找回身分識別碼",
      "申请时预留的邮箱": "申請時預留的信箱",
      "请输入申请时预留的信息（至少一条）。":
        "請輸入申請時預留的資訊（至少一項）。",
      "如果您是通过人工申请的识别码且预留信息不详细，请联系市长人工处理。":
        "如果您是透過人工申請的識別碼且預留資訊不詳細，請聯絡市長人工處理。",
      "找回的识别码将发送到申请时预留的邮箱，如果您更换了邮箱，请联系市长人工处理。":
        "找回的識別碼將傳送到申請時預留的信箱，如果您更換了信箱，請聯絡市長人工處理。",
      "申请编号（可选）": "申請編號（可選）",
      "发送识别码到预留邮箱": "傳送識別碼到預留信箱",
      "识别码已发送至预留邮箱。": "識別碼已傳送至預留信箱。",
      "识别码已发送至预留邮箱；该识别码已过期，可以申请延期。":
        "識別碼已傳送至預留信箱；該識別碼已過期，可以申請延期。",
      "申请时预留的邮箱（可选）": "申請時預留的信箱（可選）"
    }
  };
  for (const [language, additions] of Object.entries(identityTranslations)) {
    Object.assign(translations[language], additions);
  }

  function translate(source, language = currentLanguage()) {
    return translations[language]?.[source] || source;
  }

  function format(source, values = {}, language = currentLanguage()) {
    return translate(source, language).replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) =>
      values[key] == null ? "" : String(values[key])
    );
  }

  function currentLanguage() {
    return P.resolveLanguage(P.getLanguageChoice());
  }

  function updateSiteFooter(language) {
    const timezone =
      document.documentElement.dataset.timezone || "Asia/Shanghai";
    const year = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      year: "numeric"
    }).format(new Date());
    const localized = {
      "zh-cn": {
        prefix: `版权所有 © ${year} `,
        company: "美国雨梦互联网有限公司",
        suffix: " 保留所有权利。本页面为在中国大陆使用而设计。"
      },
      "zh-tw": {
        prefix: `版權所有 © ${year} `,
        company: "美國雨夢網際網路有限公司",
        suffix: "。保留所有權利。"
      },
      en: {
        prefix: `Copyright © ${year} `,
        company: "Yume Internet LLC",
        suffix: ". All Rights Reserved."
      },
      fr: {
        prefix: `Copyright © ${year} `,
        company: "Yume Internet LLC",
        suffix: ". Tous droits réservés."
      },
      ja: {
        prefix: `Copyright © ${year} `,
        company: "Yume Internet LLC",
        suffix: "。無断転載を禁じます。"
      }
    }[language];
    if (!localized) return;
    for (const footer of document.querySelectorAll("[data-footer-copy]")) {
      if (footer.dataset.footerLanguage === language && footer.dataset.footerYear === year) {
        continue;
      }
      const link = document.createElement("a");
      link.href = "https://www.yume.zone/";
      link.textContent = localized.company;
      footer.replaceChildren(
        document.createTextNode(localized.prefix),
        link,
        document.createTextNode(localized.suffix)
      );
      footer.dataset.footerLanguage = language;
      footer.dataset.footerYear = year;
    }
  }

  function translateDocument({ emitEvent = true } = {}) {
    const language = currentLanguage();
    document.documentElement.lang = language === "zh-cn" ? "zh-CN" : language;
    document.title = translate(originalTitle, language);
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (["SCRIPT", "STYLE", "CODE", "TEXTAREA"].includes(node.parentElement?.tagName)) {
        continue;
      }
      if (!originalText.has(node)) originalText.set(node, node.nodeValue);
      const original = originalText.get(node);
      const trimmed = original.trim();
      if (!trimmed) continue;
      node.nodeValue = original.replace(trimmed, translate(trimmed, language));
    }
    for (const field of document.querySelectorAll("[placeholder]")) {
      if (!originalPlaceholder.has(field)) {
        originalPlaceholder.set(field, field.getAttribute("placeholder"));
      }
      field.setAttribute(
        "placeholder",
        translate(originalPlaceholder.get(field), language)
      );
    }
    for (const element of document.querySelectorAll("[aria-label], [title]")) {
      if (!originalAttributes.has(element)) originalAttributes.set(element, {});
      const originals = originalAttributes.get(element);
      for (const attribute of ["aria-label", "title"]) {
        if (!element.hasAttribute(attribute)) continue;
        if (!(attribute in originals)) originals[attribute] = element.getAttribute(attribute);
        element.setAttribute(attribute, translate(originals[attribute], language));
      }
    }
    updateSiteFooter(language);
    syncControls();
    if (emitEvent) {
      document.dispatchEvent(
        new CustomEvent("mrzh:languagechange", { detail: { language } })
      );
    }
  }

  function installControls() {
    for (const header of document.querySelectorAll(".site-header, .login-card")) {
      if (header.querySelector(".preference-controls")) continue;
      const controls = document.createElement("div");
      controls.className = "preference-controls";
      controls.append(
        createPreferenceMenu({
          type: "language",
          label: "选择语言",
          icon:
            '<svg class="preference-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 5.828h2.7m3.3 0H9.5m-1.8 0h1.8m-1.8 0V5m1.8.828c-.316 1.131-.98 2.201-1.736 3.141M5.836 11a19 19 0 0 0 1.928-2.03m0 0c-.385-.453-.925-1.184-1.08-1.515m1.08 1.514l1.157 1.203M13.5 19l.833-2m4.167 2l-.833-2m-3.334 0L16 13l1.667 4m-3.334 0h3.334"/><path stroke-linecap="round" d="M14 10V8c0-2.828 0-4.243-.879-5.121C12.243 2 10.828 2 8 2s-4.243 0-5.121.879C2 3.757 2 5.172 2 8s0 4.243.879 5.121C3.757 14 5.172 14 8 14h2"/><path d="M10 16c0-2.828 0-4.243.879-5.121C11.757 10 13.172 10 16 10s4.243 0 5.121.879C22 11.757 22 13.172 22 16s0 4.243-.879 5.121C20.243 22 18.828 22 16 22s-4.243 0-5.121-.879C10 20.243 10 18.828 10 16Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M4 16.5c0 1.404 0 2.107.337 2.611a2 2 0 0 0 .552.552C5.393 20 6.096 20 7.5 20M20 7.5c0-1.404 0-2.107-.337-2.611a2 2 0 0 0-.552-.552C18.607 4 17.904 4 16.5 4"/></g></svg>',
          options: ["auto", "zh-cn", "zh-tw", "en", "fr", "ja"].map(value => ({
            value,
            label: languageNames[value]
          }))
        }),
        createPreferenceMenu({
          type: "theme",
          label: "选择主题",
          icon:
            '<svg class="preference-icon" xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><path d="M12 16a4 4 0 0 0 0-8z"/><path fill-rule="evenodd" d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10s10-4.477 10-10S17.523 2 12 2m0 2v4a4 4 0 1 0 0 8v4a8 8 0 1 0 0-16" clip-rule="evenodd"/></g></svg>',
          options: [
            { value: "auto", label: "自动" },
            { value: "dark", label: "深色" },
            { value: "light", label: "浅色" }
          ]
        })
      );
      header.append(controls);
    }
    syncControls();
  }

  function createPreferenceMenu({ type, label, icon, options }) {
    const details = document.createElement("details");
    details.className = `preference-menu preference-menu-${type}`;
    const trigger = document.createElement("summary");
    trigger.className = "preference-trigger";
    trigger.setAttribute("aria-label", label);
    trigger.innerHTML = icon;
    const dropdown = document.createElement("div");
    dropdown.className = "preference-dropdown";
    dropdown.setAttribute("role", "radiogroup");
    dropdown.setAttribute("aria-label", label);

    for (const option of options) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "preference-option";
      button.dataset.preference = type;
      button.dataset.value = option.value;
      button.setAttribute("role", "radio");
      button.textContent = option.label;
      button.addEventListener("click", () => {
        if (type === "language") {
          P.setLanguageChoice(option.value);
          translateDocument();
        } else {
          P.applyTheme(P.setThemeChoice(option.value));
        }
        details.removeAttribute("open");
        syncControls();
      });
      dropdown.append(button);
    }

    details.addEventListener("toggle", () => {
      trigger.setAttribute("aria-expanded", String(details.open));
      if (!details.open) return;
      for (const other of document.querySelectorAll(".preference-menu[open]")) {
        if (other !== details) other.removeAttribute("open");
      }
    });
    details.append(trigger, dropdown);
    return details;
  }

  function syncControls() {
    const values = {
      language: P.getLanguageChoice(),
      theme: P.getThemeChoice()
    };
    for (const field of document.querySelectorAll(".preference-option")) {
      field.setAttribute(
        "aria-checked",
        String(field.dataset.value === values[field.dataset.preference])
      );
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    installControls();
    translateDocument();
    document.addEventListener("click", event => {
      if (event.target.closest(".preference-menu")) return;
      for (const menu of document.querySelectorAll(".preference-menu[open]")) {
        menu.removeAttribute("open");
      }
    });
    let translationScheduled = false;
    const observer = new MutationObserver(() => {
      if (translationScheduled) return;
      translationScheduled = true;
      queueMicrotask(() => {
        translationScheduled = false;
        // Dynamic cards still need their text translated, but emitting the
        // language-change event here would make their renderer mutate the DOM
        // again and create an endless observer/render loop.
        translateDocument({ emitEvent: false });
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "lang") translateDocument();
    if (event.key === "yume-theme") P.applyTheme(P.getThemeChoice());
  });
  window.addEventListener("yume:preferenceschange", () => {
    P.applyTheme(P.getThemeChoice());
    translateDocument();
  });
  window.MrzhI18n = Object.freeze({
    t: translate,
    format,
    language: currentLanguage,
    apply: translateDocument
  });
})();
