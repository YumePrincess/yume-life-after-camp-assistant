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

  async keyUntilText(action, signal) {
    const timeoutMs = this.timeoutMs(action);
    const deadline = Date.now() + timeoutMs;
    const minimumKeyBatches = Math.max(
      0,
      Math.min(20, Number(action.minimumKeyBatches) || 0)
    );
    let keyBatches = 0;
    do {
      if (keyBatches >= minimumKeyBatches) {
        const frame = await this.vision.capture(
          `key-until-${action.texts.join("-")}`,
          signal
        );
        const found = action.texts
          .map((text) => ({
            text,
            match: this.vision.find(frame.observations, text)
          }))
          .find((item) => item.match);
        if (found) return { ...found, frame };
      }
      await this.adb.key(action.code, signal, {
        longPress: action.longPress !== false,
        repeat: action.repeat || 1
      });
      keyBatches += 1;
      await delay(action.intervalMs || 250, signal);
    } while (Date.now() < deadline);
    throw new Error(`Timed out moving until: ${action.texts.join(" / ")}`);
  }

  async keyIfAnyText(texts, code, signal) {
    const frame = await this.vision.capture("conditional-key", signal);
    const found = texts
      .map((text) => ({ text, match: this.vision.find(frame.observations, text) }))
      .find((item) => item.match);
    if (!found) return null;
    await this.adb.key(code, signal);
    await this.afterAction(signal);
    return { ...found, frame };
  }

  async tapIfAnyText(texts, point, signal) {
    const frame = await this.vision.capture("conditional-tap", signal);
    const found = texts
      .map((text) => ({ text, match: this.vision.find(frame.observations, text) }))
      .find((item) => item.match);
    if (!found) return null;
    await this.tap(point, signal);
    return { ...found, frame };
  }

  async tapUnlessAnyText(texts, point, signal) {
    const frame = await this.vision.capture("conditional-tap-unless", signal);
    const found = texts
      .map((text) => ({ text, match: this.vision.find(frame.observations, text) }))
      .find((item) => item.match);
    if (found) return { ...found, frame, skipped: true };
    await this.tap(point, signal);
    return { frame, skipped: false };
  }

  async clickIfText(text, options, signal) {
    const frame = await this.vision.capture(`conditional-click-${text}`, signal);
    const match = this.vision.find(frame.observations, text, options.mode);
    if (!match) return null;
    await this.tap(center(match), signal);
    return { frame, match };
  }

  async clickTextsUntilAnyText(action, signal) {
    const deadline = Date.now() + this.timeoutMs(action);
    do {
      const frame = await this.vision.capture("click-texts-until-target", signal);
      const target = action.targetTexts
        .map((text) => ({ text, match: this.vision.find(frame.observations, text) }))
        .find((item) => item.match);
      if (target) return { ...target, frame };
      const candidate = action.clickTexts
        .map((text) => ({ text, match: this.vision.find(frame.observations, text) }))
        .find((item) => item.match);
      if (candidate) {
        await this.tap(center(candidate.match), signal);
      } else {
        await delay(action.intervalMs || 800, signal);
      }
    } while (Date.now() < deadline);
    throw new Error(
      `Timed out navigating via ${action.clickTexts.join(" / ")} to ${action.targetTexts.join(" / ")}`
    );
  }

  async teleportWithFallback(action, signal) {
    let result = await this.attemptTeleport(action, action.target, signal);
    if (result.state === "success") return result;
    if (result.state === "nearby" && action.nearbyIsSuccess) return result;

    if (result.state === "cooldown") {
      await this.report(
        "warning",
        "teleport_cooldown",
        `传送到${action.target.name}时仍在冷却，等待 ${action.cooldownSeconds} 秒后重试`
      );
      await delay(action.cooldownSeconds * 1000, signal);
      result = await this.attemptTeleport(action, action.target, signal);
      if (result.state === "success") return result;
    }

    if (result.state !== "nearby") {
      const health = await this.adb.gameHealth().catch(() => ({
        running: false
      }));
      if (!health.running) throw new Error("GAME_PROCESS_EXITED");
      throw new Error(
        `Teleport to ${action.target.name} failed: ${result.state}${result.text ? ` (${result.text})` : ""}`
      );
    }

    await this.report(
      "warning",
      "teleport_nearby_recovery",
      `角色可能已在${action.target.name}附近，先传送到${action.fallback.name}，等待传送冷却后再返回`,
      { firstState: result.state, detectedText: result.text || null }
    );
    const fallback = await this.attemptTeleport(
      action,
      action.fallback,
      signal
    );
    if (fallback.state !== "success") {
      throw new Error(
        `Teleport fallback to ${action.fallback.name} failed: ${fallback.state}${fallback.text ? ` (${fallback.text})` : ""}`
      );
    }
    await delay(action.cooldownSeconds * 1000, signal);
    const returned = await this.attemptTeleport(action, action.target, signal);
    if (returned.state !== "success") {
      throw new Error(
        `Teleport return to ${action.target.name} failed after fallback: ${returned.state}${returned.text ? ` (${returned.text})` : ""}`
      );
    }
    return returned;
  }

  async attemptTeleport(action, destination, signal) {
    await this.ensureMapOpen(action, signal);
    if (action.mapModeButton) {
      // The camp map can reopen on "查看庄园". "标志查看" is idempotent,
      // so always select it before using the fixed destination list.
      await this.tap(action.mapModeButton, signal);
      await delay(action.mapModeDelayMs || 800, signal);
    }
    const scrollSteps = Math.max(
      0,
      Math.min(20, Number(destination.scrollSteps) || 0)
    );
    for (let index = 0; index < scrollSteps; index += 1) {
      await this.adb.mouseSwipe(
        action.mapListSwipe?.from || { x: 350, y: 950 },
        action.mapListSwipe?.to || { x: 350, y: 350 },
        action.mapListSwipe?.durationMs || 500,
        signal
      );
      await delay(action.mapListSwipe?.betweenMs || 500, signal);
    }
    await this.tap(destination, signal);
    await delay(action.destinationSelectDelayMs || 600, signal);
    if (action.quickTravelEnabledDetection) {
      const selected = await this.vision.capture(
        `teleport-selected-${destination.name || "target"}`,
        signal
      );
      const [feature] = await this.vision.probe(
        selected.path,
        [action.quickTravel],
        action.quickTravelEnabledDetection.radius || 30,
        signal
      );
      if (
        feature.meanSaturation <
        action.quickTravelEnabledDetection.minimumSaturation
      ) {
        return {
          state: "nearby",
          text: "快速前往按钮为灰色（已在目标点附近）"
        };
      }
    }
    await this.tap(action.quickTravel, signal);
    const result = await this.waitTeleportResult(
      destination.readyTexts,
      action.failureTexts,
      action.resultTimeoutSeconds,
      signal
    );
    return result;
  }

  async ensureMapOpen(action, signal) {
    const frame = await this.vision.captureTransient("teleport-map-state", signal);
    const alreadyOpen = (action.mapReadyTexts || [])
      .map((text) => this.vision.find(frame.observations, text))
      .find(Boolean);
    const failureOverlay = (action.failureTexts || [])
      .map((text) => this.vision.find(frame.observations, text))
      .find(Boolean);
    if (failureOverlay) {
      await this.adb.key(4, signal);
      await this.afterAction(signal);
    }
    if (!alreadyOpen || failureOverlay) {
      if (action.mapKey) {
        await this.adb.key(action.mapKey, signal);
      } else {
        await this.tap(action.mapButton, signal);
      }
    }
    const deadline =
      Date.now() + (action.mapOpenTimeoutSeconds || 10) * 1000;
    do {
      await delay(action.mapOpenPollMs || 500, signal);
      const verification = await this.vision.captureTransient(
        "teleport-map-verification",
        signal
      );
      const verified = (action.mapReadyTexts || [])
        .map((text) => this.vision.find(verification.observations, text))
        .find(Boolean);
      if (verified) return;
    } while (Date.now() < deadline);
    throw new Error(
      "MAP_DID_NOT_OPEN: 未识别到“标志查看/查看庄园”，已停止后续地点与快速前往点击"
    );
  }

  async waitTeleportResult(
    readyTexts,
    failureTexts,
    timeoutSeconds = 30,
    signal
  ) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    do {
      const frame = await this.vision.captureTransient(
        "teleport-result",
        signal
      );
      const ready = readyTexts
        .map((text) => ({
          text,
          match: this.vision.find(frame.observations, text)
        }))
        .find((item) => item.match);
      if (ready) return { state: "success", text: ready.text };
      const failure = failureTexts
        .map((text) => ({
          text,
          match: this.vision.find(frame.observations, text)
        }))
        .find((item) => item.match);
      if (failure) {
        return {
          state: /冷却/.test(failure.text) ? "cooldown" : "nearby",
          text: failure.text
        };
      }
      await delay(600, signal);
    } while (Date.now() < deadline);
    return { state: "timeout", text: null };
  }

  async teleportByText(action, signal) {
    await this.ensureMapOpen(action, signal);
    if (action.mapModeButton) {
      await this.tap(action.mapModeButton, signal);
      await delay(action.mapModeDelayMs || 800, signal);
    }
    await this.clickText(
      action.targetText,
      {
        mode: action.targetTextMode || "includes",
        timeoutSeconds: action.targetFindTimeoutSeconds || 12
      },
      signal
    );
    if (action.quickTravelEnabledDetection) {
      const selected = await this.vision.capture(
        `teleport-selected-${action.targetText}`,
        signal
      );
      const [feature] = await this.vision.probe(
        selected.path,
        [action.quickTravel],
        action.quickTravelEnabledDetection.radius || 30,
        signal
      );
      if (
        feature.meanSaturation <
        action.quickTravelEnabledDetection.minimumSaturation
      ) {
        return {
          state: "nearby",
          text: "快速前往按钮为灰色（已在目标点附近）"
        };
      }
    }
    await this.tap(action.quickTravel, signal);
    const result = await this.waitTeleportResult(
      action.readyTexts,
      action.failureTexts,
      action.resultTimeoutSeconds,
      signal
    );
    if (result.state === "success" || result.state === "nearby") {
      return result;
    }
    if (result.state === "cooldown") {
      await delay(action.cooldownSeconds * 1000, signal);
      await this.ensureMapOpen(action, signal);
      if (action.mapModeButton) {
        await this.tap(action.mapModeButton, signal);
        await delay(action.mapModeDelayMs || 800, signal);
      }
      await this.clickText(
        action.targetText,
        { timeoutSeconds: action.targetFindTimeoutSeconds || 12 },
        signal
      );
      await this.tap(action.quickTravel, signal);
      const retry = await this.waitTeleportResult(
        action.readyTexts,
        action.failureTexts,
        action.resultTimeoutSeconds,
        signal
      );
      if (retry.state === "success" || retry.state === "nearby") return retry;
    }
    throw new Error(
      `Teleport to ${action.targetText} failed: ${result.state}${result.text ? ` (${result.text})` : ""}`
    );
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
          await this.adb.key(action.code, signal, {
            longPress: action.longPress,
            repeat: action.repeat
          });
          await this.afterAction(signal);
          break;
        case "keyUntilText":
          await this.keyUntilText(action, signal);
          await this.afterAction(signal);
          break;
        case "keyIfAnyText":
          await this.keyIfAnyText(action.texts, action.code, signal);
          break;
        case "tapIfAnyText":
          await this.tapIfAnyText(action.texts, action, signal);
          break;
        case "tapUnlessAnyText":
          await this.tapUnlessAnyText(action.texts, action, signal);
          break;
        case "clickIfText":
          await this.clickIfText(action.text, action, signal);
          break;
        case "clickTextsUntilAnyText":
          await this.clickTextsUntilAnyText(action, signal);
          break;
        case "teleportWithFallback":
          await this.teleportWithFallback(action, signal);
          break;
        case "teleportByText":
          await this.teleportByText(action, signal);
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
