import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { MumuLifecycle } from "../src/mumu.mjs";
import { Vision } from "../src/vision.mjs";
import { delay } from "../src/process.mjs";
import { GameUi } from "../src/ui.mjs";
import {
  assertContributionComplete,
  capturePagedTable
} from "../src/workflows/member-sync.mjs";
import { normalizeContribution } from "../src/table-parser.mjs";

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
      event: "contribution_current_test",
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
const context = { config, adb, vision, ui, report };

async function resetContributionTableToTop(definition, signal) {
  const pagination = definition?.pagination || {};
  const from = pagination.from;
  const to = pagination.to;
  if (!from || !to) {
    throw new Error("CONTRIBUTION_RESET_NOT_CALIBRATED: missing pagination endpoints");
  }
  // The diagnostic may be launched while the game is still on the last page
  // from a previous run. Reverse the calibrated page gesture enough times to
  // reach the list origin. Extra reverse swipes are harmless at the first
  // page, and avoid using OCR to guess the current page before the scan.
  const expectedPages = Math.ceil(
    Math.min(120, Math.max(1, Number(process.env.MRZH_EXPECTED_MEMBER_COUNT) || 101)) /
      Math.max(1, Number(pagination.rowsPerPage) || 11)
  );
  const swipeCount = Math.max(
    expectedPages + 2,
    Math.min(24, Number(pagination.maxPages) || 11) + 1
  );
  const durationMs = Math.max(
    300,
    Math.round((Number(pagination.durationMs) || 1_000) * 0.6)
  );
  const settleMs = 450;
  await report(
    "info",
    "contribution_reset_to_top",
    `扫描前将贡献列表回到第一页，最多反向翻页 ${swipeCount} 次`
  );
  for (let index = 0; index < swipeCount; index += 1) {
    if (signal?.aborted) throw signal.reason || new Error("Interrupted");
    await adb.mouseSwipe(to, from, durationMs, signal);
    await delay(settleMs, signal);
  }
  await report(
    "info",
    "contribution_reset_to_top_done",
    `贡献列表已完成起点复位，共执行 ${swipeCount} 次反向翻页`
  );
}

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    controller.abort(
      new Error(`Current contribution test received ${signalName}`)
    );
  });
}

vision.beginTask();
let advisorStarted = false;
let rows = [];
let completed = false;
const startedAt = Date.now();
const expectedCount = Math.max(
  1,
  Number(process.env.MRZH_EXPECTED_MEMBER_COUNT) || 101
);
try {
  const instance = await mumu.resolveInstance(controller.signal, { refresh: true });
  await adb.waitReady(config.mumu.adbReadyTimeoutSeconds, controller.signal);
  await report(
    "info",
    "mumu_instance_resolved",
    `已连接 MuMu 实例 ${instance.name}(${instance.index})，ADB ${config.adb.serial}`,
    { instance: instance.name, index: instance.index, serial: config.adb.serial }
  );
  await adb.connect();
  await resetContributionTableToTop(config.tables.contribution, controller.signal);
  advisorStarted = await vision.startAdvisor(controller.signal);
  rows = normalizeContribution(
    await capturePagedTable(
      context,
      "member-contribution-current",
      config.tables.contribution,
      controller.signal,
      { expectedCount }
    )
  );
  assertContributionComplete(rows, config.tables.contribution);
  completed = true;
} finally {
  const removedScreenshots = await vision.cleanupTask().catch(() => 0);
  if (advisorStarted) {
    await vision.stopAdvisor().catch(() => undefined);
  }
  const maximumMaterial = rows.reduce(
    (maximum, row) =>
      Math.max(maximum, Number(row.materialContribution) || 0),
    0
  );
  console.log(
    JSON.stringify({
      event: "contribution_current_test_result",
      completed,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      rows: rows.length,
      uniqueNames: new Set(rows.map((row) => row.name)).size,
      expectedCount,
      maximumMaterialContribution: maximumMaterial,
      firstRow: rows[0] || null,
      lastRow: rows.at(-1) || null,
      removedScreenshots,
      gameAndMumuPreserved: true
    })
  );
}
