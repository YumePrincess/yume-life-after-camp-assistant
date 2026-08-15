import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";
import {
  assertContributionComplete,
  capturePagedTable
} from "../src/workflows/member-sync.mjs";
import { normalizeContribution } from "../src/table-parser.mjs";

const config = await loadConfig();
const adb = new AdbClient(config);
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
try {
  await adb.connect();
  advisorStarted = await vision.startAdvisor(controller.signal);
  rows = normalizeContribution(
    await capturePagedTable(
      context,
      "member-contribution-current",
      config.tables.contribution,
      controller.signal
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
      maximumMaterialContribution: maximumMaterial,
      firstRow: rows[0] || null,
      lastRow: rows.at(-1) || null,
      removedScreenshots,
      gameAndMumuPreserved: true
    })
  );
}
