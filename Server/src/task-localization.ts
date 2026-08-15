import { normalizeLocale, type SupportedLocale } from "./locale";

type LocalizedMessages = Partial<Record<SupportedLocale, string>>;

const SERVER_MESSAGES: Record<string, LocalizedMessages> = {
  "定时任务已入队": {
    "zh-tw": "定時任務已加入佇列",
    en: "Scheduled task queued",
    fr: "Tâche planifiée mise en file",
    ja: "定期タスクをキューに追加しました"
  },
  "管理员手工任务已入队": {
    "zh-tw": "管理員手動任務已加入佇列",
    en: "Manual administrator task queued",
    fr: "Tâche manuelle de l’administrateur mise en file",
    ja: "管理者の手動タスクをキューに追加しました"
  },
  "巡逻任务已超过后台设置的截止时间；本次失败不再按定时重试次数重新启动任务": {
    "zh-tw": "巡邏任務已超過後台設定的截止時間；本次失敗不再依定時重試次數重新啟動任務",
    en: "The patrol task passed the configured deadline; this failure will not restart it through scheduled retries",
    fr: "La patrouille a dépassé l’heure limite configurée ; cet échec ne relancera pas la tâche par les reprises planifiées",
    ja: "巡回タスクが設定された締切を過ぎたため、この失敗では定期リトライによる再起動を行いません"
  },
  "任务已进入结束收尾阶段；本次收尾错误不再按失败重试次数重新启动任务": {
    "zh-tw": "任務已進入結束收尾階段；本次收尾錯誤不再依失敗重試次數重新啟動任務",
    en: "The task entered final cleanup; this cleanup error will not restart it through failure retries",
    fr: "La tâche est entrée dans le nettoyage final ; cette erreur de nettoyage ne relancera pas la tâche",
    ja: "タスクは終了処理に入りました。この終了処理エラーでは失敗リトライによる再起動を行いません"
  },
  "当前 Agent 已有任务正在运行或排队；手工任务不会重复入队": {
    "zh-tw": "目前 Agent 已有任務正在執行或排隊；手動任務不會重複加入佇列",
    en: "The Agent already has a running or queued task; the manual task was not queued again",
    fr: "L’Agent exécute déjà une tâche ou en a une en file ; la tâche manuelle n’a pas été ajoutée",
    ja: "Agent には実行中またはキュー待ちのタスクがあるため、手動タスクは重複登録しません"
  }
};

const PATTERN_MESSAGES: Array<{
  pattern: RegExp;
  values: Record<SupportedLocale, string>;
}> = [
  {
    pattern: /^定时任务失败，已发起第 (\d+) 次重试$/,
    values: {
      "zh-cn": "定时任务失败，已发起第 $1 次重试",
      "zh-tw": "定時任務失敗，已發起第 $1 次重試",
      en: "Scheduled task failed; started retry $1",
      fr: "Échec de la tâche planifiée ; reprise $1 lancée",
      ja: "定期タスクが失敗したため、$1 回目のリトライを開始しました"
    }
  },
  {
    pattern: /^任务失败，已发起第 (\d+) 次定时重试$/,
    values: {
      "zh-cn": "任务失败，已发起第 $1 次定时重试",
      "zh-tw": "任務失敗，已發起第 $1 次定時重試",
      en: "Task failed; started scheduled retry $1",
      fr: "Échec de la tâche ; reprise planifiée $1 lancée",
      ja: "タスクが失敗したため、定期リトライ $1 を開始しました"
    }
  },
  {
    pattern: /^这是第 (\d+)\/(\d+) 次定时重试$/,
    values: {
      "zh-cn": "这是第 $1/$2 次定时重试",
      "zh-tw": "這是第 $1/$2 次定時重試",
      en: "This is scheduled retry $1/$2",
      fr: "Il s’agit de la reprise planifiée $1/$2",
      ja: "これは定期リトライ $1/$2 です"
    }
  },
  {
    pattern: /^定时任务到达时 Agent 仍被前一任务占用；先等待 15 分钟，超时后终止前一任务$/,
    values: {
      "zh-cn": "定时任务到达时 Agent 仍被前一任务占用；先等待 15 分钟，超时后终止前一任务",
      "zh-tw": "定時任務到達時 Agent 仍被前一任務佔用；先等待 15 分鐘，逾時後終止前一任務",
      en: "The Agent was still occupied when the scheduled task arrived; waiting 15 minutes before terminating the previous task",
      fr: "L’Agent était encore occupé à l’arrivée de la tâche planifiée ; attente de 15 minutes avant d’arrêter la tâche précédente",
      ja: "定期タスクの時刻に Agent が前のタスクで使用中でした。15 分待機し、タイムアウト後に前のタスクを終了します"
    }
  }
];

function detailObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function localizeWorkerMessage(
  message: string | null | undefined,
  detail: Record<string, unknown>,
  localeValue: unknown
): string {
  const locale = normalizeLocale(localeValue);
  const source = String(message ?? "");
  const messages = detail.localizedMessages;
  if (messages && typeof messages === "object" && !Array.isArray(messages)) {
    const translated = (messages as Record<string, unknown>)[locale];
    if (typeof translated === "string" && translated.length) return translated;
  }
  const exact = SERVER_MESSAGES[source]?.[locale];
  if (exact) return exact;
  for (const item of PATTERN_MESSAGES) {
    const match = item.pattern.exec(source);
    if (!match) continue;
    return item.values[locale].replace(/\$(\d+)/g, (_, index) => match[Number(index)] ?? "");
  }
  return source;
}

export function localizeWorkerEvent<T extends { message?: unknown; detail_json?: unknown }>(
  event: T,
  localeValue: unknown
): T & { message: string } {
  const detail = detailObject(event.detail_json);
  return {
    ...event,
    message: localizeWorkerMessage(
      typeof event.message === "string" ? event.message : String(event.message ?? ""),
      detail,
      localeValue
    )
  };
}

export function localizeWorkerRun<T extends { message?: unknown; detail_json?: unknown }>(
  run: T,
  localeValue: unknown
): T & { message: string } {
  const detail = detailObject(run.detail_json);
  return {
    ...run,
    message: localizeWorkerMessage(
      typeof run.message === "string" ? run.message : String(run.message ?? ""),
      detail,
      localeValue
    )
  };
}
