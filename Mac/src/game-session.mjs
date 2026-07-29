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
        const health = await adb.gameHealth().catch(() => ({
          running: false,
          anr: false,
          detail: ""
        }));
        const canRestart =
          watchdog.enabled &&
          restartCount < watchdog.maxRestarts &&
          isRecoverableGameFailure(error, health);
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
            `检测到游戏无响应或界面超时，正在结束进程并重启游戏（${restartCount + 1}/${watchdog.maxRestarts}）`,
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
    maxPages: 2,
    initialWaitMs: 7_000,
    betweenPagesMs: 1_800,
    dismissPoint: { x: 960, y: 1135 },
    readyTexts: ["配方", "背包", "营地"],
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
    texts: ["系统公告", "更新公告", "游戏公告"],
    ...config.preLoginAnnouncements
  };
  let deadline = Date.now() + config.timeouts.gameLaunchSeconds * 1000;
  let dismissedPages = 0;
  let newspaperSeen = false;
  let loginClicked = false;
  let loginClickedAt = 0;
  let lastLoginClickAt = 0;
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
  let lastAccurateOcrAt = Date.now();
  let readyStreak = 0;
  let readySince = 0;
  let readyStabilizingReported = false;
  let lastLoadingEvidenceAt = 0;
  while (Date.now() < deadline) {
    let frame = await vision.captureTransient("game-login-state", signal);
    const blockingStateTexts = [
      ...announcements.texts,
      ...updates.stateTexts,
      ...updates.restartButtonTexts,
      ...promotions.loadingTexts,
      "点击登录游戏",
      "登录游戏",
      "明日希望报",
      "加入队伍语音频道"
    ];
    const fastReadyCount = promotions.readyTexts.filter((text) =>
      vision.find(frame.observations, text)
    ).length;
    const fastMatchedKnownState =
      fastReadyCount >=
        Math.max(1, Number(promotions.readyMinimumTexts) || 2) ||
      blockingStateTexts.some((text) =>
        vision.find(frame.observations, text)
      );
    const accurateFallbackMs =
      Math.max(
        0.05,
        Number(config.vision?.accurateFallbackSeconds) || 5
      ) * 1000;
    if (
      !fastMatchedKnownState &&
      config.vision?.accurateFallbackEnabled !== false &&
      typeof vision.captureAccurateTransient === "function" &&
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
    const ready = readyMatches[0]?.text || null;
    const loadingProgressVisible = frame.observations.some((item) => {
      const text = String(item.text || "").replace(/\s+/g, "");
      return (
        /^(?:100|[0-9]{1,2})(?:\.[0-9]+)?[%％]$/.test(text) ||
        /(?:加载|登录|进入|场景|资源).{0,12}(?:100|[0-9]{1,2})(?:\.[0-9]+)?[%％]/.test(
          text
        )
      );
    });
    const blocksReady = [
      ...promotions.loadingTexts,
      ...updates.stateTexts,
      ...updates.restartButtonTexts,
      ...announcements.texts,
      "点击登录游戏",
      "登录游戏",
      "明日希望报",
      "加入队伍语音频道"
    ].some((text) => vision.find(frame.observations, text)) ||
      loadingProgressVisible;
    if (blocksReady) lastLoadingEvidenceAt = Date.now();
    const readyMinimumTexts = Math.max(
      1,
      Number(promotions.readyMinimumTexts) || 2
    );
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
      readyMatches.length >= readyMinimumTexts &&
      !blocksReady &&
      postLoginWaitSatisfied &&
      loadingQuietSatisfied
    ) {
      readyStreak += 1;
      readySince ||= Date.now();
      const configuredStableFrames = Number(promotions.readyStableFrames);
      const configuredStableMs = Number(promotions.readyStableMs);
      const stableFrames = Math.max(
        1,
        Number.isFinite(configuredStableFrames) ? configuredStableFrames : 3
      );
      const stableMs = Math.max(
        0,
        Number.isFinite(configuredStableMs) ? configuredStableMs : 3_000
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
              readyTexts: readyMatches.map((item) => item.text),
              postLoginWaitMs,
              loadingQuietMs
            }
          );
        }
      } else {
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
      announcementCloseAttempts < maxFixedCloseAttempts &&
      Date.now() - lastAnnouncementCloseAt >=
        fixedAnnouncementCloseIntervalMs
    ) {
      announcementCloseAttempts += 1;
      lastAnnouncementCloseAt = Date.now();
      await report(
        "info",
        "prelogin_announcement_fixed_close",
        "当前尚未识别到登录、加载或 HUD，正在尝试关闭登录前未知公告",
        { attempt: announcementCloseAttempts, maxFixedCloseAttempts }
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

    const login = ["点击登录游戏", "登录游戏"]
      .map((text) => ({ text, match: vision.find(frame.observations, text) }))
      .find((item) => item.match);
    if (login && Date.now() - lastLoginClickAt >= 5_000) {
      await ui.tap(config.adb.loginButton, signal);
      loginClicked = true;
      loginClickedAt = Date.now();
      lastLoginClickAt = Date.now();
      dismissedPages = 0;
      newspaperSeen = false;
      continue;
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
    if (
      newspaper &&
      dismissedPages < promotions.maxPages
    ) {
      newspaperSeen = true;
      dismissedPages += 1;
      await report(
        "info",
        "promotion_newspaper_dismiss",
        "识别到《明日希望报》宣传页，正在点击底部安全区域关闭"
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

    const advisorConfig = vision.advisor?.config;
    if (
      unknownRecoveryRequested &&
      !unknownRecoveryAttempted &&
      !context.positionIndependent
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
    const actionableAdvice =
      advisorConfig?.mode === "guarded" &&
      guardedAdvice &&
      Date.now() - guardedAdvice.acceptedAt <=
        Math.max(
          2,
          Number(advisorConfig.maxAdviceAgeSeconds) || 8
        ) * 1000
        ? guardedAdvice
        : null;
    if (actionableAdvice?.state === "hud") {
      guardedAdvice = null;
      await report(
        "info",
        "local_model_guarded_hud",
        "本地模型以连续极高置信度确认 HUD；仍等待 OCR 连续稳定后再开始任务点击"
      );
    }
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
      newspaperSeen = false;
      continue;
    }
    if (
      loginClicked &&
      dismissedPages < promotions.maxPages &&
      ["promotion", "promotion_newspaper"].includes(actionableAdvice?.state)
    ) {
      const state = actionableAdvice.state;
      guardedAdvice = null;
      dismissedPages += 1;
      newspaperSeen ||= state === "promotion_newspaper";
      await report(
        "info",
        "local_model_guarded_promotion",
        "本地模型以高置信度确认登录后宣传页，正在点击已校准的底部关闭区域",
        { state, dismissedPages }
      );
      await ui.tap(promotions.dismissPoint, signal);
      await ui.afterAction(signal);
      continue;
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
            advisorConfig.mode === "guarded" &&
            ["login", "promotion", "promotion_newspaper", "hud"].includes(
              advice?.state
            ) &&
            Number(advice?.confidence) >=
              Math.max(
                0.9,
                Number(advisorConfig.minimumActionConfidence) || 0.95
              ) &&
            repeatedAdvice >=
              Math.max(
                1,
                Number(advisorConfig.consecutiveMatches) || 1
              );
          if (guardedCandidate) {
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
              accepted: guardedCandidate,
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

function isRecoverableGameFailure(error, health) {
  if (health.anr || !health.running) return true;
  return /ADB|GAME_PROCESS_EXITED|GAME_ANR|MUMU_DEVICE_|screencap|无响应/i.test(
    error.message
  );
}
