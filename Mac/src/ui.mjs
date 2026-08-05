import { delay } from "./process.mjs";
import { center } from "./vision.mjs";

export class GameUi {
  constructor(config, adb, vision, report = async () => {}, mumu = null) {
    this.config = config;
    this.adb = adb;
    this.vision = vision;
    this.report = report;
    this.mumu = mumu;
    this.runtimeAutomation = null;
    this.lastConfirmedDestination = null;
  }

  setRuntimeAutomation(automation) {
    this.runtimeAutomation = automation;
  }

  async afterAction(signal) {
    await delay(this.config.timeouts.actionDelayMs, signal);
  }

  resetGameMouseState() {
    this.adb.resetGameMouseState?.();
  }

  async ensureGameMouseForClick(signal) {
    const detector = this.vision?.gameMouseIconVisible;
    if (typeof detector !== "function") {
      await this.adb.prepareGameMouseForClick?.(signal);
      return;
    }

    let visible = await detector.call(this.vision, signal);
    if (visible) return;

    await this.adb.prepareGameMouseForClick?.(signal, { force: true });
    const verifyTimeoutMs = Math.max(
      500,
      Number(this.config.adb?.gameMouseIconVerifyTimeoutMs) || 2_000
    );
    const pollMs = Math.max(
      100,
      Number(this.config.adb?.gameMouseIconVerifyPollMs) || 250
    );
    const deadline = Date.now() + verifyTimeoutMs;
    do {
      visible = await detector.call(this.vision, signal);
      if (visible) return;
      if (Date.now() >= deadline) break;
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
    } while (Date.now() < deadline);

    throw new Error(
      "ADB_GAME_MOUSE_ICON_NOT_VISIBLE: input keyevent 70 后未确认右下角鼠标图标"
    );
  }

  async performAdbTap(point, signal) {
    if (typeof this.adb.touchTap === "function") {
      await this.adb.touchTap(point.x, point.y, signal);
      return "touch";
    }
    await this.adb.mouseTap(point.x, point.y, signal);
    return "mouse-compatibility";
  }

  async tap(point, signal) {
    // Most game surfaces handled by the Agent are Android panels. A direct
    // touch tap is stable there and must not probe the HUD-only game-mouse
    // icon. Only callers that explicitly mark a game-mouse entry use the
    // gameMouseTap path below.
    await this.performAdbTap(point, signal);
    await this.afterAction(signal);
  }

  async gameMouseTap(point, signal) {
    await this.ensureGameMouseForClick(signal);
    try {
      await this.performAdbTap(point, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      await this.report(
        "warning",
        "adb_mouse_click_retry",
        "ADB 触屏点击命令失败，重新检查右下角鼠标图标后重试；图标仍存在时不会再次发送 70"
      );
      if (typeof this.vision?.gameMouseIconVisible === "function") {
        await this.ensureGameMouseForClick(signal);
      } else {
        // Compatibility for diagnostic/test clients that do not expose the
        // screenshot detector. The production client always takes the
        // icon-aware branch above.
        this.adb.resetGameMouseState?.();
        await this.adb.prepareGameMouseForClick?.(signal, { force: true });
      }
      await this.performAdbTap(point, signal);
    }
    await this.afterAction(signal);
  }

  async hudTap(point, signal) {
    return this.tap(point, signal);
  }

  async androidTouchTap(point, signal) {
    if (typeof this.adb.touchTap !== "function") {
      throw new Error(
        "ADB_TOUCH_TAP_UNAVAILABLE: 当前 MuMu ADB 未提供 Android 触屏点击"
      );
    }
    await this.adb.touchTap(point.x, point.y, signal);
    await this.afterAction(signal);
  }

  async tapAction(point, signal) {
    if (point?.gameMouse === true) {
      return this.gameMouseTap(point, signal);
    }
    return this.tap(point, signal);
  }

  async clickText(text, options = {}, signal) {
    const timeoutMs = this.timeoutMs(options);
    let deadline = Date.now() + timeoutMs;
    let nextRegionOcrAt = 0;
    let nextAccurateOcrAt = 0;
    do {
      const frame = await this.vision.capture(`find-${text}`, signal);
      let match = this.findInRegion(
        frame.observations,
        text,
        options.region,
        options.mode
      );
      if (
        !match &&
        options.region &&
        frame.path &&
        typeof this.vision.ocrRegion === "function" &&
        Date.now() >= nextRegionOcrAt
      ) {
        nextRegionOcrAt = Date.now() + 2_000;
        const regionalObservations = await this.vision
          .ocrRegion(
            frame.path,
            options.region,
            `click-${text}`,
            signal,
            "accurate",
            Number(options.regionOcrMinimumConfidence) || 0.2,
            Number(options.regionOcrScale) || 2
          )
          .catch(() => []);
        match = this.findInRegion(
          regionalObservations,
          text,
          options.region,
          options.mode
        );
        if (match) {
          await this.report(
            "info",
            "accurate_click_text_verified",
            `快速 OCR 漏读后，已通过目标区域高精度 OCR 确认可点击文字：${text}`
          );
        }
      }
      if (
        !match &&
        typeof this.vision.captureAccurateTransient === "function" &&
        Date.now() >= nextAccurateOcrAt
      ) {
        nextAccurateOcrAt = Date.now() + 2_000;
        const accurate = await this.vision
          .captureAccurateTransient(`click-${text}-accurate`, signal)
          .catch(() => null);
        match = this.findInRegion(
          accurate?.observations || [],
          text,
          options.region,
          options.mode
        );
        if (match) {
          await this.report(
            "info",
            "accurate_click_text_verified",
            `快速 OCR 漏读后，已通过全屏高精度 OCR 确认可点击文字：${text}`
          );
        }
      }
      if (match) {
        const point = center(match);
        await this.tapAction(
          {
            ...point,
            hud: options.hud === true,
            gameMouse: options.gameMouse === true
          },
          signal
        );
        return { frame, match };
      }
      await delay(700, signal);
      if (
        Date.now() >= deadline &&
        this.config.timeouts.neverAbortHealthyTaskOnTimeout &&
        options.strictTimeout !== true
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
        this.vision.advisor?.config.waitTextVerificationEnabled === true &&
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
        this.config.timeouts.neverAbortHealthyTaskOnTimeout &&
        options.strictTimeout !== true
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

  findMapVerificationMarker(observations, action) {
    // 地图是否打开只能由左上角的“标志查看”确认。地图中的地点、
    // 庄园等文字会在其他界面出现，不能作为放行后续点击的依据。
    const markerText =
      action.mapVerificationText || action.mapModeText || "标志查看";
    const markerRegion = action.mapVerificationRegion || {
      left: 0,
      top: 0,
      right: 700,
      bottom: 260
    };
    return this.findInRegion(observations, markerText, markerRegion);
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
    const { frame, found } = await this.findConditionalText(
      texts,
      "conditional-tap",
      point,
      signal
    );
    if (!found) return null;
    await this.tapAction(point, signal);
    return { ...found, frame };
  }

  async tapUnlessAnyText(texts, point, signal) {
    const { frame, found } = await this.findConditionalText(
      texts,
      "conditional-tap-unless",
      point,
      signal
    );
    if (found) return { ...found, frame, skipped: true };
    await this.tapAction(point, signal);
    return { frame, skipped: false };
  }

  async findConditionalText(texts, label, options, signal) {
    const frame = await this.vision.capture(label, signal);
    let found = texts
      .map((text) => ({
        text,
        match: this.findInRegion(
          frame.observations,
          text,
          options.region,
          options.mode
        )
      }))
      .find((item) => item.match);
    if (!found && typeof this.vision.captureAccurateTransient === "function") {
      const accurate = await this.vision
        .captureAccurateTransient(`${label}-accurate`, signal)
        .catch(() => null);
      found = texts
        .map((text) => ({
          text,
          match: this.findInRegion(
            accurate?.observations || [],
            text,
            options.region,
            options.mode
          )
        }))
        .find((item) => item.match);
      if (found) {
        await this.report(
          "info",
          "accurate_conditional_text_verified",
          `快速 OCR 漏读后，已通过高精度 OCR 确认条件文字：${found.text}`
        );
      }
    }
    return { frame, found };
  }

  async clickIfText(text, options, signal) {
    const frame = await this.vision.capture(`conditional-click-${text}`, signal);
    let match = this.findInRegion(
      frame.observations,
      text,
      options.region,
      options.mode
    );
    if (
      !match &&
      options.region &&
      frame.path &&
      typeof this.vision.ocrRegion === "function"
    ) {
      const regional = await this.vision
        .ocrRegion(
          frame.path,
          options.region,
          `conditional-click-${text}`,
          signal,
          "accurate",
          Number(options.regionOcrMinimumConfidence) || 0.2,
          Number(options.regionOcrScale) || 2
        )
        .catch(() => []);
      match = this.findInRegion(
        regional,
        text,
        options.region,
        options.mode
      );
    }
    if (
      !match &&
      typeof this.vision.captureAccurateTransient === "function"
    ) {
      const accurate = await this.vision
        .captureAccurateTransient(
          `conditional-click-${text}-accurate`,
          signal
        )
        .catch(() => null);
      match = this.findInRegion(
        accurate?.observations || [],
        text,
        options.region,
        options.mode
      );
    }
    if (!match) return null;
    const point = center(match);
    await this.tapAction(
      {
        ...point,
        hud: options.hud === true,
        gameMouse: options.gameMouse === true
      },
      signal
    );
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
        const point = center(candidate.match);
        await this.tapAction(
          {
            ...point,
            hud: action.hud === true,
            gameMouse: action.gameMouse === true
          },
          signal
        );
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
          await this.tapAction(
            {
              ...point,
              hud: action.hud === true,
              gameMouse: action.gameMouse === true
            },
            signal
          );
        } else {
          await delay(action.intervalMs || 800, signal);
        }
      }
    } while (Date.now() < deadline);
    throw new Error(
      `Timed out navigating via ${action.clickTexts.join(" / ")} to ${action.targetTexts.join(" / ")}`
    );
  }

  async captureFlowObservations(label, action, signal) {
    const frame = await this.vision.capture(label, signal);
    const observations = [...(frame.observations || [])];
    if (
      action.region &&
      frame.path &&
      typeof this.vision.ocrRegion === "function"
    ) {
      const regional = await this.vision
        .ocrRegion(
          frame.path,
          action.region,
          `${label}-region`,
          signal,
          "accurate",
          Number(action.regionOcrMinimumConfidence) || 0.2,
          Number(action.regionOcrScale) || 2
        )
        .catch(() => []);
      observations.push(...regional);
    }
    if (typeof this.vision.captureAccurateTransient === "function") {
      const accurate = await this.vision
        .captureAccurateTransient(`${label}-accurate`, signal)
        .catch(() => null);
      observations.push(...(accurate?.observations || []));
    }
    return { frame, observations };
  }

  countFlowTexts(observations, action) {
    return (action.texts || []).filter((text) =>
      this.findInRegion(observations, text, action.region, action.mode)
    ).length;
  }

  async tapUntilNoneTexts(action, signal) {
    const attempts = Math.max(
      1,
      Math.min(6, Number(action.maxAttempts) || 6)
    );
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const screen = await this.captureFlowObservations(
        `tap-until-none-${attempt + 1}`,
        action,
        signal
      );
      if (this.countFlowTexts(screen.observations, action) === 0) {
        await this.report(
          "info",
          "hud_panel_closed_verified",
          `已确认界面文字“${(action.texts || []).join("/")}”消失，HUD 面板已关闭`
        );
        return screen;
      }
      if (attempt >= attempts) break;
      await this.report(
        attempt === 0 ? "info" : "warning",
        "hud_panel_close_attempt",
        `第 ${attempt + 1}/${attempts} 次关闭 HUD 面板；${action.controlLabel ? `点击已校准的${action.controlLabel}` : "点击前先释放容器鼠标"}并在点击后重新识别`
      );
      await this.tapAction(
        {
          ...action,
          gameMouse:
            action.gameMouse === true ||
            (action.gameMouseOnRetry === true && attempt > 0)
        },
        signal
      );
      await delay(Math.max(200, Number(action.intervalMs) || 500), signal);
    }
    throw new Error(
      `HUD_PANEL_DID_NOT_CLOSE: ${attempts} 次后仍识别到 ${(action.texts || []).join("/")}`
    );
  }

  async closePatrolTeamPanelBeforeAccept(action, signal) {
    const panelTexts = action.panelTexts || ["调整", "离开队伍"];
    const hudTexts = action.hudTexts || ["综合", "世界", "场景", "营地", "队伍"];
    const fullRegion = action.region || {
      left: 0,
      top: 0,
      right: 1920,
      bottom: 1200
    };
    const hudRegion = action.hudRegion || {
      left: 0,
      top: 930,
      right: 760,
      bottom: 1200
    };
    const collapseRegion = action.collapseRegion || {
      left: 1450,
      top: 850,
      right: 1900,
      bottom: 1150
    };
    const chatRegion = action.chatRegion || {
      left: 1200,
      top: 100,
      right: 1900,
      bottom: 1150
    };
    const chatTexts = action.chatTexts || [
      "营地频道",
      "成员",
      "私聊",
      "萌芽邀约",
      "聊天室"
    ];
    const minimumHudTexts = Math.max(
      2,
      Math.min(hudTexts.length, Number(action.minimumHudTexts) || 2)
    );
    const inspect = async (label) => {
      const screen = await this.captureFlowObservations(
        label,
        { ...action, region: fullRegion },
        signal
      );
      const observations = screen.observations;
      const panelMatches = panelTexts
        .map((text) => this.findInRegion(observations, text, fullRegion))
        .filter(Boolean);
      const hudMatches = hudTexts
        .map((text) => this.findInRegion(observations, text, hudRegion))
        .filter(Boolean);
      const collapse = this.findInRegion(
        observations,
        action.collapseText || "收起",
        collapseRegion
      );
      const chatMatches = chatTexts
        .map((text) => this.findInRegion(observations, text, chatRegion))
        .filter(Boolean);
      return {
        ...screen,
        panelMatches,
        hudMatches,
        collapse,
        chatMatches
      };
    };

    await this.report(
      "info",
      "patrol_close_team_panel_once",
      "巡逻队伍满员；只点击一次队伍页左下角返回箭头，等待 5 秒后确认 HUD，避免重复点击误开营地聊天"
    );
    await this.tapAction(action, signal);
    await delay(Math.max(5_000, Number(action.settleAfterClickMs) || 5_000), signal);

    let screen = await inspect("patrol-close-team-panel-after-wait");
    const chatOpen = Boolean(screen.collapse) || screen.chatMatches.length >= 2;
    if (chatOpen) {
      await this.report(
        "warning",
        "patrol_close_team_chat_detected",
        screen.collapse
          ? "关闭队伍时误打开了营地聊天；先点击 OCR 识别到的“收起”关闭聊天，再重新确认 HUD 和交互选项"
          : "关闭队伍后识别到营地聊天但未读到“收起”；点击右下角校准的收起位置关闭聊天，再重新确认 HUD 和交互选项"
      );
      const collapsePoint = screen.collapse
        ? center(screen.collapse)
        : action.collapsePoint || { x: 1740, y: 1110 };
      await this.tapAction({ ...collapsePoint, hud: true }, signal);
      await delay(
        Math.max(1_000, Number(action.collapseSettleMs) || 1_500),
        signal
      );
      screen = await inspect("patrol-close-team-panel-after-chat-collapse");
    }

    if (screen.collapse || screen.chatMatches.length >= 2) {
      throw new Error(
        "PATROL_CLOSE_TEAM_CHAT_DID_NOT_CLOSE: 已尝试点击收起，但仍识别到营地聊天界面"
      );
    }
    if (screen.panelMatches.length > 0) {
      if (screen.hudMatches.length < minimumHudTexts) {
        throw new Error(
          "PATROL_CLOSE_TEAM_PANEL_DID_NOT_CLOSE: 一次点击并等待后仍识别到队伍面板，且未确认 HUD；停止以避免重复点击"
        );
      }
      await this.report(
        "warning",
        "patrol_close_team_panel_text_stale",
        "队伍面板关闭后 OCR 仍残留“调整/离开队伍”文字，但 HUD 已确认且右下角没有“收起”；按已关闭处理，不重复点击"
      );
    }
    if (screen.hudMatches.length < minimumHudTexts) {
      throw new Error(
        `PATROL_CLOSE_TEAM_HUD_UNVERIFIED: 关闭队伍后仅识别到 ${screen.hudMatches.length} 个 HUD 锚点，至少需要 ${minimumHudTexts} 个`
      );
    }
    await this.report(
      "info",
      "patrol_close_team_panel_verified",
      `已等待并确认队伍面板关闭，HUD 锚点 ${screen.hudMatches.length}/${hudTexts.length}，右下角未显示“收起”；继续识别公告版交互选项`
    );
    return screen;
  }

  async tapUntilAnyTexts(action, signal) {
    const attempts = Math.max(
      1,
      Math.min(6, Number(action.maxAttempts) || 4)
    );
    const minimumTexts = Math.max(
      1,
      Math.min((action.texts || []).length, Number(action.minimumTexts) || 1)
    );
    const minimumTapsBeforeSuccess = Math.max(
      0,
      Math.min(attempts, Number(action.minimumTapsBeforeSuccess) || 0)
    );
    let performedTaps = 0;
    for (let attempt = 0; attempt <= attempts; attempt += 1) {
      const screen = await this.captureFlowObservations(
        `tap-until-any-${attempt + 1}`,
        action,
        signal
      );
      const matched = this.countFlowTexts(screen.observations, action);
      if (matched >= minimumTexts && performedTaps >= minimumTapsBeforeSuccess) {
        await this.report(
          "info",
          "hud_return_verified",
          `已识别到 ${matched} 个 HUD 锚点，确认遮挡页面已全部关闭`
        );
        return screen;
      }
      if (attempt >= attempts) break;
      await this.report(
        "info",
        "overlay_exit_attempt",
        matched >= minimumTexts
          ? `已出现 HUD 锚点，但巡逻结果页至少需返回 ${minimumTapsBeforeSuccess} 次；继续第 ${performedTaps + 1}/${minimumTapsBeforeSuccess} 次左下角返回`
          : `正在逐层退出遮挡页面（${attempt + 1}/${attempts}），返回 HUD 后立即停止`
      );
      await this.tapAction(
        {
          ...action,
          gameMouse:
            action.gameMouse === true ||
            (action.gameMouseOnRetry === true && performedTaps > 0)
        },
        signal
      );
      performedTaps += 1;
      await delay(Math.max(200, Number(action.intervalMs) || 500), signal);
    }
    throw new Error(
      `HUD_RETURN_UNVERIFIED: ${attempts} 次返回后仍未识别到至少 ${minimumTexts} 个 HUD 锚点`
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

    const maximumRecoveries = Math.max(
      1,
      Math.min(6, Number(action.fallbackMaxAttempts) || 6)
    );
    let lastResult = result;
    for (let recovery = 1; recovery <= maximumRecoveries; recovery += 1) {
      await this.report(
        "warning",
        "teleport_nearby_recovery",
        `第 ${recovery}/${maximumRecoveries} 次寻路恢复：先传送到${action.fallback.name}，再返回${action.target.name}`,
        {
          recovery,
          maximumRecoveries,
          previousState: lastResult.state,
          detectedText: lastResult.text || null
        }
      );
      let fallback = await this.attemptTeleport(
        action,
        action.fallback,
        signal
      );
      if (fallback.state === "cooldown") {
        await delay(action.cooldownSeconds * 1000, signal);
        fallback = await this.attemptTeleport(action, action.fallback, signal);
      }
      if (!["success", "nearby"].includes(fallback.state)) {
        lastResult = fallback;
        await this.report(
          "warning",
          "teleport_fallback_retry_failed",
          `第 ${recovery}/${maximumRecoveries} 次返回${action.fallback.name}未成功，游戏健康时继续下一轮恢复`,
          { state: fallback.state, text: fallback.text || null }
        );
        continue;
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
      let returned = await this.attemptTeleport(action, action.target, signal);
      if (returned.state === "cooldown") {
        await delay(action.cooldownSeconds * 1000, signal);
        returned = await this.attemptTeleport(action, action.target, signal);
      }
      if (returned.state === "success") {
        this.lastConfirmedDestination = action.target.name;
        return returned;
      }
      if (returned.state === "nearby" && action.nearbyIsSuccess) {
        this.lastConfirmedDestination = action.target.name;
        return returned;
      }
      lastResult = returned;
      await this.report(
        "warning",
        "teleport_target_recovery_retry",
        `第 ${recovery}/${maximumRecoveries} 次返回${action.target.name}后仍未找到交互选项，将继续往返恢复`,
        { state: returned.state, text: returned.text || null }
      );
    }
    throw new Error(
      `Teleport return to ${action.target.name} failed after ${maximumRecoveries} recovery attempts: ${lastResult.state}${lastResult.text ? ` (${lastResult.text})` : ""}`
    );
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
    const legacyApproachRounds = destination.approachUntilReady
      ? Math.max(
          1,
          Math.min(
            6,
            Number(destination.approachMaxRounds) ||
              Number(destination.approachMaxSteps) ||
              6
          )
        )
      : 0;
    const fallbackKey = destination.approachFallbackKey;
    const fallbackRounds = fallbackKey
      ? Math.max(
          1,
          Math.min(5, Number(destination.approachFallbackMaxRounds) || 5)
        )
      : 0;
    const approachRounds = fallbackKey ? fallbackRounds : legacyApproachRounds;
    const pressesPerRound = Math.max(
      1,
      Math.min(5, Number(destination.approachPressesPerRound) || 5)
    );
    const approachIntervalMs = Math.max(
      250,
      Number(destination.approachIntervalMs) || 1_000
    );
    for (let attempt = 0; attempt < Math.max(2, approachRounds + 1); attempt += 1) {
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
      if (attempt < approachRounds) {
        if (fallbackKey && attempt < fallbackRounds) {
          if (attempt === 0) {
            await this.report(
              "warning",
              "teleport_destination_approaching",
              `已到达${destination.name}但暂未看到交互选项，优先使用实机验证有效的 W 寻路：每轮先按一次 W，再持续按住 ${destination.approachFallbackHoldMs || 1_500} 毫秒，暂停 ${destination.approachFallbackIntervalMs || 2_000} 毫秒识别，最多 ${fallbackRounds} 轮`,
              {
                readyTexts: destination.readyTexts,
                maximumRounds: fallbackRounds,
                key: fallbackKey,
                holdMs: destination.approachFallbackHoldMs || 1_500,
                intervalMs: destination.approachFallbackIntervalMs || 2_000
              }
            );
          }
          await this.sendGameKey(fallbackKey, signal);
          if (typeof this.adb.holdKey === "function") {
            await this.adb.holdKey(
              fallbackKey,
              destination.approachFallbackHoldMs || 1_500,
              signal
            );
          } else {
            await this.sendGameKey(fallbackKey, signal, { longPress: true });
          }
          await delay(
            Math.max(
              250,
              Number(destination.approachFallbackIntervalMs) || 2_000
            ),
            signal
          );
          continue;
        }
        if (attempt === 0) {
          await this.report(
            "warning",
            "teleport_destination_approaching",
            `已到达${destination.name}但暂未看到交互选项，正在按 W 分轮前进（每轮连续按 ${pressesPerRound} 次，最多 ${approachRounds} 轮），每轮后识别目标文字并立即停止`,
            {
              readyTexts: destination.readyTexts,
              maximumRounds: approachRounds,
              pressesPerRound,
              intervalMs: approachIntervalMs
            }
          );
        }
        if (typeof this.adb.focusGameInput === "function") {
          const focusPoint = destination.approachFocusPoint || {
            x: Math.round((this.config.adb?.screenWidth || 1920) / 2),
            y: Math.round((this.config.adb?.screenHeight || 1200) / 2)
          };
          await this.adb.focusGameInput(
            focusPoint.x,
            focusPoint.y,
            signal
          );
          if (attempt === 0) {
            await this.report(
              "info",
              "teleport_approach_adb_focus",
              "已通过 ADB 鼠标悬停与按键释放复位 MuMu 设备输入焦点；不会切换 macOS 前台窗口"
            );
          }
        }
        await this.sendGameKey(
          destination.approachKey || "KEYCODE_W",
          signal,
          { repeat: pressesPerRound }
        );
        await delay(approachIntervalMs, signal);
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
        approachRounds,
        fallbackRounds,
        pressesPerRound
      }
    );
    return false;
  }

  async ensureMapOpen(action, signal) {
    const prepared = await this.closePagesBeforeMap(action, signal);
    if (prepared === "map") return;
    const mapButton = Object.hasOwn(action, "mapButton")
      ? action.mapButton
      : { x: 1782, y: 128 };
    const mapKey = action.mapKey || "KEYCODE_M";
    const timeoutMs = Math.max(
      1,
      Number(action.mapOpenTimeoutSeconds) || 10
    ) * 1000;
    const mapKeyRetryAttempts = mapKey
      ? Math.max(1, Math.min(6, Number(action.mapKeyRetryAttempts) || 3))
      : 0;
    let mapKeyAttempts = 0;
    const sendMapKey = async (retry = false) => {
      mapKeyAttempts += 1;
      await this.report(
        retry ? "warning" : "info",
        retry ? "map_open_key_retry" : "map_open_key",
        retry
          ? `等待 ${timeoutMs / 1000} 秒仍未在左上角 OCR 识别“标志查看”，重新发送 M 键打开地图（${mapKeyAttempts}/${mapKeyRetryAttempts}）`
          : "正在通过 ADB 复位游戏输入后发送 M 键打开地图；不会先点击右上角以免误开相机",
        { key: mapKey, focusPoint: mapButton || null, attempt: mapKeyAttempts }
      );
      if (mapButton && typeof this.adb.focusGameInput === "function") {
        await this.adb.focusGameInput(mapButton.x, mapButton.y, signal);
      }
      await this.sendGameKey(mapKey, signal);
    };
    if (mapKey) {
      await sendMapKey();
    } else {
      await this.report(
        "info",
        "map_open_button",
        "未配置地图快捷键，正在点击校准后的右上角圆盘中心",
        { point: mapButton }
      );
      await this.hudTap(mapButton, signal);
    }
    let deadline = Date.now() + timeoutMs;
    let advisorChecked = false;
    let modelMapCandidate = false;
    let accurateCheckedAt = 0;
    let mapButtonFallbackSent = !mapButton || !mapKey;
    const configuredFallbackDelayMs = Number(action.mapButtonFallbackDelayMs);
    const mapButtonFallbackDelayMs = Math.max(
      0,
      Number.isFinite(configuredFallbackDelayMs)
        ? configuredFallbackDelayMs
        : 4_000
    );
    const mapButtonFallbackAt = Date.now() + mapButtonFallbackDelayMs;
    do {
      await delay(action.mapOpenPollMs || 500, signal);
      const verification = await this.vision.captureTransient(
        "teleport-map-verification",
        signal
      );
      const verified = this.findMapVerificationMarker(
        verification.observations,
        action
      );
      if (verified) {
        await this.report(
          "info",
          "map_open_verified",
          `已通过地图固定文字确认页面打开：${verified.text}`
        );
        return;
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
        const accurateVerified = accurate
          ? this.findMapVerificationMarker(accurate.observations, action)
          : null;
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
              [action.mapVerificationText || action.mapModeText || "标志查看"]
            ).join("、")}`,
            ocrTexts: verification.observations.map((item) => item.text)
          },
          signal
        ).catch(() => null);
        const minimum =
          Number(
            this.vision.advisor.config.minimumActionConfidence
          ) || 0.95;
        modelMapCandidate =
          advice?.state === "map" && advice.confidence >= minimum;
        await this.report(
          "info",
          "local_model_map_verification",
          `本地模型地图候选仅供记录：${advice?.state || "unavailable"}；仍需 OCR 地图固定文字确认`,
          {
            ...advice,
            accepted: false,
            modelWouldAccept:
              modelMapCandidate
          }
        );
      }
      if (
        !mapButtonFallbackSent &&
        Date.now() >= mapButtonFallbackAt
      ) {
        mapButtonFallbackSent = true;
        await this.report(
          "warning",
          "map_open_button_fallback",
          "M 键及高精度 OCR 均未确认地图，正在点击校准后的右上角圆盘中心；该点与相机按钮保持安全距离",
          { point: mapButton }
        );
        await this.hudTap(mapButton, signal);
      }
      if (
        Date.now() >= deadline &&
        mapKey &&
        mapKeyAttempts < mapKeyRetryAttempts
      ) {
        await sendMapKey(true);
        advisorChecked = false;
        modelMapCandidate = false;
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
    const attempts = Math.max(1, Math.min(6, Number(action.attempts) || 6));
    const chatReadyTexts = action.chatReadyTexts || [];
    const chatReadyRegion = action.chatReadyRegion || {
      left: 1200,
      top: 100,
      right: 1900,
      bottom: 1150
    };
    const chatReadyMinimum = Math.max(
      1,
      Math.min(chatReadyTexts.length || 1, Number(action.chatReadyMinimumTexts) || 1)
    );
    const campChatReady = (observations) =>
      chatReadyTexts.filter((text) =>
        this.findInRegion(observations, text, chatReadyRegion)
      ).length >= chatReadyMinimum;
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
        `通过聊天营地频道打开营地界面（${attempt}/${attempts}）；点击前检查右下角鼠标图标，使用 ADB 触屏点击`
      );
      try {
        await this.tapAction(
          {
            ...(action.chatButton || { x: 250, y: 1060 }),
            gameMouse: true
          },
          signal
        );
        await delay(action.chatDelayMs || 500, signal);
        let chatReady = chatReadyTexts.length === 0;
        if (!chatReady) {
          const chatFrame = await this.vision.captureTransient(
            `camp-chat-verify-${attempt}`,
            signal
          );
          chatReady = campChatReady(chatFrame.observations);
          if (
            !chatReady &&
            typeof this.vision.captureAccurateTransient === "function"
          ) {
            const accurateChat = await this.vision.captureAccurateTransient(
              `camp-chat-verify-accurate-${attempt}`,
              signal
            );
            chatReady = campChatReady(accurateChat.observations);
          }
        }
        if (!chatReady) {
          await this.report(
            "warning",
            "camp_chat_not_verified",
            `第 ${attempt}/${attempts} 次点击聊天入口后未 OCR 确认聊天营地频道，禁止继续点击营地频道坐标`
          );
          continue;
        }
        await this.report(
          "info",
          "camp_chat_verified",
          "已确认聊天层，继续使用 ADB 触屏点击；图标存在时不会再次发送 70"
        );
        await this.tap(action.campChannelButton || { x: 1740, y: 355 }, signal);
        await delay(action.channelDelayMs || 500, signal);
        await this.tap(action.campIconButton || { x: 980, y: 65 }, signal);
      } catch (error) {
        await this.report(
          "warning",
          "camp_channel_click_failed",
          `第 ${attempt}/${attempts} 次聊天→营地频道→市政厅点击失败；下一次只重试 ADB 点击，不切换鼠标状态`,
          { reason: error?.message || String(error) }
        );
        if (attempt >= attempts) throw error;
        continue;
      }

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
        `打开营地面板前检测到地图遮挡（${match.text}），正在点击右上角 X 关闭地图`
      );
      await this.tap(action.mapClosePoint || { x: 1850, y: 70 }, signal);
      await this.afterAction(signal);
    }
    throw new Error(
      "CAMP_PANEL_MAP_BLOCKED: 已确认地图遮挡但两次点击右上角 X 后仍未关闭"
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
      "营地公职人员"
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
      const mapOpen = this.findMapVerificationMarker(
        frame.observations,
        action
      );
      if (mapOpen) return "map";
      if (typeof this.vision.captureAccurateTransient === "function") {
        accurateFrame = await this.vision.captureAccurateTransient(
          `map-preparation-map-accurate-${attempt}`,
          signal
        ).catch(() => null);
        const accurateMapOpen = accurateFrame
          ? this.findMapVerificationMarker(accurateFrame.observations, action)
          : null;
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
      // “收起”可能来自任务/交互控件，“营地”也可能只是“营地巡逻”。
      // 只有右侧同时出现至少两个聊天频道锚点，才把深灰色大面板视为聊天页。
      const chatOpen = chatMarkers.length >= 2;
      const bottomChannelMarkers = [
        "综合",
        "世界",
        "场景",
        "营地",
        "队伍"
      ]
        .map((text) =>
          this.findInRegion(
            observations,
            text,
            { left: 0, top: 930, right: 760, bottom: 1200 }
          )
        )
        .filter(Boolean);
      const bottomChannelHud = bottomChannelMarkers.length >= 2;
      const teamPanelMarkers = [
        "调整队伍目标",
        "队伍目标",
        "目标：",
        "创建队伍",
        "离开队伍",
        "快速匹配",
        "招募"
      ]
        .map((text) => this.vision.find(observations, text))
        .filter(Boolean);
      const teamPanelOpen = teamPanelMarkers.length >= 2;
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
        !bottomChannelHud &&
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
        !bottomChannelHud &&
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
        (
          visibleHudText ||
          visibleInteractionPanelText ||
          (bottomChannelHud && !chatOpen)
        ) &&
        !bottomChannelHud &&
        !visiblePanelText &&
        !teamPanelOpen &&
        !campPanelOpen &&
        !chatOpen &&
        !failureOverlay
      ) {
        return "hud";
      }
      if (
        bottomChannelHud &&
        !chatOpen &&
        !teamPanelOpen &&
        !campPanelOpen &&
        !sandTableOpen &&
        !failureOverlay
      ) {
        await this.report(
          "info",
          "map_preparation_bottom_channels_hud",
          "已确认左下角频道 HUD，且右侧没有深灰色聊天大框；交互按钮不视为遮挡，直接打开地图",
          {
            bottomChannelMarkers: bottomChannelMarkers.map(
              (item) => item.text
            ),
            interactionText: visibleInteractionPanelText?.text || null
          }
        );
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
        teamPanelOpen ||
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
          bottomChannelMarkers: bottomChannelMarkers.map(
            (item) => item.text
          ),
          teamPanelMarkers: teamPanelMarkers.map((item) => item.text),
          visibleHudText: visibleHudText?.text || null,
          overlayControl: overlayAdvice?.control || null,
          overlayConfidence: overlayAdvice?.confidence || null
        }
      );
      if (
        visiblePanelText ||
        sandTableOpen ||
        teamPanelOpen ||
        failureOverlay
      ) {
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
    if (
      this.config.timeouts.neverAbortHealthyTaskOnTimeout &&
      options.strictTimeout !== true
    ) {
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
          await this.tapAction(action, signal);
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
        case "tapUntilNoneTexts":
          await this.tapUntilNoneTexts(action, signal);
          break;
        case "closePatrolTeamPanelBeforeAccept":
          await this.closePatrolTeamPanelBeforeAccept(action, signal);
          break;
        case "tapUntilAnyTexts":
          await this.tapUntilAnyTexts(action, signal);
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
