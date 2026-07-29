import { loadConfig } from "../src/config.mjs";
import { AdbClient } from "../src/adb.mjs";
import { Vision } from "../src/vision.mjs";

const config = await loadConfig();
const adb = new AdbClient(config);
const vision = new Vision(config, adb);
const controller = new AbortController();
const mapAction = config.flows.teleportCityHall.find(
  (action) => action.op === "teleportWithFallback"
);

vision.beginTask();
let match = null;
try {
  await adb.connect();
  const frame = await vision.captureAccurate(
    "map-current-verification",
    controller.signal
  );
  match = mapAction.mapReadyTexts
    .map((text) => vision.find(frame.observations, text))
    .find(Boolean);
  if (!match) {
    throw new Error(
      `CURRENT_MAP_UNVERIFIED: OCR=${JSON.stringify(
        frame.observations.map((item) => ({
          text: item.text,
          confidence: item.confidence
        }))
      )}`
    );
  }
} finally {
  const removedScreenshots = await vision.cleanupTask().catch(() => 0);
  console.log(
    JSON.stringify({
      event: "map_current_test_result",
      completed: Boolean(match),
      matchedText: match?.text || null,
      confidence: match?.confidence || null,
      removedScreenshots,
      uploaded: false,
      gameAndMumuPreserved: true
    })
  );
}
