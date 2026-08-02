import { delay } from "./process.mjs";
import { center } from "./vision.mjs";

export async function withGameSession(
  context,
  work,
  signal,
  watchdog = {
    enabled: true,
    healthCheckSeconds: 10,
    maxRestarts: 2,
    restartCooldownSeconds: 8
  }
) {
  const { mumu, adb, ui, vision, report, config } = context;
  let started = false;
  let gameReady = false;
  let advisorStarted = false;
  let preserveSceneAfterError = false;
  let preservedError = null;
  const cleanupResult = {
    cleanupCompleted: true,
    cleanupIssues: []
  };
  try {
    if (vision?.advisor?.enabled) {
      await report(
        "info",
        "local_model_start",
        "正在按任务启动本地视觉辅助模型"
      );
      try {
        advisorStarted = await vision.startAdvisor(signal);
      } catch (error) {
        await report(
          "warning",
          "local_model_unavailable",
          "本地视觉模型未能启动，本次任务继续使用 OCR 与确定性流程",
          { reason: error.message }
        );
      }
    }
    await report("info", "emulator_start", "正在后台启动 MuMu 模拟器");
    started = true;
    await mumu.ensureStarted(signal);

    for (let restartCount = 0; ; restartCount += 1) {
      try {
        await startAndEnterGame(context, signal);
        gameReady = true;
        await runWithWatchdog(context, work, signal, watchdog);
        return cleanupResult;
      } catch (error) {
        if (signal.aborted) throw signal.reason || error;
        const deviceState = await adb.state();
        const health = await adb.gameHealth().catch((healthError) => ({
          running: null,
          anr: false,
          detail: "",
          checkFailed: true,
          error: healthError.message
        }));
        const canRestart =
          watchdog.enabled &&
          restartCount < watchdog.maxRestarts &&
          isRecoverableGameFailure(error, health, deviceState);
        if (!canRestart) throw error;
        const hardRestart =
          deviceState !== "device" ||
          restartCount > 0 ||
          /MUMU_DEVICE_|ADB device|GAME_SCREEN_FROZEN/i.test(error.message);
        if (hardRestart) {
          await report(
            "warning",
            "emulator_container_restart",
            `检测到 MuMu 设备或界面无响应，正在优先重启 Android 容器（${restartCount + 1}/${watchdog.maxRestarts}）`,
            { reason: error.message, deviceState, health }
          );
          try {
            await mumu.restartContainer(signal);
          } catch (containerError) {
            await report(
              "warning",
              "emulator_hard_restart",
              "容器重启按钮/命令未在 60 秒内恢复，正在强制结束 macOS MuMu 进程",
              { reason: containerError.message }
            );
            await mumu.hardRestart(signal);
          }
        } else {
          await report(
            "warning",
            "game_restart",
            `已确认游戏进程退出或发生 ANR，正在结束进程并重启游戏（${restartCount + 1}/${watchdog.maxRestarts}）`,
            { reason: error.message, deviceState, health }
          );
          await adb.stopGame();
        }
        await delay(watchdog.restartCooldownSeconds * 1000, signal);
      }
    }
  } catch (error) {
    preservedError = error;
    preserveSceneAfterError =
      started &&
      !signal.aborted &&
      config.mumu.keepRunningOnTaskError === true &&
      !isFatalDeviceFailure(error);
    throw error;
  } finally {
    if (started) {
      if (preserveSceneAfterError) {
        await report(
          "warning",
          "task_error_scene_preserved",
          "任务遇到普通流程或识别错误，已保留当前游戏与 MuMu 现场；不会返回中心、关闭游戏或停止容器",
          { reason: preservedError?.message || "unknown" }
        ).catch(() => undefined);
      } else {
        if (
          gameReady &&
          !context.skipReturnToCenter &&
          config.mumu.returnToCenterAfterTask !== false
        ) {
          const returnResult = await returnToCenterExit(context);
          if (!returnResult.completed) {
            cleanupResult.cleanupCompleted = false;
            cleanupResult.cleanupIssues.push(returnResult.reason);
          }
        }
        await report("info", "game_stop", "正在关闭游戏进程").catch(() => undefined);
        await adb.stopGame().catch(async (error) => {
          cleanupResult.cleanupCompleted = false;
          cleanupResult.cleanupIssues.push(`关闭游戏失败：${error.message}`);
          await report(
            "warning",
            "game_stop_failed",
            "核心任务已完成，但关闭游戏进程失败",
            { reason: error.message }
          ).catch(() => undefined);
        });
        if (config.mumu.stopEmulatorAfterTask) {
          await report(
            "info",
            "emulator_stop",
            "任务已结束，正在停止 MuMu 以节约资源和能耗"
          ).catch(() => undefined);
          await mumu.stopAfterTask().catch(async (error) => {
            cleanupResult.cleanupCompleted = false;
            cleanupResult.cleanupIssues.push(`停止 MuMu 失败：${error.message}`);
            await report(
              "warning",
              "emulator_stop_failed",
              "核心任务已完成，但停止 MuMu 失败",
              { reason: error.message }
            ).catch(() => undefined);
          });
        }
      }
      if (advisorStarted) {
        await report(
          "info",
          "local_model_stop",
          preserveSceneAfterError
            ? "已保留游戏现场，正在单独释放本地视觉模型内存"
            : "任务已结束，正在释放本地视觉模型内存"
        ).catch(() => undefined);
        await vision.stopAdvisor().catch(() => undefined);
      }
    }
  }
}

function isFatalDeviceFailure(error) {
  return /(?:MUMU_DEVICE_|ADB device|GAME_PROCESS_EXITED|GAME_ANR|GAME_SCREEN_FROZEN|device offline|device unauthorized|no devices)/i.test(
    String(error?.message || "")
  );
}

async function returnToCenterExit(context) {
  const { adb, ui, report, config } = context;
  if (ui.lastConfirmedDestination === "中心出入口") {
    await report(
      "info",
      "return_center_skipped",
      "角色已确认位于中心出入口，跳过重复打开地图与传送"
    ).catch(() => undefined);
    return { completed: true, reason: null };
  }
  const deviceState = await adb.state().catch(() => "offline");
  const health = await adb.gameHealth().catch(() => ({
    running: false,
    anr: true
  }));
  if (deviceState !== "device" || !health.running || health.anr) {
    await report(
      "warning",
      "return_center_skipped",
      "游戏或 ADB 已无响应，跳过中心出入口收尾传送并直接关停",
      { deviceState, health }
    ).catch(() => undefined);
    return {
      completed: false,
      reason: "游戏或 ADB 无响应，未能返回中心出入口"
    };
  }
  const timeoutSeconds = Math.max(
    20,
    Number(config.mumu.returnToCenterTimeoutSeconds) || 60
  );
  const cleanupController = new AbortController();
  const timer = setTimeout(
    () => cleanupController.abort(new Error("中心出入口收尾传送超时")),
    timeoutSeconds * 1000
  );
  try {
    await report(
      "info",
      "return_center",
      "任务已结束，正在传送角色到中心出入口"
    );
    await ui.executeFlow(
      "teleportCentralExit",
      {},
      cleanupController.signal
    );
    await report(
      "info",
      "return_center_done",
      "角色已返回中心出入口"
    );
    return { completed: true, reason: null };
  } catch (error) {
    await report(
      "warning",
      "return_center_failed",
      "中心出入口收尾传送失败，将继续关闭游戏与模拟器",
      { reason: error.message }
    ).catch(() => undefined);
    return {
      completed: false,
      reason: `返回中心出入口失败：${error.message}`
    };
  } finally {
    clearTimeout(timer);
  }
}

async function startAndEnterGame(context, signal) {
  const { adb, ui, vision, report, config } = context;
  await report("info", "game_start", "正在启动明日之后");
  await adb.launchGame();
  await waitForGameReady(context, signal);
}

export async function waitForGameReady(context, signal) {
  const { adb, ui, vision, report, config } = context;
  const promotions = {
    maxDismissAttemptsPerPage: 4,
    dismissRetryCooldownMs: 15_000,
    initialWaitMs: 7_000,
    betweenPagesMs: 1_800,
    dismissPoint: { x: 960, y: 1035 },
    signatureTexts: ["立即前往", "前往查看", "前往活动", "活动时间"],
    readyTexts: ["配方", "背包", "营地"],
    channelReadyTexts: ["综合", "世界", "场景", "营地", "队伍"],
    channelReadyRegion: {
      left: 0,
      top: 980,
      right: 760,
      bottom: 1200
    },
    channelReadyMinimumTexts: 2,
    channelReadyStableFrames: 2,
    channelReadyStableMs: 1_000,
    loadingTexts: ["场景加载中", "正在加载", "加载中", "网络连接中"],
    readyMinimumTexts: 2,
    readyStableFrames: 5,
    readyStableMs: 12_000,
    postLoginMinimumWaitMs: 15_000,
    loadingQuietMs: 5_000,
    ...config.postLoginPromotions
  };
  const updates = {
    enabled: true,
    timeoutSeconds: 1800,
    maxGameRestarts: 3,
    processCheckSeconds: 3,
    relaunchDelaySeconds: 5,
    stateTexts: [
      "资源更新",
      "正在更新",
      "检查更新",
      "状态检测",
      "游戏状态检测",
      "更新资源",
      "下载资源",
      "正在下载",
      "正在解压"
    ],
    restartButtonTexts: ["重启游戏", "重新启动", "立即重启"],
    ...config.gameUpdates
  };
  const announcements = {
    enabled: true,
    maxClosures: 2,
    maxFixedCloseAttempts: 2,
    closePoint: { x: 1742, y: 155 },
    fixedCloseIntervalSeconds: 3,
    // 登录前公告必须由其固定文字锚点确认，不能把普通登录页当成公告盲点。
    texts: [
      "系统公告",
      "更新公告",
      "游戏公告",
      "经典服",
      "亲爱的幸存者"
    ],
    ...config.preLoginAnnouncements
  };
  let deadline = Date.now() + config.timeouts.gameLaunchSeconds * 1000;
  let dismissedPages = 0;
  const promotionDismissAttempts = new Map();
  let newspaperSeen = false;
  let loginClicked = false;
  let loginClickedAt = 0;
  let lastLoginClickAt = 0;
  let lastLoginAccurateOcrAt = 0;
  let updateObserved = false;
  let lastUpdateState = "";
  let lastUpdateReportAt = 0;
  let lastProcessCheckAt = 0;
  let processMissingSince = null;
  let updateRestartCount = 0;
  let announcementClosures = 0;
  let announcementCloseAttempts = 0;
  let lastAnnouncementCloseAt = 0;
  let lastAdviceAt = 0;
  let lastAdviceSignature = "";
  let repeatedAdvice = 0;
  let advisorFailureReported = false;
  let advisorPending = false;
  let guardedAdvice = null;
  let unknownAfterLoginCount = 0;
  let unknownRecoveryRequested = false;
  let unknownRecoveryAttempted = false;
  let accurateOcrFailureReported = false;
  let channelAccurateOcrFailureReported = false;
  let lastAccurateOcrAt = Date.now();
  let lastChannelAccurateOcrAt = 0;
  let readyStreak = 0;
  let readySince = 0;
  let readyStabilizingReported = false;
  let readyAccurateChannelSeen = false;
  let lastLoadingEvidenceAt = 0;
  const reservePromotionDismissAttempt = (state) => {
    const previous = promotionDismissAttempts.get(state);
    const now = Date.now();
    if (previous == null) {
      dismissedPages += 1;
      promotionDismissAttempts.set(state, {
        attempts: 1,
        lastAttemptAt: now
      });
      return 1;
    }
    const maxAttempts = Math.max(
      1,
      Number(promotions.maxDismissAttemptsPerPage) || 4
    );
    if (previous.attempts >= maxAttempts) {
      const retryCooldownMs = Math.max(
        1_000,
        Number(promotions.dismissRetryCooldownMs) || 15_000
      );
      if (now - previous.lastAttemptAt < retryCooldownMs) return null;
      promotionDismissAttempts.set(state, {
        attempts: 1,
        lastAttemptAt: now
      });
      return 1;
    }
    const nextAttempt = previous.attempts + 1;
    promotionDismissAttempts.set(state, {
      attempts: nextAttempt,
      lastAttemptAt: now
    });
    return nextAttempt;
  };
  while (Date.now() < deadline) {
    let frame = await vision.captureTransient("game-login-state", signal);
    let accurateChannelCandidate = false;
    const blockingStateTexts = [
      ...announcements.texts,
      ...updates.stateTexts,
      ...updates.restartButtonTexts,
      ...promotions.loadingTexts,
      "点击登录游戏",
      "登录游戏",
      "明日希望报",
      ...promotions.signatureTexts,
      "加入队伍语音频道"
    ];
    let fastReadyCount = promotions.readyTexts.filter((text) =>
      vision.find(frame.observations, text)
    ).length;
    let fastChannelReadyCount = findReadyTextsInRegion(
      vision,
      frame.observations,
      promotions.channelReadyTexts,
      promotions.channelReadyRegion
    ).length;
    const channelReadyMinimum = Math.max(
      2,
      Number(promotions.channelReadyMinimumTexts) || 2
    );
    const accurateFallbackMs =
      Math.max(
        0.05,
        Number(config.vision?.accurateFallbackSeconds) || 5
      ) * 1000;
    // The small bottom-left channel crop is the most reliable HUD signal on
    // macOS 27. It must not share the much slower full-frame accurate-OCR
    // cooldown: otherwise one successful “世界/场景” frame is followed by an
    // empty cooldown frame, resetting the stable-frame counter forever.
    const channelAccurateProbeMs = Math.max(
      250,
      Number(promotions.channelReadyProbeMs) || 800
    );
    if (
      fastChannelReadyCount < channelReadyMinimum &&
      (typeof vision.captureSource === "function" ||
        typeof vision.capture === "function") &&
      typeof vision.ocrRegion === "function" &&
      Date.now() - lastChannelAccurateOcrAt >= channelAccurateProbeMs
    ) {
      lastChannelAccurateOcrAt = Date.now();
      try {
        const channelFrame = typeof vision.captureSource === "function"
          ? await vision.captureSource("game-ready-channel-source", signal)
          : await vision.capture("game-ready-channel-source", signal);
        const channelObservations = await vision.ocrRegion(
          channelFrame.path,
          promotions.channelReadyRegion,
          "game-ready-channel-accurate",
          signal,
          "accurate",
          0.15,
          2
        );
        const accurateChannelMatches = findReadyTextsInRegion(
          vision,
          channelObservations,
          promotions.channelReadyTexts,
          promotions.channelReadyRegion
        );
        if (accurateChannelMatches.length >= channelReadyMinimum) {
          frame = {
            ...frame,
            observations: [...frame.observations, ...channelObservations]
          };
          fastChannelReadyCount = accurateChannelMatches.length;
          // A single accurate-OCR frame is still only a candidate. The final
          // confirmation below requires multiple stable frames and no login,
          // loading, announcement, or promotion evidence.
          accurateChannelCandidate = true;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!channelAccurateOcrFailureReported) {
          channelAccurateOcrFailureReported = true;
          await report(
            "warning",
            "game_ready_channel_accurate_unavailable",
            "左下角频道区域高精度 OCR 本次未能返回；将继续尝试完整画面与本地模型，不会禁用其他 OCR 模式",
            { reason: error.message }
          );
        }
      }
    }
    const fastMatchedKnownState =
      fastReadyCount >=
        Math.max(1, Number(promotions.readyMinimumTexts) || 2) ||
      fastChannelReadyCount >=
        channelReadyMinimum ||
      blockingStateTexts.some((text) =>
        vision.find(frame.observations, text)
      );
    if (
      !fastMatchedKnownState &&
      config.vision?.accurateFallbackEnabled !== false &&
      typeof vision.captureAccurate === "function" &&
      Date.now() - lastAccurateOcrAt >= accurateFallbackMs
    ) {
      lastAccurateOcrAt = Date.now();
      try {
        const accurateFrame = await vision.captureAccurateTransient(
          "game-login-state-accurate",
          signal
        );
        if (accurateFrame.observations.length) {
          frame = accurateFrame;
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!accurateOcrFailureReported) {
          accurateOcrFailureReported = true;
          await report(
            "warning",
            "accurate_ocr_unavailable",
            "高精度 OCR 本次未能及时返回，已自动退回快速 OCR，任务继续执行",
            { reason: error.message }
          );
        }
      }
    }
    const readyMatches = promotions.readyTexts
      .map((text) => ({ text, match: vision.find(frame.observations, text) }))
      .filter((item) => item.match);
    const channelReadyMatches = findReadyTextsInRegion(
      vision,
      frame.observations,
      promotions.channelReadyTexts,
      promotions.channelReadyRegion
    );
    const ready = readyMatches[0]?.text || null;
    const loadingProgressRegion = promotions.loadingProgressRegion || {
      left: 360,
      top: 900,
      right: 1560,
      bottom: 1200
    };
    const loadingProgressVisible = frame.observations.some((item) => {
      const text = String(item.text || "").replace(/\s+/g, "");
      const centerX = Number(item.x || 0) + Number(item.width || 0) / 2;
      const centerY = Number(item.y || 0) + Number(item.height || 0) / 2;
      const inLoadingBarRegion =
        centerX >= loadingProgressRegion.left &&
        centerX <= loadingProgressRegion.right &&
        centerY >= loadingProgressRegion.top &&
        centerY <= loadingProgressRegion.bottom;
      if (!inLoadingBarRegion) return false;
      return /^(?:100|[0-9]{1,2})(?:\.[0-9]+)?[%％]$/.test(text) ||
        /(?:加载|登录|进入|场景|资源).{0,12}(?:100|[0-9]{1,2})(?:\.[0-9]+)?[%％]/.test(text);
    });
    const blocksReady = [
      ...promotions.loadingTexts,
      ...updates.stateTexts,
      ...updates.restartButtonTexts,
      ...announcements.texts,
      "点击登录游戏",
      "登录游戏",
      "明日希望报",
      ...promotions.signatureTexts,
      "加入队伍语音频道"
    ].some((text) => vision.find(frame.observations, text)) ||
      loadingProgressVisible;
    if (blocksReady) lastLoadingEvidenceAt = Date.now();
    const readyMinimumTexts = Math.max(
      1,
      Number(promotions.readyMinimumTexts) || 2
    );
    const channelReadyMinimumTexts = Math.max(
      2,
      Number(promotions.channelReadyMinimumTexts) || 2
    );
    const channelHudReady =
      channelReadyMatches.length >= channelReadyMinimumTexts;
    const configuredPostLoginWaitMs = Number(
      promotions.postLoginMinimumWaitMs
    );
    const postLoginWaitMs = Math.max(
      0,
      Number.isFinite(configuredPostLoginWaitMs)
        ? configuredPostLoginWaitMs
        : 15_000
    );
    const configuredLoadingQuietMs = Number(promotions.loadingQuietMs);
    const loadingQuietMs = Math.max(
      0,
      Number.isFinite(configuredLoadingQuietMs)
        ? configuredLoadingQuietMs
        : 5_000
    );
    const postLoginWaitSatisfied =
      !loginClicked || Date.now() - loginClickedAt >= postLoginWaitMs;
    const loadingQuietSatisfied =
      !lastLoadingEvidenceAt ||
      Date.now() - lastLoadingEvidenceAt >= loadingQuietMs;
    if (
      (readyMatches.length >= readyMinimumTexts || channelHudReady) &&
      !blocksReady &&
      postLoginWaitSatisfied &&
      loadingQuietSatisfied
    ) {
      readyStreak += 1;
      readySince ||= Date.now();
      readyAccurateChannelSeen ||= accurateChannelCandidate;
      const configuredStableFrames = Number(promotions.readyStableFrames);
      const configuredStableMs = Number(promotions.readyStableMs);
      const channelStableFrames = Number(promotions.channelReadyStableFrames);
      const stableFrames = Math.max(
        channelHudReady ? 2 : 1,
        channelHudReady
          ? Number.isFinite(channelStableFrames)
            ? channelStableFrames
            : 2
          : Number.isFinite(configuredStableFrames)
            ? configuredStableFrames
            : 3
      );
      const channelStableMs = Number(promotions.channelReadyStableMs);
      const stableMs = Math.max(
        channelHudReady ? 1_000 : 0,
        channelHudReady
          ? Number.isFinite(channelStableMs)
            ? channelStableMs
            : 1_000
          : Number.isFinite(configuredStableMs)
            ? configuredStableMs
            : 3_000
      );
      if (readyStreak < stableFrames || Date.now() - readySince < stableMs) {
        if (!readyStabilizingReported) {
          readyStabilizingReported = true;
          await report(
            "info",
            "game_ready_stabilizing",
            "已看到多个 HUD 锚点，继续等待登录进度层消失且场景连续稳定后再开始任务点击",
            {
              stableFrames,
              stableMs,
              readyTexts: [
                ...readyMatches.map((item) => item.text),
                ...channelReadyMatches.map((item) => item.text)
              ],
              channelHudReady,
              postLoginWaitMs,
              loadingQuietMs
            }
          );
        }
      } else {
        if (channelHudReady && readyAccurateChannelSeen) {
          await report(
            "info",
            "game_ready_channel_accurate",
            `已通过左下角独立频道标签的稳定多帧高精度 OCR 确认 HUD：${channelReadyMatches.map((item) => item.text).join("、")}`
          );
        }
        await report(
          "info",
          "game_ready",
          dismissedPages
            ? `游戏界面已就绪，已关闭 ${dismissedPages} 张活动宣传页`
            : "游戏界面已就绪，未出现活动宣传页"
        );
        await ui.keyIfAnyText(["加入队伍语音频道"], 111, signal);
        await adb.releaseMouseButton?.(
          Math.round((config.adb.screenWidth || 1920) / 2),
          Math.round((config.adb.screenHeight || 1200) / 2),
          signal
        );
        return;
      }
    } else {
      readyStreak = 0;
      readySince = 0;
      readyStabilizingReported = false;
      readyAccurateChannelSeen = false;
    }
    // 登录是已校准的固定安全点击。它的文本在新版登录页中偶尔会被快速
    // OCR 漏掉；必须在“关闭未知公告”之前先做一次登录区域高精度确认，
    // 否则会把正常登录页误当公告而一直不点登录。
    let login = ["点击登录游戏", "登录游戏"]
      .map((text) => ({ text, match: vision.find(frame.observations, text) }))
      .find((item) => item.match);
    let announcementText = announcements.texts.find((text) =>
      vision.find(frame.observations, text)
    );
    const captureAccurateLogin =
      vision.captureAccurate || vision.captureAccurateTransient;
    if (
      !login &&
      !loginClicked &&
      typeof captureAccurateLogin === "function" &&
      Date.now() - lastLoginAccurateOcrAt >= 2_000
    ) {
      lastLoginAccurateOcrAt = Date.now();
      try {
        const accurateLoginFrame = await captureAccurateLogin.call(
          vision,
          "game-login-button-accurate",
          signal
        );
        let loginObservations = accurateLoginFrame.observations;
        if (
          accurateLoginFrame.path &&
          typeof vision.ocrRegion === "function"
        ) {
          const loginPoint = config.adb.loginButton || { x: 960, y: 945 };
          const loginRegion = config.adb.loginButtonRegion || {
            left: Math.max(0, loginPoint.x - 600),
            top: Math.max(0, loginPoint.y - 150),
            right: Math.min(config.adb.screenWidth || 1920, loginPoint.x + 600),
            bottom: Math.min(config.adb.screenHeight || 1200, loginPoint.y + 150)
          };
          const regionObservations = await vision.ocrRegion(
            accurateLoginFrame.path,
            loginRegion,
            "game-login-button-region-accurate",
            signal,
            "accurate",
            0.08,
            2
          );
          loginObservations = [...loginObservations, ...regionObservations];
        }
        login = ["点击登录游戏", "登录游戏"]
          .map((text) => ({
            text,
            match: vision.find(loginObservations, text)
          }))
          .find((item) => item.match);
        announcementText ||= announcements.texts.find((text) =>
          vision.find(loginObservations, text)
        );
        if (login) {
          await report(
            "info",
            "accurate_login_button_verified",
            `快速 OCR 漏读后，已通过高精度 OCR 确认“${login.text}”，正在点击校准登录按钮`
          );
        }
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!accurateOcrFailureReported) {
          accurateOcrFailureReported = true;
          await report(
            "warning",
            "accurate_ocr_unavailable",
            "登录按钮区域高精度 OCR 本次未能及时返回，已自动退回快速 OCR 与本地模型，任务继续执行",
            { reason: error.message }
          );
        }
      }
    }
    if (login && Date.now() - lastLoginClickAt >= 5_000) {
      await ui.tap(config.adb.loginButton, signal);
      loginClicked = true;
      loginClickedAt = Date.now();
      lastLoginClickAt = Date.now();
      dismissedPages = 0;
      promotionDismissAttempts.clear();
      newspaperSeen = false;
      continue;
    }

    // 登录页仅在启动阶段处理，点击位置是经过校准的固定登录按钮。模型明确
    // 判为 login 时使用单独的较低门槛，不能沿用功能页面的 0.95 高风险门槛，
    // 否则会出现“已识别 login、却持续不点击”的死循环。
    const advisorConfig = vision.advisor?.config;
    const actionableAdvice =
      advisorConfig?.mode === "guarded" &&
      guardedAdvice &&
      Date.now() - guardedAdvice.acceptedAt <=
        Math.max(
          2,
          guardedAdvice.state === "login"
            ? Math.max(
                120,
                Number(advisorConfig.maxLoginAdviceAgeSeconds) || 120
              )
            : Number(advisorConfig.maxAdviceAgeSeconds) || 8
        ) * 1000
        ? guardedAdvice
        : null;
    if (
      actionableAdvice?.state === "login" &&
      !loginClicked &&
      Date.now() - lastLoginClickAt >= 5_000
    ) {
      guardedAdvice = null;
      await report(
        "info",
        "local_model_guarded_login",
        "本地模型以高置信度确认登录页，正在点击已校准的固定登录按钮"
      );
      await ui.tap(config.adb.loginButton, signal);
      loginClicked = true;
      loginClickedAt = Date.now();
      lastLoginClickAt = Date.now();
      dismissedPages = 0;
      promotionDismissAttempts.clear();
      newspaperSeen = false;
      continue;
    }
    const fixedAnnouncementCloseIntervalMs =
      Math.max(
        0.5,
        Number(announcements.fixedCloseIntervalSeconds) || 3
      ) * 1000;
    const maxFixedCloseAttempts = Math.max(
      0,
      Number(announcements.maxFixedCloseAttempts) || 2
    );
    if (
      announcements.enabled &&
      !loginClicked &&
      !ready &&
      !blocksReady &&
      announcementText &&
      announcementCloseAttempts < maxFixedCloseAttempts &&
      Date.now() - lastAnnouncementCloseAt >=
        fixedAnnouncementCloseIntervalMs
    ) {
      announcementCloseAttempts += 1;
      lastAnnouncementCloseAt = Date.now();
      await report(
        "info",
        "prelogin_announcement_ocr_close",
        `OCR 已确认登录前系统公告锚点“${announcementText}”，正在点击右上角 X`,
        {
          anchor: announcementText,
          attempt: announcementCloseAttempts,
          maxFixedCloseAttempts
        }
      );
      await ui.tap(announcements.closePoint, signal);
      await ui.afterAction(signal);
    }
    const updateState = updates.enabled
      ? updates.stateTexts.find((text) =>
          vision.find(frame.observations, text)
        )
      : null;
    if (updateState) {
      if (!updateObserved) {
        deadline = Math.max(
          deadline,
          Date.now() + updates.timeoutSeconds * 1000
        );
      }
      updateObserved = true;
      if (
        updateState !== lastUpdateState ||
        Date.now() - lastUpdateReportAt >= 60_000
      ) {
        lastUpdateState = updateState;
        lastUpdateReportAt = Date.now();
        await report(
          "info",
          "game_resource_update",
          `检测到明日之后资源更新/状态检测：${updateState}，保持等待且不点击宣传页`,
          { restartCount: updateRestartCount }
        );
      }
      const restartButton = updates.restartButtonTexts
        .map((text) => ({
          text,
          match: vision.find(frame.observations, text)
        }))
        .find((item) => item.match);
      if (restartButton) {
        await report(
          "info",
          "game_update_restart_button",
          `资源更新要求${restartButton.text}，正在点击明确的重启按钮`
        );
        await ui.tap(center(restartButton.match), signal);
        await ui.afterAction(signal);
        processMissingSince = null;
        continue;
      }
    }

    const announcement = announcements.enabled && !loginClicked
      ? announcements.texts.find((text) =>
          vision.find(frame.observations, text)
        )
      : null;
    if (announcement && announcementClosures < announcements.maxClosures) {
      announcementClosures += 1;
      lastAnnouncementCloseAt = Date.now();
      await report(
        "info",
        "prelogin_announcement_close",
        `检测到登录角色前的${announcement}，正在点击右上角关闭按钮`,
        { closure: announcementClosures }
      );
      await ui.tap(announcements.closePoint, signal);
      await ui.afterAction(signal);
      continue;
    }

    const newspaper = loginClicked
      ? vision.find(frame.observations, "明日希望报")
      : null;
    const newspaperDismissAttempt = newspaper
      ? reservePromotionDismissAttempt("promotion_newspaper")
      : null;
    if (newspaper && newspaperDismissAttempt != null) {
      newspaperSeen = true;
      await report(
        "info",
        newspaperDismissAttempt === 1
          ? "promotion_newspaper_dismiss"
          : "promotion_newspaper_dismiss_retry",
        newspaperDismissAttempt === 1
          ? "识别到《明日希望报》宣传页，正在点击底部安全区域关闭"
          : `《明日希望报》仍在显示，正在第 ${newspaperDismissAttempt} 次点击底部安全区域关闭`,
        {
          attempt: newspaperDismissAttempt,
          maxAttempts: promotions.maxDismissAttemptsPerPage
        }
      );
      await ui.tap(promotions.dismissPoint, signal);
      await ui.afterAction(signal);
      continue;
    }

    const promotionSignature =
      loginClicked &&
      !ready &&
      !channelHudReady &&
      promotions.signatureTexts.find((text) =>
        vision.find(frame.observations, text)
      );
    const signatureDismissAttempt = promotionSignature
      ? reservePromotionDismissAttempt("promotion")
      : null;
    if (promotionSignature && signatureDismissAttempt != null) {
      await report(
        "info",
        signatureDismissAttempt === 1
          ? "promotion_signature_dismiss"
          : "promotion_signature_dismiss_retry",
        signatureDismissAttempt === 1
          ? `识别到登录后活动宣传页特征“${promotionSignature}”，正在点击已校准的底部安全区域关闭`
          : `登录后活动宣传页仍在显示，正在第 ${signatureDismissAttempt} 次点击底部安全区域关闭`,
        {
          dismissedPages,
          attempt: signatureDismissAttempt,
          maxAttempts: promotions.maxDismissAttemptsPerPage
        }
      );
      await ui.tap(promotions.dismissPoint, signal);
      await ui.afterAction(signal);
      continue;
    }

    const voicePrompt = vision.find(frame.observations, "加入队伍语音频道");
    if (voicePrompt) {
      await adb.key(111, signal);
      await ui.afterAction(signal);
      continue;
    }

    if (
      unknownRecoveryRequested &&
      !unknownRecoveryAttempted &&
      !context.positionIndependent &&
      !context.skipUnknownRecovery
    ) {
      unknownRecoveryAttempted = true;
      unknownRecoveryRequested = false;
      await report(
        "warning",
        "local_model_unknown_recovery",
        "AI 连续无法确认当前登录后场景，正在传送到中心出入口恢复已知位置；随后继续当前任务的目标传送"
      );
      await ui.executeFlow("teleportCentralExit", {}, signal);
      await report(
        "info",
        "local_model_unknown_recovered",
        "已回到中心出入口，当前任务将继续前往所需场所"
      );
      return;
    }
    if (actionableAdvice?.state === "hud") {
      guardedAdvice = null;
      await report(
        "info",
        "local_model_guarded_hud",
        "本地模型以连续极高置信度确认 HUD；仍等待 OCR 连续稳定后再开始任务点击"
      );
    }
    if (
      loginClicked &&
      ["promotion", "promotion_newspaper", "prelogin_announcement"].includes(
        actionableAdvice?.state
      )
    ) {
      const classifiedState = actionableAdvice.state;
      const state =
        classifiedState === "prelogin_announcement"
          ? "promotion"
          : classifiedState;
      const dismissAttempt = reservePromotionDismissAttempt(state);
      if (dismissAttempt != null) {
        guardedAdvice = null;
        newspaperSeen ||= state === "promotion_newspaper";
        await report(
          "info",
          dismissAttempt === 1
            ? "local_model_guarded_promotion"
            : "local_model_guarded_promotion_retry",
          dismissAttempt === 1
            ? classifiedState === "prelogin_announcement"
              ? "本地模型在登录后高置信度识别到全屏公告式画面，已按活动宣传页处理并点击校准后的底部关闭区域"
              : "本地模型以高置信度确认登录后宣传页，正在点击已校准的底部关闭区域"
            : `本地模型确认宣传页仍未关闭，正在第 ${dismissAttempt} 次点击校准后的底部关闭区域`,
          {
            state,
            classifiedState,
            dismissedPages,
            attempt: dismissAttempt,
            maxAttempts: promotions.maxDismissAttemptsPerPage
          }
        );
        await ui.tap(promotions.dismissPoint, signal);
        await ui.afterAction(signal);
        continue;
      }
    }

    if (
      vision.advisor?.enabled &&
      !advisorPending &&
      Date.now() - lastAdviceAt >=
        Math.max(0.05, Number(advisorConfig.intervalSeconds) || 8) * 1000
    ) {
      lastAdviceAt = Date.now();
      advisorPending = true;
      void vision.adviseCurrent(
          "game-login-advisor",
          {
            loginClicked,
            expectedState: loginClicked
              ? "promotion, promotion_newspaper, hud"
              : "prelogin_announcement, login, resource_update",
            ocrTexts: frame.observations.map((item) => item.text)
          },
          signal
        )
        .then(async (advice) => {
          const signature = advice
            ? `${advice.state}:${advice.action}`
            : "";
          repeatedAdvice = signature && signature === lastAdviceSignature
            ? repeatedAdvice + 1
            : 1;
          lastAdviceSignature = signature;
          const guardedCandidate =
            (
              advisorConfig.mode === "guarded" &&
              ["login", "promotion", "promotion_newspaper", "hud"].includes(
                advice?.state
              )
            ) ||
            (
              advisorConfig.mode === "guarded" &&
              loginClicked &&
              advice?.state === "prelogin_announcement"
            );
          const guardedCandidateAccepted =
            guardedCandidate &&
            Number(advice?.confidence) >=
              (advice?.state === "login" && !loginClicked
                ? Math.max(
                    0.35,
                    Number(advisorConfig.minimumLoginActionConfidence) || 0.45
                  )
                : Math.max(
                    0.9,
                    Number(advisorConfig.minimumActionConfidence) || 0.95
                  )) &&
            repeatedAdvice >=
              (advice?.state === "login" && !loginClicked
                ? 1
                : Math.max(
                    1,
                    Number(advisorConfig.consecutiveMatches) || 1
                  ));
          if (guardedCandidateAccepted) {
            guardedAdvice = {
              ...advice,
              acceptedAt: Date.now()
            };
          }
          if (
            loginClicked &&
            Date.now() - lastLoginClickAt >=
              Math.max(
                5,
                Number(advisorConfig.unknownRecoveryDelaySeconds) || 8
              ) * 1000 &&
            advice?.state === "unknown"
          ) {
            unknownAfterLoginCount += 1;
            if (
              unknownAfterLoginCount >=
                Math.max(
                  1,
                  Number(advisorConfig.unknownRecoveryMatches) || 2
                )
            ) {
              unknownRecoveryRequested = true;
            }
          } else if (
            advice?.state &&
            advice.state !== "loading"
          ) {
            unknownAfterLoginCount = 0;
          }
          await report(
            "info",
            "local_model_classification",
            advisorConfig.mode === "guarded"
              ? `本地模型记录受限候选画面 ${advice?.state || "unknown"}`
              : `本地模型只读记录候选画面 ${advice?.state || "unknown"}，不会点击或推动任务流程`,
            {
              ...advice,
              repeatedAdvice,
              accepted: guardedCandidateAccepted,
              executionMode: advisorConfig.mode
            }
          );
        })
        .catch(async (error) => {
          if (!advisorFailureReported) {
            advisorFailureReported = true;
            await report(
              "warning",
              "local_model_request_failed",
              "本地模型请求失败，本次登录继续使用 OCR 规则",
              { reason: error.message }
            );
          }
        })
        .finally(() => {
          advisorPending = false;
        });
    }

    if (
      updateObserved &&
      Date.now() - lastProcessCheckAt >= updates.processCheckSeconds * 1000
    ) {
      lastProcessCheckAt = Date.now();
      const health = await adb.gameHealth().catch(() => ({ running: false }));
      if (health.running) {
        processMissingSince = null;
      } else if (processMissingSince == null) {
        processMissingSince = Date.now();
      } else if (
        Date.now() - processMissingSince >= updates.processCheckSeconds * 1000
      ) {
        if (updateRestartCount >= updates.maxGameRestarts) {
          throw new Error(
            `Game exited during resource update more than ${updates.maxGameRestarts} times`
          );
        }
        updateRestartCount += 1;
        await report(
          "warning",
          "game_update_relaunch",
          `资源更新期间游戏已主动结束，等待 ${updates.relaunchDelaySeconds} 秒后重新启动（${updateRestartCount}/${updates.maxGameRestarts}）`
        );
        await delay(updates.relaunchDelaySeconds * 1000, signal);
        await adb.launchGame();
        processMissingSince = null;
        loginClicked = false;
        loginClickedAt = 0;
        dismissedPages = 0;
        promotionDismissAttempts.clear();
        newspaperSeen = false;
        continue;
      }
    }

    await delay(800, signal);
    if (
      Date.now() >= deadline &&
      config.timeouts.neverAbortHealthyTaskOnTimeout
    ) {
      await report(
        "warning",
        "healthy_login_wait_extended",
        "游戏进程健康，登录/加载等待已延长，不重启或关闭游戏"
      );
      deadline = Date.now() +
        Math.max(180, Number(config.timeouts.gameLaunchSeconds) || 180) * 1000;
    }
  }
  throw new Error(
    updateObserved
      ? `Timed out waiting for resource update to finish after ${updates.timeoutSeconds}s`
      : `Timed out waiting for game HUD after login; dismissed ${dismissedPages} possible promotion pages`
  );
}

function findReadyTextsInRegion(vision, observations, texts = [], region) {
  if (!region || !Array.isArray(texts)) return [];
  const bounded = observations.filter((item) => {
    const centerX = item.x + item.width / 2;
    const centerY = item.y + item.height / 2;
    return (
      centerX >= region.left &&
      centerX <= region.right &&
      centerY >= region.top &&
      centerY <= region.bottom
    );
  });
  // Channel tabs are short, independent labels. Never use substring matching
  // here: the login/loading page legal disclaimer contains both “世界观” and
  // “角色场景”, which previously allowed one sentence to impersonate two HUD
  // anchors. Each label must occupy its own OCR observation.
  const claimed = new Set();
  return texts.flatMap((text) => {
    const expected = normalizeChannelLabel(text);
    const index = bounded.findIndex(
      (item, candidateIndex) =>
        !claimed.has(candidateIndex) &&
        normalizeChannelLabel(item.text) === expected
    );
    if (index < 0) return [];
    claimed.add(index);
    return [{ text, match: bounded[index] }];
  });
}

function normalizeChannelLabel(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

async function runWithWatchdog(context, work, parentSignal, watchdog) {
  if (!watchdog.enabled) return work();
  const controller = new AbortController();
  const abort = () =>
    controller.abort(parentSignal.reason || new Error("管理员请求中断"));
  parentSignal.addEventListener("abort", abort, { once: true });
  const monitor = monitorGame(context, watchdog, controller.signal).catch((error) => {
    controller.abort(error);
    throw error;
  });
  try {
    return await Promise.race([work(controller.signal), monitor]);
  } finally {
    controller.abort(new Error("看门狗结束"));
    parentSignal.removeEventListener("abort", abort);
  }
}

async function monitorGame(context, watchdog, signal) {
  while (!signal.aborted) {
    await delay(watchdog.healthCheckSeconds * 1000, signal);
    const deviceState = await context.adb.state();
    if (deviceState !== "device") {
      throw new Error(`MUMU_DEVICE_${deviceState.toUpperCase()}`);
    }
    const health = await context.adb.gameHealth();
    if (!health.running) throw new Error("GAME_PROCESS_EXITED");
    if (health.anr) throw new Error("GAME_ANR_DETECTED");
  }
}

export function isRecoverableGameFailure(error, health, deviceState = "device") {
  if (deviceState !== "device") return true;
  if (health?.anr === true || health?.running === false) return true;
  // UI/OCR timeouts and transient input failures must not restart a healthy game.
  // The watchdog performs the authoritative process/ANR check above.
  return false;
}
