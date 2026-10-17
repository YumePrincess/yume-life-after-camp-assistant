import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

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
  const markdown = [
    "# Agent 任务结果",
    "",
    "<!-- yla-member-task-result:v1 -->",
    "",
    "此文档记录本次任务读取并上传的成员数据。可以在 Agent 内或其他编辑器中修改；Workers 仅接受格式正确的版本。",
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
