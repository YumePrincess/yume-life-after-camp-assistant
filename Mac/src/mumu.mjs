import { runFile, delay } from "./process.mjs";

export class MumuLifecycle {
  constructor(config, adb) {
    this.config = config;
    this.adb = adb;
    this.startedForTask = false;
  }

  async ensureStarted(signal) {
    if ((await this.adb.state()) === "device") {
      this.startedForTask = true;
      return;
    }
    const { appName, startManagerInBackground, toolPath, instanceIndex } =
      this.config.mumu;
    if (startManagerInBackground) {
      await runFile(
        "/usr/bin/open",
        ["-gj", "-a", appName],
        { timeoutMs: 20_000, signal }
      ).catch(() => undefined);
      await delay(2_000, signal);
    }
    await runFile(toolPath, ["open", String(instanceIndex)], {
      timeoutMs: 30_000,
      signal
    });
    this.startedForTask = true;
    await this.adb.waitReady(this.config.mumu.adbReadyTimeoutSeconds, signal);
  }

  async stopAfterTask() {
    if (!this.config.mumu.stopEmulatorAfterTask || !this.startedForTask) return;
    const { toolPath, instanceIndex } = this.config.mumu;
    await runFile(toolPath, ["close", String(instanceIndex)], {
      timeoutMs: 45_000
    }).catch(async () => {
      await runFile("/usr/bin/open", ["-gj", "-a", this.config.mumu.appName], {
        timeoutMs: 20_000
      }).catch(() => undefined);
      await delay(2_000);
      await runFile(toolPath, ["close", String(instanceIndex)], {
        timeoutMs: 45_000
      });
    });
    this.startedForTask = false;
  }
}
