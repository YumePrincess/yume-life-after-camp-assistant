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
      "营地与公共展示": "Camp and public display",
      "自动任务时间": "Automation schedules",
      "感染者日程": "Infected event schedule",
      "科技目录、投票与固定科技": "Technology catalog, voting and fixed choices",
      "保存全部配置": "Save all settings",
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
      "搬砖": "Brick transport",
      "周日程更新": "Weekly schedule update",
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
      "失败": "Failed",
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
      "读取贡献、职业、庄园、同居与公职":
        "Read contributions, professions, manors, roommates and officers",
      "组队、困难路线、古籍分享与聊天指令":
        "Team formation, hard route, book-defense sharing and chat commands",
      "按时间窗执行营地搬砖路线": "Run the camp brick route within its time window",
      "更新感染者活动时间与等级": "Update infected-event times and levels",
      "全部时间使用上方时区": "All times use the time zone above",
      "启动": "Start",
      "最早开巡逻": "Earliest patrol start",
      "结束": "End",
      "分享间隔（分钟）": "Share interval (minutes)",
      "聊天轮询（秒）": "Chat polling (seconds)",
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
      "周日 22:30 后修改的日程自动顺延到下一周。":
        "Schedule changes after Sunday 22:30 automatically move to the following week.",
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
      "营地与公共展示": "Camp et affichage public",
      "自动任务时间": "Horaires d’automatisation",
      "感染者日程": "Programme des événements infectés",
      "科技目录、投票与固定科技": "Technologies, votes et choix fixes",
      "保存全部配置": "Enregistrer les paramètres",
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
      "搬砖": "Transport de briques",
      "周日程更新": "Mise à jour hebdomadaire",
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
      "失败": "Échouée",
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
      "读取贡献、职业、庄园、同居与公职":
        "Lire contributions, professions, manoirs, cohabitants et responsables",
      "组队、困难路线、古籍分享与聊天指令":
        "Équipe, route difficile, partage des livres et commandes de discussion",
      "按时间窗执行营地搬砖路线": "Exécuter le trajet des briques dans sa plage horaire",
      "更新感染者活动时间与等级": "Mettre à jour horaires et niveaux des événements",
      "全部时间使用上方时区": "Toutes les heures utilisent le fuseau ci-dessus",
      "启动": "Démarrage",
      "最早开巡逻": "Début de patrouille au plus tôt",
      "结束": "Fin",
      "分享间隔（分钟）": "Intervalle de partage (minutes)",
      "聊天轮询（秒）": "Lecture du chat (secondes)",
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
      "周日 22:30 后修改的日程自动顺延到下一周。":
        "Les horaires modifiés après dimanche 22 h 30 passent automatiquement à la semaine suivante.",
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
      "营地与公共展示": "野営地と公開表示",
      "自动任务时间": "自動タスク時刻",
      "感染者日程": "感染者イベント日程",
      "科技目录、投票与固定科技": "技術一覧・投票・固定技術",
      "保存全部配置": "設定を保存",
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
      "搬砖": "レンガ運搬",
      "周日程更新": "週間日程更新",
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
      "失败": "失敗",
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
      "读取贡献、职业、庄园、同居与公职":
        "貢献・職業・荘園・同居人・役職を読み取る",
      "组队、困难路线、古籍分享与聊天指令":
        "チーム編成・困難ルート・古籍共有・チャット指示",
      "按时间窗执行营地搬砖路线": "時間枠内にレンガ運搬ルートを実行",
      "更新感染者活动时间与等级": "感染者イベントの時刻とレベルを更新",
      "全部时间使用上方时区": "すべて上記タイムゾーンを使用",
      "启动": "開始",
      "最早开巡逻": "パトロール最早開始",
      "结束": "終了",
      "分享间隔（分钟）": "共有間隔（分）",
      "聊天轮询（秒）": "チャット確認（秒）",
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
      "周日 22:30 后修改的日程自动顺延到下一周。":
        "日曜22:30以降のスケジュール変更は自動的に翌週へ繰り越されます。",
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
      "营地与公共展示": "營地與公共展示",
      "自动任务时间": "自動任務時間",
      "感染者日程": "感染者日程",
      "科技目录、投票与固定科技": "科技目錄、投票與固定科技",
      "保存全部配置": "儲存全部設定",
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
      "搬砖": "搬磚",
      "周日程更新": "週日程更新",
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
      "失败": "失敗",
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
      "读取贡献、职业、庄园、同居与公职":
        "讀取貢獻、職業、莊園、同居與公職",
      "组队、困难路线、古籍分享与聊天指令":
        "組隊、困難路線、古籍分享與聊天指令",
      "按时间窗执行营地搬砖路线": "按時間窗執行營地搬磚路線",
      "更新感染者活动时间与等级": "更新感染者活動時間與等級",
      "全部时间使用上方时区": "全部時間使用上方時區",
      "启动": "啟動",
      "最早开巡逻": "最早開巡邏",
      "结束": "結束",
      "分享间隔（分钟）": "分享間隔（分鐘）",
      "聊天轮询（秒）": "聊天輪詢（秒）",
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
      "周日 22:30 后修改的日程自动顺延到下一周。":
        "週日 22:30 後修改的日程會自動順延到下一週。",
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
    const year = String(new Date().getFullYear());
    const localized = {
      "zh-cn": {
        prefix: `版权所有 © 2012–${year} `,
        company: "美国雨梦互联网有限公司",
        suffix: " 保留所有权利。本页面为在中国大陆使用而设计。"
      },
      "zh-tw": {
        prefix: `版權所有 © 2012–${year} `,
        company: "美國雨夢網際網路有限公司",
        suffix: "。保留所有權利。"
      },
      en: {
        prefix: `Copyright © 2012–${year} `,
        company: "Yume Internet LLC",
        suffix: ". All Rights Reserved."
      },
      fr: {
        prefix: `Copyright © 2012–${year} `,
        company: "Yume Internet LLC",
        suffix: ". Tous droits réservés."
      },
      ja: {
        prefix: `Copyright © 2012–${year} `,
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

  function translateDocument() {
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
    document.dispatchEvent(
      new CustomEvent("mrzh:languagechange", { detail: { language } })
    );
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
            '<svg class="preference-icon" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.5"><path stroke-linecap="round" stroke-linejoin="round" d="M5 5.8h6M8 5.8V5m1.5.8C9 8 7.5 10 5.8 11.2M7.8 9c.8 1 1.7 1.8 2.8 2.6M13.5 19l.8-2m4.2 2-.8-2m-3.4 0 1.7-4 1.7 4"/><path d="M14 10V8c0-4.8-1.2-6-6-6S2 3.2 2 8s1.2 6 6 6h2m0 2c0 4.8 1.2 6 6 6s6-1.2 6-6-1.2-6-6-6-6 1.2-6 6Z"/></g></svg>',
          options: ["auto", "zh-cn", "zh-tw", "en", "fr", "ja"].map(value => ({
            value,
            label: languageNames[value]
          }))
        }),
        createPreferenceMenu({
          type: "theme",
          label: "选择主题",
          icon:
            '<svg class="preference-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 2a10 10 0 1 0 0 20zm0 2v4a4 4 0 1 0 0 8v4a8 8 0 1 1 0-16Z"/></svg>',
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
    const observer = new MutationObserver(() => translateDocument());
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
