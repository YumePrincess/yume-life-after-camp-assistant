import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";
import { waitForGameReady } from "../src/game-session.mjs";
import {
  countTradingCityKeywordGroups,
  clickTradingCityWeekday,
  prepareTradingCityApplication,
  TRADING_CITY_APPLICATION_CONFIRM_POSITION,
  TRADING_CITY_WEEKDAY_POSITIONS
} from "../src/workflows/trading-city.mjs";

const outputPath = "/private/tmp/yume-life-after-trading-city-weekday-calibration.png";
const applicationFormRegion = { left: 1080, top: 55, right: 1910, bottom: 1140 };
const applicationFormKeywordGroups = [
  ["交易之城竞标申请表"],
  ["成为交易之城日期"],
  ["需求物资确认"],
  ["预估幸福值"],
  ["上周最低值"],
  ["周一"],
  ["周二"],
  ["周三"],
  ["周四"],
  ["周五"],
  ["周六"],
  ["周日"]
];
const continueFromForm = process.env.TRADING_CITY_DIAGNOSTIC_FROM_FORM === "1";
const config = await loadConfig();
const adb = new AdbClient(config);
if (process.env.MRZH_ADB_SERIAL) adb.setSerial(process.env.MRZH_ADB_SERIAL);
const vision = new Vision(config, adb);
const controller = new AbortController();
const report = async (level, step, message, detail = {}) => {
  console.log(JSON.stringify({
    event: "trading_city_current_diagnostic",
    level,
    step,
    message,
    ...detail
  }));
};
const ui = new GameUi(config, adb, vision, report);
ui.setRuntimeAutomation({
  gameWatchdog: {
    actionTimeoutSeconds: 180,
    frozenScreenSeconds: 180
  }
});
const context = { config, adb, vision, ui, report };

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    controller.abort(new Error(`Trading City diagnostic received ${signalName}`));
  });
}

vision.beginTask();
let advisorStarted = false;
try {
  await adb.connect();
  await adb.waitReady(config.mumu.adbReadyTimeoutSeconds, controller.signal);
  await report(
    "info",
    "adb_ready",
    `已连接当前 MuMu Android 实例，ADB ${config.adb.serial}`,
    { serial: config.adb.serial }
  );
  let evidence = {};
  if (continueFromForm) {
    const formVisible = await waitForApplicationForm(vision, controller.signal);
    if (!formVisible) throw new Error("TRADING_CITY_DIAGNOSTIC_CURRENT_FORM_NOT_RECOGNIZED");
    await report("info", "trading_city_existing_form_verified", "已在当前游戏画面识别到竞标申请表，继续执行直接坐标诊断");
  } else {
    advisorStarted = await vision.startAdvisor(controller.signal).catch(async (error) => {
      await report(
        "warning",
        "local_model_unavailable",
        "本地视觉模型不可用，继续使用 OCR 流程",
        { reason: error.message }
      );
      return false;
    });
    await adb.launchGame();
    await waitForGameReady(context, controller.signal);
    evidence = await prepareTradingCityApplication(context, controller.signal);
  }
  await report(
    "warning",
    "trading_city_confirm_position_probe",
    "尚未选择任何报名日期，先实测右下角✅位置；确认申请表仍打开后才继续测试星期坐标"
  );
  await ui.tap(TRADING_CITY_APPLICATION_CONFIRM_POSITION, controller.signal);
  const formStillOpen = await waitForApplicationForm(vision, controller.signal);
  if (!formStillOpen) {
    await report(
      "error",
      "trading_city_confirm_probe_stopped",
      "点击✅后未能再次识别申请表；为避免在其他界面误点星期坐标，诊断脚本已停止",
      { confirmationTriedWithoutDate: true, submitted: "unverified", outputPath }
    );
    throw new Error("TRADING_CITY_DIAGNOSTIC_CONFIRM_PROBE_DID_NOT_KEEP_FORM_OPEN");
  }

  const weekdayPositions = {};
  for (let weekday = 1; weekday <= 7; weekday += 1) {
    weekdayPositions[weekday] = await clickTradingCityWeekday(ui, weekday, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    if (!(await isApplicationFormVisible(
      vision,
      controller.signal,
      `trading-city-weekday-position-${weekday}`
    ))) {
      throw new Error(`TRADING_CITY_DIAGNOSTIC_FORM_LOST_AFTER_WEEKDAY_${weekday}`);
    }
    await report(
      "info",
      "trading_city_weekday_position_tapped",
      `已按顺序实测报名星期坐标：周${["一", "二", "三", "四", "五", "六", "日"][weekday - 1]}`,
      { weekday, position: TRADING_CITY_WEEKDAY_POSITIONS[weekday] }
    );
  }
  await adb.screenshot(outputPath);
  await report(
    "info",
    "trading_city_weekday_calibration_complete",
    "已实测✅位置及周一至周日七个坐标；申请表仍打开，不再执行提交，保留当前游戏现场",
    {
      ...evidence,
      confirmationTriedWithoutDate: true,
      confirmPosition: TRADING_CITY_APPLICATION_CONFIRM_POSITION,
      weekdayPositions,
      finalSelection: 7,
      outputPath,
      submitted: false
    }
  );
} finally {
  await vision.cleanupTask().catch(() => undefined);
  if (advisorStarted) await vision.stopAdvisor().catch(() => undefined);
}

async function waitForApplicationForm(vision, signal) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    if (await isApplicationFormVisible(vision, signal, `trading-city-confirm-position-probe-${attempt}`)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  return false;
}

async function isApplicationFormVisible(vision, signal, label) {
  const frame = await vision.capture(label, signal);
  let observations = frame.observations;
  let keywordCount = countTradingCityKeywordGroups(
    vision,
    observations,
    applicationFormKeywordGroups,
    applicationFormRegion
  );
  if (keywordCount >= 4) return true;

  if (frame.path && typeof vision.ocrRegion === "function") {
    const regional = await vision.ocrRegion(
      frame.path,
      applicationFormRegion,
      `${label}-region`,
      signal,
      "accurate",
      0.18,
      2
    ).catch(() => []);
    observations = [...observations, ...regional];
    keywordCount = countTradingCityKeywordGroups(
      vision,
      observations,
      applicationFormKeywordGroups,
      applicationFormRegion
    );
    if (keywordCount >= 4) return true;
  }

  if (typeof vision.captureAccurateTransient === "function") {
    const accurate = await vision.captureAccurateTransient(`${label}-accurate`, signal).catch(() => null);
    if (accurate) {
      observations = [...observations, ...accurate.observations];
      keywordCount = countTradingCityKeywordGroups(
        vision,
        observations,
        applicationFormKeywordGroups,
        applicationFormRegion
      );
    }
  }
  return keywordCount >= 4;
}
