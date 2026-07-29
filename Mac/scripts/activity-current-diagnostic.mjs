import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { Vision } from "../src/vision.mjs";
import {
  reconcilePageRows,
  selectActivityWarningRows
} from "../src/workflows/member-sync.mjs";
import { normalizeActivity } from "../src/table-parser.mjs";
import { delay } from "../src/process.mjs";

const config = await loadConfig();
const adb = new AdbClient(config);
const vision = new Vision(config, adb);
const controller = new AbortController();
const definition = config.tables.activity;
const minimumInactiveDays = Math.max(
  1,
  Number(process.env.MRZH_ACTIVITY_DAYS) || 1
);

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    controller.abort(
      new Error(`Current activity diagnostic received ${signalName}`)
    );
  });
}

async function readPage(label) {
  const frame = await vision.capture(label, controller.signal);
  const rows = await vision.extractTableRows(
    frame.path,
    definition,
    label,
    controller.signal
  );
  return normalizeActivity(rows);
}

vision.beginTask();
let firstPage = [];
let secondPage = [];
let restoredPage = [];
let restored = false;
const startedAt = Date.now();
try {
  await adb.connect();
  firstPage = await readPage("activity-current-page-1");
  const firstSelection = selectActivityWarningRows(
    firstPage.map((row) => ({
      name: row.name,
      onlineState: row.lastActiveText
    })),
    minimumInactiveDays
  );
  console.log(
    JSON.stringify({
      event: "activity_current_first_page",
      visibleRows: firstPage.length,
      warningRows: firstSelection.rows.length,
      thresholdBoundaryReached: firstSelection.reachedBoundary,
      rows: firstPage
    })
  );

  await adb.mouseSwipe(
    definition.pagination.from,
    definition.pagination.to,
    definition.pagination.durationMs,
    controller.signal
  );
  await delay(1_000, controller.signal);
  secondPage = await readPage("activity-current-page-2");
  const reconciledSecond = reconcilePageRows(
    firstPage.map(toRawActivity),
    secondPage.map(toRawActivity)
  );
  const firstNames = new Set(firstPage.map((row) => row.name));
  const overlap = reconciledSecond
    .map((row) => row.name)
    .filter((name) => firstNames.has(name));
  console.log(
    JSON.stringify({
      event: "activity_current_second_page",
      visibleRows: secondPage.length,
      overlapRows: overlap.length,
      overlap,
      uniqueAfterTwoPages: new Set([
        ...firstPage.map((row) => row.name),
        ...reconciledSecond.map((row) => row.name)
      ]).size,
      rows: secondPage
    })
  );

  await adb.mouseSwipe(
    definition.pagination.to,
    definition.pagination.from,
    definition.pagination.durationMs,
    controller.signal
  );
  await delay(1_000, controller.signal);
  restoredPage = await readPage("activity-current-restored");
  restored =
    Boolean(firstPage[0]?.name) &&
    restoredPage.some((row) => row.name === firstPage[0].name);
} finally {
  const removedScreenshots = await vision.cleanupTask().catch(() => 0);
  console.log(
    JSON.stringify({
      event: "activity_current_test_result",
      completed:
        firstPage.length > 0 &&
        selectActivityWarningRows(
          firstPage.map(toRawActivity),
          minimumInactiveDays
        ).rows.length > 0,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      firstPageRows: firstPage.length,
      warningRows: selectActivityWarningRows(
        firstPage.map(toRawActivity),
        minimumInactiveDays
      ).rows.length,
      secondPageRows: secondPage.length,
      restored,
      restoredFirstRow: restoredPage[0] || null,
      removedScreenshots,
      uploaded: false,
      gameAndMumuPreserved: true
    })
  );
}

function toRawActivity(row) {
  return {
    name: row.name,
    onlineState: row.lastActiveText
  };
}
