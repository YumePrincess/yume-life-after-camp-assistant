import {
  appendFile,
  copyFile,
  mkdir,
  rename,
  rm,
  writeFile
} from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";

const APP_SUPPORT = resolve(
  homedir(),
  "Library/Application Support/Yume Life After Mac Agent"
);
export const TASK_DEBUG_ROOT = resolve(APP_SUPPORT, "debug");

function safeComponent(value, fallback = "unknown") {
  const normalized = String(value || "")
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]/gu, "_")
    .replace(/^\.+/u, "")
    .slice(0, 120);
  return normalized || fallback;
}

function imageExtension(path) {
  const extension = String(path || "").match(/\.(png|jpe?g|webp)$/iu)?.[1];
  return extension ? `.${extension.toLowerCase()}` : ".png";
}

/**
 * Persists the local evidence for one Agent run. The source screenshots stay
 * disposable in Mac/snapshots; this recorder copies them into an immutable,
 * run-scoped folder only when Debug mode is enabled.
 */
export class TaskDebugArtifacts {
  constructor({
    runId,
    taskKey,
    taskName,
    executionMode,
    startedAt,
    rootDirectory = TASK_DEBUG_ROOT
  }) {
    this.runId = String(runId || "");
    this.taskKey = String(taskKey || "unknown");
    this.taskName = String(taskName || this.taskKey);
    this.executionMode = String(executionMode || "unknown");
    this.startedAt = startedAt || new Date().toISOString();
    this.taskDirectory = resolve(rootDirectory, safeComponent(this.runId));
    this.imageSequence = 0;
    this.queue = Promise.resolve();
    this.started = false;
    this.enabled = true;
  }

  async start() {
    await mkdir(this.taskDirectory, { recursive: true, mode: 0o700 });
    this.started = true;
    await writeFile(
      resolve(this.taskDirectory, "manifest.json"),
      `${JSON.stringify({
        runId: this.runId,
        taskKey: this.taskKey,
        taskName: this.taskName,
        executionMode: this.executionMode,
        startedAt: this.startedAt,
        imageDirectory: "."
      }, null, 2)}\n`,
      { mode: 0o600 }
    );
  }

  recordEvent(event) {
    return this.#enqueue(async () => {
      if (!this.started || !this.enabled) return;
      await appendFile(
        resolve(this.taskDirectory, "events.jsonl"),
        `${JSON.stringify(event)}\n`,
        { encoding: "utf8", mode: 0o600 }
      );
    });
  }

  recordImage(sourcePath, label = "step") {
    return this.#enqueue(async () => {
      if (!this.started || !this.enabled || !sourcePath) return null;
      const sequence = ++this.imageSequence;
      const capturedAt = new Date().toISOString();
      const safeLabel = safeComponent(label, "step");
      const target = resolve(
        this.taskDirectory,
        `${String(sequence).padStart(4, "0")}-${safeLabel}${imageExtension(sourcePath)}`
      );
      const temporaryTarget = resolve(
        this.taskDirectory,
        `.${String(sequence).padStart(4, "0")}-${safeLabel}.partial`
      );
      try {
        // The App indexes files while a task is still running. Publish each
        // image atomically so the gallery never caches a half-copied masked
        // screenshot as a broken thumbnail under its permanent ID.
        await copyFile(sourcePath, temporaryTarget);
        await rename(temporaryTarget, target);
        await appendFile(
          resolve(this.taskDirectory, "images.jsonl"),
          `${JSON.stringify({
            sequence,
            label: safeLabel,
            fileName: target.split("/").at(-1),
            capturedAt
          })}\n`,
          { encoding: "utf8", mode: 0o600 }
        ).catch(() => undefined);
        return target;
      } catch (error) {
        await rm(temporaryTarget, { force: true }).catch(() => undefined);
        await appendFile(
          resolve(this.taskDirectory, "image-errors.jsonl"),
          `${JSON.stringify({
            sequence,
            label: safeComponent(label, "step"),
            source: String(sourcePath).split("/").at(-1),
            message: String(error?.message || error),
            timestamp: new Date().toISOString()
          })}\n`,
          { encoding: "utf8", mode: 0o600 }
        ).catch(() => undefined);
        return null;
      }
    });
  }

  finish({ state, message, finishedAt = new Date().toISOString() }) {
    return this.#enqueue(async () => {
      if (!this.started || !this.enabled) return;
      await writeFile(
        resolve(this.taskDirectory, "metadata.json"),
        `${JSON.stringify({
          runId: this.runId,
          taskKey: this.taskKey,
          taskName: this.taskName,
          executionMode: this.executionMode,
          startedAt: this.startedAt,
          finishedAt,
          state,
          success: ["succeeded", "partially_succeeded"].includes(state),
          message: String(message || "")
        }, null, 2)}\n`,
        { mode: 0o600 }
      );
    });
  }

  disable() {
    this.enabled = false;
  }

  #enqueue(operation) {
    const result = this.queue.then(operation, operation);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

export async function clearTaskDebugArtifacts() {
  await rm(TASK_DEBUG_ROOT, { recursive: true, force: true });
  return TASK_DEBUG_ROOT;
}
