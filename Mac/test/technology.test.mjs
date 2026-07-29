import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAllConfiguredSlots,
  selectTechnology,
  verifyFinalConfiguredSlots
} from "../src/workflows/technology.mjs";

const emptyCore = {
  meanRed: 0.3,
  meanGreen: 0.4,
  meanBlue: 0.3,
  meanSaturation: 0.2,
  luminanceDeviation: 0.07
};
const emptyGeneral = {
  meanRed: 0.3,
  meanGreen: 0.3,
  meanBlue: 0.3,
  meanSaturation: 0.02,
  luminanceDeviation: 0.15
};
const filled = {
  meanRed: 0.8,
  meanGreen: 0.1,
  meanBlue: 0.1,
  meanSaturation: 0.9,
  luminanceDeviation: 0.4
};

test("every occupied technology slot is selected and unloaded separately", async () => {
  const taps = [];
  let probeCall = 0;
  const context = {
    config: technologyConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    vision: {
      async capture(label) {
        return { path: `${label}.png` };
      },
      async probe(_path, points) {
        probeCall += 1;
        if (probeCall === 1) return points.map(() => filled);
        return points.map((point) =>
          point.y === 400 ? emptyCore : emptyGeneral
        );
      }
    },
    async report() {}
  };
  await clearAllConfiguredSlots(context);
  assert.deepEqual(taps, [
    { x: 800, y: 550, lane: "general", index: 0 },
    { x: 745, y: 638 },
    { x: 800, y: 400, lane: "core", index: 0 },
    { x: 745, y: 638 }
  ]);
});

test("technology selection uses the exact left-list match and verifies the target slot", async () => {
  const taps = [];
  const reports = [];
  const context = {
    config: technologyConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      },
      async afterAction() {}
    },
    adb: {
      async mouseSwipe() {
        throw new Error("unexpected swipe");
      }
    },
    vision: {
      async capture(label) {
        if (label.startsWith("technology-selector")) {
          return {
            path: `${label}.png`,
            observations: [
              {
                text: "温室大棚",
                confidence: 1,
                x: 240,
                y: 450,
                width: 120,
                height: 40
              }
            ]
          };
        }
        return { path: `${label}.png`, observations: [] };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact"
            ? item.text === query
            : item.text.includes(query)
        );
      },
      async probe() {
        return [filled];
      }
    },
    async report(_level, step, message) {
      reports.push({ step, message });
    }
  };
  await selectTechnology(context, "core", 0, "温室大棚");
  assert.deepEqual(taps, [
    { x: 800, y: 400 },
    { x: 300, y: 470 }
  ]);
  assert.ok(
    reports.some(
      (item) =>
        item.step === "tech_slot_verified" &&
        item.message.includes("第一行第 1 个槽位")
    )
  );
});

test("formal technology workflow verifies every expected filled and empty slot", async () => {
  const reports = [];
  const context = {
    config: technologyConfig(),
    vision: {
      async capture() {
        return { path: "final.png" };
      },
      async probe(_path, points) {
        return points.map((point) =>
          point.lane === "core" ? filled : emptyGeneral
        );
      }
    },
    async report(_level, step, message) {
      reports.push({ step, message });
    }
  };
  await verifyFinalConfiguredSlots(context, {
    core: [{ name: "温室大棚" }],
    general: []
  });
  assert.ok(
    reports.some(
      (item) =>
        item.step === "technology_final_verified" &&
        item.message.includes("12 个槽位")
    )
  );
});

test("formal technology workflow aborts when a final slot has the wrong state", async () => {
  const context = {
    config: technologyConfig(),
    vision: {
      async capture() {
        return { path: "final.png" };
      },
      async probe(_path, points) {
        return points.map((point) =>
          point.lane === "core" ? emptyCore : emptyGeneral
        );
      }
    },
    async report() {}
  };
  await assert.rejects(
    verifyFinalConfiguredSlots(context, {
      core: [{ name: "温室大棚" }],
      general: []
    }),
    /第一行第 1 格应为已安装/
  );
});

function technologyConfig() {
  return {
    technology: {
      slots: {
        core: [{ x: 800, y: 400 }],
        general: [{ x: 800, y: 550 }]
      },
      unloadSelected: { x: 745, y: 638 },
      selectorRegion: {
        left: 60,
        top: 180,
        right: 720,
        bottom: 1040
      },
      selectorSwipe: {
        from: { x: 430, y: 820 },
        to: { x: 430, y: 580 },
        durationMs: 450,
        maxPages: 0,
        resetToTop: { repeats: 0 }
      },
      filledSlotDetection: {
        sampleRadius: 24,
        maximumEmptyFeatureDistance: 0.08,
        emptyReference: {
          core: emptyCore,
          general: emptyGeneral
        }
      }
    }
  };
}
