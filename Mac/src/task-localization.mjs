const LOCALES = new Set(["zh-cn", "zh-tw", "en", "fr", "ja"]);

const FIXED_TRANSLATIONS = {
  "首次识别到营地数据中心，按住 W 700 毫秒寻路，不按 F 打开数据中心面板": {
    "zh-tw": "首次識別到營地資料中心，按住 W 700 毫秒尋路，不按 F 開啟資料中心面板",
    en: "First Camp Data Center detection: hold W for 700 ms to pathfind without opening the panel",
    fr: "Première détection du centre de données : maintenir W pendant 700 ms pour avancer sans ouvrir le panneau",
    ja: "キャンプデータセンターを初めて認識しました。Fでパネルを開かず、Wを700ミリ秒押し続けて移動します"
  },
  "再次识别到营地数据中心，切换视角后继续寻路": {
    "zh-tw": "再次識別到營地資料中心，切換視角後繼續尋路",
    en: "Camp Data Center detected again: turn the camera, then continue pathfinding",
    fr: "Deuxième détection du centre de données : tourner la caméra, puis continuer le trajet",
    ja: "キャンプデータセンターを再認識しました。視点を切り替えてから移動を続けます"
  },
  "地图传送并识别到市政厅交互选项，确认到达后继续寻路": {
    "zh-tw": "地圖傳送並識別到市政廳互動選項，確認抵達後繼續尋路",
    en: "Map travel and the City Hall interaction were confirmed; continuing pathfinding",
    fr: "La téléportation et l’interaction de la mairie sont confirmées ; poursuite du trajet",
    ja: "マップ移動後に市役所の操作項目を確認しました。経路探索を続けます"
  },
  "TRADING_CITY_CITY_HALL_UNCONFIRMED: 未通过地图与交互选项确认到达市政厅": {
    "zh-tw": "TRADING_CITY_CITY_HALL_UNCONFIRMED：未透過地圖與互動選項確認抵達市政廳",
    en: "TRADING_CITY_CITY_HALL_UNCONFIRMED: Arrival was not confirmed by the map flow and interaction option",
    fr: "TRADING_CITY_CITY_HALL_UNCONFIRMED : l’arrivée n’a pas été confirmée par la carte et l’option d’interaction",
    ja: "TRADING_CITY_CITY_HALL_UNCONFIRMED：マップと操作項目で市役所への到着を確認できませんでした"
  },
  "任务已由管理员中断": {
    "zh-tw": "任務已由管理員中斷",
    en: "The task was interrupted by an administrator",
    fr: "La tâche a été interrompue par un administrateur",
    ja: "管理者によってタスクが中断されました"
  },
  "TRADING_CITY_TARGET_WEEKDAY_MISSING: 未收到有效的报名目标星期": {
    "zh-tw": "TRADING_CITY_TARGET_WEEKDAY_MISSING：未收到有效的報名目標星期",
    en: "TRADING_CITY_TARGET_WEEKDAY_MISSING: No valid application weekday was received",
    fr: "TRADING_CITY_TARGET_WEEKDAY_MISSING : aucun jour de candidature valide reçu",
    ja: "TRADING_CITY_TARGET_WEEKDAY_MISSING：有効な応募曜日を受信できませんでした"
  },
  "TRADING_CITY_DEXTER_NOT_FOUND: 最多重启六轮后仍未识别到德克斯特交谈选项": {
    "zh-tw": "TRADING_CITY_DEXTER_NOT_FOUND：最多重新啟動六輪後仍未識別到德克斯特交談選項",
    en: "TRADING_CITY_DEXTER_NOT_FOUND: Dexter's talk option was not recognized after six route restarts",
    fr: "TRADING_CITY_DEXTER_NOT_FOUND : l’option de dialogue de Dexter reste introuvable après six reprises du trajet",
    ja: "TRADING_CITY_DEXTER_NOT_FOUND：経路を6回再開してもデクスターの会話選択肢を認識できませんでした"
  },
  "TRADING_CITY_WEEKDAY_POSITION_MISSING": {
    "zh-tw": "TRADING_CITY_WEEKDAY_POSITION_MISSING",
    en: "TRADING_CITY_WEEKDAY_POSITION_MISSING: The checkbox position is missing",
    fr: "TRADING_CITY_WEEKDAY_POSITION_MISSING : position de la case manquante",
    ja: "TRADING_CITY_WEEKDAY_POSITION_MISSING：曜日チェック欄の位置がありません"
  },
  "TRADING_CITY_SUBMISSION_UNCONFIRMED: 申请表未消失或未重新识别到世界 HUD": {
    "zh-tw": "TRADING_CITY_SUBMISSION_UNCONFIRMED：申請表未消失或未重新識別到世界 HUD",
    en: "TRADING_CITY_SUBMISSION_UNCONFIRMED: The form did not disappear or the world HUD was not recognized again",
    fr: "TRADING_CITY_SUBMISSION_UNCONFIRMED : le formulaire est toujours présent ou l’interface du monde n’a pas été reconnue",
    ja: "TRADING_CITY_SUBMISSION_UNCONFIRMED：申請フォームが消えないか、ワールド HUD を再認識できませんでした"
  },
  "正在按任务启动本地视觉辅助模型": {
    "zh-tw": "正在依任務啟動本機視覺輔助模型",
    en: "Starting the local vision assistant for this task",
    fr: "Démarrage de l’assistant visuel local pour cette tâche",
    ja: "タスク用のローカル視覚アシスタントを起動しています"
  },
  "正在按任务启动 Qwen 本地视觉辅助模型": {
    "zh-tw": "正在依任務啟動 Qwen 本機視覺輔助模型",
    en: "Starting the Qwen local vision assistant for this task",
    fr: "Démarrage de l’assistant visuel local Qwen pour cette tâche",
    ja: "タスク用の Qwen ローカル視覚アシスタントを起動しています"
  },
  "Qwen 本地视觉辅助模型已启动": {
    "zh-tw": "Qwen 本機視覺輔助模型已啟動",
    en: "Qwen local vision assistant started",
    fr: "Assistant visuel local Qwen démarré",
    ja: "Qwen ローカル視覚アシスタントを起動しました"
  },
  "本次任务未启用 Qwen 本地视觉辅助模型，使用 OCR 与确定性流程": {
    "zh-tw": "本次任務未啟用 Qwen 本機視覺輔助模型，使用 OCR 與確定性流程",
    en: "Qwen local vision is disabled for this task; using OCR and deterministic steps",
    fr: "La vision locale Qwen est désactivée pour cette tâche ; utilisation de l’OCR et des étapes déterministes",
    ja: "このタスクでは Qwen ローカル視覚を無効化し、OCR と決定的な手順を使用します"
  },
  "Qwen 本地视觉辅助模型因任务配置未自动启动，使用 OCR 与确定性流程": {
    "zh-tw": "Qwen 本機視覺輔助模型因任務設定未自動啟動，使用 OCR 與確定性流程",
    en: "Qwen local vision was not auto-started by task configuration; using OCR and deterministic steps",
    fr: "La vision locale Qwen n’a pas été démarrée automatiquement par la configuration ; utilisation de l’OCR et des étapes déterministes",
    ja: "タスク設定で Qwen ローカル視覚の自動起動が無効なため、OCR と決定的な手順を使用します"
  },
  "Qwen 本地视觉模型启动失败，本次任务继续使用 OCR 与确定性流程": {
    "zh-tw": "Qwen 本機視覺模型啟動失敗，本次任務繼續使用 OCR 與確定性流程",
    en: "Qwen local vision failed to start; continuing with OCR and deterministic steps",
    fr: "Échec du démarrage de la vision locale Qwen ; poursuite avec l’OCR et les étapes déterministes",
    ja: "Qwen ローカル視覚を起動できないため、OCR と決定的な手順で続行します"
  },
  "本地视觉模型未能启动，本次任务继续使用 OCR 与确定性流程": {
    "zh-tw": "本機視覺模型未能啟動，本次任務繼續使用 OCR 與確定性流程",
    en: "The local vision model did not start; continuing with OCR and deterministic steps",
    fr: "Le modèle visuel local n’a pas démarré ; poursuite avec l’OCR et les étapes déterministes",
    ja: "ローカル視覚モデルを起動できないため、OCR と決定的な手順で続行します"
  },
  "正在后台启动 MuMu 模拟器": {
    "zh-tw": "正在背景啟動 MuMu 模擬器",
    en: "Starting the MuMu emulator in the background",
    fr: "Démarrage de l’émulateur MuMu en arrière-plan",
    ja: "MuMu エミュレーターをバックグラウンドで起動しています"
  },
  "正在启动明日之后": {
    "zh-tw": "正在啟動明日之後",
    en: "Starting LifeAfter",
    fr: "Démarrage de LifeAfter",
    ja: "LifeAfter を起動しています"
  },
  "正在预热本机 OCR（首次启动可能较慢）": {
    "zh-tw": "正在預熱本機 OCR（首次啟動可能較慢）",
    en: "Warming up local OCR (the first launch may be slower)",
    fr: "Préparation de l’OCR local (le premier lancement peut être plus lent)",
    ja: "ローカル OCR をウォームアップしています（初回起動は時間がかかる場合があります）"
  },
  "本机 OCR 预热失败，将继续尝试正常 OCR": {
    "zh-tw": "本機 OCR 預熱失敗，將繼續嘗試一般 OCR",
    en: "Local OCR warm-up failed; continuing with normal OCR",
    fr: "Échec de la préparation de l’OCR local ; poursuite avec l’OCR normal",
    ja: "ローカル OCR のウォームアップに失敗したため、通常の OCR で続行します"
  },
  "正在关闭游戏进程": {
    "zh-tw": "正在關閉遊戲程序",
    en: "Closing the game process",
    fr: "Fermeture du processus du jeu",
    ja: "ゲームプロセスを終了しています"
  },
  "任务已结束，正在停止 MuMu 以节约资源和能耗": {
    "zh-tw": "任務已結束，正在停止 MuMu 以節省資源與電力",
    en: "The task is complete; stopping MuMu to save resources and power",
    fr: "Tâche terminée ; arrêt de MuMu pour économiser les ressources et l’énergie",
    ja: "タスクが終了したため、リソースと電力節約のため MuMu を停止しています"
  },
  "任务已结束，正在释放本地视觉模型内存": {
    "zh-tw": "任務已結束，正在釋放本機視覺模型記憶體",
    en: "The task is complete; releasing local vision-model memory",
    fr: "Tâche terminée ; libération de la mémoire du modèle visuel local",
    ja: "タスクが終了したため、ローカル視覚モデルのメモリを解放しています"
  },
  "已保留游戏现场，正在单独释放 Qwen 本地视觉模型内存": {
    "zh-tw": "已保留遊戲現場，正在單獨釋放 Qwen 本機視覺模型記憶體",
    en: "The game scene is preserved; releasing Qwen local vision memory separately",
    fr: "La scène du jeu est conservée ; libération séparée de la mémoire de vision locale Qwen",
    ja: "ゲーム画面を保持し、Qwen ローカル視覚モデルのメモリを個別に解放しています"
  },
  "任务已结束，正在释放 Qwen 本地视觉模型内存": {
    "zh-tw": "任務已結束，正在釋放 Qwen 本機視覺模型記憶體",
    en: "The task is complete; releasing Qwen local vision memory",
    fr: "Tâche terminée ; libération de la mémoire de vision locale Qwen",
    ja: "タスクが終了したため、Qwen ローカル視覚モデルのメモリを解放しています"
  },
  "Qwen 本地视觉辅助模型已停止并释放内存": {
    "zh-tw": "Qwen 本機視覺輔助模型已停止並釋放記憶體",
    en: "Qwen local vision assistant stopped and memory released",
    fr: "Assistant visuel local Qwen arrêté et mémoire libérée",
    ja: "Qwen ローカル視覚アシスタントを停止し、メモリを解放しました"
  },
  "Qwen 本地视觉辅助模型停止失败": {
    "zh-tw": "Qwen 本機視覺輔助模型停止失敗",
    en: "Qwen local vision assistant failed to stop",
    fr: "Échec de l’arrêt de l’assistant visuel local Qwen",
    ja: "Qwen ローカル視覚アシスタントの停止に失敗しました"
  },
  "任务成功；已完成资源清理": {
    "zh-tw": "任務成功；已完成資源清理",
    en: "Task succeeded; resources have been cleaned up",
    fr: "Tâche réussie ; nettoyage des ressources terminé",
    ja: "タスク成功；リソースのクリーンアップが完了しました"
  },
  "任务已成功完成，游戏与模拟器已停止": {
    "zh-tw": "任務已成功完成，遊戲與模擬器已停止",
    en: "Task completed successfully; the game and emulator were stopped",
    fr: "Tâche terminée avec succès ; le jeu et l’émulateur ont été arrêtés",
    ja: "タスクが正常に完了し、ゲームとエミュレーターを停止しました"
  },
  "任务收尾返回中心失败；保留原始任务错误，不重新启动 MuMu": {
    "zh-tw": "任務收尾返回中心失敗；保留原始任務錯誤，不重新啟動 MuMu",
    en: "Returning to Center during cleanup failed; preserving the original task error without restarting MuMu",
    fr: "Le retour au centre pendant le nettoyage a échoué ; l’erreur d’origine est conservée sans redémarrer MuMu",
    ja: "終了処理中の中心への復帰に失敗しました。元のタスクエラーを保持し、MuMu は再起動しません"
  },
  "本地 Agent 已领取任务": {
    "zh-tw": "本機 Agent 已領取任務",
    en: "The local Agent claimed the task",
    fr: "L’Agent local a pris en charge la tâche",
    ja: "ローカル Agent がタスクを取得しました"
  },
  "本地 Agent 已开始执行": {
    "zh-tw": "本機 Agent 已開始執行",
    en: "The local Agent started executing the task",
    fr: "L’Agent local a commencé à exécuter la tâche",
    ja: "ローカル Agent がタスクの実行を開始しました"
  },
  "角色已回到营地并确认复活，将从头重新执行原任务": {
    "zh-tw": "角色已回到營地並確認復活，將從頭重新執行原任務",
    en: "The character returned to camp and revived; restarting the original task from the beginning",
    fr: "Le personnage est retourné au camp et a ressuscité ; reprise de la tâche d’origine depuis le début",
    ja: "キャラクターがキャンプに戻って復活したため、元のタスクを最初から再実行します"
  },
  "角色已回到营地并确认复活，继续登录/加载流程": {
    "zh-tw": "角色已回到營地並確認復活，繼續登入／載入流程",
    en: "The character returned to camp and revived; continuing the login/loading flow",
    fr: "Le personnage est retourné au camp et a ressuscité ; poursuite de la connexion et du chargement",
    ja: "キャラクターがキャンプに戻って復活したため、ログイン／読み込みを続行します"
  },
  "已识别昏迷通知，但未取得“回到营地”按钮坐标；为避免误触，未发送点击": {
    "zh-tw": "已識別昏迷通知，但未取得「回到營地」按鈕座標；為避免誤觸，未發送點擊",
    en: "The incapacitation notice was recognized, but the Return to Camp button position was unavailable; no click was sent",
    fr: "La notification d’inconscience a été reconnue, mais la position du bouton Retour au camp est inconnue ; aucun clic n’a été envoyé",
    ja: "昏迷通知は認識しましたが、「キャンプに戻る」ボタンの座標を取得できないため、誤操作防止のためクリックしませんでした"
  },
  "已点击“回到营地”，但在确认时间内未确认昏迷通知消失；暂停当前任务以避免在错误场景继续操作": {
    "zh-tw": "已點擊「回到營地」，但在確認時間內未確認昏迷通知消失；暫停目前任務以避免在錯誤場景繼續操作",
    en: "Return to Camp was clicked, but the incapacitation notice did not clear within the confirmation window; pausing the task to avoid acting in the wrong scene",
    fr: "Retour au camp a été cliqué, mais la notification ne s’est pas effacée dans le délai de confirmation ; tâche suspendue pour éviter d’agir dans la mauvaise scène",
    ja: "「キャンプに戻る」をクリックしましたが、確認時間内に昏迷通知が消えなかったため、誤った画面での操作を避けてタスクを停止します"
  },
  "巡逻队伍已创建并分别分享到营地频道和场景频道": {
    "zh-tw": "巡邏隊伍已建立並分別分享到營地頻道和場景頻道",
    en: "The patrol team was created and shared in both the camp and scene channels",
    fr: "L’équipe de patrouille a été créée et partagée dans les canaux du camp et de la scène",
    ja: "巡回チームを作成し、キャンプチャンネルとシーンチャンネルで共有しました"
  },
  "困难巡逻已确认，队伍已切换为保卫古籍并分享": {
    "zh-tw": "困難巡邏已確認，隊伍已切換為保衛古籍並分享",
    en: "Hard patrol confirmed; the team switched to Defend the Ancient Book and shared it",
    fr: "Patrouille difficile confirmée ; l’équipe est passée à Défense du livre ancien et l’a partagée",
    ja: "高難度巡回を確認し、チームを古書防衛に切り替えて共有しました"
  },
  "已再次分享到营地频道和场景频道": {
    "zh-tw": "已再次分享到營地頻道和場景頻道",
    en: "Shared in the camp and scene channels again",
    fr: "Partagé à nouveau dans les canaux du camp et de la scène",
    ja: "キャンプチャンネルとシーンチャンネルに再度共有しました"
  },
  "已到巡逻任务结束时间": {
    "zh-tw": "已到巡邏任務結束時間",
    en: "The patrol task reached its end time",
    fr: "L’heure de fin de la patrouille est atteinte",
    ja: "巡回タスクの終了時刻になりました"
  },
  "已记录本次动态扣费信息，不对扣费数值作固定匹配": {
    "zh-tw": "已記錄本次動態扣費資訊，不對扣費數值作固定匹配",
    en: "Recorded the dynamic cost for this run; the cost value is not fixed-matched",
    fr: "Coût dynamique enregistré ; la valeur du coût n’est pas comparée à une valeur fixe",
    ja: "今回の動的コストを記録しました。コスト値は固定照合しません"
  },
  "未读取到更新成员资料任务保存的成员主名单，请先执行“更新成员资料”": {
    "zh-tw": "未讀取到更新成員資料任務保存的成員主名單，請先執行「更新成員資料」",
    en: "The member-profile roster is unavailable; run Update Member Profiles first",
    fr: "La liste principale des membres est indisponible ; exécutez d’abord la mise à jour des profils",
    ja: "メンバープロフィールの名簿を読み取れません。先にメンバープロフィール更新を実行してください"
  },
  "贡献数据未能匹配成员资料主名单，已保留上一份贡献数据": {
    "zh-tw": "貢獻資料無法匹配成員資料主名單，已保留上一份貢獻資料",
    en: "Contribution data matched no member in the profile roster; the previous contribution data was kept",
    fr: "Aucune donnée de contribution ne correspond à la liste des profils ; les données précédentes ont été conservées",
    ja: "貢献データをプロフィール名簿のメンバーに照合できなかったため、前回のデータを保持しました"
  },
  "营地周计划显示暂无周活跃记录，已为全部成员写入周活跃点 0": {
    "zh-tw": "營地週計畫顯示暫無週活躍記錄，已為全部成員寫入週活躍點 0",
    en: "The camp weekly plan has no activity records; weekly activity points were set to 0 for all members",
    fr: "Le plan hebdomadaire du camp ne contient aucune activité ; les points hebdomadaires ont été définis à 0 pour tous les membres",
    ja: "キャンプ週間計画に活躍記録がないため、全メンバーの週間活躍ポイントを0に設定しました"
  },
  "活跃排行显示暂无排名，已为全部成员写入周活跃点 0": {
    "zh-tw": "活躍排行顯示暫無排名，已為全部成員寫入週活躍點 0",
    en: "The activity ranking has no entries; weekly activity points were set to 0 for all members",
    fr: "Le classement d’activité est vide ; les points hebdomadaires ont été définis à 0 pour tous les membres",
    ja: "活躍ランキングが空のため、全メンバーの週間活躍ポイントを0に設定しました"
  },
};

const PATTERN_TRANSLATIONS = [
  {
    test: /^TRADING_CITY_SCREEN_SIZE_UNSUPPORTED: 表单点击位置按 1920×1200 校准，当前为 (\d+)×(\d+)$/,
    values: {
      "zh-tw": "TRADING_CITY_SCREEN_SIZE_UNSUPPORTED：表單點擊位置依 1920×1200 校準，目前為 $1×$2",
      en: "TRADING_CITY_SCREEN_SIZE_UNSUPPORTED: Form tap coordinates require 1920×1200; current size is $1×$2",
      fr: "TRADING_CITY_SCREEN_SIZE_UNSUPPORTED : les coordonnées du formulaire exigent 1920×1200 ; résolution actuelle : $1×$2",
      ja: "TRADING_CITY_SCREEN_SIZE_UNSUPPORTED：フォーム座標は1920×1200用です。現在のサイズは$1×$2です"
    }
  },
  {
    test: /^TRADING_CITY_CONVERSATION_UNRECOGNIZED: 交易之城对话关键词仅识别到 (\d+)\/6 个$/,
    values: {
      "zh-tw": "TRADING_CITY_CONVERSATION_UNRECOGNIZED：交易之城對話關鍵字僅識別到 $1/6 個",
      en: "TRADING_CITY_CONVERSATION_UNRECOGNIZED: Recognized only $1 of 6 Trading City dialogue keywords",
      fr: "TRADING_CITY_CONVERSATION_UNRECOGNIZED : seulement $1 des 6 mots-clés du dialogue reconnus",
      ja: "TRADING_CITY_CONVERSATION_UNRECOGNIZED：交易の街の会話キーワードを6個中$1個だけ認識しました"
    }
  },
  {
    test: /^TRADING_CITY_APPLICATION_UNRECOGNIZED: 竞标申请表关键词仅识别到 (\d+)\/12 个$/,
    values: {
      "zh-tw": "TRADING_CITY_APPLICATION_UNRECOGNIZED：競標申請表關鍵字僅識別到 $1/12 個",
      en: "TRADING_CITY_APPLICATION_UNRECOGNIZED: Recognized only $1 of 12 application-form keywords",
      fr: "TRADING_CITY_APPLICATION_UNRECOGNIZED : seulement $1 des 12 mots-clés du formulaire reconnus",
      ja: "TRADING_CITY_APPLICATION_UNRECOGNIZED：申請フォームのキーワードを12個中$1個だけ認識しました"
    }
  },
  {
    test: /^第 (\d+)\/6 次寻路重启：本轮两次寻路均未找到德克斯特，先传送回市中心出入口，再重新前往市政厅$/,
    values: {
      "zh-tw": "第 $1/6 次路徑重啟：本輪兩次尋路均未找到德克斯特，先傳送回市中心出入口，再重新前往市政廳",
      en: "Route restart $1/6: Dexter was not found on either of the two attempts this round. Returning to the central exit, then retrying City Hall.",
      fr: "Reprise du trajet $1/6 : Dexter reste introuvable après les deux essais de ce tour. Retour à la sortie centrale avant de réessayer la mairie.",
      ja: "経路再開 $1/6：このラウンドの2回の探索でデクスターが見つかりません。中央出口に戻ってから市役所へ向かい直します。"
    }
  },
  {
    test: /^第 (\d+) 轮第 (\d+)\/2 次寻路后识别到“德克斯特”和“交谈”，正在交谈$/,
    values: {
      "zh-tw": "第 $1 輪第 $2/2 次尋路後識別到「德克斯特」和「交談(F)」，正在交談",
      en: "Recognized Dexter and Talk (F) on route $1, attempt $2/2; starting the conversation",
      fr: "Dexter et l’option Parler (F) reconnus au trajet $1, essai $2/2 ; démarrage du dialogue",
      ja: "$1周目の経路探索$2/2回目でデクスターと「会話(F)」を認識しました。会話を開始します。"
    }
  },
  {
    test: /^第 (\d+) 轮第 (\d+)\/2 次寻路后通过高精度识别到“德克斯特”和“交谈”，正在交谈$/,
    values: {
      "zh-tw": "第 $1 輪第 $2/2 次尋路後透過高精度識別到「德克斯特」和「交談(F)」，正在交談",
      en: "Accurately recognized Dexter and Talk (F) on route $1, attempt $2/2; starting the conversation",
      fr: "Dexter et l’option Parler (F) reconnus avec précision au trajet $1, essai $2/2 ; démarrage du dialogue",
      ja: "$1周目の経路探索$2/2回目で高精度認識によりデクスターと「会話(F)」を確認しました。会話を開始します。"
    }
  },
  {
    test: /^第 (\d+) 轮第 (\d+)\/2 次寻路：按住 W (\d+) 毫秒后识别德克斯特$/,
    values: {
      "zh-tw": "第 $1 輪第 $2/2 次尋路：按住 W $3 毫秒後識別德克斯特",
      en: "Route $1, pathfind attempt $2/2: hold W for $3 ms, then look for Dexter",
      fr: "Trajet $1, essai $2/2 : maintenir W pendant $3 ms, puis chercher Dexter",
      ja: "$1周目の経路探索$2/2回目：Wを$3ミリ秒押し続けてからデクスターを探します"
    }
  },
  {
    test: /^已点击报名目标日期(周[一二三四五六日])，申请表坐标 \((\d+), (\d+)\)$/,
    values: {
      "zh-tw": "已點擊報名目標日期$1，申請表座標（$2, $3）",
      en: "Selected $1 for the application (form coordinates: $2, $3)",
      fr: "$1 sélectionné pour la candidature (coordonnées du formulaire : $2, $3)",
      ja: "応募曜日に$1を選択しました（フォーム座標：$2, $3）"
    }
  },
  {
    test: /^已确认竞标申请表消失并重新识别世界 HUD；报名目标日期：(周[一二三四五六日])$/,
    values: {
      "zh-tw": "已確認競標申請表消失並重新識別世界 HUD；報名目標日期：$1",
      en: "Confirmed the application form closed and the world HUD returned; application weekday: $1",
      fr: "Formulaire fermé et interface du monde reconnue ; jour de candidature : $1",
      ja: "申請フォームが閉じ、ワールド HUD を再認識しました。応募曜日：$1"
    }
  },
  {
    test: /^成员资料首次扫描识别 (\d+)\/(\d+) 名，先通过顶部“首页”返回列表起点，再进入“成员”页完整重扫一次，避免末页 OCR 漏行$/,
    values: {
      "zh-tw": "成員資料首次掃描識別 $1/$2 名，先透過頂部「首頁」返回列表起點，再進入「成員」頁完整重掃一次，避免末頁 OCR 漏行",
      en: "The first member-profile scan recognized $1/$2; returning to Home and reopening Members before a full rescan to avoid missing rows at the bottom",
      fr: "Le premier scan des profils a reconnu $1/$2 membres ; retour à l’accueil puis réouverture de Membres avant un nouveau scan complet pour éviter les lignes manquantes en bas",
      ja: "メンバープロフィールの初回スキャンは $1/$2 名を認識しました。末尾の行抜けを避けるため、「ホーム」に戻って「メンバー」を開き直して再スキャンします"
    }
  },
  {
    test: /^周活跃点读取完成：识别 (\d+) 名玩家，更新 (\d+) 名；未出现在排行的成员按 0 处理$/,
    values: {
      "zh-tw": "週活躍點讀取完成：識別 $1 名玩家，更新 $2 名；未出現在排行的成員按 0 處理",
      en: "Weekly activity points read: $1 players recognized and $2 updated; members absent from the ranking use 0",
      fr: "Points d’activité hebdomadaires lus : $1 joueurs reconnus et $2 mis à jour ; les absents du classement valent 0",
      ja: "週間活躍ポイントの読み取り完了：$1人を認識し$2人を更新；ランキングにないメンバーは0として処理"
    }
  },
  {
    test: /^周活跃点第 (\d+) 页原生 OCR 识别成员 (\d+) 名：(.+)$/,
    values: {
      "zh-tw": "週活躍點第 $1 頁原生 OCR 識別成員 $2 名：$3",
      en: "Weekly activity page $1 native OCR recognized $2 members: $3",
      fr: "La page d’activité hebdomadaire $1 a reconnu $2 membres avec l’OCR natif : $3",
      ja: "週間活躍ポイント $1 ページ目のネイティブ OCR が $2 人を認識：$3"
    }
  },
  {
    test: /^周活跃点第 (\d+) 页 Qwen 辅助识别成员 (\d+) 名：(.+)$/,
    values: {
      "zh-tw": "週活躍點第 $1 頁 Qwen 輔助識別成員 $2 名：$3",
      en: "Weekly activity page $1 Qwen-assisted recognition found $2 members: $3",
      fr: "La reconnaissance Qwen de la page d’activité hebdomadaire $1 a trouvé $2 membres : $3",
      ja: "週間活躍ポイント $1 ページ目の Qwen 補助認識で $2 人を検出：$3"
    }
  },
  {
    test: /^周活跃点第 (\d+) 页最终采用成员 (\d+) 名：(.+)$/,
    values: {
      "zh-tw": "週活躍點第 $1 頁最終採用成員 $2 名：$3",
      en: "Weekly activity page $1 final result retained $2 members: $3",
      fr: "Le résultat final de la page d’activité hebdomadaire $1 retient $2 membres : $3",
      ja: "週間活躍ポイント $1 ページ目の最終結果は $2 人：$3"
    }
  },
  {
    test: /^按更新成员资料任务的分段滑动方式上移 (\d+)px，连续读取 (\d+) 行$/,
    values: {
      "zh-tw": "依更新成員資料任務的分段滑動方式上移 $1px，連續讀取 $2 行",
      en: "Moved up $1px using the member-profile segmented swipe and will read $2 consecutive rows",
      fr: "Défilement vers le haut de $1 px avec le geste segmenté des profils, puis lecture de $2 lignes consécutives",
      ja: "メンバープロフィール更新と同じ分割スワイプで $1px 上へ移動し、$2 行を連続読み取り"
    }
  },
  {
    test: /^周活跃点第 (\d+) 页识别 (\d+) 行，当前最后排名 (.+)，累计 (\d+) 名$/,
    values: {
      "zh-tw": "週活躍點第 $1 頁識別 $2 行，目前最後排名 $3，累計 $4 名",
      en: "Weekly activity page $1 recognized $2 rows; last rank $3; $4 accumulated",
      fr: "Page d’activité hebdomadaire $1 : $2 lignes reconnues ; dernier rang $3 ; $4 cumulées",
      ja: "週間活躍ポイント $1 ページ目で $2 行を認識、最終順位 $3、累計 $4 人"
    }
  },
  {
    test: /^翻页后最后一名玩家排名仍为 (\d+)，确认活跃排行已到底部$/,
    values: {
      "zh-tw": "翻頁後最後一名玩家排名仍為 $1，確認活躍排行已到底部",
      en: "The last player remained rank $1 after paging; the activity ranking bottom is confirmed",
      fr: "Le dernier joueur reste au rang $1 après défilement ; le bas du classement est confirmé",
      ja: "ページ送り後も最後のプレイヤーが $1 位のため、活躍ランキング末尾を確認しました"
    }
  },
  {
    test: /^检测到角色昏迷状态（(.+)），已确认“回到营地”按钮，正在点击回到营地复活$/,
    values: {
      "zh-tw": "偵測到角色昏迷狀態（$1），已確認「回到營地」按鈕，正在點擊回到營地復活",
      en: "The character's incapacitation state was detected ($1); the Return to Camp button was confirmed and will be clicked",
      fr: "État d’inconscience du personnage détecté ($1) ; le bouton Retour au camp a été confirmé et sera cliqué",
      ja: "キャラクターの昏迷状態を検出（$1）、「キャンプに戻る」ボタンを確認してクリックします"
    }
  },
  {
    test: /^角色已复活，正在从头重新执行原任务（第 (\d+)\/(\d+) 次）$/,
    values: {
      "zh-tw": "角色已復活，正在從頭重新執行原任務（第 $1/$2 次）",
      en: "The character revived; restarting the original task from the beginning (attempt $1/$2)",
      fr: "Le personnage a ressuscité ; reprise de la tâche d’origine depuis le début (tentative $1/$2)",
      ja: "キャラクターが復活したため、元のタスクを最初から再実行します（$1/$2 回目）"
    }
  },
  {
    test: /^核心数据已更新，但收尾未完全完成：(.+)$/,
    values: {
      "zh-tw": "核心資料已更新，但收尾未完全完成：$1",
      en: "Core data was updated, but cleanup was incomplete: $1",
      fr: "Les données principales ont été mises à jour, mais le nettoyage est incomplet : $1",
      ja: "主要データは更新されましたが、終了処理が完了していません：$1"
    }
  },
  {
    test: /^顶部人数识别：正式市民 (\d+)\/(\d+)，启航市民 (\d+)\/(\d+)，合计 (\d+) 名（当前在线人数不计入总数）$/,
    values: {
      "zh-tw": "頂部人數識別：正式市民 $1/$2，啟航市民 $3/$4，合計 $5 人（目前在線人數不計入總數）",
      en: "Header counts: formal citizens $1/$2, sailing citizens $3/$4; total $5 (current online counts are excluded)",
      fr: "Comptage en haut de page : citoyens officiels $1/$2, citoyens de l’expédition $3/$4 ; total $5 (les présents ne sont pas comptés)",
      ja: "上部人数を認識：正式市民 $1/$2、航海市民 $3/$4、合計 $5 人（現在オンラインの人数は合計に含めません）"
    }
  },
  {
    test: /^开始界面流程：(.+)$/,
    values: {
      "zh-tw": "開始介面流程：$1",
      en: "Starting UI flow: $1",
      fr: "Démarrage du flux d’interface : $1",
      ja: "画面フローを開始：$1"
    }
  },
  {
    test: /^第 (\d+) 页识别 (\d+) 行，累计 (\d+) 名成员（耗时 (\d+)ms）$/,
    values: {
      "zh-tw": "第 $1 頁識別 $2 行，累計 $3 名成員（耗時 $4ms）",
      en: "Page $1 recognized $2 rows; $3 members accumulated ($4ms)",
      fr: "Page $1 : $2 lignes reconnues ; $3 membres cumulés ($4 ms)",
      ja: "$1 ページ目で $2 行を認識、累計 $3 人（$4ms）"
    }
  },
  {
    test: /^成员资料列表已完整翻到底部，扫描 (\d+) 页；全表去重合并后整理为 (\d+)\/(\d+) 名成员$/,
    values: {
      "zh-tw": "成員資料列表已完整翻到底部，掃描 $1 頁；全表去重合併後整理為 $2/$3 名成員",
      en: "Member profile list reached the bottom after $1 pages; deduplicated roster: $2/$3 members",
      fr: "La liste des profils a atteint le bas après $1 pages ; liste dédupliquée : $2/$3 membres",
      ja: "メンバープロフィール一覧の最下部まで $1 ページ走査；重複除去後 $2/$3 人"
    }
  },
  {
    test: /^第 (\d+) 页连续重读仍未达到 (\d+) 行，已立即停止翻页；当前(?:整页重读)?结果为 (\d+) 行$/,
    values: {
      "zh-tw": "第 $1 頁連續重讀仍未達到 $2 行，已立即停止翻頁；目前結果為 $3 行",
      en: "Page $1 stayed below $2 rows after repeated reads; scrolling stopped immediately with $3 rows",
      fr: "La page $1 est restée sous $2 lignes après plusieurs lectures ; défilement arrêté immédiatement avec $3 lignes",
      ja: "$1 ページ目は再読しても $2 行に達しなかったため、$3 行の状態でスクロールを直ちに停止しました"
    }
  },
  {
    test: /^第 (\d+) 页连续重读仍未达到 (\d+) 行，已立即停止翻页；当前(?:整页重读)?结果为 (\d+) 行；当前已读到：(.+)$/,
    values: {
      "zh-tw": "第 $1 頁連續重讀仍未達到 $2 行，已立即停止翻頁；目前結果為 $3 行；目前已讀到：$4",
      en: "Page $1 stayed below $2 rows after repeated reads; scrolling stopped immediately with $3 rows; names currently recognized: $4",
      fr: "La page $1 est restée sous $2 lignes après plusieurs lectures ; défilement arrêté avec $3 lignes ; noms reconnus : $4",
      ja: "$1 ページ目は再読しても $2 行に達せず、$3 行の状態でスクロールを直ちに停止；現在認識した名前：$4"
    }
  },
  {
    test: /^第 (\d+) 页识别不足，正在调用 Qwen 本地视觉辅助模型重读当前页；当前已读到：(.+)$/,
    values: {
      "zh-tw": "第 $1 頁識別不足，正在呼叫 Qwen 本機視覺輔助模型重讀目前頁面；目前已讀到：$2",
      en: "Page $1 is incomplete; asking the Qwen local vision assistant to reread it; names currently recognized: $2",
      fr: "La page $1 est incomplète ; nouvelle lecture par l’assistant visuel local Qwen ; noms reconnus : $2",
      ja: "$1 ページ目の認識が不完全なため、Qwen ローカル視覚アシスタントで再読；現在認識した名前：$2"
    }
  },
  {
    test: /^第 (\d+) 页疑似将带颜色码的“启航”职位识别为名字，正在调用 Qwen 本地视觉辅助模型重读当前页；当前已读到：(.+)$/,
    values: {
      "zh-tw": "第 $1 頁疑似將帶顏色碼的「啟航」職位識別為姓名，正在呼叫 Qwen 本機視覺輔助模型重讀目前頁面；目前已讀到：$2",
      en: "Page $1 may have read a color-coded sailing title as a name; asking the Qwen local vision assistant to reread it; names currently recognized: $2",
      fr: "La page $1 a peut-être reconnu un titre de navigation codé par couleur comme un nom ; nouvelle lecture par l’assistant visuel local Qwen ; noms reconnus : $2",
      ja: "$1 ページ目で色コード付きの「啓航」役職を名前として認識した可能性があるため、Qwen ローカル視覚アシスタントで再読；現在認識した名前：$2"
    }
  },
  {
    test: /^第 1 页读取 (\d+) 行整体高度 (\d+)px，增加 (\d+)px 后按 (\d+)px 翻页$/,
    values: {
      "zh-tw": "第 1 頁讀取 $1 行整體高度 $2px，增加 $3px 後按 $4px 翻頁",
      en: "Page 1 measured an overall height of $2px for $1 rows; added $3px and will use $4px for subsequent pages",
      fr: "La page 1 a mesuré une hauteur totale de $2 px pour $1 lignes ; ajout de $3 px, puis utilisation de $4 px pour les pages suivantes",
      ja: "1ページ目で$1行の全体高さ$2pxを測定；$3pxを加え、以降は$4pxでスクロールします"
    }
  },
  {
    test: /^(.+) 第 (\d+) 页检测到顶部色带偏移，按 (\d+)px 上移自动修正后再读取 (\d+) 行$/,
    values: {
      "zh-tw": "$1 第 $2 頁偵測到頂部色帶偏移，向上自動修正 $3px 後再讀取 $4 行",
      en: "$1 page $2 detected a top color-band offset; moved up $3px before rereading $4 rows",
      fr: "$1 page $2 a détecté un décalage de bande de couleur en haut ; décalage vers le haut de $3 px avant la relecture de $4 lignes",
      ja: "$1 の $2 ページ目で上端の色帯ずれを検出；$3px 上へ自動補正して $4 行を再読します"
    }
  },
  {
    test: /^(.+) 第 (\d+) 页检测到顶部色带偏移，按 (\d+)px 下移自动修正后再读取 (\d+) 行$/,
    values: {
      "zh-tw": "$1 第 $2 頁偵測到頂部色帶偏移，向下自動修正 $3px 後再讀取 $4 行",
      en: "$1 page $2 detected a top color-band offset; moved down $3px before rereading $4 rows",
      fr: "$1 page $2 a détecté un décalage de bande de couleur en haut ; décalage vers le bas de $3 px avant la relecture de $4 lignes",
      ja: "$1 の $2 ページ目で上端の色帯ずれを検出；$3px 下へ自動補正して $4 行を再読します"
    }
  },
  {
    test: /^(.+) 第 (\d+) 页检测到顶部残留色带，按 (\d+)px 上移自动修正后再读取 (\d+) 行$/,
    values: {
      "zh-tw": "$1 第 $2 頁偵測到頂部殘留色帶，向上自動修正 $3px 後再讀取 $4 行",
      en: "$1 page $2 detected a small residual top color band; moved up $3px before rereading $4 rows",
      fr: "$1 page $2 a détecté une petite bande de couleur résiduelle en haut ; décalage vers le haut de $3 px avant la relecture de $4 lignes",
      ja: "$1 の $2 ページ目で上端の小さな残留色帯を検出；$3px 上へ自動補正して $4 行を再読します"
    }
  },
  {
    test: /^第 (\d+) 页检测到阈值边界，重读恢复 (\d+) 名离线达到 (\d+) 天的成员$/,
    values: {
      "zh-tw": "第 $1 頁偵測到閾值邊界，重讀恢復 $2 名離線達到 $3 天的成員",
      en: "Page $1 reached the threshold boundary; rereading recovered $2 members offline for at least $3 days",
      fr: "La page $1 a atteint la limite du seuil ; une nouvelle lecture a récupéré $2 membres absents depuis au moins $3 jours",
      ja: "$1 ページ目でしきい値境界を検出；再読により $3 日以上オフラインのメンバーを $2 人復元しました"
    }
  },
  {
    test: /^第 (\d+) 页阈值边界重读失败，保留当前页已识别结果并继续判断结束位置$/,
    values: {
      "zh-tw": "第 $1 頁閾值邊界重讀失敗，保留目前頁面已識別結果並繼續判斷結束位置",
      en: "Threshold-boundary reread failed on page $1; keeping the recognized rows and continuing to determine the end",
      fr: "La nouvelle lecture de la limite du seuil a échoué à la page $1 ; conservation des lignes reconnues et poursuite de la détermination de la fin",
      ja: "$1 ページ目のしきい値境界の再読に失敗；認識済みの行を保持して終了位置の判定を続けます"
    }
  },
  {
    test: /^(贡献|斩杀预警)列表行对齐的 MuMu 鼠标注入被系统拒绝，已切换 Android 触摸滑动$/,
    values: {
      "zh-tw": "$1 列表行對齊的 MuMu 滑鼠注入遭系統拒絕，已切換 Android 觸控滑動",
      en: "MuMu mouse injection for $1 row alignment was rejected by Android; switched to touch swipe",
      fr: "L’injection de souris MuMu pour l’alignement des lignes $1 a été refusée par Android ; passage au geste tactile",
      ja: "$1 リストの行揃えで MuMu のマウス入力が Android に拒否されたため、タッチスクロールに切り替えました"
    }
  },
  {
    test: /^(贡献|斩杀预警)列表滚动的 MuMu 鼠标注入被系统拒绝，已切换 Android 触摸滑动$/,
    values: {
      "zh-tw": "$1 列表滾動的 MuMu 滑鼠注入遭系統拒絕，已切換 Android 觸控滑動",
      en: "MuMu mouse injection for $1 scrolling was rejected by Android; switched to touch swipe",
      fr: "L’injection de souris MuMu pour le défilement $1 a été refusée par Android ; passage au geste tactile",
      ja: "$1 リストのスクロールで MuMu のマウス入力が Android に拒否されたため、タッチスクロールに切り替えました"
    }
  },
  {
    test: /^第 (\d+) 页识别不足，Qwen 本地视觉辅助模型当前不可用，继续使用 OCR 重读；当前已读到：(.+)$/,
    values: {
      "zh-tw": "第 $1 頁識別不足，Qwen 本機視覺輔助模型目前不可用，繼續使用 OCR 重讀；目前已讀到：$2",
      en: "Page $1 is incomplete; the Qwen local vision assistant is unavailable, continuing with OCR rereads; names currently recognized: $2",
      fr: "La page $1 est incomplète ; l’assistant visuel local Qwen est indisponible, poursuite avec de nouvelles lectures OCR ; noms reconnus : $2",
      ja: "$1 ページ目の認識が不完全ですが、Qwen ローカル視覚アシスタントが利用できないため OCR で再読；現在認識した名前：$2"
    }
  },
  {
    test: /^成员资料第 (\d+) 页连续重读达到最多 (\d+) 次仍不完整，停止当前扫描；整理为 (\d+)\/(\d+) 名成员$/,
    values: {
      "zh-tw": "成員資料第 $1 頁連續重讀達到最多 $2 次仍不完整，停止目前掃描；整理為 $3/$4 名成員",
      en: "Member profiles stopped on page $1 after $2 incomplete reads; roster total: $3/$4 members",
      fr: "Les profils membres se sont arrêtés à la page $1 après $2 lectures incomplètes ; total : $3/$4 membres",
      ja: "メンバープロフィールは不完全な再読を $2 回行っても改善せず、$1 ページ目で停止；名簿は $3/$4 人"
    }
  },
  {
    test: /^成员资料第 (\d+) 页连续重读达到最多 (\d+) 次仍不完整，停止当前扫描；整理为 (\d+)\/(\d+) 名成员；当前已读到：(.+)$/,
    values: {
      "zh-tw": "成員資料第 $1 頁連續重讀達到最多 $2 次仍不完整，停止目前掃描；整理為 $3/$4 名成員；目前已讀到：$5",
      en: "Member profiles stopped on page $1 after $2 incomplete reads; roster total: $3/$4 members; names currently recognized: $5",
      fr: "Les profils membres se sont arrêtés à la page $1 après $2 lectures incomplètes ; total : $3/$4 membres ; noms reconnus : $5",
      ja: "メンバープロフィールは不完全な再読を $2 回行っても改善せず、$1 ページ目で停止；名簿は $3/$4 人；現在認識した名前：$5"
    }
  },
  {
    test: /^成员资料第 (\d+) 页连续重读达到最多 (\d+) 次仍不完整，停止当前扫描；整理为 (\d+) 名成员$/,
    values: {
      "zh-tw": "成員資料第 $1 頁連續重讀達到最多 $2 次仍不完整，停止目前掃描；整理為 $3 名成員",
      en: "Member profiles stopped on page $1 after $2 incomplete reads; roster total: $3 members",
      fr: "Les profils membres se sont arrêtés à la page $1 après $2 lectures incomplètes ; total : $3 membres",
      ja: "メンバープロフィールは不完全な再読を $2 回行っても改善せず、$1 ページ目で停止；名簿は $3 人"
    }
  },
  {
    test: /^成员详情滚动的 MuMu 鼠标注入被系统拒绝，已切换 Android 触摸滑动$/,
    values: {
      "zh-tw": "成員詳情滾動的 MuMu 滑鼠注入遭系統拒絕，已切換 Android 觸控滑動",
      en: "MuMu mouse injection was rejected by Android; switched member-detail scrolling to touch swipe",
      fr: "L’injection de souris MuMu a été refusée par Android ; défilement des détails basculé vers le geste tactile",
      ja: "MuMu のマウス入力が Android に拒否されたため、メンバー詳細のスクロールをタッチ操作に切り替えました"
    }
  },
  {
    test: /^已达到页面顶部报告的 (\d+) 名成员，结束本表扫描$/,
    values: {
      "zh-tw": "已達到頁面頂部報告的 $1 名成員，結束本表掃描",
      en: "The page header total of $1 members was reached; stopping this table scan",
      fr: "Le total de $1 membres indiqué en haut de la page est atteint ; arrêt du scan",
      ja: "ページ上部の合計 $1 人に達したため、この表の走査を終了します"
    }
  },
  {
    test: /^贡献页识别 (\d+) 行，OCR 清洗后保留 (\d+) 行；按成员资料主名单 (\d+) 名成员去重匹配，最终更新 (\d+) 名，忽略 (\d+) 行；不会新增成员$/,
    values: {
      "zh-tw": "貢獻頁識別 $1 行，OCR 清洗後保留 $2 行；按成員資料主名單 $3 名成員去重匹配，最終更新 $4 名，忽略 $5 行；不會新增成員",
      en: "Contribution page recognized $1 rows, retaining $2 after OCR cleanup; matched against the $3-member profile roster, updated $4, ignored $5; no members added",
      fr: "Page des contributions : $1 lignes reconnues, $2 après nettoyage OCR ; comparaison avec la liste de $3 membres, $4 mises à jour, $5 ignorées ; aucun membre ajouté",
      ja: "貢献ページで $1 行を認識し、OCR 整理後 $2 行を保持；$3 人のプロフィール名簿と照合し $4 人を更新、$5 行を無視；メンバーは追加しません"
    }
  },
  {
    test: /^已更新 (\d+) 名成员资料和 (\d+) 项最新公职；贡献数值由“更新贡献”任务单独更新$/,
    values: {
      "zh-tw": "已更新 $1 名成員資料和 $2 項最新公職；貢獻數值由「更新貢獻」任務單獨更新",
      en: "Updated profiles for $1 members and $2 current staff assignments; contribution values are updated separately",
      fr: "$1 profils membres et $2 fonctions actuelles mis à jour ; les contributions sont mises à jour séparément",
      ja: "$1 人のメンバープロフィールと $2 件の役職を更新；貢献値は別の更新タスクで処理します"
    }
  },
  {
    test: /^斩杀页识别 (\d+) 行，自身去重后更新 (\d+) 条离线达到 (\d+) 天的独立预警，忽略 (\d+) 条重复数据；不会写入或关联成员名单$/,
    values: {
      "zh-tw": "斬殺頁識別 $1 行，自身去重後更新 $2 條離線達到 $3 天的獨立預警，忽略 $4 條重複資料；不會寫入或關聯成員名單",
      en: "Activity page recognized $1 rows; after deduplication, updated $2 independent warnings for members offline at least $3 days and ignored $4 duplicates; the roster was not changed",
      fr: "Page d’activité : $1 lignes reconnues ; après déduplication, $2 alertes indépendantes pour au moins $3 jours hors ligne, $4 doublons ignorés ; la liste des membres n’a pas changé",
      ja: "活動ページで $1 行を認識；重複除去後、$3 日以上オフラインの警告 $2 件を更新し、重複 $4 件を無視；名簿は変更しません"
    }
  }
];

const WEEKDAY_TRANSLATIONS = {
  "zh-tw": {
    "周一": "週一", "周二": "週二", "周三": "週三", "周四": "週四",
    "周五": "週五", "周六": "週六", "周日": "週日"
  },
  en: {
    "周一": "Monday", "周二": "Tuesday", "周三": "Wednesday", "周四": "Thursday",
    "周五": "Friday", "周六": "Saturday", "周日": "Sunday"
  },
  fr: {
    "周一": "lundi", "周二": "mardi", "周三": "mercredi", "周四": "jeudi",
    "周五": "vendredi", "周六": "samedi", "周日": "dimanche"
  },
  ja: {
    "周一": "月曜", "周二": "火曜", "周三": "水曜", "周四": "木曜",
    "周五": "金曜", "周六": "土曜", "周日": "日曜"
  }
};

export function normalizeTaskLocale(value) {
  if (typeof value !== "string") return "zh-cn";
  const normalized = value.trim().toLowerCase().replace(/_/g, "-");
  if (
    normalized.startsWith("zh-tw") ||
    normalized.startsWith("zh-hk") ||
    normalized.startsWith("zh-hant")
  ) return "zh-tw";
  if (normalized.startsWith("zh")) return "zh-cn";
  if (normalized.startsWith("en")) return "en";
  if (normalized.startsWith("fr")) return "fr";
  if (normalized.startsWith("ja")) return "ja";
  return "zh-cn";
}

export function localizeTaskEvent(step, message, locale) {
  const target = normalizeTaskLocale(locale);
  const source = String(message ?? "");
  if (target === "zh-cn" || !LOCALES.has(target)) return source;
  const exact = FIXED_TRANSLATIONS[source]?.[target];
  if (exact) return exact;
  for (const pattern of PATTERN_TRANSLATIONS) {
    const match = pattern.test.exec(source);
    if (!match) continue;
    return pattern.values[target].replace(/\$(\d+)/g, (_, index) => {
      const captured = match[Number(index)] ?? "";
      return WEEKDAY_TRANSLATIONS[target]?.[captured] || captured;
    });
  }
  // OCR, device diagnostics, and other text without a safe fixed template
  // stay byte-for-byte unchanged so recognized game text is never translated.
  return source;
}

export function localizedTaskEventMessages(step, message) {
  return Object.fromEntries(
    ["zh-cn", "zh-tw", "en", "fr", "ja"].map((locale) => [
      locale,
      localizeTaskEvent(step, message, locale)
    ])
  );
}
