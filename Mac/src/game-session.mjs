import { delay } from "./process.mjs";
import { TaskRestartRequestedError } from "./ui.mjs";
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
  const setProgress = async (value, step) => {
    if (typeof context.progress === "function") {
      await context.progress(value, step);
    }
  };
  let started = false;
  let gameReady = false;
  let advisorStarted = false;
  let preserveSceneAfterError = false;
  let preservedError = null;
  const startupProtectionSeconds = Math.max(
    300,
    Number(config.mumu.startupProtectionSeconds) || 300
  );
  let startupProtectionDeadline = 0;
  let containerReady = false;
  let startupWaitReportAt = 0;
  const startupState = {
    launched: false,
    prewarmed: false
  };
  const cleanupResult = {
    cleanupCompleted: true,
    cleanupIssues: []
  };
  try {
    if (vision?.advisor?.enabled) {
      await report(
        "info",
        "local_model_start",
        "正在按任务启动 Qwen 本地视觉辅助模型",
        {
          transport: vision.advisor.config?.transport || "unknown",
          model: vision.advisor.config?.model || null,
          autoStartForTasks: vision.advisor.config?.autoStartForTasks !== false
        }
      );
      await setProgress(0.025, "local_model_start");
      try {
        advisorStarted = await vision.startAdvisor(signal);
        if (advisorStarted) {
          await report(
            "info",
            "local_model_started",
            "Qwen 本地视觉辅助模型已启动",
            {
              transport: vision.advisor.config?.transport || "unknown",
              model: vision.advisor.config?.model || null,
              baseUrl: vision.advisor.config?.baseUrl || null
            }
          );
        } else {
          await report(
            "info",
            "local_model_skipped",
            "Qwen 本地视觉辅助模型因任务配置未自动启动，使用 OCR 与确定性流程",
            { autoStartForTasks: false }
          );
        }
      } catch (error) {
        await report(
          "warning",
          "local_model_unavailable",
          "Qwen 本地视觉模型启动失败，本次任务继续使用 OCR 与确定性流程",
          { reason: error.message }
        );
      }
    } else {
      await report(
        "info",
        "local_model_disabled",
        "本次任务未启用 Qwen 本地视觉辅助模型，使用 OCR 与确定性流程",
        {
          enabled: false,
          transport: config.localVisionModel?.transport || null,
          model: config.localVisionModel?.model || null
        }
      );
    }
    await report("info", "emulator_start", "正在后台启动 MuMu 模拟器");
    await setProgress(0.03, "emulator_start");
    started = true;
    // Start the protection window immediately before the container launch;
    // local-model startup must not consume the container's 300-second budget.
    startupProtectionDeadline =
      Date.now() + startupProtectionSeconds * 1000;
    let restartCount = 0;
    let taskRestartCount = 0;
    while (true) {
      try {
        if (!containerReady) {
          await mumu.ensureStarted(signal);
          // The protection window is only for MuMu/Android container startup.
          // Once ensureStarted has returned, the ADB device is ready and the
          // game must proceed immediately through launch, OCR warmup and login.
          containerReady = true;
          await setProgress(0.035, "emulator_ready");
        }
        await startAndEnterGame(context, signal, startupState);
        gameReady = true;
        ui.setTaskActive?.(true);
        let workResult;
        try {
          workResult = await runWithWatchdog(context, work, signal, watchdog);
        } finally {
          ui.setTaskActive?.(false);
        }
        if (workResult?.restartTask === true) {
          const maxTaskRestarts = Math.max(
            0,
            Number(config.deathRecovery?.maxTaskRestarts) || 2
          );
          if (taskRestartCount >= maxTaskRestarts) {
            throw new Error(
              `DEATH_RECOVERY_RESTART_LIMIT: 角色复活后已重试 ${taskRestartCount} 次，仍无法完成原任务`
            );
          }
          taskRestartCount += 1;
          await report(
            "warning",
            "task_restarted_after_revival",
            `角色已复活，正在从头重新执行原任务（第 ${taskRestartCount}/${maxTaskRestarts} 次）`,
            { attempt: taskRestartCount, maxAttempts: maxTaskRestarts }
          );
          await delay(
            Math.max(
              250,
              (Number(config.deathRecovery?.restartDelaySeconds) || 3) * 1000
            ),
            signal
          );
          continue;
        }
        return cleanupResult;
      } catch (error) {
        if (signal.aborted) throw signal.reason || error;
        if (shouldHoldInitialStartup(containerReady, startupProtectionDeadline)) {
          const now = Date.now();
          if (now - startupWaitReportAt >= 15_000) {
            startupWaitReportAt = now;
            const waitedSeconds = Math.max(
              0,
              Math.round(
                (startupProtectionSeconds * 1000 -
                  Math.max(0, startupProtectionDeadline - now)) /
                  1000
              )
            );
            await report(
              "warning",
              "emulator_start_waiting",
              `MuMu Android 容器首次启动仍在加载，已等待约 ${waitedSeconds} 秒；首次容器启动保护共 ${startupProtectionSeconds} 秒，保护期内不重启容器`,
              { waitedSeconds, startupProtectionSeconds, reason: error.message }
            ).catch(() => undefined);
          }
          await delay(
            Math.min(
              5_000,
              Math.max(250, startupProtectionDeadline - Date.now())
            ),
            signal
          );
          continue;
        }
        const deviceState = await adb.state();
        const health = await adb.gameHealth().catch((healthError) => ({
          running: null,
          anr: false,
          detail: "",
          checkFailed: true,
          error: healthError.message
        }));
        const startupFailureStillRecoverable =
          !gameReady &&
          (deviceState !== "device" ||
            health.anr === true ||
            health.running === false);
        const canRestart =
          !context.suppressScheduledRetry &&
          watchdog.enabled &&
          restartCount < watchdog.maxRestarts &&
          (isRecoverableGameFailure(error, health, deviceState) ||
            startupFailureStillRecoverable);
        if (!canRestart && context.suppressScheduledRetry && !signal.aborted) {
          await report(
            "warning",
            "task_cleanup_error_no_restart",
            "任务已进入巡逻结束收尾阶段；本次收尾错误不会触发失败重启或新的定时任务尝试",
            {
              reason: error.message,
              cleanupReason: context.suppressScheduledRetryReason || "task_cleanup"
            }
          ).catch(() => undefined);
        }
        if (!canRestart) throw error;
        const startupProtectionExpired =
          !containerReady && Date.now() >= startupProtectionDeadline;
        const nextRestartCount = restartCount + 1;
        const hardRestart =
          startupProtectionExpired ||
          deviceState !== "device" ||
          restartCount > 0 ||
          /MUMU_DEVICE_|ADB device|GAME_SCREEN_FROZEN/i.test(error.message);
        if (hardRestart) {
          await report(
            "warning",
            "emulator_container_restart",
            startupProtectionExpired
              ? `首次启动保护已等待 ${startupProtectionSeconds} 秒仍未成功，正在重启 Android 容器（${nextRestartCount}/${watchdog.maxRestarts}）`
              : `检测到 MuMu 设备或界面无响应，正在优先重启 Android 容器（${nextRestartCount}/${watchdog.maxRestarts}）`,
            {
              reason: error.message,
              deviceState,
              health,
              startupProtectionExpired
            }
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
          startupState.launched = false;
          startupState.prewarmed = false;
          containerReady = true;
        } else {
          await report(
            "warning",
            "game_restart",
            `已确认游戏进程退出或发生 ANR，正在结束进程并重启游戏（${nextRestartCount}/${watchdog.maxRestarts}）`,
            { reason: error.message, deviceState, health }
          );
          await adb.stopGame();
          startupState.launched = false;
          startupState.prewarmed = false;
        }
        restartCount = nextRestartCount;
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
          let returnResult;
          try {
            returnResult = await returnToCenterExit(context);
          } catch (error) {
            returnResult = {
              completed: false,
              reason: `返回中心失败：${error.message}`
            };
            await report(
              "warning",
              "return_center_failed",
              "任务收尾返回中心失败；保留原始任务错误，不重新启动 MuMu",
              { reason: conciseError(error, 500) }
            ).catch(() => undefined);
          }
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
            { reason: conciseError(error, 500) }
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
            ? "已保留游戏现场，正在单独释放 Qwen 本地视觉模型内存"
            : "任务已结束，正在释放 Qwen 本地视觉模型内存"
        ).catch(() => undefined);
        try {
          await vision.stopAdvisor();
          await report(
            "info",
            "local_model_stopped",
            "Qwen 本地视觉辅助模型已停止并释放内存"
          ).catch(() => undefined);
        } catch (error) {
          await report(
            "warning",
            "local_model_stop_failed",
            "Qwen 本地视觉辅助模型停止失败",
            { reason: error.message }
          ).catch(() => undefined);
        }
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

async function startAndEnterGame(context, signal, startupState = {}) {
  const { adb, ui, vision, report, config } = context;
  if (!startupState.launched) {
    await report("info", "game_start", "正在启动明日之后");
    await context.progress?.(0.04, "game_start");
    ui.resetGameMouseState?.();
    await adb.launchGame();
    startupState.launched = true;
  }
  if (!startupState.prewarmed && typeof vision.prewarm === "function") {
    await report("info", "ocr_prewarm", "正在预热本机 OCR（首次启动可能较慢）");
    try {
      const result = await vision.prewarm(signal);
      await report(
        "info",
        "ocr_prewarm_done",
        `本机 OCR 预热完成（${result.elapsedMs}ms），后续 fast OCR 进入低延迟模式`
      );
      await context.progress?.(0.05, "ocr_prewarm_done");
    } catch (error) {
      if (signal?.aborted) throw error;
      await report(
        "warning",
        "ocr_prewarm_failed",
        "本机 OCR 预热失败，将继续尝试正常 OCR",
        { reason: error.message }
      );
    }
    startupState.prewarmed = true;
  }
  await waitForGameReady(context, signal);
}

export async function waitForGameReady(context, signal) {
  const { adb, ui, vision, report, config } = context;
  // The login screen and other pre-login overlays are Android UI, not the
  // game's captured-mouse HUD. Use the existing touch path there so the game
  // mouse toggle is only evaluated for post-login game clicks that actually
  // need it.
  const tapBeforeLogin = async (point) => {
    if (typeof ui.androidTouchTap === "function") {
      return ui.androidTouchTap(point, signal);
    }
    // Never fall back to GameUi.tap here: older runtimes made that path
    // summon the in-game mouse and could fail login before the HUD exists.
    if (typeof adb.touchTap === "function") {
      await adb.touchTap(point.x, point.y, signal);
      await ui.afterAction?.(signal);
      return;
    }
    throw new Error(
      "ADB_TOUCH_TAP_UNAVAILABLE: 登录阶段禁止回退到游戏鼠标点击"
    );
  };
  const promotions = {
    maxDismissAttemptsPerPage: 4,
    dismissRetryCooldownMs: 15_000,
    initialWaitMs: 7_000,
    betweenPagesMs: 1_800,
    // Normal promotion pages close from the blank strip below the 1/2/newspaper
    // page indicators, not from the activity page's return arrow.
    dismissPoint: { x: 960, y: 1140 },
    signatureTexts: ["立即前往", "前往查看", "前往活动", "活动时间"],
    activityPageTexts: ["推荐", "活动", "臻藏"],
    activityPageRegion: {
      left: 0,
      top: 0,
      right: 450,
      bottom: 1050
    },
    activityPageMinimumTexts: 3,
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
  const voiceChannelPrompt = {
    enabled: true,
    promptTexts: [
      "可以加入队伍语音频道进行自由沟通",
      "加入队伍语音频道",
      "是否加入"
    ],
    cancelTexts: ["取消(Esc)", "取消（Esc）", "取消"],
    region: { left: 560, top: 300, right: 1360, bottom: 820 },
    cancelPoint: { x: 800, y: 700 },
    keyCode: 111,
    ocrIntervalMs: 1_000,
    maxDismissAttempts: 4,
    ...(promotions.voiceChannelPrompt || {})
  };
  // Reuse the already calibrated bottom-left return tap used by the existing
  // page-closing flow. The activity page is a mis-navigation of the promotion
  // close action, so it must return through that same safe point rather than
  // inventing another coordinate.
  const configuredActivityPageBackAction = Array.isArray(
    config.flows?.closeContribution
  )
    ? config.flows.closeContribution.find(
        (action) =>
          action?.op === "tap" &&
          Number.isFinite(Number(action.x)) &&
          Number.isFinite(Number(action.y))
      )
    : null;
  const configuredActivityPageBackPoint =
    promotions.activityPageBackPoint || configuredActivityPageBackAction;
  const activityPageBackPoint = configuredActivityPageBackPoint
    ? {
        x: Number(configuredActivityPageBackPoint.x),
        y: Number(configuredActivityPageBackPoint.y)
      }
    : { x: 80, y: 1080 };
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
  const postLoginHudTimeoutSeconds = Math.max(
    1,
    Number(config.timeouts.postLoginHudTimeoutSeconds) || 300
  );
  let dismissedPages = 0;
  const promotionDismissAttempts = new Map();
  let newspaperSeen = false;
  let loginClicked = false;
  // Keep the post-login phase active across a relaunch so the healthy-process
  // watchdog cannot extend it indefinitely. A fresh login-button click after
  // a relaunch is allowed to start a fresh five-minute protection window.
  let loginAttempted = false;
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
  let lastReadyDiagnosticsAt = 0;
  let lastVoiceChannelPromptOcrAt = 0;
  let voiceChannelPromptOcrFailureReported = false;
  let voiceChannelPromptDismissAttempts = 0;
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
    await ui.checkForDeathAndRevive?.(signal);
    const loopStartedAt = Date.now();
    let channelProbe = {
      status: "not_needed",
      elapsedMs: 0,
      texts: [],
      matches: [],
      reason: ""
    };
    let frame = await vision.captureTransient("game-login-state", signal);
    let accurateChannelCandidate = false;
    let voicePromptEvidence = findVoiceChannelPromptEvidence(
      vision,
      frame.observations,
      voiceChannelPrompt
    );
    // This prompt is frequently rendered during the transition from the
    // loading HUD to the world HUD. A normal fast full-frame OCR can miss the
    // small centered dialog, so use a bounded accurate reread as a fallback;
    // it is still deterministic text evidence, never a blind click.
    if (
      loginClicked &&
      voiceChannelPrompt.enabled !== false &&
      !voicePromptEvidence.detected &&
      typeof vision.captureSource === "function" &&
      typeof vision.ocrRegion === "function" &&
      Date.now() - lastVoiceChannelPromptOcrAt >=
        Math.max(250, Number(voiceChannelPrompt.ocrIntervalMs) || 1_000)
    ) {
      lastVoiceChannelPromptOcrAt = Date.now();
      try {
        const promptFrame = await vision.captureSource(
          "voice-channel-prompt-source",
          signal
        );
        const promptObservations = await vision.ocrRegion(
          promptFrame.path,
          voiceChannelPrompt.region,
          "voice-channel-prompt-accurate",
          signal,
          "accurate",
          0.08,
          2
        );
        voicePromptEvidence = findVoiceChannelPromptEvidence(
          vision,
          [...frame.observations, ...promptObservations],
          voiceChannelPrompt
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (!voiceChannelPromptOcrFailureReported) {
          voiceChannelPromptOcrFailureReported = true;
          await report(
            "warning",
            "voice_channel_prompt_ocr_unavailable",
            "队伍语音确认框的局部高精度 OCR 暂不可用，将继续用全屏 OCR 识别并等待，不盲目点击",
            { reason: conciseError(error, 500) }
          );
        }
      }
    }
    if (voicePromptEvidence.detected) {
      voiceChannelPromptDismissAttempts += 1;
      const attempt = voiceChannelPromptDismissAttempts;
      const maxAttempts = Math.max(
        1,
        Number(voiceChannelPrompt.maxDismissAttempts) || 4
      );
      const keyCode = Math.max(
        0,
        Number(voiceChannelPrompt.keyCode) || 111
      );
      let action = "escape";
      let keyError = null;
      try {
        await adb.key(keyCode, signal);
        await ui.afterAction(signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        keyError = error;
      }
      // If ESC was rejected or the same confirmed dialog survives one full
      // retry, click the OCR-located cancel button. The fixed fallback point
      // covers the case where OCR sees the prompt text but misses the button.
      if (keyError || attempt >= 2) {
        const cancelPoint = voicePromptEvidence.cancelMatch
          ? center(voicePromptEvidence.cancelMatch)
          : voiceChannelPrompt.cancelPoint;
        if (
          cancelPoint &&
          Number.isFinite(Number(cancelPoint.x)) &&
          Number.isFinite(Number(cancelPoint.y))
        ) {
          action = keyError ? "cancel-fallback" : "cancel-retry";
          await ui.tap(
            { x: Number(cancelPoint.x), y: Number(cancelPoint.y) },
            signal
          );
        }
      }
      await report(
        keyError ? "warning" : "info",
        "voice_channel_prompt_dismiss",
        keyError
          ? `检测到“可以加入队伍语音频道进行自由沟通，是否加入？”但 ESC 发送失败，已点击取消按钮（第 ${attempt}/${maxAttempts} 次）`
          : action === "escape"
            ? `检测到“可以加入队伍语音频道进行自由沟通，是否加入？”，已发送 ESC 选择取消（第 ${attempt}/${maxAttempts} 次）`
            : `队伍语音确认框仍存在，已点击取消按钮（第 ${attempt}/${maxAttempts} 次）`,
        {
          action,
          attempt,
          maxAttempts,
          promptTexts: voicePromptEvidence.promptMatches.map((item) => item.text),
          cancelTexts: voicePromptEvidence.cancelMatches.map((item) => item.text),
          cancelPoint: voicePromptEvidence.cancelMatch
            ? center(voicePromptEvidence.cancelMatch)
            : voiceChannelPrompt.cancelPoint,
          keyError: keyError ? conciseError(keyError, 500) : null
        }
      );
      if (attempt >= maxAttempts) voiceChannelPromptDismissAttempts = 0;
      continue;
    }
    if (voiceChannelPromptDismissAttempts > 0) {
      voiceChannelPromptDismissAttempts = 0;
    }
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
      const channelProbeStartedAt = Date.now();
      channelProbe.status = "running";
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
        channelProbe = {
          status: "success",
          elapsedMs: Date.now() - channelProbeStartedAt,
          texts: channelObservations.map((item) => item.text).slice(0, 12),
          matches: accurateChannelMatches.map((item) => item.text),
          reason: ""
        };
        if (channelAccurateOcrFailureReported) {
          channelAccurateOcrFailureReported = false;
          await report(
            "info",
            "game_ready_channel_accurate_recovered",
            `左下角频道 OCR 已恢复（${channelProbe.elapsedMs}ms）：${channelProbe.matches.join("、") || channelProbe.texts.join(" | ") || "未命中频道词"}`
          );
        }
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
        channelProbe = {
          status: "failed",
          elapsedMs: Date.now() - channelProbeStartedAt,
          texts: [],
          matches: [],
          reason: conciseError(error)
        };
        if (!channelAccurateOcrFailureReported) {
          channelAccurateOcrFailureReported = true;
          await report(
            "warning",
            "game_ready_channel_accurate_unavailable",
            `左下角频道区域高精度 OCR 失败（${channelProbe.elapsedMs}ms）：${channelProbe.reason}；将在短暂冷却后自动重试`,
            { reason: conciseError(error, 500) }
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
    const activityPageMatches = findReadyTextsInRegion(
      vision,
      frame.observations,
      promotions.activityPageTexts,
      promotions.activityPageRegion
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
    const readyBlockingTexts = [
      ...promotions.loadingTexts,
      ...updates.stateTexts,
      ...updates.restartButtonTexts,
      ...announcements.texts,
      "点击登录游戏",
      "登录游戏",
      "明日希望报",
      ...promotions.signatureTexts,
      "加入队伍语音频道"
    ];
    const blockingMatches = readyBlockingTexts.filter((text) =>
      vision.find(frame.observations, text)
    );
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
    const activityPageMinimumTexts = Math.max(
      3,
      Number(promotions.activityPageMinimumTexts) || 3
    );
    const activityPageDetected =
      loginClicked &&
      !ready &&
      !channelHudReady &&
      activityPageMatches.length >= activityPageMinimumTexts;
    const blocksReady =
      blockingMatches.length > 0 ||
      loadingProgressVisible ||
      activityPageDetected;
    if (blocksReady) lastLoadingEvidenceAt = Date.now();
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
      loginClicked &&
      Date.now() - lastReadyDiagnosticsAt >= 10_000
    ) {
      lastReadyDiagnosticsAt = Date.now();
      const health = typeof vision.ocrHealth === "function"
        ? vision.ocrHealth()
        : null;
      const accurateHealth = health?.modes?.accurate;
      const retrySeconds = accurateHealth?.disabledUntil > Date.now()
        ? Math.ceil((accurateHealth.disabledUntil - Date.now()) / 1000)
        : 0;
      const channelSummary = channelReadyMatches.length
        ? channelReadyMatches.map((item) => item.text).join("、")
        : "无";
      const probeSummary = channelProbe.status === "success"
        ? `${channelProbe.elapsedMs}ms / ${channelProbe.matches.join("、") || channelProbe.texts.join(" | ") || "无文字"}`
        : channelProbe.status === "failed"
          ? `${channelProbe.elapsedMs}ms / ${channelProbe.reason}`
          : channelProbe.status;
      const blockSummary = [
        ...blockingMatches,
        ...(loadingProgressVisible ? ["底部登录/加载百分比"] : [])
      ].join("、") || "无";
      const healthSummary = retrySeconds > 0
        ? `冷却 ${retrySeconds}s / ${conciseError(accurateHealth?.reason || "未知错误", 120)}`
        : "可用";
      await report(
        "info",
        "game_ready_probe",
        `HUD 探测：频道锚点=${channelSummary}；频道高精度OCR=${probeSummary}；阻塞=${blockSummary}；登录等待=${postLoginWaitSatisfied ? "完成" : "未完成"}；加载静默=${loadingQuietSatisfied ? "完成" : "未完成"}；连续帧=${readyStreak}；OCR状态=${healthSummary}；本轮=${Date.now() - loopStartedAt}ms`,
        {
          recognizedTexts: frame.observations
            .map((item) => String(item?.text || "").trim())
            .filter(Boolean)
            .slice(0, 120),
          channelMatches: channelReadyMatches.map((item) => item.text),
          accurateChannelTexts: channelProbe.texts?.slice(0, 80) || [],
          accurateChannelMatches: channelProbe.matches || [],
          readyTexts: readyMatches.map((item) => item.text),
          blockingTexts: blockingMatches,
          loadingProgressVisible,
          readyStreak,
          postLoginWaitSatisfied,
          loadingQuietSatisfied
        }
      );
    }
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
        await context.progress?.(0.06, "game_ready");
        await ui.keyIfAnyText(
          voiceChannelPrompt.promptTexts || ["加入队伍语音频道"],
          Number(voiceChannelPrompt.keyCode) || 111,
          signal
        );
        await adb.releaseMouseButton?.(
          Math.round((config.adb.screenWidth || 1920) / 2),
          Math.round((config.adb.screenHeight || 1200) / 2),
          signal
        );
        // The stable HUD is the only unconditional game-mouse toggle point.
        // The lower-right fist icon is diagnostic only: some MuMu/game states
        // do not render it even though keyevent 70 was accepted.
        await ui.summonGameMouseAfterHud?.(
          signal,
          Number(config.adb?.gameMouseHudReleaseAttempts) || 6
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
      await tapBeforeLogin(config.adb.loginButton);
      loginClicked = true;
      loginAttempted = true;
      loginClickedAt = Date.now();
      // Once the gold login button has been clicked, the startup watchdog is
      // no longer allowed to extend itself because the game process is
      // healthy. The only successful terminal state is a stable world HUD
      // after the login and promotion pages have been cleared.
      deadline = loginClickedAt + postLoginHudTimeoutSeconds * 1000;
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
      await tapBeforeLogin(config.adb.loginButton);
      loginClicked = true;
      loginAttempted = true;
      loginClickedAt = Date.now();
      deadline = loginClickedAt + postLoginHudTimeoutSeconds * 1000;
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
      await tapBeforeLogin(announcements.closePoint);
      await ui.afterAction(signal);
    }
    const updateState = updates.enabled
      ? updates.stateTexts.find((text) =>
          vision.find(frame.observations, text)
        )
      : null;
    if (updateState) {
      if (!updateObserved && !loginClicked) {
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
        await tapBeforeLogin(center(restartButton.match));
        await ui.afterAction(signal);
        processMissingSince = null;
        continue;
      }
    }

    // The system announcement can appear both before the login tap and
    // immediately after it. It is still the same top-right-X panel; do not
    // let the post-login promotion fallback send a bottom-safe-area tap.
    const announcement = announcements.enabled && !ready
      ? announcementText
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
      await tapBeforeLogin(announcements.closePoint);
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

    // A promotion close tap can occasionally land on the game's activity
    // center instead of dismissing the overlay. The left navigation's exact
    // “推荐 / 活动 / 臻藏” combination identifies that page; return first,
    // then let the next OCR pass decide whether the real promotion remains.
    const activityPageBackAttempt = activityPageDetected
      ? reservePromotionDismissAttempt("promotion_activity_page")
      : null;
    if (activityPageDetected && activityPageBackAttempt != null) {
      const recognizedTexts = activityPageMatches.map((item) => item.text);
      await report(
        "warning",
        activityPageBackAttempt === 1
          ? "promotion_activity_page_back"
          : "promotion_activity_page_back_retry",
        activityPageBackAttempt === 1
          ? `检测到活动页面左侧“${recognizedTexts.join("/")}”，正在点击左下角返回关闭`
          : `活动页面仍未关闭，正在第 ${activityPageBackAttempt} 次点击左下角返回关闭`,
        {
          recognizedTexts,
          point: activityPageBackPoint,
          attempt: activityPageBackAttempt,
          maxAttempts: promotions.maxDismissAttemptsPerPage
        }
      );
      await ui.tap(activityPageBackPoint, signal);
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
    if (actionableAdvice?.state === "prelogin_announcement") {
      if (announcementClosures < announcements.maxClosures) {
        announcementClosures += 1;
        guardedAdvice = null;
        await report(
          "info",
          "local_model_guarded_announcement",
          "本地模型确认系统公告，正在点击右上角 X 关闭，不使用宣传页底部关闭区域",
          {
            closure: announcementClosures,
            maxClosures: announcements.maxClosures
          }
        );
        await tapBeforeLogin(announcements.closePoint);
        await ui.afterAction(signal);
        continue;
      }
      guardedAdvice = null;
    }
    if (
      loginClicked &&
      ["promotion", "promotion_newspaper"].includes(
        actionableAdvice?.state
      )
    ) {
      const classifiedState = actionableAdvice.state;
      const state = classifiedState;
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
              ["login", "promotion", "promotion_newspaper", "prelogin_announcement", "hud"].includes(
                advice?.state
              )
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
      !loginAttempted &&
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
  if (loginAttempted) {
    const loginAttemptTimestamp = loginClickedAt || lastLoginClickAt;
    await report(
      "error",
      "login_hud_timeout",
      `点击金色登录按钮后 ${postLoginHudTimeoutSeconds} 秒仍未识别到登录完成并稳定的世界 HUD，任务终止`,
      {
        timeoutSeconds: postLoginHudTimeoutSeconds,
        loginClickedAt: new Date(loginAttemptTimestamp).toISOString(),
        dismissedPages
      }
    );
    throw new Error(
      `Timed out waiting for world HUD after login for ${postLoginHudTimeoutSeconds}s`
    );
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
  // Vision may merge adjacent channel tabs into one observation, for example
  // “世界 场景「营地“队伍”. Split only at whitespace/punctuation and require
  // complete tokens. This accepts that real tab row while rejecting substring
  // hits such as “世界观” and “角色场景” in the login legal disclaimer.
  const candidates = bounded.map((item) => ({
    item,
    tokens: new Set(channelLabelTokens(item.text))
  }));
  return texts.flatMap((text) => {
    const expected = normalizeChannelLabel(text);
    const candidate = candidates.find(({ tokens }) => tokens.has(expected));
    return candidate ? [{ text, match: candidate.item }] : [];
  });
}

function findVoiceChannelPromptEvidence(vision, observations, config = {}) {
  const region = config.region;
  const bounded = (Array.isArray(observations) ? observations : []).filter(
    (item) => {
      const centerX = Number(item?.x || 0) + Number(item?.width || 0) / 2;
      const centerY = Number(item?.y || 0) + Number(item?.height || 0) / 2;
      return (
        !region ||
        (centerX >= Number(region.left || 0) &&
          centerX <= Number(region.right || Number.POSITIVE_INFINITY) &&
          centerY >= Number(region.top || 0) &&
          centerY <= Number(region.bottom || Number.POSITIVE_INFINITY))
      );
    }
  );
  const matches = (texts) =>
    (Array.isArray(texts) ? texts : [])
      .map((text) => ({ text, match: vision.find(bounded, text) }))
      .filter((item) => item.match);
  const promptMatches = matches(config.promptTexts);
  const cancelMatches = matches(config.cancelTexts);
  const hasPromptPhrase = promptMatches.some(({ text }) => {
    const value = String(text || "");
    return (
      value.includes("可以加入") ||
      value.includes("加入队伍语音频道") ||
      value.includes("是否加入")
    );
  });
  return {
    detected: hasPromptPhrase || (promptMatches.length > 0 && cancelMatches.length > 0),
    promptMatches,
    cancelMatches,
    promptMatch: promptMatches[0]?.match || null,
    cancelMatch: cancelMatches[0]?.match || null
  };
}

function channelLabelTokens(value) {
  return String(value || "")
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/gu)
    .map(normalizeChannelLabel)
    .filter(Boolean);
}

function normalizeChannelLabel(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

function conciseError(error, limit = 240) {
  const message = String(error?.message || error || "未知错误")
    .replace(/\s+/g, " ")
    .trim();
  return message.length > limit
    ? `${message.slice(0, Math.max(1, limit - 1))}…`
    : message;
}

export async function runWithWatchdog(context, work, parentSignal, watchdog) {
  if (!watchdog.enabled) {
    try {
      return await work(parentSignal);
    } catch (error) {
      if (isTaskRestartRequested(error)) return { restartTask: true };
      throw error;
    }
  }
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
  } catch (error) {
    if (
      isTaskRestartRequested(error) ||
      isTaskRestartRequested(controller.signal.reason)
    ) {
      return { restartTask: true };
    }
    throw error;
  } finally {
    controller.abort(new Error("看门狗结束"));
    parentSignal.removeEventListener("abort", abort);
  }
}

async function monitorGame(context, watchdog, signal) {
  const healthIntervalMs =
    Math.max(0.5, Number(watchdog.healthCheckSeconds) || 10) * 1000;
  const deathIntervalMs =
    Math.max(
      0.5,
      Number(context.config.deathRecovery?.pollSeconds) || 3
    ) * 1000;
  let nextHealthCheck = Date.now() + healthIntervalMs;
  let nextDeathCheck = Date.now() + deathIntervalMs;
  while (!signal.aborted) {
    const waitMs = Math.max(
      1,
      Math.min(nextHealthCheck, nextDeathCheck) - Date.now()
    );
    await delay(waitMs, signal);
    if (Date.now() >= nextDeathCheck) {
      nextDeathCheck = Date.now() + deathIntervalMs;
      const revived = await context.ui?.checkForDeathAndRevive?.(signal);
      if (revived) throw new TaskRestartRequestedError();
    }
    if (Date.now() >= nextHealthCheck) {
      nextHealthCheck = Date.now() + healthIntervalMs;
      const deviceState = await context.adb.state();
      if (deviceState !== "device") {
        throw new Error(`MUMU_DEVICE_${deviceState.toUpperCase()}`);
      }
      const health = await context.adb.gameHealth();
      if (!health.running) throw new Error("GAME_PROCESS_EXITED");
      if (health.anr) throw new Error("GAME_ANR_DETECTED");
    }
  }
}

function isTaskRestartRequested(error) {
  return (
    error?.code === "TASK_RESTART_REQUESTED_AFTER_REVIVAL" ||
    error?.name === "TaskRestartRequestedError" ||
    String(error?.message || error || "").startsWith(
      "TASK_RESTART_REQUESTED_AFTER_REVIVAL:"
    )
  );
}

export function isRecoverableGameFailure(error, health, deviceState = "device") {
  const message = String(error?.message || error || "");
  // Only the watchdog's explicit health failures may restart MuMu.  A
  // workflow-level OCR, validation, or ADB input error must finish the
  // current task and enter its terminal state even if the concurrent health
  // probe happens to report a transiently unhealthy game.
  const watchdogFailure =
    /MUMU_DEVICE_|GAME_PROCESS_EXITED|GAME_ANR_DETECTED|GAME_SCREEN_FROZEN/i.test(
      message
    );
  if (!watchdogFailure) return false;
  if (deviceState !== "device") return true;
  if (health?.anr === true || health?.running === false) return true;
  return /MUMU_DEVICE_|GAME_PROCESS_EXITED|GAME_ANR_DETECTED|GAME_SCREEN_FROZEN/i.test(
    message
  );
}

export function shouldHoldInitialStartup(
  containerReady,
  startupProtectionDeadline,
  now = Date.now()
) {
  return containerReady !== true && now < startupProtectionDeadline;
}
