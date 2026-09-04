import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  clearAllConfiguredSlots,
  findTechnologyMatch,
  selectTechnology,
  verifyFinalConfiguredSlots
} from "../src/workflows/technology.mjs";

test("technology matching ignores parenthetical prerequisites as one generic rule", () => {
  const region = { left: 60, top: 180, right: 720, bottom: 1040 };
  const observations = [
    observation("快速装填", 240, 430),
    observation("（赤色瓶子）", 325, 430),
    observation("赤色瓶子", 240, 520)
  ];

  const mainMatch = findTechnologyMatch(
    null,
    observations,
    "快速装填",
    region
  );
  assert.equal(mainMatch?.text, "快速装填（赤色瓶子）");
  assert.equal(mainMatch?.y, 430);

  const prerequisiteMatch = findTechnologyMatch(
    null,
    observations.slice(0, 2),
    "赤色瓶子",
    region
  );
  assert.equal(prerequisiteMatch, null);

  const wrappedMatch = findTechnologyMatch(
    null,
    [observation("快速装填（赤色\n瓶子）", 240, 430)],
    "快速装填",
    region
  );
  assert.equal(wrappedMatch?.text, "快速装填（赤色\n瓶子）");
});

test("technology detail accepts the main title when the prerequisite is omitted", () => {
  const match = findTechnologyMatch(
    null,
    [observation("快速装填", 620, 430)],
    "快速装填（赤色瓶子）",
    { left: 520, top: 250, right: 1050, bottom: 850 }
  );
  assert.equal(match?.text, "快速装填");
});

test("1920x1200 technology hitboxes keep the live-device calibration", async () => {
  const config = JSON.parse(
    await readFile(new URL("../config.json", import.meta.url), "utf8")
  );
  assert.deepEqual(config.technology.slots, {
    core: [
      { x: 768, y: 425 },
      { x: 899, y: 425 },
      { x: 1030, y: 425 },
      { x: 1161, y: 425 },
      { x: 1292, y: 425 },
      { x: 1423, y: 425 }
    ],
    general: [
      { x: 704, y: 554 },
      { x: 834, y: 554 },
      { x: 965, y: 554 },
      { x: 1096, y: 554 },
      { x: 1227, y: 554 },
      { x: 1358, y: 554 }
    ]
  });
  assert.deepEqual(config.technology.unloadSelected, { x: 744, y: 612 });
  assert.deepEqual(config.technology.configureSelected, { x: 744, y: 612 });
  assert.equal(config.technology.selectorItemTapX, 178);
});

test("technology slots unload core 1-6 then general 1-6 without re-clicking", async () => {
  const actions = [];
  const coreSlots = Array.from({ length: 6 }, (_, index) => ({
    x: 700 + index * 100,
    y: 400
  }));
  const generalSlots = Array.from({ length: 6 }, (_, index) => ({
    x: 650 + index * 100,
    y: 550
  }));
  const context = {
    config: {
      ...technologyConfig(),
      technology: {
        ...technologyConfig().technology,
        slots: { core: coreSlots, general: generalSlots }
      }
    },
    ui: {
      async tap(point) {
        actions.push(["tap", point]);
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
    async sleep(ms) {
      actions.push(["wait", ms]);
    },
    async report() {}
  };
  await clearAllConfiguredSlots(context);
  const expected = [];
  for (const [lane, slots] of [
    ["core", coreSlots],
    ["general", generalSlots]
  ]) {
    slots.forEach((slot, index) => {
      expected.push(["tap", { ...slot, lane, index }]);
      expected.push(["wait", 1200]);
      expected.push(["tap", { x: 745, y: 638 }]);
      expected.push(["wait", 3000]);
    });
  }
  assert.deepEqual(actions, expected);
});

test("cropped detail OCR detects and unloads the first general slot", async () => {
  const actions = [];
  const context = {
    config: technologyConfig(),
    ui: {
      async tap(point) {
        actions.push(["tap", point]);
      }
    },
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      async ocrRegion(_path, _region, label) {
        return label.includes("clear-check-general-1")
          ? [observation("卸下", 700, 600)]
          : [];
      },
      find(observations, query, mode) {
        return findObservation(observations, query, mode);
      },
      async probe(_path, slots) {
        return slots.map(() => feature(0));
      }
    },
    async sleep(ms) {
      actions.push(["wait", ms]);
    },
    async report() {}
  };

  await clearAllConfiguredSlots(context);

  assert.deepEqual(actions, [
    ["tap", { x: 800, y: 400, lane: "core", index: 0 }],
    ["wait", 1200],
    ["tap", { x: 800, y: 550, lane: "general", index: 0 }],
    ["wait", 1200],
    ["tap", { x: 745, y: 638 }],
    ["wait", 3000]
  ]);
});

test("empty slot pixels never override the actual click and detail OCR", async () => {
  const actions = [];
  const reports = [];
  const config = technologyConfig();
  config.technology.slots = {
    core: [
      { x: 800, y: 400 },
      { x: 900, y: 400 }
    ],
    general: []
  };
  const context = {
    config,
    ui: {
      async tap(point) {
        actions.push(["tap", point]);
      }
    },
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      find(observations, query, mode) {
        return findObservation(observations, query, mode);
      },
      async probe() {
        throw new Error("pixel occupancy must not be consulted");
      }
    },
    async sleep(ms) {
      actions.push(["wait", ms]);
    },
    async report(_level, step) {
      reports.push(step);
    }
  };

  await clearAllConfiguredSlots(context);

  assert.deepEqual(actions, [
    ["tap", { x: 800, y: 400, lane: "core", index: 0 }],
    ["wait", 1200],
    ["tap", { x: 900, y: 400, lane: "core", index: 1 }],
    ["wait", 1200]
  ]);
  assert.equal(reports.filter((step) => step === "tech_slot_empty").length, 2);
});

test("technology selection configures the exact target without re-clicking its slot", async () => {
  const taps = [];
  const waits = [];
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
        if (label.startsWith("technology-configure-check")) {
          return {
            path: `${label}.png`,
            observations: [
              observation("温室大棚", 620, 430),
              observation("配置", 700, 600)
            ]
          };
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
      waits.push(ms);
    },
    async report(_level, step, message) {
      reports.push({ step, message });
    }
  };
  await selectTechnology(context, "core", 0, "温室大棚");
  assert.deepEqual(taps.map(({ x, y }) => ({ x, y })), [
    { x: 800, y: 400 },
    { x: 178, y: 470 },
    { x: 745, y: 638 }
  ]);
  assert.deepEqual(waits, [1200, 800, 1200, 3000]);
  assert.ok(
    reports.some(
      (item) =>
        item.step === "tech_slot_configured" &&
        item.message.includes("等待 3 秒")
    )
  );
});

test("a mismatched right-side technology name is reselected and never configured", async () => {
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
        if (label.includes("technology-configure-check-core-1-1")) {
          return {
            path: `${label}.png`,
            observations: [
              observation("超强吸力", 620, 430),
              observation("配置", 700, 600)
            ]
          };
        }
        if (label.includes("technology-configure-check-core-1-2")) {
          return {
            path: `${label}.png`,
            observations: [
              observation("生物多样性", 620, 430),
              observation("配置", 700, 600)
            ]
          };
        }
        return {
          path: `${label}.png`,
          observations: [observation("生物多样性", 240, 450)]
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

  await selectTechnology(context, "core", 0, "生物多样性");

  assert.deepEqual(taps.map(({ x, y }) => ({ x, y })), [
    { x: 800, y: 400 },
    { x: 178, y: 465 },
    { x: 178, y: 465 },
    { x: 745, y: 638 }
  ]);
  assert.ok(reports.includes("tech_selected_name_mismatch"));
  assert.ok(reports.includes("tech_selected_name_verified"));
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
        const target =
          label.includes("种豆得豆") ||
          label.includes("configure-check-core-2")
            ? "种豆得豆"
            : "大丰收";
        if (label.startsWith("technology-selector-open-check")) {
          return { path: `${label}.png`, observations: [] };
        }
        if (label.startsWith("technology-configure-check")) {
          return {
            path: `${label}.png`,
            observations: [
              observation(target, 620, 430),
              observation("配置", 700, 600)
            ]
          };
        }
        return {
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
    ["wait", 1200],
    ["wait", 800],
    ["tap", { x: 178, y: 465 }],
    ["wait", 1200],
    ["tap", { x: 745, y: 638 }],
    ["wait", 3000],
    ["tap", { x: 1000, y: 400 }],
    ["wait", 1200],
    ["wait", 800],
    ["tap", { x: 178, y: 465 }],
    ["wait", 1200],
    ["tap", { x: 745, y: 638 }],
    ["wait", 3000]
  ]);
});

test("technology selection uses cropped OCR and a unique one-character OCR correction", async () => {
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
        return {
          path: `${label}.png`,
          observations: label.startsWith("technology-configure-check")
            ? [
                observation("永原青春", 620, 430),
                observation("配置", 700, 600)
              ]
            : []
        };
      },
      async ocrRegion(_path, region, _label, _signal, mode, confidence, scale) {
        assert.deepEqual(region, technologyConfig().technology.selectorRegion);
        assert.equal(mode, "accurate");
        assert.equal(confidence, 0.1);
        assert.equal(scale, 2);
        return [observation("永原青春", 240, 650)];
      },
      find(observations, query, mode) {
        return findObservation(observations, query, mode);
      }
    },
    async sleep() {},
    async report(_level, step, _message, detail) {
      reports.push({ step, detail });
    }
  };

  await selectTechnology(context, "core", 0, "永葆青春");

  assert.deepEqual(taps, [
    { x: 800, y: 400 },
    { x: 178, y: 665 },
    { x: 745, y: 638 }
  ]);
  assert.equal(
    reports.find((item) => item.step === "tech_target_found")?.detail
      ?.matchedText,
    "永原青春"
  );
});

test("technology selection stops after the list content remains unchanged at the bottom", async () => {
  let swipes = 0;
  const reports = [];
  const context = {
    config: {
      ...technologyConfig(),
      technology: {
        ...technologyConfig().technology,
        selectorSwipe: {
          ...technologyConfig().technology.selectorSwipe,
          maxPages: 20
        }
      }
    },
    ui: {
      async tap() {},
      async afterAction() {}
    },
    adb: {
      async mouseSwipe() {
        swipes += 1;
      }
    },
    vision: {
      async capture(label) {
        return {
          path: `${label}.png`,
          observations: [observation("列表最后一项", 240, 650)]
        };
      },
      find(observations, query, mode) {
        return findObservation(observations, query, mode);
      }
    },
    async report(_level, step) {
      reports.push(step);
    }
  };

  await assert.rejects(
    selectTechnology(context, "core", 0, "不存在科技"),
    /科技选择列表中找不到/
  );
  assert.equal(swipes, 2);
  assert.ok(reports.includes("tech_selector_bottom_reached"));
});

test("technology selection never double-clicks a slot when the list is closed", async () => {
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
  await assert.rejects(
    selectTechnology(context, "core", 0, "温室大棚"),
    /禁止重复点击同一格/
  );
  assert.deepEqual(taps, [{ x: 800, y: 400 }]);
  assert.ok(!reports.includes("tech_selector_reopen"));
});

test("formal technology workflow verifies every expected filled and empty slot", async () => {
  const reports = [];
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
          observations: label.includes("final-slot-core-1")
            ? [observation("卸下", 700, 600)]
            : []
        };
      },
      find(observations, query, mode) {
        return findObservation(observations, query, mode);
      }
    },
    technologyEmptySlotBaseline: baseline(),
    async sleep() {},
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
        item.message.includes("2 个槽位")
    )
  );
  assert.deepEqual(
    taps.map(({ x, y }) => ({ x, y })),
    [{ x: 800, y: 400 }, { x: 800, y: 550 }]
  );
  assert.ok(reports.some((item) => item.step === "tech_final_empty_slot_verified"));
});

test("technology detail is collapsed before the next final slot is inspected", async () => {
  const taps = [];
  const waits = [];
  const config = technologyConfig();
  config.technology.dismissDetailBetweenSlots = true;
  config.technology.slots = {
    core: [{ x: 800, y: 400 }, { x: 900, y: 400 }],
    general: []
  };
  const context = {
    config,
    ui: { async tap(point) { taps.push(point); } },
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      find(observations, query, mode) {
        return findObservation(observations, query, mode);
      }
    },
    async sleep(ms) { waits.push(ms); },
    async report() {}
  };
  await verifyFinalConfiguredSlots(context, { core: [], general: [] });
  assert.deepEqual(taps.map(({ x, y }) => ({ x, y })), [
    { x: 800, y: 400 },
    { x: 959, y: 208 },
    { x: 900, y: 400 }
  ]);
  assert.deepEqual(waits, [1200, 2000, 1200]);
});

test("final empty slots are clicked and verified by detail OCR, not pixels", async () => {
  const taps = [];
  const reports = [];
  const config = technologyConfig();
  config.technology.slots = {
    core: Array.from({ length: 6 }, (_value, index) => ({
      x: 800 + index * 100,
      y: 400
    })),
    general: []
  };
  const context = {
    config,
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    vision: {
      async capture(label) {
        const installed = /final-slot-core-[1-5]-attempt-1/.test(label);
        return {
          path: `${label}.png`,
          observations: installed ? [observation("卸下", 700, 600)] : []
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
  await verifyFinalConfiguredSlots(context, {
    core: Array.from({ length: 5 }, (_value, index) => ({
      name: `科技${index + 1}`,
      uiLabel: `科技${index + 1}`
    })),
    general: []
  });
  assert.deepEqual(
    (({ x, y }) => ({ x, y }))(taps.at(-1)),
    { x: 1300, y: 400 }
  );
  assert.ok(reports.includes("tech_final_empty_slot_verified"));
});

test("formal technology workflow aborts when a final slot has the wrong state", async () => {
  const context = {
    config: technologyConfig(),
    ui: { async tap() {} },
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: [] };
      },
      find(observations, query, mode) {
        return findObservation(observations, query, mode);
      }
    },
    technologyEmptySlotBaseline: baseline(),
    async sleep() {},
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
      dismissDetailBetweenSlots: false,
      slots: {
        core: [{ x: 800, y: 400 }],
        general: [{ x: 800, y: 550 }]
      },
      unloadSelected: { x: 745, y: 638 },
      slotOpenSettleMs: 1200,
      detailOpenSettleMs: 1200,
      selectorItemTapX: 178,
      selectionBorderOffsetY: -73,
      selectionBorderProbeRadius: 4,
      unloadSettleMs: 3000,
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
