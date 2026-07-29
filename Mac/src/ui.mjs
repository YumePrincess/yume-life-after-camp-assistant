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
      const match = this.vision.find(frame.observations, text, options.mode);
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
    let regionOcrFailureReported = false;
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
        await this.report(
          "info",
          "local_model_text_verification",
          `本地模型页面候选仅供记录：${advice?.state || "unavailable"}；不会替代限定区域 OCR 推动流程`,
          {
            ...advice,
            accepted: false,
            modelWouldAccept: accepted,
            texts,
            region: options.region || null
          }
        );
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
    for (let attempt = 0; attempt < 2; attempt += 1) {
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
      await delay(1_000, signal);
    }
    await this.report(
      "warning",
      "teleport_destination_unverified",
      `已到达${destination.name}传送点，但没有出现配置的正确交互选项；将执行中心出入口往返恢复`,
      { readyTexts: destination.readyTexts }
    );
    return false;
  }

  async ensureMapOpen(action, signal) {
    const prepared = await this.closePagesBeforeMap(action, signal);
    if (prepared === "map") return;
    const mapKey = action.mapKey || "KEYCODE_M";
    if (mapKey) {
      await this.report(
        "info",
        "map_open_key",
        "已发送 M 键打开地图；确认地图界面后才会继续选择传送点",
        { key: mapKey }
      );
      await this.adb.key(mapKey, signal);
    } else {
      await this.tap(action.mapButton, signal);
    }
    const timeoutMs = Math.max(
      180,
      Number(action.mapOpenTimeoutSeconds) || 10
    ) * 1000;
    let deadline = Date.now() + timeoutMs;
    let advisorChecked = false;
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
          `本地模型地图确认结果：${advice?.state || "unavailable"}`,
          { ...advice, accepted: advice?.state === "map" && advice.confidence >= minimum }
        );
        if (advice?.state === "map" && advice.confidence >= minimum) return;
        advisorChecked = false;
      }
      if (
        Date.now() >= deadline &&
        this.config.timeouts.neverAbortHealthyTaskOnTimeout
      ) {
        await this.report(
          "warning",
          "healthy_map_wait_extended",
          "游戏进程健康，地图确认等待已延长，不重启游戏"
        );
        advisorChecked = false;
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
    const bottomLeftBack = action.pageBackPoint || { x: 200, y: 1040 };
    const topRightClose = action.pageClosePoint || { x: 1750, y: 145 };
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
    for (let attempt = 0; attempt <= maximumClosures; attempt += 1) {
      const frame = await this.vision.captureTransient(
        `map-preparation-${attempt}`,
        signal
      );
      const mapOpen = (action.mapReadyTexts || [])
        .map((text) => this.vision.find(frame.observations, text))
        .find(Boolean);
      if (mapOpen) return "map";

      const closeText = ["关闭", "×", "X"]
        .map((text) => this.vision.find(frame.observations, text, "exact"))
        .find(
          (item) =>
            item &&
            item.x >= 1200 &&
            item.y <= 260
        );
      const visiblePanelText = panelTexts
        .map((text) => this.vision.find(frame.observations, text))
        .find(Boolean);
      const visibleInteractionPanelText = interactionPanelTexts
        .map((text) => this.vision.find(frame.observations, text))
        .find(Boolean);
      const visibleCampPanelText = campPanelTexts
        .map((text) => this.vision.find(frame.observations, text))
        .find(Boolean);
      const chatCollapse = this.findInRegion(
        frame.observations,
        "收起",
        { left: 1450, top: 850, right: 1900, bottom: 1150 }
      );
      const chatMarkers = ["世界", "队伍", "营地", "萌芽邀约", "聊天室"]
        .map((text) =>
          this.findInRegion(
            frame.observations,
            text,
            { left: 1450, top: 120, right: 1900, bottom: 1100 }
          )
        )
        .filter(Boolean);
      const chatOpen = Boolean(chatCollapse) || chatMarkers.length >= 2;
      const visibleHudText = ["背包", "配方", "生存手册", "任务"]
        .map((text) => this.vision.find(frame.observations, text))
        .find(Boolean);
      const failureOverlay = (action.failureTexts || [])
        .map((text) => this.vision.find(frame.observations, text))
        .find(Boolean);

      let advice = null;
      if (
        !visiblePanelText &&
        !visibleInteractionPanelText &&
        !failureOverlay &&
        this.vision.advisor?.enabled &&
        this.vision.advisor.config.mode === "guarded"
      ) {
        advice = await this.vision.adviseCurrent(
          `map-preparation-advisor-${attempt}`,
          {
            expectedState: "hud or map or panel",
            taskHint:
              "打开地图前确认：map=地图已开；hud=无遮挡角色主界面；panel=贡献表、成员页、队伍页、弹窗等功能窗口仍遮挡",
            ocrTexts: frame.observations.map((item) => item.text)
          },
          signal
        ).catch(() => null);
      }
      const minimum =
        Number(this.vision.advisor?.config.minimumActionConfidence) || 0.95;
      const confident = Number(advice?.confidence) >= minimum;
      if (confident && advice.state === "map") return "map";
      if (
        visibleHudText &&
        !visiblePanelText &&
        !visibleInteractionPanelText &&
        !visibleCampPanelText &&
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
          visiblePanelText: visiblePanelText?.text || null
          ,
          visibleInteractionPanelText:
            visibleInteractionPanelText?.text || null,
          visibleCampPanelText: visibleCampPanelText?.text || null,
          chatOpen,
          visibleHudText: visibleHudText?.text || null
        }
      );
      if (visibleCampPanelText) {
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
      } else if (visibleInteractionPanelText) {
        await this.adb.key(4, signal);
        await this.afterAction(signal);
      } else if (
        confident &&
        ["panel", "patrol_notice_board"].includes(advice.state) &&
        /右上|关闭|X/i.test(String(advice.evidence || ""))
      ) {
        await this.tap(topRightClose, signal);
      } else if (visiblePanelText || failureOverlay) {
        await this.tap(bottomLeftBack, signal);
      } else {
        await this.adb.key(4, signal);
        await this.afterAction(signal);
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
    let confirmedMapFrames = 0;
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
          `本地模型传送结果：${advice?.state || "unavailable"}`,
          { ...advice, accepted }
        );
        if (accepted && advice.state === "hud") {
          return { state: "success", text: advice.evidence };
        }
        if (accepted && advice.state === "teleport_error") {
          return {
            state: /冷却/.test(advice.evidence) ? "cooldown" : "nearby",
            text: advice.evidence
          };
        }
        if (accepted && advice.state === "map") {
          confirmedMapFrames += 1;
          if (confirmedMapFrames >= 2) {
            return {
              state: "nearby",
              text: "点击快速前往后地图持续打开（目标点附近）"
            };
          }
        } else if (advice?.state && advice.state !== "loading") {
          confirmedMapFrames = 0;
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
        deadline = Date.now() + timeoutMs;
      }
    } while (Date.now() < deadline);
    return { state: "timeout", text: null };
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
