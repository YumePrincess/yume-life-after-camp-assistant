import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function runFile(file, args = [], options = {}) {
  const {
    timeoutMs = 30_000,
    signal,
    encoding = "utf8",
    maxBuffer = 16 * 1024 * 1024
  } = options;
  try {
    return await execFileAsync(file, args, {
      timeout: timeoutMs,
      signal,
      encoding,
      maxBuffer,
      env: { ...process.env, LC_ALL: "C", LANG: "C.UTF-8" }
    });
  } catch (error) {
    const stderr = String(error.stderr || "").trim();
    const detail = stderr || error.message;
    throw new Error(`${file} ${args.join(" ")} failed: ${detail}`, { cause: error });
  }
}

export function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new Error("Interrupted"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason || new Error("Interrupted"));
      },
      { once: true }
    );
  });
}
