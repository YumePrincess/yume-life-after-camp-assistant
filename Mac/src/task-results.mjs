import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { normalizeTaskLocale } from "./task-localization.mjs";

const APP_SUPPORT = resolve(
  homedir(),
  "Library/Application Support/Yume Life After Mac Agent"
);
export const TASK_RESULTS_ROOT = resolve(APP_SUPPORT, "task-results");
export const MEMBER_TASK_RESULT_FORMAT = "yla-member-task-result/v1";

const MEMBER_TASK_KEYS = new Set([
  "contribution_sync",
  "inactivity_sync",
  "member_profile_sync",
  "weekly_activity_sync"
]);

const DOCUMENT_COPY = {
  "zh-cn": {
    title: "Agent 任务结果",
    description: "此文档记录本次任务读取并上传的成员数据。可以在 Agent 内或其他编辑器中修改；Workers 仅接受格式正确的版本。"
  },
  "zh-tw": {
    title: "Agent 任務結果",
    description: "此文件記錄本次任務讀取並上傳的成員資料。可在 Agent 或其他編輯器中修改；Workers 僅接受格式正確的版本。"
  },
  en: {
    title: "Agent Task Results",
    description: "This document records member data read and uploaded by this task. Edit it in Agent or another editor; Workers accepts only documents that pass format validation."
  },
  fr: {
    title: "Résultats de tâche de l’Agent",
    description: "Ce document répertorie les données des membres lues et envoyées par cette tâche. Modifiez-le dans l’Agent ou un autre éditeur ; Workers n’accepte que les documents au format valide."
  },
  ja: {
    title: "Agent タスク結果",
    description: "このドキュメントには、タスクが読み取り送信したメンバーデータを記録します。Agent または他のエディタで編集できます。Workers は形式が正しいドキュメントのみ受け付けます。"
  }
};

function safeComponent(value, fallback = "unknown") {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 120);
  return normalized || fallback;
}

/** Save the exact member payload submitted by one supported task. */
export async function writeMemberTaskResult({
  taskKey,
  runId,
  capturedAt,
  payload,
  locale = "zh-cn",
  rootDirectory = TASK_RESULTS_ROOT
}) {
  if (!MEMBER_TASK_KEYS.has(taskKey)) {
    throw new Error(`Unsupported member task result: ${taskKey}`);
  }
  const safeRunID = safeComponent(runId);
  const result = {
    format: MEMBER_TASK_RESULT_FORMAT,
    taskKey,
    runId: String(runId || ""),
    capturedAt: String(capturedAt || ""),
    payload
  };
  const copy = DOCUMENT_COPY[normalizeTaskLocale(locale)];
  const markdown = [
    `# ${copy.title}`,
    "",
    "<!-- yla-member-task-result:v1 -->",
    "",
    copy.description,
    "",
    "```json",
    JSON.stringify(result, null, 2),
    "```",
    ""
  ].join("\n");
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  await chmod(rootDirectory, 0o700);
  const path = resolve(rootDirectory, `${safeRunID}-${taskKey}.md`);
  await writeFile(path, markdown, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}
