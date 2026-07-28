import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "node:util";

export function enableExternalFileLogging(root) {
  if (process.env.YUME_AGENT_FILE_LOG !== "1") return;
  const logDir = resolve(root, "logs");
  mkdirSync(logDir, { recursive: true });
  const stdoutPath = resolve(logDir, "agent.log");
  const stderrPath = resolve(logDir, "agent-error.log");
  const write = (path, values) => {
    appendFileSync(
      path,
      `${new Date().toISOString()} ${format(...values)}\n`,
      "utf8"
    );
  };
  console.log = (...values) => write(stdoutPath, values);
  console.info = (...values) => write(stdoutPath, values);
  console.warn = (...values) => write(stderrPath, values);
  console.error = (...values) => write(stderrPath, values);
}
