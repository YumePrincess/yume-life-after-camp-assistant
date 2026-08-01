import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execFileAsync = promisify(execFile);

export async function loadConfig(options = {}) {
  const {
    resolveSecrets = true,
    validateCredentials = true
  } = options;
  const path = resolve(process.env.MRZH_CONFIG || resolve(MAC_ROOT, "config.json"));
  const config = JSON.parse(await readFile(path, "utf8"));
  config.__path = path;
  config.__root = MAC_ROOT;
  if (resolveSecrets && config.server?.agentToken === "KEYCHAIN") {
    config.server.agentToken = await readAgentTokenFromKeychain();
  }
  if (config.adb?.binary?.startsWith(".")) {
    config.adb.binary = resolve(MAC_ROOT, config.adb.binary);
  }
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
  if (config.localVisionModel?.pythonBinary?.startsWith(".")) {
    config.localVisionModel.pythonBinary = resolve(
      MAC_ROOT,
      config.localVisionModel.pythonBinary
    );
  }
  config.plugins ||= {};
  config.plugins.userDirectory = resolve(
    expandHome(config.plugins.userDirectory) ||
      resolve(
        homedir(),
        "Library/Application Support/Yume Life After Mac Agent/Plugins"
      )
  );
  config.plugins.disabled ||= [];
  config.plugins.uninstalled ||= [];
  config.plugins.trustedKeys ||= {};
  config.plugins.allowUnsignedLocal ??= false;
  validate(config, { validateCredentials });
  return config;
}

async function readAgentTokenFromKeychain() {
  try {
    const { stdout } = await execFileAsync(
      "/usr/bin/security",
      [
        "find-generic-password",
        "-s",
        "zone.yume.lifeafter.agent",
        "-a",
        "agent-token",
        "-w"
      ],
      { timeout: 5_000, encoding: "utf8" }
    );
    return stdout.trim();
  } catch {
    throw new Error(
      "Agent token is stored in Keychain but could not be read; open Yume Life After Mac Agent and save the connection settings again"
    );
  }
}

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return resolve(homedir(), value.slice(2));
  return value;
}

function validate(config, { validateCredentials = true } = {}) {
  if (!/^https:\/\//.test(config.server?.baseUrl || "")) {
    throw new Error("server.baseUrl must use HTTPS");
  }
  if (
    validateCredentials &&
    !config.server?.agentToken ||
    validateCredentials && config.server.agentToken.startsWith("REPLACE_WITH")
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
    config.localVisionModel?.transport !== "cli" &&
    !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(
      config.localVisionModel?.baseUrl || ""
    )
  ) {
    throw new Error(
      "localVisionModel.baseUrl must remain a 127.0.0.1 loopback endpoint"
    );
  }
}
