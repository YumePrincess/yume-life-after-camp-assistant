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
  if (config.localVisionModel?.model?.startsWith(".")) {
    config.localVisionModel.model = resolve(
      MAC_ROOT,
      config.localVisionModel.model
    );
  }
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
  if (
    config.adb?.serial !== "auto" &&
    !/^127\.0\.0\.1:\d{2,5}$/.test(config.adb?.serial || "")
  ) {
    throw new Error(
      "adb.serial must be auto or a 127.0.0.1 loopback endpoint; public ADB addresses are forbidden"
    );
  }
  if (config.debug?.host !== "127.0.0.1") {
    throw new Error("debug.host must remain 127.0.0.1");
  }
  if (
    config.localVisionModel?.enabled &&
    !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(
      config.localVisionModel?.baseUrl || ""
    )
  ) {
    throw new Error(
      "localVisionModel.baseUrl must remain a 127.0.0.1 loopback endpoint"
    );
  }
}
