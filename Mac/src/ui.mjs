import { delay } from "./process.mjs";
import { center } from "./vision.mjs";

export class GameUi {
  constructor(config, adb, vision, report = async () => {}) {
    this.config = config;
    this.adb = adb;
    this.vision = vision;
    this.report = report;
    this.runtimeAutomation = null;
  }

  setRuntimeAutomation(automation) {
    this.runtimeAutomation = automation;
  }

  async afterAction(signal) {
    await delay(this.config.timeouts.actionDelayMs, signal);
  }

  async tap(point, signal) {
    await this.adb.mouseTap(point.x, point.y, signal);
    await this.afterAction(signal);
  }

  async clickText(text, options = {}, signal) {
    const timeoutMs = this.timeoutMs(options);
    const deadline = Date.now() + timeoutMs;
    do {
      const frame = await this.vision.capture(`find-${text}`, signal);
      const match = this.vision.find(frame.observations, text, options.mode);
      if (match) {
        await this.tap(center(match), signal);
        return { frame, match };
      }
      await delay(700, signal);
    } while (Date.now() < deadline);
    throw new Error(`OCR could not find text: ${text}`);
  }

  async waitAnyText(texts, options = {}, signal) {
    const timeoutMs = this.timeoutMs(options);
    const deadline = Date.now() + timeoutMs;
    let unchangedSince = Date.now();
    let previousFingerprint = "";
    do {
      const frame = await this.vision.capture("wait-text", signal);
      const found = texts
        .map((text) => ({ text, match: this.vision.find(frame.observations, text) }))
        .find((item) => item.match);
      if (found) return { ...found, frame };
      const fingerprint = frame.observations
        .map((item) => `${item.text}:${Math.round(item.x / 8)}:${Math.round(item.y / 8)}`)
        .join("|");
      if (fingerprint !== previousFingerprint) {
        previousFingerprint = fingerprint;
        unchangedSince = Date.now();
      } else {
        const frozenSeconds =
          this.runtimeAutomation?.gameWatchdog?.frozenScreenSeconds;
        if (
          Number.isFinite(frozenSeconds) &&
          Date.now() - unchangedSince >= frozenSeconds * 1000
        ) {
          throw new Error(`GAME_SCREEN_FROZEN:${texts.join("/")}`);
        }
      }
      await delay(800, signal);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for: ${texts.join(" / ")}`);
  }

  timeoutMs(options) {
    const local = options.timeoutSeconds || this.config.timeouts.screenTransitionSeconds;
    const configured =
      this.runtimeAutomation?.gameWatchdog?.actionTimeoutSeconds || local;
    return Math.min(local, configured) * 1000;
  }

  async executeFlow(name, variables = {}, signal) {
    const actions = this.config.flows[name];
    if (!Array.isArray(actions) || !actions.length) {
      throw new Error(`Flow "${name}" is not calibrated in Mac/config.json`);
    }
    await this.report("info", name, `开始界面流程：${name}`);
    for (const source of actions) {
      if (signal?.aborted) throw signal.reason || new Error("Interrupted");
      const action = substitute(source, variables);
      switch (action.op) {
        case "tap":
          await this.tap(action, signal);
          break;
        case "clickText":
          await this.clickText(action.text, action, signal);
          break;
        case "waitAnyText":
          await this.waitAnyText(action.texts, action, signal);
          break;
        case "key":
          await this.adb.key(action.code, signal);
          await this.afterAction(signal);
          break;
        case "sleep":
          await delay(action.ms, signal);
          break;
        case "swipe":
          await this.adb.mouseSwipe(action.from, action.to, action.durationMs, signal);
          await this.afterAction(signal);
          break;
        case "typeUnicode":
          await this.adb.typeUnicode(action.text, signal);
          await this.afterAction(signal);
          break;
        default:
          throw new Error(`Unsupported UI action: ${action.op}`);
      }
    }
  }
}

function substitute(value, variables) {
  if (typeof value === "string") {
    return value.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_, path) => {
      let current = variables;
      for (const key of path.split(".")) current = current?.[key];
      return current == null ? "" : String(current);
    });
  }
  if (Array.isArray(value)) return value.map((item) => substitute(item, variables));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, substitute(item, variables)])
  );
}
