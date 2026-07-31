import { runFile, delay } from "./process.mjs";

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
    const foregroundSettleSeconds = Math.max(
      0.1,
      Math.min(10, Number(controls.foregroundSettleMs) / 1000 || 4)
    );
    const postKeySettleSeconds = Math.max(
      0.1,
      Math.min(10, Number(controls.postKeySettleMs) / 1000 || 4)
    );
    // 创建队伍前必须让这个容器保持前台：先等待窗口实际获得焦点，再发送
    // Esc 下方物理键（ANSI key code 50，即 ` / ~），然后等待游戏解除锁定。
    // 不点击 Dock、菜单栏或桌面，也不使用切换空间的快捷键。
    const script = [
      'tell application "System Events"',
      `  set targetProcess to first application process whose unix id is ${processId}`,
      ...(bringToFront
        ? ["  set frontmost of targetProcess to true", `  delay ${foregroundSettleSeconds}`]
        : []),
      `  key code ${keyCode}`,
      `  delay ${postKeySettleSeconds}`,
      "end tell"
    ].join("\n");
    await runFile("/usr/bin/osascript", ["-e", script], {
      timeoutMs: 15_000,
      signal
    });
    const mouseReleased = await this.hostMouseButtonsReleased(signal);
    return {
      instanceIndex: instance.index,
      processId,
      keyCode,
      bringToFront,
      foregroundSettleSeconds,
      postKeySettleSeconds,
      mouseReleased
    };
  }

  async hostMouseButtonsReleased(signal) {
    // macOS does not expose an app's private cursor-capture state. The safe,
    // observable condition before an ADB click is that no global mouse button
    // remains pressed; this check deliberately treats an unavailable result as
    // not released so the patrol workflow does not click blindly.
    const script = [
      "ObjC.import('ApplicationServices');",
      "const source = $.kCGEventSourceStateCombinedSessionState;",
      "const pressed = $.CGEventSourceButtonState(source, $.kCGMouseButtonLeft) || $.CGEventSourceButtonState(source, $.kCGMouseButtonRight) || $.CGEventSourceButtonState(source, $.kCGMouseButtonCenter);",
      "JSON.stringify({ released: !pressed });"
    ].join("\n");
    try {
      const result = await runFile(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", script],
        { timeoutMs: 5_000, signal }
      );
      return JSON.parse(String(result.stdout || "{}")).released === true;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
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
