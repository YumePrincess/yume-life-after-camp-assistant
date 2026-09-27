import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { Vision } from "../src/vision.mjs";
import { GameUi } from "../src/ui.mjs";

const config = await loadConfig();
const adb = new AdbClient(config);
const vision = new Vision(config, adb);
const controller = new AbortController();
const events = [];
const report = async (level, step, message, detail = {}) => {
  const item = { level, step, message, ...detail };
  events.push(item);
  console.log(JSON.stringify({ event: "cityhall_close_current", ...item }));
};
const ui = new GameUi(config, adb, vision, report);
const mapAction = config.flows.teleportCityHall.find(
  (action) => action.op === "teleportWithFallback"
);

for (const signalName of ["SIGINT", "SIGTERM"]) {
  process.on(signalName, () => {
    controller.abort(
      new Error(`City-hall close diagnostic received ${signalName}`)
    );
  });
}

vision.beginTask();
let completed = false;
const startedAt = Date.now();
try {
  await adb.connect();
  await adb.key("KEYCODE_F", controller.signal);
  await ui.waitAnyText(
    ["时代信息", "成员信息", "活动时间管理"],
    { timeoutSeconds: 12 },
    controller.signal
  );
  await ui.executeFlow("openContribution", {}, controller.signal);
  await ui.ensureMapOpen(mapAction, controller.signal);
  const mapFrame = await vision.captureAccurateTransient(
    "cityhall-close-map-open",
    controller.signal
  );
  const mapText = mapAction.mapReadyTexts
    .map((text) => vision.find(mapFrame.observations, text))
    .find(Boolean);
  if (!mapText) {
    throw new Error("CITYHALL_CLOSE_DIAGNOSTIC_MAP_UNVERIFIED");
  }
  await adb.key(41, controller.signal);
  await ui.waitAnyText(
    ["配方", "生存手册", "营地管理"],
    { timeoutSeconds: 12 },
    controller.signal
  );
  completed = true;
} finally {
  const removedScreenshots = await vision.cleanupTask().catch(() => 0);
  console.log(
    JSON.stringify({
      event: "cityhall_close_current_result",
      completed,
      elapsedSeconds: Number(((Date.now() - startedAt) / 1000).toFixed(2)),
      bottomLeftBackClosures: events.filter(
        (item) =>
          item.step === "map_page_closing" &&
          (
            item.visiblePanelText ||
            (Array.isArray(item.sandTableMarkers) &&
              item.sandTableMarkers.length >= 2)
          )
      ).length,
      mapVerified: events.some((item) =>
        ["map_open_verified", "map_open_verified_accurate"].includes(
          item.step
        )
      ),
      removedScreenshots,
      uploaded: false,
      gameAndMumuPreserved: true
    })
  );
}
