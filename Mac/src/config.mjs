import { lstat, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CREDENTIALS_MARKERS = new Set(["CREDENTIALS_FILE", "KEYCHAIN"]);
let runtimeCredentialsPromise;

export async function loadConfig(options = {}) {
  const {
    resolveSecrets = true,
    validateCredentials = true
  } = options;
  const path = resolve(process.env.MRZH_CONFIG || resolve(MAC_ROOT, "config.json"));
  const config = JSON.parse(await readFile(path, "utf8"));
  config.__path = path;
  config.__root = MAC_ROOT;
  if (
    resolveSecrets &&
    (CREDENTIALS_MARKERS.has(config.server?.agentToken) ||
      CREDENTIALS_MARKERS.has(config.debug?.token))
  ) {
    const credentials = await readRuntimeCredentials();
    if (CREDENTIALS_MARKERS.has(config.server?.agentToken)) {
      config.server.agentToken = credentials.agentToken;
    }
    if (CREDENTIALS_MARKERS.has(config.debug?.token)) {
      config.debug.token = credentials.debugToken;
    }
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

async function readRuntimeCredentials() {
  // The background Agent must never invoke a generic Keychain shell utility;
  // macOS would authorize that utility rather than this App and could show a
  // password dialog on every reload. The App writes this owner-only file once;
  // each Agent process reads and caches it at startup.
  runtimeCredentialsPromise ||= loadRuntimeCredentialsFile();
  return runtimeCredentialsPromise;
}

async function loadRuntimeCredentialsFile() {
  const path = resolve(
    process.env.YLA_CREDENTIALS_FILE ||
      resolve(
        homedir(),
        "Library/Application Support/Yume Life After Mac Agent/credentials.json"
      )
  );
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("credentials path is not a regular file");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("credentials file permissions must be 0600");
    }
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("credentials file is not owned by the current user");
    }
    const credentials = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof credentials.agentToken !== "string" ||
      credentials.agentToken.length === 0 ||
      typeof credentials.debugToken !== "string" ||
      credentials.debugToken.length === 0
    ) {
      throw new Error("credentials file is incomplete");
    }
    return Object.freeze({
      agentToken: credentials.agentToken,
      debugToken: credentials.debugToken
    });
  } catch (error) {
    throw new Error(
      `Runtime credentials are unavailable; open Yume Life After Mac Agent, load or enter both tokens, then save settings (${error.message})`
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
