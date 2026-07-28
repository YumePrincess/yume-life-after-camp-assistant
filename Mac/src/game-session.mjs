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
        return;
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
  } finally {
    if (started) {
      if (gameReady && config.mumu.returnToCenterAfterTask !== false) {
        await returnToCenterExit(context);
      }
      await report("info", "game_stop", "正在关闭游戏进程").catch(() => undefined);
      await adb.stopGame();
      if (config.mumu.stopEmulatorAfterTask) {
        await report(
          "info",
          "emulator_stop",
          "任务已结束，正在停止 MuMu 以节约资源和能耗"
        ).catch(() => undefined);
        await mumu.stopAfterTask();
      }
      if (advisorStarted) {
        await report(
          "info",
          "local_model_stop",
          "任务已结束，正在释放本地视觉模型内存"
        ).catch(() => undefined);
        await vision.stopAdvisor().catch(() => undefined);
      }
    }
  }
}

async function returnToCenterExit(context) {
  const { adb, ui, report, config } = context;
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
    return;
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
  } catch (error) {
    await report(
      "warning",
      "return_center_failed",
      "中心出入口收尾传送失败，将继续关闭游戏与模拟器",
      { reason: error.message }
    ).catch(() => undefined);
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
    closePoint: { x: 1742, y: 155 },
    texts: ["系统公告", "更新公告", "游戏公告"],
    ...config.preLoginAnnouncements
  };
  let deadline = Date.now() + config.timeouts.gameLaunchSeconds * 1000;
  let dismissedPages = 0;
  let newspaperSeen = false;
  let loginClicked = false;
  let lastLoginClickAt = 0;
  let updateObserved = false;
  let lastUpdateState = "";
  let lastUpdateReportAt = 0;
  let lastProcessCheckAt = 0;
  let processMissingSince = null;
  let updateRestartCount = 0;
  let announcementClosures = 0;
  let lastAdviceAt = 0;
  let lastAdviceSignature = "";
  let repeatedAdvice = 0;
  let advisorFailureReported = false;
  while (Date.now() < deadline) {
    const frame = await vision.captureTransient("game-login-state", signal);
    const ready = promotions.readyTexts.find((text) =>
      vision.find(frame.observations, text)
    );
    if (ready) {
      await report(
        "info",
        "game_ready",
        dismissedPages
          ? `游戏界面已就绪，已关闭 ${dismissedPages} 张活动宣传页`
          : "游戏界面已就绪，未出现活动宣传页"
      );
      await ui.keyIfAnyText(["加入队伍语音频道"], 111, signal);
      return;
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
      vision.advisor?.enabled &&
      Date.now() - lastAdviceAt >=
        Math.max(2, Number(advisorConfig.intervalSeconds) || 8) * 1000
    ) {
      lastAdviceAt = Date.now();
      try {
        const advice = await vision.adviseCurrent(
          "game-login-advisor",
          {
            loginClicked,
            ocrTexts: frame.observations.map((item) => item.text)
          },
          signal
        );
        const signature = advice
          ? `${advice.state}:${advice.action}`
          : "";
        repeatedAdvice = signature && signature === lastAdviceSignature
          ? repeatedAdvice + 1
          : 1;
        lastAdviceSignature = signature;
        await report(
          "info",
          "local_model_classification",
          `本地模型只读记录候选画面 ${advice?.state || "unknown"}，不会点击或推动任务流程`,
          {
            ...advice,
            repeatedAdvice,
            accepted: false,
            executionMode: "shadow"
          }
        );
      } catch (error) {
        if (!advisorFailureReported) {
          advisorFailureReported = true;
          await report(
            "warning",
            "local_model_request_failed",
            "本地模型请求失败，本次登录继续使用 OCR 规则",
            { reason: error.message }
          );
        }
      }
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
        dismissedPages = 0;
        newspaperSeen = false;
        continue;
      }
    }

    await delay(800, signal);
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
  return /timed out|timeout|OCR could not find|ADB|GAME_|MUMU_DEVICE_|screencap|无响应/i.test(
    error.message
  );
}
