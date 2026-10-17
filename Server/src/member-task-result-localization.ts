import { normalizeLocale, type SupportedLocale } from "./locale";

const EXACT_MESSAGES: Record<string, Partial<Record<SupportedLocale, string>>> = {
  "请粘贴完整的 Agent 任务结果文档（不超过 950 KB）": {
    "zh-tw": "請貼上完整的 Agent 任務結果文件（不超過 950 KB）",
    en: "Paste the complete Agent task result document (up to 950 KB).",
    fr: "Collez le document complet de résultats de tâche de l’Agent (950 Ko maximum).",
    ja: "Agent タスク結果ドキュメント全体を貼り付けてください（950 KB 以下）。"
  },
  "文档格式不符：请保留 Agent 任务结果标题、版本标记和唯一的 JSON 数据块": {
    "zh-tw": "文件格式不符：請保留 Agent 任務結果標題、版本標記及唯一的 JSON 資料區塊",
    en: "Document format is invalid. Keep the Agent task result heading, version marker, and single JSON block.",
    fr: "Format invalide. Conservez le titre des résultats de tâche, le marqueur de version et l’unique bloc JSON.",
    ja: "ドキュメント形式が正しくありません。Agent タスク結果の見出し、バージョンマーカー、JSON ブロックを1つずつ残してください。"
  },
  "JSON 数据块无法解析，请修正文档后重新校验": {
    "zh-tw": "JSON 資料區塊無法解析，請修正文件後重新驗證",
    en: "The JSON block could not be parsed. Fix the document and validate it again.",
    fr: "Le bloc JSON est illisible. Corrigez le document puis validez-le à nouveau.",
    ja: "JSON ブロックを解析できません。ドキュメントを修正して再検証してください。"
  },
  "任务结果版本不受支持": {
    "zh-tw": "不支援此任務結果版本",
    en: "This task result version is not supported.",
    fr: "Cette version des résultats de tâche n’est pas prise en charge.",
    ja: "このタスク結果バージョンには対応していません。"
  },
  "任务类型不受支持": {
    "zh-tw": "不支援此任務類型",
    en: "This task type is not supported.",
    fr: "Ce type de tâche n’est pas pris en charge.",
    ja: "このタスクの種類には対応していません。"
  },
  "任务编号格式不正确": {
    "zh-tw": "任務編號格式不正確",
    en: "The task ID format is invalid.",
    fr: "Le format de l’identifiant de tâche est invalide.",
    ja: "タスク ID の形式が正しくありません。"
  },
  "采集时间必须是 ISO 8601 UTC 时间": {
    "zh-tw": "擷取時間必須為 ISO 8601 UTC 時間",
    en: "The capture time must be an ISO 8601 UTC timestamp.",
    fr: "L’heure de collecte doit être un horodatage UTC au format ISO 8601.",
    ja: "取得時刻は ISO 8601 UTC 形式で指定してください。"
  },
  "成员资料人数与当前主名单不一致，未应用任何校正": {
    "zh-tw": "成員資料人數與目前主名單不一致，未套用任何校正",
    en: "The profile row count does not match the current master roster. No changes were applied.",
    fr: "Le nombre de profils ne correspond pas à la liste principale actuelle. Aucune modification n’a été appliquée.",
    ja: "プロフィールの行数が現在のメンバー一覧と一致しません。変更は適用されていません。"
  },
  "没有成员资料与当前成员名单匹配，未应用任何校正": {
    "zh-tw": "沒有成員資料符合目前名單，未套用任何校正",
    en: "No member profiles matched the current roster. No changes were applied.",
    fr: "Aucun profil ne correspond à la liste actuelle. Aucune modification n’a été appliquée.",
    ja: "現在のメンバー一覧に一致するプロフィールがありません。変更は適用されていません。"
  },
  "部分成员资料无法与当前主名单唯一匹配，未应用任何校正": {
    "zh-tw": "部分成員資料無法與目前主名單唯一符合，未套用任何校正",
    en: "Some profiles could not be matched uniquely to the current roster. No changes were applied.",
    fr: "Certains profils ne correspondent pas de façon unique à la liste actuelle. Aucune modification n’a été appliquée.",
    ja: "一部のプロフィールを現在の一覧と一意に照合できません。変更は適用されていません。"
  },
  "公职数据无法安全匹配，未应用任何校正": {
    "zh-tw": "公職資料無法安全符合，未套用任何校正",
    en: "Officer assignments could not be matched safely. No changes were applied.",
    fr: "Les fonctions ne peuvent pas être associées de manière sûre. Aucune modification n’a été appliquée.",
    ja: "役職データを安全に照合できません。変更は適用されていません。"
  },
  "成员人数摘要与成员资料行数不一致": {
    "zh-tw": "成員人數摘要與成員資料行數不一致",
    en: "The member count summary does not match the number of profile rows.",
    fr: "Le résumé du nombre de membres ne correspond pas au nombre de lignes de profil.",
    ja: "メンバー数の概要とプロフィール行数が一致しません。"
  },
  "该任务对应的 Workers 插件未启用，未应用任何校正": {
    "zh-tw": "此任務對應的 Workers 外掛程式未啟用，未套用任何校正",
    en: "The Workers plugin for this task is disabled. No changes were applied.",
    fr: "Le module Workers de cette tâche est désactivé. Aucune modification n’a été appliquée.",
    ja: "このタスクの Workers プラグインが無効です。変更は適用されていません。"
  },
  "没有贡献数据与当前成员名单匹配，未应用任何校正": {
    "zh-tw": "沒有貢獻資料符合目前成員名單，未套用任何校正",
    en: "No contribution rows matched the current roster. No changes were applied.",
    fr: "Aucune contribution ne correspond à la liste actuelle. Aucune modification n’a été appliquée.",
    ja: "現在のメンバー一覧に一致する貢献データがありません。変更は適用されていません。"
  },
  "没有斩杀预警数据与当前成员名单匹配，未应用任何校正": {
    "zh-tw": "沒有斬殺預警資料符合目前成員名單，未套用任何校正",
    en: "No inactivity warning rows matched the current roster. No changes were applied.",
    fr: "Aucune alerte d’inactivité ne correspond à la liste actuelle. Aucune modification n’a été appliquée.",
    ja: "現在のメンバー一覧に一致する離脱警告データがありません。変更は適用されていません。"
  }
};

const GENERIC_MESSAGES: Record<SupportedLocale, string> = {
  "zh-cn": "任务结果文档或成员数据格式无效。请检查字段和值，再重新校验。",
  "zh-tw": "任務結果文件或成員資料格式無效。請檢查欄位與數值後重新驗證。",
  en: "The task result document or member data is invalid. Check its fields and values, then validate it again.",
  fr: "Le document de résultats ou les données des membres sont invalides. Vérifiez les champs et les valeurs, puis validez à nouveau.",
  ja: "タスク結果ドキュメントまたはメンバーデータが無効です。項目と値を確認して再検証してください。"
};

export function localizeMemberTaskResultError(
  message: string,
  localeValue: unknown
): string {
  const locale = normalizeLocale(localeValue);
  if (locale === "zh-cn") return message;
  return EXACT_MESSAGES[message]?.[locale] ?? GENERIC_MESSAGES[locale];
}
