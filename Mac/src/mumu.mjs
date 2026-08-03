import { runFile, delay } from "./process.mjs";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
const bundledHostInputHelperApp = path.resolve(
  moduleDirectory,
  "../bin/Yume Life After Mac Agent Input Helper.app"
);

export class MumuLifecycle {
  constructor(config, adb) {
    this.config = config;
    this.adb = adb;
    this.startedForTask = false;
    this.resolvedInstance = null;
  }

  async resolveInstance(signal, { refresh = false } = {}) {
    if (this.resolvedInstance && !refresh) return this.resolvedInstance;
    await this.ensureManagerRunning(signal);
    const response = await this.waitForDeviceList(signal);
    const devices = response?.return?.results;
    if (!Array.isArray(devices)) {
      throw new Error("MuMu info all did not return an Android Device list");
    }
    const configuredName = this.config.mumu.instanceName?.trim();
    let matches = configuredName
      ? devices.filter((item) => item.name === configuredName)
      : [];
    if (matches.length > 1) {
      throw new Error(`MuMu has more than one container named "${configuredName}"`);
    }
    let instance = matches[0];
    if (!instance && Number.isInteger(this.config.mumu.instanceIndex)) {
      instance = devices.find(
        (item) => Number(item.index) === this.config.mumu.instanceIndex
      );
    }
    if (!instance) {
      const available = devices
        .map((item) => `${item.name}(${item.index})`)
        .join(", ");
      throw new Error(
        `MuMu container not found: ${configuredName || this.config.mumu.instanceIndex}; available: ${available}`
      );
    }
    if (configuredName && instance.name !== configuredName) {
      throw new Error(
        `MuMu index ${instance.index} is "${instance.name}", expected "${configuredName}"`
      );
    }
    this.resolvedInstance = normalizeInstance(instance);
    this.applyAdbPort(this.resolvedInstance);
    return this.resolvedInstance;
  }

  async ensureStarted(signal) {
    let instance = await this.resolveInstance(signal, { refresh: true });
    if (instance.state !== "running") {
      await this.toolJson(["open", String(instance.index)], signal, 30_000);
    }
    this.startedForTask = true;
    instance = await this.waitForRunningInstance(
      instance.index,
      this.config.mumu.adbReadyTimeoutSeconds,
      signal
    );
    this.resolvedInstance = instance;
    this.applyAdbPort(instance);
    await this.adb.waitReady(this.config.mumu.adbReadyTimeoutSeconds, signal);
  }

  async hardRestart(signal) {
    const {
      appName,
      deviceProcessName = "MuMuEmulator",
      hardRestartDelaySeconds = 4
    } = this.config.mumu;
    const instance = await this.resolveInstance(signal);

    await this.adb.stopGame().catch(() => undefined);
    await runFile(
      "/usr/bin/pkill",
      [
        "-KILL",
        "-f",
        `${deviceProcessName}.*--index ${instance.index}( |$)`
      ],
      { timeoutMs: 10_000, signal }
    ).catch(() => undefined);
    await runFile("/usr/bin/killall", ["-KILL", appName], {
      timeoutMs: 10_000,
      signal
    }).catch(() => undefined);
    await delay(hardRestartDelaySeconds * 1000, signal);
    this.resolvedInstance = null;
    await this.ensureManagerRunning(signal);
    const resolved = await this.resolveInstance(signal, { refresh: true });
    await this.toolJson(["open", String(resolved.index)], signal, 30_000);
    this.startedForTask = true;
    const running = await this.waitForRunningInstance(
      resolved.index,
      this.config.mumu.adbReadyTimeoutSeconds,
      signal
    );
    this.resolvedInstance = running;
    this.applyAdbPort(running);
    await this.adb.waitReady(this.config.mumu.adbReadyTimeoutSeconds, signal);
  }

  async restartContainer(signal) {
    const { containerRestartTimeoutSeconds = 60 } = this.config.mumu;
    const instance = await this.resolveInstance(signal);
    await this.toolJson(
      ["restart", String(instance.index)],
      signal,
      20_000
    );
    this.startedForTask = true;
    const running = await this.waitForRunningInstance(
      instance.index,
      containerRestartTimeoutSeconds,
      signal
    );
    this.resolvedInstance = running;
    this.applyAdbPort(running);
    await this.adb.waitReady(containerRestartTimeoutSeconds, signal);
  }

  async stopAfterTask() {
    if (!this.config.mumu.stopEmulatorAfterTask || !this.startedForTask) return;
    const instance = await this.resolveInstance(undefined);
    await this.toolJson(
      ["close", String(instance.index)],
      undefined,
      45_000
    ).catch(async () => {
      await this.ensureManagerRunning();
      await delay(2_000);
      await this.toolJson(
        ["close", String(instance.index)],
        undefined,
        45_000
      );
    });
    this.startedForTask = false;
  }

  currentInstance() {
    return this.resolvedInstance;
  }

  async releaseContainerMouseCapture(signal, { bringToFront = true } = {}) {
    const controls = this.config.mumu.hostMouseUnlock;
    if (!controls?.enabled) return false;
    const instance = await this.resolveInstance(signal);
    const processId = Number(instance.pid);
    if (!Number.isSafeInteger(processId) || processId <= 0) {
      throw new Error(
        "MUMU_HOST_MOUSE_UNLOCK_PID_UNAVAILABLE: 未能取得 MuMu 安卓容器进程 PID"
      );
    }
    const keyCode = Math.max(
      0,
      Math.min(255, Number(controls.keyCode) || 50)
    );
    // `~` is a toggle. The container must be the active window before the
    // state check, and MuMu needs a full settling period after either the
    // activation or the toggle before the second state check is meaningful.
    // Keep the two-second floor here as well as in the bundled config so an
    // older user config cannot bypass the required foreground/check spacing.
    const foregroundSettleSeconds = Math.max(
      2,
      Math.min(10, Number(controls.foregroundSettleMs) / 1000 || 2)
    );
    const postKeySettleSeconds = Math.max(
      2,
      Math.min(10, Number(controls.postKeySettleMs) / 1000 || 2)
    );
    const configuredHelper = String(controls.helperBinary || "").trim();
    const helperApp = hostInputHelperAppPath(
      configuredHelper ? path.resolve(configuredHelper) : bundledHostInputHelperApp
    );
    const permissionTimeoutMs = Math.max(
      1_000,
      Math.min(
        5_000,
        Number(controls.permissionTimeoutSeconds) * 1000 || 5_000
      )
    );
    const resultPath = `/private/tmp/yume-life-after-input-${randomUUID()}.json`;
    const helperArguments = [
      "--pid",
      String(processId),
      "--key-code",
      String(keyCode),
      "--foreground-settle-ms",
      String(Math.round(foregroundSettleSeconds * 1000)),
      "--post-key-settle-ms",
      String(Math.round(postKeySettleSeconds * 1000)),
      "--permission-timeout-ms",
      String(permissionTimeoutMs),
      "--bring-to-front",
      bringToFront ? "true" : "false",
      "--result-path",
      resultPath
    ];
    try {
      await runFile("/usr/bin/open", [
        "-n",
        helperApp,
        "--args",
        ...helperArguments
      ], {
        timeoutMs: permissionTimeoutMs + 25_000,
        signal
      });
      const response = await waitForHostInputResult(
        resultPath,
        permissionTimeoutMs + 15_000,
        signal
      );
      if (response.error) throw new Error(response.error);
      const cursorVisibleBefore = response.cursorVisibleBefore === true;
      const cursorVisibleAfter = response.cursorVisibleAfter === true;
      return {
        instanceIndex: instance.index,
        processId,
        keyCode,
        bringToFront,
        foregroundSettleSeconds,
        postKeySettleSeconds,
        helperMouseReleased: response.mouseReleased === true,
        mouseReleased: response.mouseReleased === true && cursorVisibleAfter,
        cursorVisibleBefore,
        cursorVisibleAfter,
        keyEventSent: response.keyEventSent === true,
        skippedBecauseAlreadyReleased:
          response.skippedBecauseAlreadyReleased === true,
        permissionOwner: "Yume Life After Mac Agent Input Helper"
      };
    } catch (error) {
      if (String(error?.message || error).includes("YLA_HOST_INPUT_PERMISSION_DENIED")) {
        throw new Error(
          "MUMU_HOST_MOUSE_UNLOCK_PERMISSION_DENIED: 请在“系统设置 > 隐私与安全性 > 辅助功能”中启用“Yume Life After Mac Agent Input Helper”。只给主 App 授权不会授权独立的后台输入助手；授权后可在 App 设置中点击“请求输入权限”验证。",
          { cause: error }
        );
      }
      if (error?.cause?.code === "ENOENT") {
        throw new Error(
          "MUMU_HOST_MOUSE_UNLOCK_HELPER_MISSING: 当前 Runtime 缺少签名 Input Helper，请在 App 首页执行安装/修复。Node 不会代替 Helper 请求权限。",
          { cause: error }
        );
      }
      throw error;
    } finally {
      await rm(resultPath, { force: true }).catch(() => undefined);
    }
  }

  async ensureManagerRunning(signal) {
    const { appName, appPath, toolPath } = this.config.mumu;
    try {
      await this.toolJson(["port"], signal, 5_000);
      return;
    } catch {
      await runFile(
        "/usr/bin/open",
        ["-gj", "-a", appPath || appName],
        { timeoutMs: 20_000, signal }
      );
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          await this.toolJson(["port"], signal, 5_000);
          return;
        } catch {
          await delay(1_000, signal);
        }
      }
      throw new Error(`MuMu manager did not start: ${toolPath}`);
    }
  }

  async waitForRunningInstance(index, timeoutSeconds, signal) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      const response = await this.toolJson(
        ["info", String(index)],
        signal,
        10_000
      ).catch(() => null);
      const instance = response?.return;
      if (
        instance?.state === "running" &&
        Number.isInteger(Number(instance.adb_port))
      ) {
        return normalizeInstance(instance);
      }
      await delay(1_500, signal);
    }
    throw new Error(`MuMu container ${index} did not become running`);
  }

  async waitForDeviceList(signal, timeoutSeconds = 30) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const response = await this.toolJson(["info", "all"], signal, 10_000);
        if (Array.isArray(response?.return?.results)) return response;
        lastError = new Error("MuMu info all returned no device list");
      } catch (error) {
        lastError = error;
      }
      await delay(1_000, signal);
    }
    throw new Error(
      `MuMu manager port opened but device list was not ready within ${timeoutSeconds}s: ${lastError?.message || "unknown error"}`
    );
  }

  applyAdbPort(instance) {
    if (!Number.isInteger(instance?.adbPort)) return;
    this.adb.setSerial(`127.0.0.1:${instance.adbPort}`);
  }

  async toolJson(args, signal, timeoutMs = 15_000) {
    const result = await runFile(this.config.mumu.toolPath, args, {
      timeoutMs,
      signal
    });
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error(
        `mumutool ${args.join(" ")} returned invalid JSON: ${String(result.stdout).slice(0, 500)}`
      );
    }
    if (parsed?.errcode !== undefined && parsed.errcode !== 0) {
      throw new Error(
        `mumutool ${args.join(" ")} failed: ${parsed.message || parsed.errcode}`
      );
    }
    return parsed;
  }
}

function normalizeInstance(instance) {
  return {
    index: Number(instance.index),
    name: String(instance.name || ""),
    state: String(instance.state || ""),
    adbPort:
      instance.adb_port === undefined ? null : Number(instance.adb_port),
    pid: instance.pid === undefined ? null : Number(instance.pid),
    bundlePath: instance.bundle_path || null
  };
}

function hostInputHelperAppPath(configuredPath) {
  const normalized = path.resolve(configuredPath);
  if (normalized.endsWith(".app")) return normalized;
  const bundleMarker = ".app/Contents/MacOS/";
  const executableOffset = normalized.indexOf(bundleMarker);
  if (executableOffset >= 0) {
    return normalized.slice(0, executableOffset + ".app".length);
  }
  throw new Error(
    `MUMU_HOST_MOUSE_UNLOCK_HELPER_INVALID: Input Helper must be a macOS .app bundle: ${normalized}`
  );
}

async function waitForHostInputResult(resultPath, timeoutMs, signal) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(resultPath, "utf8"));
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) {
        throw error;
      }
      await delay(250, signal);
    }
  }
  throw new Error(
    `YLA_HOST_INPUT_RESULT_TIMEOUT: Input Helper did not return within ${timeoutMs} ms`
  );
}
