import { delay } from "./process.mjs";
import { center } from "./vision.mjs";

export class GameUi {
  constructor(config, adb, vision, report = async () => {}) {
    this.config = config;
    this.adb = adb;
    this.vision = vision;
    this.report = report;
    this.runtimeAutomation = null;
    this.lastConfirmedDestination = null;
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
    let deadline = Date.now() + timeoutMs;
    do {
      const frame = await this.vision.capture(`find-${text}`, signal);
      const match = this.findInRegion(
        frame.observations,
        text,
        options.region,
        options.mode
      );
      if (match) {
        await this.tap(center(match), signal);
        return { frame, match };
      }
      await delay(700, signal);
      if (
        Date.now() >= deadline &&
        this.config.timeouts.neverAbortHealthyTaskOnTimeout
      ) {
        await this.report(
          "warning",
          "healthy_ui_wait_extended",
          `游戏进程健康，继续等待可点击文字：${text}`
        );
        deadline = Date.now() + timeoutMs;
      }
    } while (Date.now() < deadline);
    throw new Error(`OCR could not find text: ${text}`);
  }

  async waitAnyText(texts, options = {}, signal) {
    const timeoutMs = this.timeoutMs(options);
    let deadline = Date.now() + timeoutMs;
    let unchangedSince = Date.now();
    let previousFingerprint = "";
    let nextAdvisorAt = 0;
    let nextRegionOcrAt = 0;
    let nextAccurateOcrAt = 0;
    let regionOcrFailureReported = false;
    let lastAdviceSignature = "";
    let lastAdviceReportAt = 0;
    do {
      const frame = await this.vision.capture("wait-text", signal);
      let found = texts
        .map((text) => ({
          text,
          match: this.findInRegion(frame.observations, text, options.region)
        }))
        .find((item) => item.match);
      if (found) return { ...found, frame };
      if (
        options.region &&
        frame.path &&
        typeof this.vision.ocrRegion === "function" &&
        Date.now() >= nextRegionOcrAt
      ) {
        nextRegionOcrAt = Date.now() + 2_000;
        try {
          const regionalObservations = await this.vision.ocrRegion(
            frame.path,
            options.region,
            `wait-${texts.join("-")}`,
            signal
          );
          found = texts
            .map((text) => ({
              text,
              match: this.findInRegion(
                regionalObservations,
                text,
                options.region
              )
            }))
            .find((item) => item.match);
          if (found) {
            return {
              ...found,
              frame,
              regionalOcr: true
            };
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          if (!regionOcrFailureReported) {
            regionOcrFailureReported = true;
            await this.report(
              "warning",
              "regional_ocr_unavailable",
              "目标小区域中文 OCR 本次不可用，保留界面并继续等待；不会由模型代替放行",
              { reason: error.message, region: options.region }
            );
          }
        }
      }
      if (
        typeof this.vision.captureAccurateTransient === "function" &&
        Date.now() >= nextAccurateOcrAt
      ) {
        nextAccurateOcrAt = Date.now() + 2_000;
        const accurate = await this.vision.captureAccurateTransient(
          `wait-text-accurate-${texts.join("-")}`,
          signal
        ).catch(() => null);
        const accurateFound = texts
          .map((text) => ({
            text,
            match: accurate
              ? this.findInRegion(
                  accurate.observations,
                  text,
                  options.region
                )
              : null
          }))
          .find((item) => item.match);
        if (accurateFound) {
          await this.report(
            "info",
            "accurate_text_verified",
            `快速 OCR 漏读后，已通过高精度 OCR 确认界面文字：${accurateFound.text}`
          );
          return { ...accurateFound, frame, accurateOcr: true };
        }
      }
      if (
        Date.now() >= nextAdvisorAt &&
        this.vision.advisor?.enabled &&
        this.vision.advisor.config.mode === "guarded"
      ) {
        nextAdvisorAt = Date.now() + 1_000;
        const advice = await this.vision.adviseCurrent(
          "wait-text-advisor",
          {
            expectedState: "target_text_visible",
            taskHint: `确认画面是否清晰显示以下任一文字：${texts.join("、")}`,
            ocrTexts: frame.observations.map((item) => item.text)
          },
          signal
        ).catch(() => null);
        const minimum =
          Number(
            this.vision.advisor.config.minimumActionConfidence
          ) || 0.95;
        const accepted =
          advice?.state === "target_text_visible" &&
          Number(advice.confidence) >= minimum;
        const adviceSignature = `${advice?.state || "unavailable"}:${Number(
          advice?.confidence || 0
        ).toFixed(2)}`;
        if (
          adviceSignature !== lastAdviceSignature ||
          Date.now() - lastAdviceReportAt >= 60_000
        ) {
          lastAdviceSignature = adviceSignature;
          lastAdviceReportAt = Date.now();
          await this.report(
            "info",
            "local_model_text_verification",
            `本地模型页面候选仅供记录：${advice?.state || "unavailable"}；不会替代 OCR 推动流程`,
            {
              ...advice,
              accepted: false,
              modelWouldAccept: accepted,
              texts,
              region: options.region || null
            }
          );
        }
      }
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
          !this.config.timeouts.neverAbortHealthyTaskOnTimeout &&
          Number.isFinite(frozenSeconds) &&
          Date.now() - unchangedSince >= frozenSeconds * 1000
        ) {
          throw new Error(`GAME_SCREEN_FROZEN:${texts.join("/")}`);
        }
      }
      await delay(800, signal);
      if (
        Date.now() >= deadline &&
        this.config.timeouts.neverAbortHealthyTaskOnTimeout
      ) {
        await this.report(
          "warning",
          "healthy_ui_wait_extended",
          `游戏进程健康，继续等待界面文字：${texts.join(" / ")}`
        );
        deadline = Date.now() + timeoutMs;
      }
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for: ${texts.join(" / ")}`);
  }

  findInRegion(observations, text, region, mode = "includes") {
    if (!region) return this.vision.find(observations, text, mode);
    const filtered = observations.filter((item) => {
      const x = item.x + item.width / 2;
      const y = item.y + item.height / 2;
      return (
        x >= region.left &&
        x <= region.right &&
        y >= region.top &&
        y <= region.bottom
      );
    });
    return this.vision.find(filtered, text, mode);
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
      await this.sendGameKey(action.code, signal, {
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
    await this.sendGameKey(code, signal);
    await this.afterAction(signal);
    return { ...found, frame };
  }

  async sendGameKey(code, signal, options = {}) {
    await this.adb.key(code, signal, options);
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
    let nextAccurateOcrAt = 0;
    let nextRegionOcrAt = 0;
    do {
      const frame = await this.vision.capture("click-texts-until-target", signal);
      let target = action.targetTexts
        .map((text) => ({
          text,
          match: this.vision.find(frame.observations, text)
        }))
        .find((item) => item.match);
      if (target) return { ...target, frame };
      let clickObservations = frame.observations;
      let candidate = action.clickTexts
        .map((text) => ({
          text,
          match: this.findInRegion(
            clickObservations,
            text,
            action.clickRegion
          )
        }))
        .find((item) => item.match);
      if (
        !candidate &&
        action.clickRegion &&
        frame.path &&
        typeof this.vision.ocrRegion === "function" &&
        Date.now() >= nextRegionOcrAt
      ) {
        nextRegionOcrAt = Date.now() + 2_000;
        const regionalObservations = await this.vision.ocrRegion(
          frame.path,
          action.clickRegion,
          "click-texts-until-target-region",
          signal,
          "accurate",
          Number(action.regionOcrMinimumConfidence) || 0.2,
          Number(action.regionOcrScale) || 2
        ).catch(() => []);
        clickObservations = [
          ...frame.observations,
          ...regionalObservations
        ];
        candidate = action.clickTexts
          .map((text) => ({
            text,
            match: this.findInRegion(
              clickObservations,
              text,
              action.clickRegion
            )
          }))
          .find((item) => item.match);
        if (candidate) {
          await this.report(
            "info",
            "accurate_navigation_text_verified",
            `快速 OCR 漏读后，已通过交互区域高精度 OCR 找到可点击文字：${candidate.text}`
          );
        }
      }
      if (
        !candidate &&
        typeof this.vision.captureAccurateTransient === "function" &&
        Date.now() >= nextAccurateOcrAt
      ) {
        nextAccurateOcrAt = Date.now() + 2_000;
        const accurate = await this.vision.captureAccurateTransient(
          "click-texts-until-target-accurate",
          signal
        ).catch(() => null);
        target = action.targetTexts
          .map((text) => ({
            text,
            match: accurate
              ? this.vision.find(accurate.observations, text)
              : null
          }))
          .find((item) => item.match);
        if (target) {
          await this.report(
            "info",
            "accurate_navigation_target_verified",
            `快速 OCR 漏读后，已通过高精度 OCR 确认目标页面：${target.text}`
          );
          return { ...target, frame, accurateOcr: true };
        }
        if (accurate) {
          clickObservations = [
            ...clickObservations,
            ...accurate.observations
          ];
          candidate = action.clickTexts
            .map((text) => ({
              text,
              match: this.findInRegion(
                clickObservations,
                text,
                action.clickRegion
              )
            }))
            .find((item) => item.match);
        }
      }
      if (candidate) {
        await this.tap(center(candidate.match), signal);
      } else {
        const anchoredClick = (action.anchorClickFallbacks || [])
          .map((fallback) => ({
            fallback,
            anchor: this.findInRegion(
              clickObservations,
              fallback.anchorText,
              action.clickRegion
            )
          }))
          .find((item) => item.anchor);
        if (anchoredClick) {
          const anchorPoint = center(anchoredClick.anchor);
          const point = {
            x: anchorPoint.x + Number(anchoredClick.fallback.offsetX || 0),
            y: anchorPoint.y + Number(anchoredClick.fallback.offsetY || 0)
          };
          await this.report(
            "info",
            "anchored_navigation_click",
            `已确认交互菜单锚点“${anchoredClick.fallback.anchorText}”，点击其相邻的“${anchoredClick.fallback.targetText}”按钮`,
            { point }
          );
          await this.tap(point, signal);
        } else {
          await delay(action.intervalMs || 800, signal);
        }
      }
    } while (Date.now() < deadline);
    throw new Error(
      `Timed out navigating via ${action.clickTexts.join(" / ")} to ${action.targetTexts.join(" / ")}`
    );
  }

  async teleportWithFallback(action, signal) {
    let result = await this.attemptTeleport(action, action.target, signal);
    if (result.state === "success") {
      this.lastConfirmedDestination = action.target.name;
      return result;
    }
    if (result.state === "nearby" && action.nearbyIsSuccess) {
      this.lastConfirmedDestination = action.target.name;
      return result;
    }

    if (result.state === "cooldown") {
      await this.report(
        "warning",
        "teleport_cooldown",
        `传送到${action.target.name}时仍在冷却，等待 ${action.cooldownSeconds} 秒后重试`
      );
      await delay(action.cooldownSeconds * 1000, signal);
      result = await this.attemptTeleport(action, action.target, signal);
      if (result.state === "success") {
        this.lastConfirmedDestination = action.target.name;
        return result;
      }
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
    if (!["success", "nearby"].includes(fallback.state)) {
      throw new Error(
        `Teleport fallback to ${action.fallback.name} failed: ${fallback.state}${fallback.text ? ` (${fallback.text})` : ""}`
      );
    }
    this.lastConfirmedDestination = action.fallback.name;
    if (fallback.state === "success") {
      await delay(action.cooldownSeconds * 1000, signal);
    } else {
      await this.report(
        "info",
        "teleport_fallback_already_there",
        `角色已在${action.fallback.name}附近，跳过备用传送和冷却等待，直接继续前往${action.target.name}`
      );
    }
    const returned = await this.attemptTeleport(action, action.target, signal);
    if (returned.state !== "success") {
      throw new Error(
        `Teleport return to ${action.target.name} failed after fallback: ${returned.state}${returned.text ? ` (${returned.text})` : ""}`
      );
    }
    this.lastConfirmedDestination = action.target.name;
    return returned;
  }

  async attemptTeleport(action, destination, signal) {
    await this.ensureMapOpen(action, signal);
    await this.ensureMapDestinationList(action, signal);
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
    if (
      action.quickTravelEnabledDetection &&
      this.config.vision.quickTravelPrecheckEnabled !== false
    ) {
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
    if (result.state === "arrived_hud") {
      if (
        !destination.readyRegion ||
        (await this.verifyDestination(destination, signal))
      ) {
        return {
          state: "success",
          text:
            result.text ||
            `传送进度已结束并回到 HUD，已确认${destination.name}交互按钮`
        };
      }
      return {
        state: "nearby",
        text: `传送进度已结束并回到 HUD，但按 W 接近后仍未出现${destination.name}交互按钮`
      };
    }
    if (
      result.state === "success" &&
      destination.readyRegion &&
      !(await this.verifyDestination(destination, signal))
    ) {
      return {
        state: "nearby",
        text: `已到达${destination.name}传送点，但未出现正确交互选项`
      };
    }
    return result;
  }

  async verifyDestination(destination, signal) {
    const approachSteps = destination.approachUntilReady
      ? Math.max(
          1,
          Math.min(5, Number(destination.approachMaxSteps) || 5)
        )
      : 0;
    const approachPressMs = 1_000;
    for (let attempt = 0; attempt < Math.max(2, approachSteps + 1); attempt += 1) {
      const frame = await this.vision.capture(
        `verify-destination-${destination.name}-${attempt + 1}`,
        signal
      );
      let observations = frame.observations;
      if (typeof this.vision.ocrRegion === "function") {
        observations = await this.vision.ocrRegion(
          frame.path,
          destination.readyRegion,
          `verify-${destination.name}-${attempt + 1}`,
          signal
        ).catch(() => observations);
      }
      const found = (destination.readyTexts || [])
        .map((text) => ({
          text,
          match: this.findInRegion(
            observations,
            text,
            destination.readyRegion
          )
        }))
        .find((item) => item.match);
      if (found) {
        await this.report(
          "info",
          "teleport_destination_verified",
          `已确认到达${destination.name}并出现正确交互选项：${found.text}`
        );
        return true;
      }
      if (attempt < approachSteps) {
        if (attempt === 0) {
          await this.report(
            "warning",
            "teleport_destination_approaching",
            `已到达${destination.name}但暂未看到交互选项，正在按 W 分段前进（每次 1 秒，最多 ${approachSteps} 次），识别到目标文字后立即停止`,
            {
              readyTexts: destination.readyTexts,
              maximumSteps: approachSteps,
              pressDurationMs: approachPressMs
            }
          );
        }
        await this.sendGameKey(
          destination.approachKey || "KEYCODE_W",
          signal,
          { longPress: true }
        );
        // MuMu receives W through Android's long-press key event. Keep every
        // movement segment at one second before re-reading the interaction UI.
        await delay(approachPressMs, signal);
      } else {
        await delay(1_000, signal);
      }
    }
    await this.report(
      "warning",
      "teleport_destination_unverified",
      `已到达${destination.name}传送点并完成前进恢复，但没有出现配置的正确交互选项；将执行中心出入口往返恢复`,
      {
        readyTexts: destination.readyTexts,
        approachSteps
      }
    );
    return false;
  }

  async ensureMapOpen(action, signal) {
    const prepared = await this.closePagesBeforeMap(action, signal);
    if (prepared === "map") return;
    const mapButton = Object.hasOwn(action, "mapButton")
      ? action.mapButton
      : { x: 1780, y: 120 };
    const mapKey = action.mapKey || "KEYCODE_M";
    if (mapButton) {
      await this.report(
        "info",
        "map_open_button",
        "正在点击右上角地图按钮；识别到地图固定文字后才会继续",
        { point: mapButton }
      );
      await this.tap(mapButton, signal);
    } else {
      await this.report(
        "info",
        "map_open_key",
        "正在发送 M 键打开地图；识别到地图固定文字后才会继续",
        { key: mapKey }
      );
      await this.sendGameKey(mapKey, signal);
    }
    const timeoutMs = Math.max(
      180,
      Number(action.mapOpenTimeoutSeconds) || 10
    ) * 1000;
    let deadline = Date.now() + timeoutMs;
    let advisorChecked = false;
    let accurateCheckedAt = 0;
    let mapKeyFallbackSent = !mapButton || !mapKey;
    const configuredFallbackDelayMs = Number(action.mapKeyFallbackDelayMs);
    const mapKeyFallbackDelayMs = Math.max(
      0,
      Number.isFinite(configuredFallbackDelayMs)
        ? configuredFallbackDelayMs
        : 4_000
    );
    const mapKeyFallbackAt = Date.now() + mapKeyFallbackDelayMs;
    do {
      await delay(action.mapOpenPollMs || 500, signal);
      const verification = await this.vision.captureTransient(
        "teleport-map-verification",
        signal
      );
      const verified = (action.mapReadyTexts || [])
        .map((text) => this.vision.find(verification.observations, text))
        .find(Boolean);
      if (verified) {
        await this.report(
          "info",
          "map_open_verified",
          `已通过地图固定文字确认页面打开：${verified.text}`
        );
        return;
      }
      if (!mapKeyFallbackSent && Date.now() >= mapKeyFallbackAt) {
        mapKeyFallbackSent = true;
        await this.report(
          "warning",
          "map_open_key_fallback",
          "地图按钮已用于取得游戏输入焦点，快速 OCR 尚未确认地图；立即发送一次 M 键备用，之后仍需地图固定文字确认",
          { key: mapKey }
        );
        await this.sendGameKey(mapKey, signal);
      }
      if (
        typeof this.vision.captureAccurateTransient === "function" &&
        Date.now() - accurateCheckedAt >= 2_000
      ) {
        accurateCheckedAt = Date.now();
        const accurate = await this.vision.captureAccurateTransient(
          "teleport-map-verification-accurate",
          signal
        ).catch(() => null);
        const accurateVerified = (action.mapReadyTexts || [])
          .map((text) =>
            accurate
              ? this.vision.find(accurate.observations, text)
              : null
          )
          .find(Boolean);
        if (accurateVerified) {
          await this.report(
            "info",
            "map_open_verified_accurate",
            `已通过高精度 OCR 确认地图页面打开：${accurateVerified.text}`
          );
          return;
        }
      }
      if (
        !advisorChecked &&
        this.vision.advisor?.enabled &&
        this.vision.advisor.config.mode === "guarded"
      ) {
        advisorChecked = true;
        const advice = await this.vision.adviseCurrent(
          "teleport-map-advisor",
          {
            expectedState: "map",
            taskHint: `确认营地地图是否已打开；可见文字通常包括${(
              action.mapReadyTexts || []
            ).join("、")}`,
            ocrTexts: verification.observations.map((item) => item.text)
          },
          signal
        ).catch(() => null);
        const minimum =
          Number(
            this.vision.advisor.config.minimumActionConfidence
          ) || 0.95;
        await this.report(
          "info",
          "local_model_map_verification",
          `本地模型地图候选仅供记录：${advice?.state || "unavailable"}；仍需 OCR 地图固定文字确认`,
          {
            ...advice,
            accepted: false,
            modelWouldAccept:
              advice?.state === "map" && advice.confidence >= minimum
          }
        );
      }
      if (
        Date.now() >= deadline &&
        this.config.timeouts.neverAbortHealthyTaskOnTimeout
      ) {
        await this.report(
          "warning",
          "healthy_map_wait_extended",
          "游戏进程健康但地图尚未确认；不会点击地点或快速前往，继续等待"
        );
        advisorChecked = false;
        accurateCheckedAt = 0;
        deadline = Date.now() + timeoutMs;
      }
    } while (Date.now() < deadline);
    throw new Error(
      "MAP_DID_NOT_OPEN: 未识别到“标志查看/查看庄园”，已停止后续地点与快速前往点击"
    );
  }

  async ensureMapDestinationList(action, signal) {
    const modeText = action.mapModeText || "标志查看";
    const frame = await this.vision.captureTransient(
      "teleport-map-mode",
      signal
    );
    const modeButton = this.vision.find(
      frame.observations,
      modeText,
      "includes"
    );
    if (modeButton) {
      await this.report(
        "info",
        "map_mode_switch",
        `已识别并点击“${modeText}”切换到可选传送点列表`
      );
      await this.tap(center(modeButton), signal);
      await delay(action.mapModeDelayMs || 800, signal);
      return;
    }
    if (action.mapModeFallbackEnabled && action.mapModeButton) {
      await this.report(
        "warning",
        "map_mode_coordinate_fallback",
        "未识别到“标志查看”，使用已校准坐标回退"
      );
      await this.tap(action.mapModeButton, signal);
      await delay(action.mapModeDelayMs || 800, signal);
    }
  }

  async openCampPanelViaChat(action, signal) {
    await this.closeMapBeforeCampPanel(action, signal);
    const attempts = Math.max(1, Math.min(5, Number(action.attempts) || 3));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (signal?.aborted) throw signal.reason || new Error("Interrupted");
      const before = await this.vision.captureTransient(
        `camp-panel-before-${attempt}`,
        signal
      );
      if (this.isCampPanel(before.observations, action)) {
        return;
      }
      if (typeof this.vision.captureAccurateTransient === "function") {
        const accurateBefore = await this.vision.captureAccurateTransient(
          `camp-panel-before-accurate-${attempt}`,
          signal
        );
        if (this.isCampPanel(accurateBefore.observations, action)) {
          await this.report(
            "info",
            "camp_panel_already_open",
            "已通过高精度中文 OCR 确认营地页面原本就已打开"
          );
          return;
        }
      }
      await this.report(
        "info",
        "open_camp_panel_attempt",
        `通过聊天营地频道打开营地界面（${attempt}/${attempts}）`
      );
      await this.tap(action.chatButton || { x: 250, y: 1060 }, signal);
      await delay(action.chatDelayMs || 500, signal);
      await this.tap(action.campChannelButton || { x: 1740, y: 355 }, signal);
      await delay(action.channelDelayMs || 500, signal);
      await this.tap(action.campIconButton || { x: 980, y: 65 }, signal);

      const verifyDeadline =
        Date.now() + Math.max(1_500, Number(action.verifySeconds || 5) * 1000);
      let accurateChecked = false;
      while (Date.now() < verifyDeadline) {
        if (signal?.aborted) throw signal.reason || new Error("Interrupted");
        const frame = await this.vision.captureTransient(
          `camp-panel-verify-${attempt}`,
          signal
        );
        if (this.isCampPanel(frame.observations, action)) {
          return;
        }
        if (
          !accurateChecked &&
          typeof this.vision.captureAccurateTransient === "function"
        ) {
          accurateChecked = true;
          const accurate = await this.vision.captureAccurateTransient(
            `camp-panel-verify-accurate-${attempt}`,
            signal
          );
          if (this.isCampPanel(accurate.observations, action)) {
            await this.report(
              "info",
              "camp_panel_verified_accurate",
              "已通过高精度中文 OCR 确认营地页面"
            );
            return;
          }
        }
        await delay(350, signal);
      }
      await this.adb.key(4, signal).catch(() => undefined);
      await delay(350, signal);
    }
    throw new Error(
      "CAMP_PANEL_DID_NOT_OPEN: 已重试聊天→营地频道→市政厅图标，但未识别到营地首页"
    );
  }

  async closeMapBeforeCampPanel(action, signal) {
    const mapTexts =
      action.mapReadyTexts ||
      ["标志查看", "查看庄园", "可快捷前往地标"];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const fast = await this.vision.captureTransient(
        `camp-panel-map-check-${attempt}`,
        signal
      );
      let match = mapTexts
        .map((text) => this.vision.find(fast.observations, text))
        .find(Boolean);
      if (
        !match &&
        typeof this.vision.captureAccurateTransient === "function"
      ) {
        const accurate = await this.vision.captureAccurateTransient(
          `camp-panel-map-check-accurate-${attempt}`,
          signal
        ).catch(() => null);
        match = mapTexts
          .map((text) =>
            accurate
              ? this.vision.find(accurate.observations, text)
              : null
          )
          .find(Boolean);
      }
      if (!match) return;
      await this.report(
        "info",
        "camp_panel_map_closing",
        `打开营地面板前检测到地图遮挡（${match.text}），正在按 M 关闭地图`
      );
      await this.sendGameKey(
        action.mapCloseKey || "KEYCODE_M",
        signal
      );
      await this.afterAction(signal);
    }
    throw new Error(
      "CAMP_PANEL_MAP_BLOCKED: 已确认地图遮挡但两次按 M 后仍未关闭"
    );
  }

  isCampPanel(observations, action = {}) {
    const constantAnchors =
      action.readyConstantAnchors || [
        {
          text: "营地",
          region: { left: 90, top: 90, right: 340, bottom: 200 }
        },
        {
          text: "量子时代",
          region: { left: 250, top: 240, right: 650, bottom: 400 }
        },
        {
          text: "市长",
          region: { left: 140, top: 360, right: 700, bottom: 560 }
        },
        {
          text: "营地周活跃",
          region: { left: 600, top: 250, right: 1150, bottom: 430 }
        }
      ];
    const constantMatches = constantAnchors.filter((anchor) =>
      this.findInRegion(observations, anchor.text, anchor.region)
    );
    const minimumConstants = Math.max(
      2,
      Math.min(
        constantAnchors.length,
        Number(action.readyMinimumConstants) || 2
      )
    );
    if (constantMatches.length >= minimumConstants) return true;

    const tabTexts =
      action.readyTabTexts || action.readyTexts ||
      ["首页", "玩法", "科技", "成员", "相册"];
    const bodyTexts =
      action.readyBodyTexts ||
      ["营地周活跃", "参与活动", "收到通知", "市长"];
    const tabRegion =
      action.readyTabRegion ||
      { left: 350, top: 150, right: 1550, bottom: 270 };
    const bodyRegion =
      action.readyBodyRegion ||
      { left: 120, top: 250, right: 1820, bottom: 1000 };
    const tabs = tabTexts.filter((text) =>
      this.findInRegion(observations, text, tabRegion)
    );
    const bodies = bodyTexts.filter((text) =>
      this.findInRegion(observations, text, bodyRegion)
    );
    const minimumTabs = Math.max(
      2,
      Math.min(tabTexts.length, Number(action.readyMinimumTabs) || 2)
    );
    return tabs.length >= minimumTabs || (tabs.length >= 1 && bodies.length >= 1);
  }

  async closePagesBeforeMap(action, signal) {
    const maximumClosures = Math.max(
      1,
      Math.min(8, Number(action.mapPreparationMaxClosures) || 6)
    );
    const bottomLeftBack = action.pageBackPoint || { x: 80, y: 1080 };
    const topRightClose = action.pageClosePoint || { x: 1850, y: 70 };
    const panelTexts = [
      "一周贡献",
      "贡献物资",
      "营地资料",
      "全部成员",
      "在线情况",
      "所在场景",
      "成员信息",
      "活动时间管理",
      "营地公职人员",
      "调整队伍目标",
      "创建队伍",
      "离开队伍",
      "确定",
      "取消"
    ];
    const campPanelTexts = [
      "一周贡献",
      "贡献物资",
      "全部成员",
      "职业",
      "庄园等级",
      "同居",
      "营地公职人员",
      "公职人员",
      "营地周活跃",
      "量子时代"
    ];
    const interactionPanelTexts = [
      "查看玩法",
      "营地巡逻",
      "营地竞赛",
      "营地擂台",
      "查看巡逻进度",
      "交谈"
    ];
    const sandTableTexts = [
      "时代信息",
      "成员信息",
      "活动时间管理",
      "财政信息",
      "建设信息"
    ];
    for (let attempt = 0; attempt <= maximumClosures; attempt += 1) {
      const frame = await this.vision.captureTransient(
        `map-preparation-${attempt}`,
        signal
      );
      let accurateFrame = null;
      const mapOpen = (action.mapReadyTexts || [])
        .map((text) => this.vision.find(frame.observations, text))
        .find(Boolean);
      if (mapOpen) return "map";
      if (typeof this.vision.captureAccurateTransient === "function") {
        accurateFrame = await this.vision.captureAccurateTransient(
          `map-preparation-map-accurate-${attempt}`,
          signal
        ).catch(() => null);
        const accurateMapOpen = (action.mapReadyTexts || [])
          .map((text) =>
            accurateFrame
              ? this.vision.find(accurateFrame.observations, text)
              : null
          )
          .find(Boolean);
        if (accurateMapOpen) {
          await this.report(
            "info",
            "map_already_open_verified_accurate",
            `已通过高精度 OCR 确认地图原本就已打开：${accurateMapOpen.text}`
          );
          return "map";
        }
      }
      const observations = [
        ...frame.observations,
        ...(accurateFrame?.observations || [])
      ];

      const closeText = ["关闭", "×", "X"]
        .map((text) => this.vision.find(observations, text, "exact"))
        .find(
          (item) =>
            item &&
            item.x >= 1200 &&
            item.y <= 260
        );
      const visiblePanelText = panelTexts
        .map((text) => this.vision.find(observations, text))
        .find(Boolean);
      const visibleInteractionPanelText = interactionPanelTexts
        .map((text) => this.vision.find(observations, text))
        .find(Boolean);
      const visibleCampPanelText = campPanelTexts
        .map((text) => this.vision.find(observations, text))
        .find(Boolean);
      const campTabMarkers = ["首页", "玩法", "科技", "成员", "相册"]
        .map((text) =>
          this.findInRegion(
            observations,
            text,
            { left: 300, top: 120, right: 1550, bottom: 260 }
          )
        )
        .filter(Boolean);
      const sandTableMarkers = sandTableTexts
        .map((text) => this.vision.find(observations, text))
        .filter(Boolean);
      const sandTableOpen = sandTableMarkers.length >= 2;
      const campPanelOpen =
        campTabMarkers.length >= 2 ||
        (
          Boolean(visibleCampPanelText) &&
          !visiblePanelText &&
          !sandTableOpen
        );
      const chatCollapse = this.findInRegion(
        observations,
        "收起",
        { left: 1450, top: 850, right: 1900, bottom: 1150 }
      );
      const chatMarkers = ["世界", "队伍", "营地", "萌芽邀约", "聊天室"]
        .map((text) =>
          this.findInRegion(
            observations,
            text,
            { left: 1450, top: 120, right: 1900, bottom: 1100 }
          )
        )
        .filter(Boolean);
      const chatOpen = Boolean(chatCollapse) || chatMarkers.length >= 2;
      const visibleHudText = ["背包", "配方", "生存手册", "任务"]
        .map((text) => this.vision.find(observations, text))
        .find(Boolean);
      const failureOverlay = (action.failureTexts || [])
        .map((text) => this.vision.find(observations, text))
        .find(Boolean);

      let advice = null;
      let overlayAdvice = null;
      const advisorEnabled =
        this.vision.advisor?.enabled &&
        this.vision.advisor.config.mode === "guarded";
      if (
        advisorEnabled &&
        !campPanelOpen &&
        !chatOpen &&
        !closeText &&
        !visiblePanelText &&
        !visibleInteractionPanelText &&
        !visibleHudText &&
        !failureOverlay &&
        typeof this.vision.adviseOverlayControlCurrent === "function"
      ) {
        overlayAdvice = await this.vision.adviseOverlayControlCurrent(
          `map-preparation-overlay-${attempt}`,
          { ocrTexts: observations.map((item) => item.text) },
          signal
        ).catch(() => null);
      }
      if (
        !visiblePanelText &&
        !visibleInteractionPanelText &&
        !failureOverlay &&
        advisorEnabled
      ) {
        advice = await this.vision.adviseCurrent(
          `map-preparation-advisor-${attempt}`,
          {
            expectedState: "hud or map or panel",
            taskHint:
              "打开地图前确认：map=地图已开；hud=无遮挡角色主界面；panel=贡献表、成员页、队伍页、弹窗等功能窗口仍遮挡",
            ocrTexts: observations.map((item) => item.text)
          },
          signal
        ).catch(() => null);
      }
      const minimum =
        Number(this.vision.advisor?.config.minimumActionConfidence) || 0.95;
      const overlayMinimum = Math.max(0.95, minimum);
      const confident = Number(advice?.confidence) >= minimum;
      const overlayConfident =
        Number(overlayAdvice?.confidence) >= overlayMinimum &&
        confident &&
        advice.state === "panel" &&
        ["close_x", "back", "collapse"].includes(overlayAdvice?.control);
      if (
        (visibleHudText || visibleInteractionPanelText) &&
        !visiblePanelText &&
        !campPanelOpen &&
        !chatOpen &&
        !failureOverlay
      ) {
        return "hud";
      }
      if (
        confident &&
        advice.state === "hud" &&
        !visiblePanelText &&
        !failureOverlay
      ) {
        return "hud";
      }
      const hasExplicitCloseAction =
        campPanelOpen ||
        chatOpen ||
        Boolean(closeText) ||
        overlayConfident ||
        Boolean(visiblePanelText) ||
        Boolean(failureOverlay);
      if (!hasExplicitCloseAction) {
        await this.report(
          "info",
          "map_preparation_no_overlay",
          "未识别到需要关闭的窗口，将直接尝试打开地图；地图固定文字出现前不会执行传送坐标",
          {
            modelState: advice?.state || null,
            confidence: advice?.confidence || null,
            ocrTexts: observations
              .map((item) => item.text)
              .filter(Boolean)
              .slice(0, 20)
          }
        );
        return "unverified";
      }
      if (attempt >= maximumClosures) {
        throw new Error(
          "MAP_PREPARATION_BLOCKED: 无法确认已关闭全部功能页面，已停止打开地图以避免隔着窗口误操作"
        );
      }

      await this.report(
        "info",
        "map_page_closing",
        `打开地图前正在关闭遮挡页面（${attempt + 1}/${maximumClosures}）`,
        {
          modelState: advice?.state || null,
          confidence: advice?.confidence || null,
          visiblePanelText: visiblePanelText?.text || null,
          visibleInteractionPanelText:
            visibleInteractionPanelText?.text || null,
          visibleCampPanelText: visibleCampPanelText?.text || null,
          campTabMarkers: campTabMarkers.map((item) => item.text),
          sandTableMarkers: sandTableMarkers.map((item) => item.text),
          chatOpen,
          visibleHudText: visibleHudText?.text || null,
          overlayControl: overlayAdvice?.control || null,
          overlayConfidence: overlayAdvice?.confidence || null
        }
      );
      if (visiblePanelText || sandTableOpen || failureOverlay) {
        await this.tap(bottomLeftBack, signal);
      } else if (campPanelOpen) {
        await this.tap(topRightClose, signal);
      } else if (chatOpen) {
        if (chatCollapse) {
          await this.tap(center(chatCollapse), signal);
        } else {
          await this.adb.key(4, signal);
          await this.afterAction(signal);
        }
      } else if (closeText) {
        await this.tap(center(closeText), signal);
      } else if (overlayConfident) {
        await this.report(
          "info",
          "map_overlay_ai_close",
          `AI 已确认安全关闭控件：${overlayAdvice.control}`,
          overlayAdvice
        );
        if (overlayAdvice.control === "close_x") {
          await this.tap(topRightClose, signal);
        } else if (overlayAdvice.control === "collapse") {
          await this.tap(
            action.chatCollapsePoint || { x: 1700, y: 1040 },
            signal
          );
        } else {
          await this.tap(bottomLeftBack, signal);
        }
      }
    }
    return "hud";
  }

  async waitTeleportResult(
    readyTexts,
    failureTexts,
    timeoutSeconds = 30,
    signal
  ) {
    const timeoutMs = Math.max(180, Number(timeoutSeconds) || 30) * 1000;
    let deadline = Date.now() + timeoutMs;
    const startedAt = Date.now();
    let advisorChecks = 0;
    let accurateCheckedAt = 0;
    let consecutiveHudFrames = 0;
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
      const fastHud = this.isStablePostTeleportHud(
        frame.observations
      );
      consecutiveHudFrames = fastHud
        ? consecutiveHudFrames + 1
        : 0;
      if (
        consecutiveHudFrames >= 2 &&
        Date.now() - startedAt >= 1_200
      ) {
        await this.report(
          "info",
          "teleport_hud_arrival_detected",
          "已用快速 OCR 连续确认传送进度结束并回到 HUD；若目标交互按钮未出现，将立即按 W 分段接近",
          { consecutiveHudFrames }
        );
        return {
          state: "arrived_hud",
          text: "传送进度结束，HUD 已连续稳定"
        };
      }
      let accurate = null;
      if (
        !fastHud &&
        typeof this.vision.captureAccurateTransient === "function" &&
        Date.now() - accurateCheckedAt >= 2_000
      ) {
        accurateCheckedAt = Date.now();
        accurate = await this.vision.captureAccurateTransient(
          "teleport-result-accurate",
          signal
        ).catch(() => null);
        if (accurate) {
          const accurateReady = readyTexts
            .map((text) => ({
              text,
              match: this.vision.find(accurate.observations, text)
            }))
            .find((item) => item.match);
          if (accurateReady) {
            return { state: "success", text: accurateReady.text };
          }
          const accurateFailure = failureTexts
            .map((text) => ({
              text,
              match: this.vision.find(accurate.observations, text)
            }))
            .find((item) => item.match);
          if (accurateFailure) {
            return {
              state: /冷却/.test(accurateFailure.text)
                ? "cooldown"
                : "nearby",
              text: accurateFailure.text
            };
          }
        }
      }
      const accurateHud =
        !fastHud &&
        this.isStablePostTeleportHud(accurate?.observations || []);
      if (accurateHud) consecutiveHudFrames += 1;
      if (
        consecutiveHudFrames >= 2 &&
        Date.now() - startedAt >= 1_200
      ) {
        await this.report(
          "info",
          "teleport_hud_arrival_detected",
          "已连续确认传送进度结束并回到 HUD；若目标交互按钮未出现，将立即按 W 分段接近",
          { consecutiveHudFrames }
        );
        return {
          state: "arrived_hud",
          text: "传送进度结束，HUD 已连续稳定"
        };
      }
      if (
        Date.now() - startedAt >= 1_500 &&
        this.vision.advisor?.enabled &&
        this.vision.advisor.config.mode === "guarded"
      ) {
        advisorChecks += 1;
        const advice = await this.vision.adviseCurrent(
          `teleport-result-advisor-${advisorChecks % 100}`,
          {
            expectedState: "hud or teleport_error",
            taskHint: `确认传送结果。到达后的HUD提示可能包括${(
              readyTexts || []
            ).join("、")}；失败提示包括${(failureTexts || []).join("、")}`,
            ocrTexts: frame.observations.map((item) => item.text)
          },
          signal
        ).catch(() => null);
        const minimum =
          Number(
            this.vision.advisor.config.minimumActionConfidence
          ) || 0.95;
        const accepted = Number(advice?.confidence) >= minimum;
        await this.report(
          "info",
          "local_model_teleport_verification",
          `本地模型传送候选仅供记录：${advice?.state || "unavailable"}；仍需 OCR 到达或错误文字确认`,
          {
            ...advice,
            accepted: false,
            modelWouldAccept: accepted
          }
        );
        if (accepted && advice?.state === "hud") {
          await this.report(
            "info",
            "teleport_hud_arrival_ai_confirmed",
            "本地模型以高置信度确认传送进度已结束并回到 HUD；开始用 W 寻找目标交互按钮",
            advice
          );
          return {
            state: "arrived_hud",
            text: "本地模型高置信度确认传送后 HUD"
          };
        }
      }
      await delay(600, signal);
      if (
        Date.now() >= deadline &&
        this.config.timeouts.neverAbortHealthyTaskOnTimeout
      ) {
        await this.report(
          "warning",
          "healthy_teleport_wait_extended",
          "游戏进程健康，继续确认传送结果，不重启游戏"
        );
        advisorChecks = 0;
        accurateCheckedAt = 0;
        deadline = Date.now() + timeoutMs;
      }
    } while (Date.now() < deadline);
    return { state: "timeout", text: null };
  }

  isStablePostTeleportHud(observations) {
    const channelRegion = {
      left: 0,
      top: 965,
      right: 760,
      bottom: 1200
    };
    const channels = ["综合", "世界", "场景", "营地", "队伍"]
      .map((text) =>
        this.findInRegion(observations, text, channelRegion)
      )
      .filter(Boolean);
    if (channels.length >= 2) return true;
    const hudAnchors = [
      "背包",
      "配方",
      "生存手册",
      "任务",
      "外观"
    ]
      .map((text) => this.vision.find(observations, text))
      .filter(Boolean);
    return hudAnchors.length >= 2;
  }

  async teleportByText(action, signal) {
    await this.ensureMapOpen(action, signal);
    await this.ensureMapDestinationList(action, signal);
    await this.clickText(
      action.targetText,
      {
        mode: action.targetTextMode || "includes",
        timeoutSeconds: action.targetFindTimeoutSeconds || 12
      },
      signal
    );
    if (
      action.quickTravelEnabledDetection &&
      this.config.vision.quickTravelPrecheckEnabled !== false
    ) {
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
      await this.ensureMapDestinationList(action, signal);
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
    if (this.config.timeouts.neverAbortHealthyTaskOnTimeout) {
      return Math.max(180, local, configured) * 1000;
    }
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
        case "openCampPanelViaChat":
          await this.openCampPanelViaChat(action, signal);
          break;
        case "clickText":
          await this.clickText(action.text, action, signal);
          break;
        case "waitAnyText":
          await this.waitAnyText(action.texts, action, signal);
          break;
        case "key":
          await this.sendGameKey(action.code, signal, {
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
