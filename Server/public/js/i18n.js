(() => {
  "use strict";
  const P = window.YumePreferences;
  const originalText = new WeakMap();
  const originalPlaceholder = new WeakMap();
  const originalAttributes = new WeakMap();
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
      "明日之后营地助手": "LifeAfter Camp Assistant",
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
      "踢出成员": "Remove members"
    },
    fr: {
      "明日之后营地助手": "Assistant de camp LifeAfter",
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
      "踢出成员": "Exclure des membres"
    },
    ja: {
      "明日之后营地助手": "ライフアフター野営地アシスタント",
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
      "踢出成员": "メンバーを除名"
    },
    "zh-tw": {
      "明日之后营地助手": "明日之後營地助手",
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
      "踢出成员": "踢出成員"
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

  function translateDocument() {
    const language = currentLanguage();
    document.documentElement.lang = language === "zh-cn" ? "zh-CN" : language;
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
      const language = document.createElement("select");
      language.className = "preference-select";
      language.setAttribute("aria-label", "Language");
      language.dataset.preference = "language";
      for (const value of ["auto", "zh-cn", "zh-tw", "en", "fr", "ja"]) {
        language.append(new Option(languageNames[value], value));
      }
      const theme = document.createElement("select");
      theme.className = "preference-select";
      theme.setAttribute("aria-label", "Theme");
      theme.dataset.preference = "theme";
      theme.append(new Option("Auto", "auto"), new Option("Light", "light"), new Option("Dark", "dark"));
      language.addEventListener("change", () => {
        P.setLanguageChoice(language.value);
        translateDocument();
      });
      theme.addEventListener("change", () => {
        P.applyTheme(P.setThemeChoice(theme.value));
      });
      controls.append(language, theme);
      header.append(controls);
    }
    syncControls();
  }

  function syncControls() {
    for (const field of document.querySelectorAll('[data-preference="language"]')) {
      field.value = P.getLanguageChoice();
    }
    for (const field of document.querySelectorAll('[data-preference="theme"]')) {
      field.value = P.getThemeChoice();
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    installControls();
    translateDocument();
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
