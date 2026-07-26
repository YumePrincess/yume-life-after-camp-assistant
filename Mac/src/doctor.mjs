import { access } from "node:fs/promises";
import { loadConfig } from "./config.mjs";
import { AdbClient } from "./adb.mjs";
import { runFile } from "./process.mjs";

const config = await loadConfig();
const adb = new AdbClient(config);
const checks = [];

await check("Vision OCR", async () => access(config.vision.binary));
await check("mumutool", async () => access(config.mumu.toolPath));
await check("ADB binary", async () => runFile(config.adb.binary, ["version"]));
await check("ADB loopback device", async () => {
  await adb.connect();
  if ((await adb.state()) !== "device") throw new Error("not ready");
});
await check("Game package", async () => {
  const result = await adb.shell(["pm", "path", config.adb.packageName]);
  if (!result.stdout.includes("package:")) throw new Error("not installed");
});
await check("Unicode keyboard", async () => {
  const result = await adb.shell(["ime", "list", "-s"]);
  if (!result.stdout.includes(config.adb.unicodeIme)) throw new Error("not installed");
});

for (const item of checks) {
  console.log(`${item.ok ? "✓" : "✗"} ${item.name}${item.error ? ` — ${item.error}` : ""}`);
}
if (checks.some((item) => !item.ok)) process.exitCode = 1;

async function check(name, action) {
  try {
    await action();
    checks.push({ name, ok: true });
  } catch (error) {
    checks.push({ name, ok: false, error: error.message });
  }
}
