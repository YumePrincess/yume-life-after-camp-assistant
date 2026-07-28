import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runFile, delay } from "./process.mjs";

export class AdbClient {
  constructor(config) {
    this.config = config;
    this.binary = config.adb.binary;
    this.serial = config.adb.serial;
    this.rawQueue = Promise.resolve();
  }

  setSerial(serial) {
    if (!/^127\.0\.0\.1:\d{2,5}$/.test(serial)) {
      throw new Error(`Refusing non-loopback ADB serial: ${serial}`);
    }
    this.serial = serial;
    this.config.adb.serial = serial;
  }

  async raw(args, options = {}) {
    const execute = () => runFile(this.binary, args, options);
    const pending = this.rawQueue.then(execute, execute);
    this.rawQueue = pending.catch(() => undefined);
    return pending;
  }

  async connect() {
    return this.raw(["connect", this.serial], { timeoutMs: 15_000 });
  }

  async reconnect() {
    await this.raw(["disconnect", this.serial], { timeoutMs: 5_000 }).catch(
      () => undefined
    );
    await this.connect();
    if ((await this.state()) !== "device") {
      throw new Error(`ADB device ${this.serial} is offline after reconnect`);
    }
  }

  async state() {
    try {
      const result = await this.raw(["-s", this.serial, "get-state"], {
        timeoutMs: 5_000
      });
      return result.stdout.trim();
    } catch {
      return "offline";
    }
  }

  async waitReady(timeoutSeconds, signal) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      await this.connect().catch(() => undefined);
      if ((await this.state()) === "device") return;
      await delay(2_000, signal);
    }
    throw new Error(`ADB device ${this.serial} did not become ready`);
  }

  async shell(args, options = {}) {
    return this.raw(["-s", this.serial, "shell", ...args.map(String)], options);
  }

  async launchGame() {
    const { packageName, launchActivity } = this.config.adb;
    if (launchActivity) {
      try {
        await this.shell([
          "am",
          "start",
          "-W",
          "-n",
          `${packageName}/${launchActivity}`
        ], { timeoutMs: 60_000 });
        return;
      } catch {
        // Launcher activity names can change between game updates.
      }
    }
    await this.shell([
      "monkey",
      "-p",
      packageName,
      "-c",
      "android.intent.category.LAUNCHER",
      "1"
    ]);
  }

  async stopGame() {
    await this.shell(["am", "force-stop", this.config.adb.packageName], {
      timeoutMs: 15_000
    }).catch(() => undefined);
  }

  async gameHealth() {
    const packageName = this.config.adb.packageName;
    const [pidResult, activityResult, windowResult] = await Promise.all([
      this.shell(["pidof", packageName], { timeoutMs: 8_000 }).catch(() => null),
      this.shell(["dumpsys", "activity", "processes"], {
        timeoutMs: 12_000
      }).catch(() => null),
      this.shell(["dumpsys", "window", "windows"], {
        timeoutMs: 12_000
      }).catch(() => null)
    ]);
    const detail = `${activityResult?.stdout || ""}\n${windowResult?.stdout || ""}`;
    const focusLines = String(windowResult?.stdout || "")
      .split("\n")
      .filter((line) =>
        /mCurrentFocus|mFocusedApp|mObscuringWindow/i.test(line)
      )
      .join("\n");
    const packageLines = detail
      .split("\n")
      .filter((line) => line.includes(packageName))
      .join("\n");
    const anr =
      /notResponding\s*=\s*true|application not responding|\bANR\b/i.test(
        packageLines
      ) ||
      new RegExp(
        `(ANR|not responding)[^\\n]{0,240}${packageName.replaceAll(".", "\\.")}`,
        "i"
      ).test(detail);
    return {
      running: Boolean(pidResult?.stdout?.trim()),
      anr,
      foreground: focusLines.includes(packageName),
      detail: packageLines.slice(0, 4_000)
    };
  }

  async screenshot(path) {
    const result = await this.raw(
      ["-s", this.serial, "exec-out", "screencap", "-p"],
      { encoding: "buffer", timeoutMs: 20_000 }
    );
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, result.stdout);
    return path;
  }

  async mouseTap(x, y, signal) {
    const args = ["input", "mouse", "tap", Math.round(x), Math.round(y)];
    try {
      await this.shell(args, { signal, timeoutMs: 5_000 });
    } catch (error) {
      if (signal?.aborted) throw error;
      await this.reconnect();
      await this.shell(args, { signal, timeoutMs: 5_000 }).catch((retryError) => {
        retryError.cause = error;
        throw retryError;
      });
    }
  }

  async mouseSwipe(from, to, durationMs = 500, signal) {
    const args = [
      "input",
      "mouse",
      "swipe",
      Math.round(from.x),
      Math.round(from.y),
      Math.round(to.x),
      Math.round(to.y),
      Math.round(durationMs)
    ];
    try {
      await this.shell(args, { signal, timeoutMs: 5_000 });
    } catch (error) {
      if (signal?.aborted) throw error;
      await this.reconnect();
      await this.shell(args, { signal, timeoutMs: 5_000 }).catch((retryError) => {
        retryError.cause = error;
        throw retryError;
      });
    }
  }

  async key(code, signal, options = {}) {
    const repeat = Math.max(1, Math.min(20, Number(options.repeat) || 1));
    const codes = Array.from({ length: repeat }, () => String(code));
    await this.shell(
      [
        "input",
        "keyevent",
        ...(options.longPress ? ["--longpress"] : []),
        ...codes
      ],
      { signal, timeoutMs: 5_000 }
    );
  }

  async currentIme() {
    const result = await this.shell(["settings", "get", "secure", "default_input_method"]);
    return result.stdout.trim();
  }

  async setIme(ime) {
    await this.shell(["ime", "enable", ime]).catch(() => undefined);
    await this.shell(["ime", "set", ime]);
  }

  async typeUnicode(text, signal) {
    const ime = this.config.adb.unicodeIme;
    const original = await this.currentIme();
    try {
      await this.setIme(ime);
      const encoded = Buffer.from(text, "utf8").toString("base64");
      await this.shell(
        [
          "am",
          "broadcast",
          "-a",
          "ADB_INPUT_B64",
          "--es",
          "msg",
          encoded
        ],
        { signal }
      );
    } finally {
      if (original && original !== "null" && original !== ime) {
        await this.setIme(original).catch(() => undefined);
      }
    }
  }
}
