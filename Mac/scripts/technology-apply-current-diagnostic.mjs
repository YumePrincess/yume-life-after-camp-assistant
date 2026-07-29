import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";
import {
  clearAllConfiguredSlots,
  selectTechnology
} from "../src/workflows/technology.mjs";

const config = await loadConfig();
const adb = new AdbClient(config);
const vision = new Vision(config, adb);
const controller = new AbortController();
const report = async (level, step, message, detail = {}) => {
  const safeDetail = { ...detail };
  delete safeDetail.screenshot;
  console.log(
    JSON.stringify({
      event: "technology_apply_current",
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
  vision,
  ui,
  report,
  async progress() {}
};

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    controller.abort(
      new Error(`Technology apply diagnostic received ${signalName}`)
    );
  });
}

vision.beginTask();
let completed = false;
let submitted = false;
let plan = null;
const startedAt = Date.now();
try {
  const response = await fetch(
    `${config.server.baseUrl}/api/public/bootstrap?t=${Date.now()}`,
    { signal: controller.signal }
  );
  if (!response.ok) {
    throw new Error(`PUBLIC_BOOTSTRAP_FAILED: HTTP ${response.status}`);
  }
  const bootstrap = await response.json();
  plan = bootstrap?.voteSummary?.projectedPlan;
  if (!plan || !Array.isArray(plan.core) || !Array.isArray(plan.general)) {
    throw new Error("TECHNOLOGY_PROJECTED_PLAN_UNAVAILABLE");
  }
  if (plan.core.length > 6 || plan.general.length > 6) {
    throw new Error(
      `TECHNOLOGY_PROJECTED_PLAN_OVERFLOW: ${plan.core.length}+${plan.general.length}`
    );
  }
  await report(
    "info",
    "technology_plan",
    `使用后台实时预测计划：第一行 ${plan.core.length} 项，第二行 ${plan.general.length} 项`,
    {
      pollDate: bootstrap.voteSummary.pollDate,
      ballotCount: bootstrap.voteSummary.ballotCount,
      core: plan.core.map((item) => item.uiLabel),
      general: plan.general.map((item) => item.uiLabel)
    }
  );
  await adb.connect();
  await clearAllConfiguredSlots(context, controller.signal);

  for (const [lane, technologies] of [
    ["core", plan.core],
    ["general", plan.general]
  ]) {
    for (let index = 0; index < technologies.length; index += 1) {
      await selectTechnology(
        context,
        lane,
        index,
        technologies[index].uiLabel,
        controller.signal
      );
    }
  }

  const allSlots = ["core", "general"].flatMap((lane) =>
    config.technology.slots[lane].map((point, index) => ({
      ...point,
      lane,
      index
    }))
  );
  const finalFrame = await vision.capture(
    "technology-final-slot-verification",
    controller.signal
  );
  const finalProbes = await vision.probe(
    finalFrame.path,
    allSlots,
    config.technology.filledSlotDetection.sampleRadius,
    controller.signal
  );
  const occupied = allSlots.filter((slot, index) =>
    isFilled(
      finalProbes[index],
      config.technology.filledSlotDetection.emptyReference[slot.lane],
      config.technology.filledSlotDetection.maximumEmptyFeatureDistance
    )
  );
  const expected = new Set([
    ...plan.core.map((_item, index) => `core:${index}`),
    ...plan.general.map((_item, index) => `general:${index}`)
  ]);
  const actual = new Set(
    occupied.map((slot) => `${slot.lane}:${slot.index}`)
  );
  if (
    expected.size !== actual.size ||
    [...expected].some((key) => !actual.has(key))
  ) {
    throw new Error(
      `TECHNOLOGY_FINAL_SLOT_MISMATCH: expected=${JSON.stringify(
        [...expected]
      )}, actual=${JSON.stringify([...actual])}`
    );
  }
  await report(
    "info",
    "technology_final_verified",
    "12 个槽位已逐一核对，目标槽位占用且其余槽位为空；允许点击完成",
    {
      expected: [...expected],
      actual: [...actual],
      probes: finalProbes
    }
  );
  await ui.tap(config.technology.tabs.finish, controller.signal);
  submitted = true;
  await ui.waitAnyText(
    ["待生效科技", "当前生效科技", "科技配置"],
    {},
    controller.signal
  );
  completed = true;
} finally {
  const removedScreenshots = await vision.cleanupTask().catch(() => 0);
  console.log(
    JSON.stringify({
      event: "technology_apply_current_result",
      completed,
      submitted,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      core: plan?.core?.map((item) => item.uiLabel) || [],
      general: plan?.general?.map((item) => item.uiLabel) || [],
      removedScreenshots,
      gameAndMumuPreserved: true
    })
  );
}

function isFilled(observed, reference, threshold) {
  if (!observed || !reference) return true;
  const distance = Math.hypot(
    observed.meanRed - reference.meanRed,
    observed.meanGreen - reference.meanGreen,
    observed.meanBlue - reference.meanBlue,
    observed.meanSaturation - reference.meanSaturation,
    observed.luminanceDeviation - reference.luminanceDeviation
  );
  return distance > threshold;
}
