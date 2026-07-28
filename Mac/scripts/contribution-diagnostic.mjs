import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { MumuLifecycle } from "../src/mumu.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";
import { withGameSession } from "../src/game-session.mjs";
import { captureContribution } from "../src/workflows/member-sync.mjs";
import { normalizeContribution } from "../src/table-parser.mjs";

const config = await loadConfig();
const adb = new AdbClient(config);
const mumu = new MumuLifecycle(config, adb);
const vision = new Vision(config, adb);
const watchdog = {
  enabled: true,
  healthCheckSeconds: 10,
  actionTimeoutSeconds: 45,
  frozenScreenSeconds: 90,
  maxRestarts: 1,
  restartCooldownSeconds: 8
};
const controller = new AbortController();
let contribution = [];
let completed = false;

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    controller.abort(new Error(`Contribution test received ${signalName}`));
  });
}

const report = async (level, step, message, detail = {}) => {
  const safeDetail = { ...detail };
  delete safeDetail.screenshot;
  console.log(
    JSON.stringify({
      event: "contribution_test",
      level,
      step,
      message,
      ...safeDetail
    })
  );
};
const ui = new GameUi(config, adb, vision, report);
ui.setRuntimeAutomation({ gameWatchdog: watchdog });
const context = {
  config,
  adb,
  mumu,
  vision,
  ui,
  report,
  progress: async () => undefined
};

vision.beginTask();
try {
  await withGameSession(
    context,
    async (signal) => {
      const rawRows = await captureContribution(context, signal);
      contribution = normalizeContribution(rawRows);
      if (!contribution.length) {
        throw new Error("Contribution test recognized no member rows");
      }
      completed = true;
    },
    controller.signal,
    watchdog
  );
} finally {
  const removedScreenshots = await vision.cleanupTask();
  const names = new Set(contribution.map((row) => row.name));
  const maximumMaterial = contribution.reduce(
    (maximum, row) => Math.max(maximum, row.materialContribution || 0),
    0
  );
  console.log(
    JSON.stringify({
      event: "contribution_test_result",
      completed,
      rows: contribution.length,
      uniqueNames: names.size,
      duplicateNames: contribution.length - names.size,
      maximumMaterialContribution: maximumMaterial,
      expectedKnownMaximumObserved: maximumMaterial === 17_892_175,
      firstRow: contribution[0] || null,
      lastRow: contribution.at(-1) || null,
      removedScreenshots
    })
  );
}
