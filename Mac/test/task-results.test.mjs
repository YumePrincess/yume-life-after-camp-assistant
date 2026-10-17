import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { writeMemberTaskResult } from "../src/task-results.mjs";

const cases = [
  ["zh-cn", "# Agent 任务结果"],
  ["zh-tw", "# Agent 任務結果"],
  ["en-US", "# Agent Task Results"],
  ["fr", "# Résultats de tâche de l’Agent"],
  ["ja-JP", "# Agent タスク結果"]
];

test("member task result documents use the selected language and retain a portable JSON payload", async () => {
  const rootDirectory = await mkdtemp(resolve(tmpdir(), "yla-task-results-"));
  try {
    for (const [locale, heading] of cases) {
      const path = await writeMemberTaskResult({
        taskKey: "contribution_sync",
        runId: `run-${locale}`,
        capturedAt: "2026-10-16T12:00:00.000Z",
        payload: [{ name: "Player One", weeklyContribution: 1 }],
        locale,
        rootDirectory
      });
      const markdown = await readFile(path, "utf8");
      assert.ok(markdown.startsWith(`${heading}\n`));
      assert.ok(markdown.includes("<!-- yla-member-task-result:v1 -->"));
      assert.ok(markdown.includes('"name": "Player One"'));
      assert.ok(markdown.endsWith("```\n"));
    }
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
});
