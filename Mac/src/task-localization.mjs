const LOCALES = new Set(["zh-cn", "zh-tw", "en", "fr", "ja"]);

const FIXED_TRANSLATIONS = {
  "任务已由管理员中断": {
    "zh-tw": "任務已由管理員中斷",
    en: "The task was interrupted by an administrator",
    fr: "La tâche a été interrompue par un administrateur",
    ja: "管理者によってタスクが中断されました"
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
  "成员资料首次扫描识别 ${details}/${expectedMembers} 名，先通过顶部“首页”返回列表起点，再进入“成员”页完整重扫一次，避免末页 OCR 漏行": {
    "zh-tw": "成員資料首次掃描識別 ${details}/${expectedMembers} 名，先透過頂部「首頁」返回列表起點，再進入「成員」頁完整重掃一次，避免末頁 OCR 漏行",
    en: "The first member-profile scan recognized ${details}/${expectedMembers}; returning to Home and reopening Members before a full rescan to avoid missing rows at the bottom",
    fr: "Le premier scan des profils a reconnu ${details}/${expectedMembers} membres ; retour à l’accueil puis réouverture de Membres avant un nouveau scan complet pour éviter les lignes manquantes en bas",
    ja: "メンバープロフィールの初回スキャンは ${details}/${expectedMembers} 名を認識しました。末尾の行抜けを避けるため、「ホーム」に戻って「メンバー」を開き直して再スキャンします"
  }
};

const PATTERN_TRANSLATIONS = [
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
    return pattern.values[target].replace(/\$(\d+)/g, (_, index) => match[Number(index)] ?? "");
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
