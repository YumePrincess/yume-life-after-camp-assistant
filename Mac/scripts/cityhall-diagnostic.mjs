import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { MumuLifecycle } from "../src/mumu.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";
import { waitForGameReady } from "../src/game-session.mjs";

const outputPath = "/tmp/yume-life-after-cityhall-diagnostic.png";
const config = await loadConfig();
const adb = new AdbClient(config);
const mumu = new MumuLifecycle(config, adb);
const vision = new Vision(config, adb);
const controller = new AbortController();
const report = async (level, step, message, detail = {}) => {
  console.log(
    JSON.stringify({
      event: "cityhall_diagnostic",
      level,
      step,
      message,
      ...detail
    })
  );
};
const ui = new GameUi(config, adb, vision, report);
ui.setRuntimeAutomation({
  gameWatchdog: {
    actionTimeoutSeconds: 180,
    frozenScreenSeconds: 180
  }
});
const context = { config, adb, mumu, vision, ui, report };

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    controller.abort(new Error(`City hall diagnostic received ${signalName}`));
  });
}

vision.beginTask();
let advisorStarted = false;
try {
  advisorStarted = await vision.startAdvisor(controller.signal).catch(
    async (error) => {
      await report(
        "warning",
        "local_model_unavailable",
        "本地模型不可用，继续使用确定性流程",
        { reason: error.message }
      );
      return false;
    }
  );
  await mumu.ensureStarted(controller.signal);
  await adb.launchGame();
  await waitForGameReady(context, controller.signal);
  await ui.executeFlow("teleportCityHall", {}, controller.signal);
  await adb.screenshot(outputPath);
  await report(
    "info",
    "cityhall_capture_ready",
    "已传送到市政厅并停止后续点击；保留游戏与 MuMu 现场",
    { outputPath }
  );
} finally {
  await vision.cleanupTask().catch(() => undefined);
  if (advisorStarted) {
    await vision.stopAdvisor().catch(() => undefined);
  }
}
