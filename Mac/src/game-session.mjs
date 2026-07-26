import { delay } from "./process.mjs";

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
  const { mumu, adb, ui, report, config } = context;
  let started = false;
  try {
    await report("info", "emulator_start", "正在后台启动 MuMu 模拟器");
    started = true;
    await mumu.ensureStarted(signal);

    for (let restartCount = 0; ; restartCount += 1) {
      try {
        await startAndEnterGame(context, signal);
        await runWithWatchdog(context, work, signal, watchdog);
        return;
      } catch (error) {
        if (signal.aborted) throw signal.reason || error;
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
        await report(
          "warning",
          "game_restart",
          `检测到游戏无响应或界面超时，正在结束进程并重启（${restartCount + 1}/${watchdog.maxRestarts}）`,
          { reason: error.message, health }
        );
        await adb.stopGame();
        await delay(watchdog.restartCooldownSeconds * 1000, signal);
      }
    }
  } finally {
    if (started) {
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
    }
  }
}

async function startAndEnterGame(context, signal) {
  const { adb, ui, report, config } = context;
  await report("info", "game_start", "正在启动明日之后");
  await adb.launchGame();
  const ready = await ui.waitAnyText(
    ["登录游戏", "点击登录游戏", "配方", "背包", "营地"],
    { timeoutSeconds: config.timeouts.gameLaunchSeconds },
    signal
  );
  if (ready.text === "登录游戏" || ready.text === "点击登录游戏") {
    await ui.tap(config.adb.loginButton, signal);
    await ui.waitAnyText(
      ["配方", "背包", "营地"],
      { timeoutSeconds: config.timeouts.gameLaunchSeconds },
      signal
    );
  }
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
    const health = await context.adb.gameHealth();
    if (!health.running) throw new Error("GAME_PROCESS_EXITED");
    if (health.anr) throw new Error("GAME_ANR_DETECTED");
  }
}

function isRecoverableGameFailure(error, health) {
  if (health.anr || !health.running) return true;
  return /timed out|timeout|OCR could not find|ADB|GAME_|screencap|无响应/i.test(
    error.message
  );
}
