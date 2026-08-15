import assert from "node:assert/strict";
import test from "node:test";
import {
  inferMemberIdentity,
  isPlausibleMemberName,
  parsePopulationCapacity,
  parsePopulationFraction,
  safeSipsCropRegion
} from "../src/vision.mjs";
import { Vision } from "../src/vision.mjs";

test("game-mouse icon detection uses two pixel probes and OCR only as a conservative fallback", async () => {
  const vision = new Vision({
    adb: {
      screenWidth: 1920,
      screenHeight: 1200,
      gameMouseIcon: {
        probePoints: [
          { x: 1728, y: 1000 },
          { x: 1728, y: 1055 }
        ],
        probeRadius: 18,
        luminanceDeviationThreshold: 0.12,
        ocrFallback: {
          texts: ["Space"],
          minimumConfidence: 0.35,
          luminanceDeviationThreshold: 0.08
        }
      }
    },
    vision: {},
    localVisionModel: { enabled: false }
  }, {});
  vision.captureSource = async () => ({ path: "/private/tmp/icon-test.png" });
  vision.ocrRegion = async () => [{ text: "Space", confidence: 1 }];
  let probes = [
    { luminanceDeviation: 0.13 },
    { luminanceDeviation: 0.12 }
  ];
  vision.probe = async () => probes;

  assert.equal(await vision.gameMouseIconVisible(), true);
  probes = [
    { luminanceDeviation: 0.03 },
    { luminanceDeviation: 0.04 }
  ];
  assert.equal(await vision.gameMouseIconVisible(), false);
  probes = [
    { luminanceDeviation: 0.09 },
    { luminanceDeviation: 0.08 }
  ];
  assert.equal(await vision.gameMouseIconVisible(), true);
});

test("C icon state uses warm-color pixels to distinguish lit from dim", async () => {
  const vision = new Vision({
    adb: {
      gameMouseCIcon: {
        probePoints: [
          { x: 1865, y: 1130 },
          { x: 1848, y: 1130 },
          { x: 1882, y: 1130 }
        ],
        minimumLitPoints: 2,
        redBlueDelta: 0.08,
        greenBlueDelta: 0.03,
        minimumSaturation: 0.15
      }
    },
    vision: {},
    localVisionModel: { enabled: false }
  }, {});
  vision.captureSource = async () => ({ path: "/private/tmp/c-icon-test.png" });
  vision.probe = async () => [
    { meanRed: 0.59, meanGreen: 0.49, meanBlue: 0.38, meanSaturation: 0.27 },
    { meanRed: 0.59, meanGreen: 0.49, meanBlue: 0.39, meanSaturation: 0.26 },
    { meanRed: 0.66, meanGreen: 0.63, meanBlue: 0.62, meanSaturation: 0.10 }
  ];
  assert.equal(await vision.gameMouseCIconLit(), true);

  vision.probe = async () => [
    { meanRed: 0.66, meanGreen: 0.63, meanBlue: 0.62, meanSaturation: 0.10 },
    { meanRed: 0.58, meanGreen: 0.52, meanBlue: 0.50, meanSaturation: 0.16 },
    { meanRed: 0.60, meanGreen: 0.58, meanBlue: 0.59, meanSaturation: 0.11 }
  ];
  assert.equal(await vision.gameMouseCIconLit(), false);
});

test("C icon background contamination is not treated as yellow", async () => {
  const vision = new Vision({
    adb: {
      gameMouseCIcon: {
        probePoints: [
          { x: 1865, y: 1130 },
          { x: 1848, y: 1130 },
          { x: 1882, y: 1130 }
        ],
        minimumLitPoints: 2,
        redBlueDelta: 0.08,
        greenBlueDelta: 0.07,
        minimumSaturation: 0.20
      }
    },
    vision: {},
    localVisionModel: { enabled: false }
  }, {});
  vision.captureSource = async () => ({ path: "/private/tmp/c-icon-warm-scene.png" });
  vision.probe = async () => [
    { meanRed: 0.66, meanGreen: 0.60, meanBlue: 0.51, meanSaturation: 0.17 },
    { meanRed: 0.63, meanGreen: 0.57, meanBlue: 0.48, meanSaturation: 0.18 },
    { meanRed: 0.70, meanGreen: 0.63, meanBlue: 0.56, meanSaturation: 0.19 }
  ];
  assert.equal(await vision.gameMouseCIconLit(), false);
});

test("member table OCR starts at the identity column and excludes avatar artwork", async () => {
  const vision = new Vision({
    adb: { screenWidth: 1920, screenHeight: 1200 },
    vision: { mode: "fast", memberTableTimeoutSeconds: 2 },
    localVisionModel: { enabled: false }
  }, {});
  let ocrRegion = null;
  vision.captureSource = async () => ({ path: "/private/tmp/member-table.png" });
  vision.ocrRegion = async (_path, region) => {
    ocrRegion = region;
    return [];
  };

  const frame = await vision.captureTable("member-details", {
    region: { left: 115, top: 285, right: 1800, bottom: 780 },
    columns: [
      { key: "identity", left: 0.08, right: 0.318 },
      { key: "profession", left: 0.318, right: 0.46 },
      { key: "manorLevel", left: 0.555, right: 0.65 },
      { key: "onlineState", left: 0.65, right: 0.745 },
      { key: "roommateName", left: 0.858, right: 1 }
    ]
  });

  assert.equal(frame.path, "/private/tmp/member-table.png");
  assert.equal(ocrRegion.left, 249.8);
  assert.equal(ocrRegion.right, 1800);
});

test("member identity keeps the first OCR line as the player name", () => {
  assert.deepEqual(
    inferMemberIdentity([
      { text: "青在\n营地助手", x: 100, y: 300 },
      { text: "称号", x: 100, y: 335 }
    ]),
    { name: "青在", campTitle: "营地助手 称号" }
  );
  assert.equal(isPlausibleMemberName("COSGH"), false);
  assert.equal(isPlausibleMemberName("青在✨"), true);
  assert.equal(isPlausibleMemberName("✨"), true);
  assert.equal(isPlausibleMemberName("#"), true);
});

test("macOS 27 bottom-edge crops shift inward instead of silently returning the full frame", () => {
  assert.deepEqual(
    safeSipsCropRegion(
      { left: 0, top: 980, right: 760, bottom: 1200 },
      1920,
      1200
    ),
    { left: 0, top: 979, width: 760, height: 220, adjusted: true }
  );
  assert.deepEqual(
    safeSipsCropRegion(
      { left: 100, top: 200, right: 500, bottom: 600 },
      1920,
      1200
    ),
    { left: 100, top: 200, width: 400, height: 400, adjusted: false }
  );
});

test("parses total members from the fraction denominator", () => {
  assert.equal(
    parsePopulationCapacity(
      [{ text: "9/96", x: 350 }, { text: "（", x: 420 }],
      110
    ),
    96
  );
  assert.equal(
    parsePopulationCapacity([{ text: "102/110", x: 350 }], 110),
    110
  );
  assert.deepEqual(
    parsePopulationFraction([{ text: "4/93", x: 350 }], 110, {
      minimumCapacity: 1
    }),
    { current: 4, capacity: 93 }
  );
  assert.deepEqual(
    parsePopulationFraction([{ text: "0/0", x: 490 }], 10, {
      minimumCapacity: 0
    }),
    { current: 0, capacity: 0 }
  );
});

test("member header total accepts 0/0 sailing citizens without fallback contamination", async () => {
  const vision = new Vision({
    vision: {},
    localVisionModel: { enabled: false }
  }, {});
  vision.capture = async () => ({ path: "/private/tmp/member-header.png" });
  vision.ocrRegion = async (_path, _region, label) =>
    label.startsWith("member-count-")
      ? [{ text: "4/93", x: 350 }]
      : [{ text: "0/0", x: 490 }];

  assert.deepEqual(await vision.readMemberExpectedBreakdown(), {
    formalCurrent: 4,
    formalTotal: 93,
    sailingCurrent: 0,
    sailingTotal: 0,
    total: 93
  });
  assert.equal(await vision.readMemberExpectedTotal(), 93);
});

test("accepts zero online citizens and split OCR fragments", () => {
  assert.equal(
    parsePopulationCapacity(
      [
        { text: "0/", x: 475 },
        { text: "5（", x: 500 }
      ],
      10
    ),
    5
  );
  assert.equal(
    parsePopulationCapacity([{ text: "6／10", x: 475 }], 10),
    10
  );
});

test("rejects icon-contaminated and impossible counts", () => {
  assert.equal(
    parsePopulationCapacity([{ text: "全部成员89/96", x: 100 }], 10),
    null
  );
  assert.equal(
    parsePopulationCapacity([{ text: "12/10", x: 475 }], 10),
    null
  );
});
