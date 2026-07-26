import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function loadConfig() {
  const path = resolve(process.env.MRZH_CONFIG || resolve(MAC_ROOT, "config.json"));
  const config = JSON.parse(await readFile(path, "utf8"));
  config.__path = path;
  config.__root = MAC_ROOT;
  config.vision.binary = resolve(MAC_ROOT, config.vision.binary);
  config.vision.pixelProbeBinary = resolve(
    MAC_ROOT,
    config.vision.pixelProbeBinary
  );
  validate(config);
  return config;
}

function validate(config) {
  if (!/^https:\/\//.test(config.server?.baseUrl || "")) {
    throw new Error("server.baseUrl must use HTTPS");
  }
  if (
    !config.server?.agentToken ||
    config.server.agentToken.startsWith("REPLACE_WITH")
  ) {
    throw new Error("Set server.agentToken in Mac/config.json");
  }
  if (config.adb?.serial !== "127.0.0.1:26688") {
    throw new Error(
      "adb.serial must remain 127.0.0.1:26688; the public ADB mapping is not used by the Mac Agent"
    );
  }
  if (config.debug?.host !== "127.0.0.1") {
    throw new Error("debug.host must remain 127.0.0.1");
  }
}
