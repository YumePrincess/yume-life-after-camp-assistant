import test from "node:test";
import assert from "node:assert/strict";
import {
  clearAllConfiguredSlots,
  selectTechnology,
  verifyFinalConfiguredSlots
} from "../src/workflows/technology.mjs";

test("every occupied technology slot is selected and unloaded separately", async () => {
  const taps = [];
  const context = {
    config: technologyConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    vision: {
      async capture(label) {
        return {
          path: `${label}.png`,
          observations: label.includes("clear-check")
            ? [observation("卸下", 700, 600)]
            : []
        };
      },
      find(observations, query, mode) {
        return findObservation(observations, query, mode);
      },
      async probe(_path, slots) {
        return slots.map(() => feature(0));
      }
    },
    async report() {}
  };
  await clearAllConfiguredSlots(context);
  assert.deepEqual(taps, [
    { x: 800, y: 550, lane: "general", index: 0 },
    { x: 745, y: 638 },
    { x: 800, y: 550, lane: "general", index: 0 },
    { x: 800, y: 400, lane: "core", index: 0 },
    { x: 745, y: 638 },
    { x: 800, y: 400, lane: "core", index: 0 }
  ]);
});

test("technology selection configures the exact target without re-clicking its slot", async () => {
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
        if (label.startsWith("technology-selector-open-check")) {
          return { path: `${label}.png`, observations: [] };
        }
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
        return {
          path: `${label}.png`,
          observations: [
            observation("温室大棚", 620, 430),
            observation("卸下", 700, 600)
          ]
        };
      },
      find(observations, query, mode) {
        return findObservation(observations, query, mode);
      }
    },
    async sleep(ms) {
      assert.equal(ms, 3000);
    },
    async report(_level, step, message) {
      reports.push({ step, message });
    }
  };
  await selectTechnology(context, "core", 0, "温室大棚");
  assert.deepEqual(taps, [
    { x: 800, y: 400 },
    { x: 300, y: 470 },
    { x: 745, y: 638 }
  ]);
  assert.ok(
    reports.some(
      (item) =>
        item.step === "tech_slot_configured" &&
        item.message.includes("等待 3 秒")
    )
  );
});

test("two technologies follow slot-select-configure-wait before the next slot", async () => {
  const actions = [];
  const context = {
    config: {
      ...technologyConfig(),
      technology: {
        ...technologyConfig().technology,
        slots: {
          core: [
            { x: 800, y: 400 },
            { x: 1000, y: 400 }
          ],
          general: [{ x: 800, y: 550 }]
        }
      }
    },
    ui: {
      async tap(point) {
        actions.push(["tap", point]);
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
        const target = label.includes("种豆得豆") ? "种豆得豆" : "大丰收";
        return label.startsWith("technology-selector-open-check")
          ? { path: `${label}.png`, observations: [] }
          : {
              path: `${label}.png`,
              observations: [observation(target, 240, 450)]
            };
      },
      find(observations, query, mode) {
        return findObservation(observations, query, mode);
      }
    },
    async sleep(ms) {
      actions.push(["wait", ms]);
    },
    async report() {}
  };

  await selectTechnology(context, "core", 0, "大丰收");
  await selectTechnology(context, "core", 1, "种豆得豆");

  assert.deepEqual(actions, [
    ["tap", { x: 800, y: 400 }],
    ["tap", { x: 280, y: 465 }],
    ["tap", { x: 745, y: 638 }],
    ["wait", 3000],
    ["tap", { x: 1000, y: 400 }],
    ["tap", { x: 280, y: 465 }],
    ["tap", { x: 745, y: 638 }],
    ["wait", 3000]
  ]);
});

test("technology selection reopens a list that was toggled closed", async () => {
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
        if (label.startsWith("technology-selector-open-check")) {
          return {
            path: `${label}.png`,
            observations: [observation("点击槽位后可在此处选择科技", 120, 700)]
          };
        }
        if (label.startsWith("technology-selector")) {
          return {
            path: `${label}.png`,
            observations: [observation("温室大棚", 240, 450)]
          };
        }
        return {
          path: `${label}.png`,
          observations: [
            observation("温室大棚", 620, 430),
            observation("卸下", 700, 600)
          ]
        };
      },
      find(observations, query, mode) {
        return findObservation(observations, query, mode);
      }
    },
    async sleep() {},
    async report(_level, step) {
      reports.push(step);
    }
  };
  await selectTechnology(context, "core", 0, "温室大棚");
  assert.deepEqual(taps.slice(0, 2), [
    { x: 800, y: 400 },
    { x: 800, y: 400 }
  ]);
  assert.ok(reports.includes("tech_selector_reopen"));
});

test("formal technology workflow verifies every expected filled and empty slot", async () => {
  const reports = [];
  const context = {
    config: technologyConfig(),
    ui: { async tap() {} },
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      async probe(_path, slots) {
        return slots.map((_slot, index) => feature(index === 0 ? 0.2 : 0));
      }
    },
    technologyEmptySlotBaseline: baseline(),
    async report(_level, step, message) {
      reports.push({ step, message });
    }
  };
  await verifyFinalConfiguredSlots(context, {
    core: [{ name: "温室大棚", uiLabel: "温室大棚" }],
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
    ui: { async tap() {} },
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      async probe(_path, slots) {
        return slots.map(() => feature(0));
      }
    },
    technologyEmptySlotBaseline: baseline(),
    async report() {}
  };
  await assert.rejects(
    verifyFinalConfiguredSlots(context, {
      core: [{ name: "温室大棚", uiLabel: "温室大棚" }],
      general: []
    }),
    /第一行第 1 格应为“温室大棚”/
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
      configureSelected: { x: 745, y: 638 },
      detailsRegion: {
        left: 520,
        top: 250,
        right: 1050,
        bottom: 850
      },
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
      configureSettleMs: 3000,
      filledSlotDetection: {
        sampleRadius: 8,
        maximumEmptyFeatureDistance: 0.08,
        minimumInstalledFeatureDistance: 0.08
      }
    }
  };
}

function baseline() {
  return {
    slots: [{}, {}],
    probes: [feature(0), feature(0)]
  };
}

function feature(value) {
  return {
    meanRed: value,
    meanGreen: 0,
    meanBlue: 0,
    meanSaturation: 0,
    luminanceDeviation: 0
  };
}

function observation(text, x, y) {
  return {
    text,
    confidence: 1,
    x,
    y,
    width: 80,
    height: 30
  };
}

function findObservation(observations, query, mode) {
  return observations.find((item) =>
    mode === "exact"
      ? item.text === query
      : item.text.includes(query)
  );
}
