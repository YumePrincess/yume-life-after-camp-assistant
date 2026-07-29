import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { MumuLifecycle } from "../src/mumu.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";
import { waitForGameReady } from "../src/game-session.mjs";

const outputPath = "/tmp/yume-life-after-technology-config.png";
const config = await loadConfig();
const adb = new AdbClient(config);
const mumu = new MumuLifecycle(config, adb);
const vision = new Vision(config, adb);
const controller = new AbortController();
const report = async (level, step, message, detail = {}) => {
  const safeDetail = { ...detail };
  delete safeDetail.screenshot;
  console.log(
    JSON.stringify({
      event: "technology_current_diagnostic",
      level,
      step,
      message,
      ...safeDetail
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
const context = {
  config,
  adb,
  mumu,
  vision,
  ui,
  report,
  positionIndependent: true
};
const useCurrentHud = process.argv.includes("--current");

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    controller.abort(
      new Error(`Technology diagnostic received ${signalName}`)
    );
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
  if (useCurrentHud) {
    await adb.connect();
    await report(
      "info",
      "technology_current_hud",
      "使用当前已登录 HUD 现场，不重启游戏或执行传送"
    );
  } else {
    await mumu.ensureStarted(controller.signal);
    await adb.launchGame();
    await waitForGameReady(context, controller.signal);
  }
  await ui.executeFlow("openCampPanel", {}, controller.signal);
  await ui.tap(config.technology.tabs.technology, controller.signal);
  await ui.waitAnyText(
    ["待生效科技", "科技配置"],
    {},
    controller.signal
  );
  await ui.tap(config.technology.tabs.pending, controller.signal);
  await ui.tap(config.technology.tabs.configure, controller.signal);
  await ui.waitAnyText(
    ["科技配置", "卸下", "完成"],
    {},
    controller.signal
  );
  await adb.screenshot(outputPath);
  await report(
    "info",
    "technology_config_ready",
    "已打开科技配置页面并停止后续点击；未卸下、安装或提交任何科技",
    { outputPath }
  );
} finally {
  await vision.cleanupTask().catch(() => undefined);
  if (advisorStarted) {
    await vision.stopAdvisor().catch(() => undefined);
  }
}
