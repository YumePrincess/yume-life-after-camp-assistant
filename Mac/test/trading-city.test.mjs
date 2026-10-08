import test from "node:test";
import assert from "node:assert/strict";
import {
  clickTradingCityWeekday,
  prepareTradingCityApplication,
  runTradingCityApply,
  selectTradingCityWeekday,
  TRADING_CITY_APPLICATION_CONFIRM_POSITION,
  TRADING_CITY_WEEKDAY_POSITIONS
} from "../src/workflows/trading-city.mjs";

test("all seven weekday taps hit the checkbox positions shown in the 1920×1200 form", async () => {
  const expected = {
    1: { x: 1642, y: 310 }, // Monday: first row, third column
    2: { x: 1196, y: 362 }, // Tuesday: second row, first column
    3: { x: 1419, y: 362 }, // Wednesday: second row, second column
    4: { x: 1642, y: 362 }, // Thursday: second row, third column
    5: { x: 1196, y: 416 }, // Friday: third row, first column
    6: { x: 1196, y: 310 }, // Saturday: first row, first column
    7: { x: 1419, y: 310 }  // Sunday: first row, second column
  };
  const taps = [];

  for (let weekday = 1; weekday <= 7; weekday += 1) {
    const position = await clickTradingCityWeekday(
      { async tap(point) { taps.push({ weekday, point }); } },
      weekday
    );
    assert.deepEqual(position, expected[weekday]);
    assert.deepEqual(TRADING_CITY_WEEKDAY_POSITIONS[weekday], expected[weekday]);
  }

  assert.deepEqual(taps, Object.entries(expected).map(([weekday, point]) => ({
    weekday: Number(weekday),
    point
  })));
  assert.deepEqual(TRADING_CITY_APPLICATION_CONFIRM_POSITION, { x: 1728, y: 947 });
});

test("a failed two-attempt Dexter route returns to the central exit before up to six restarts", async () => {
  const context = createContext({ findDexterOnAttempt: () => false });

  await assert.rejects(
    runTradingCityApply(context, commandFor(1), {}, undefined),
    /TRADING_CITY_DEXTER_NOT_FOUND: 最多重启六轮/
  );

  assert.equal(context.flows.filter((name) => name === "teleportCityHall").length, 7);
  assert.equal(context.flows.filter((name) => name === "navigateToSandTable").length, 0);
  assert.equal(context.flows.filter((name) => name === "teleportCentralExit").length, 6);
  assert.deepEqual(context.flows.slice(0, 5), [
    "teleportCityHall",
    "teleportCentralExit",
    "teleportCityHall",
    "teleportCentralExit",
    "teleportCityHall"
  ]);
  assert.equal(context.dexterAttempts, 14);
  assert.equal(context.keys.filter((code) => code === "KEYCODE_W").length, 21);
  assert.equal(context.holds.length, 21);
  assert.deepEqual(
    context.holds,
    Array.from({ length: 7 }, () => [
      { code: "KEYCODE_W", durationMs: 700 },
      { code: "KEYCODE_W", durationMs: 580 },
      { code: "KEYCODE_W", durationMs: 580 }
    ]).flat()
  );
  const restarts = context.reports.filter(({ step }) => step === "trading_city_route_restart");
  assert.equal(restarts.length, 6);
  assert.equal(restarts[0].message, "第 1/6 次寻路重启：本轮两次寻路均未找到德克斯特，先传送回市中心出入口，再重新前往市政厅");
  assert.equal(restarts[0].details.maximumRestarts, 6);
  assert.equal(
    context.keyCalls.some(({ code, options }) => code === "KEYCODE_W" && options?.longPress),
    false
  );
  assert.equal(context.keyCalls.some(({ code }) => code === "KEYCODE_ESCAPE"), false);
  assert.equal(context.keyCalls.some(({ code }) => code === "KEYCODE_F"), false);
});

test("the workflow waits three seconds after each W press, recognizes Dexter and talk, then submits the selected weekday", async () => {
  for (let targetWeekday = 1; targetWeekday <= 7; targetWeekday += 1) {
    const context = createContext({ findDexterOnAttempt: () => true });
    await runTradingCityApply(context, commandFor(targetWeekday), {}, undefined);

    assert.equal(context.flows[0], "teleportCityHall");
    assert.deepEqual(context.flowDestinations, Array(context.flows.length).fill("市政厅"));
    assert.equal(
      context.reports.filter(({ step }) => step === "trading_city_city_hall_confirmed").length,
      1
    );
    assert.deepEqual(context.shellCalls, [["input", "swipe", "500", "500", "1000", "500", "800"]]);
    assert.ok(context.keys.includes("KEYCODE_F"));
    const dataCenterWaits = context.events.filter(([type]) => type === "waitAnyText");
    assert.equal(dataCenterWaits.length, 2);
    const firstHoldIndex = context.events.findIndex(([type]) => type === "holdKey");
    assert.deepEqual(context.events.slice(firstHoldIndex - 1, firstHoldIndex + 2), [
      ["key", "KEYCODE_W"],
      ["holdKey", "KEYCODE_W", 700],
      ["sleep", 3_000]
    ]);
    const cameraSwipeIndex = context.events.findIndex(([type]) => type === "camera-swipe");
    assert.ok(cameraSwipeIndex > context.events.findIndex(([type]) => type === "data-center-second-seen"));
    assert.ok(context.events.findIndex(([type, code]) => type === "key" && code === "KEYCODE_F") > cameraSwipeIndex);
    assert.equal(context.keyCalls.some(({ code }) => code === "KEYCODE_ESCAPE"), false);
    assert.deepEqual(
      context.holds,
      [
        { code: "KEYCODE_W", durationMs: 700 },
        { code: "KEYCODE_W", durationMs: 580 }
      ]
    );
    assert.equal(
      context.reports.find(({ step }) => step === "trading_city_w_pathfinding").message,
      "第 1 轮第 1/2 次寻路：按住 W 580 毫秒后识别德克斯特"
    );
    const dexterCaptures = context.events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event[0] === "capture" && event[1].startsWith("trading-city-dexter-"));
    assert.equal(dexterCaptures.length, 1);
    assert.deepEqual(context.events[dexterCaptures[0].index - 1], ["sleep", 3_000]);
    assert.deepEqual(context.taps, [
      TRADING_CITY_WEEKDAY_POSITIONS[targetWeekday],
      TRADING_CITY_APPLICATION_CONFIRM_POSITION
    ]);
    assert.deepEqual(context.events
      .filter(([type]) => ["tap", "sleep"].includes(type))
      .slice(-3), [
      ["tap", TRADING_CITY_WEEKDAY_POSITIONS[targetWeekday]],
      ["sleep", 2_000],
      ["tap", TRADING_CITY_APPLICATION_CONFIRM_POSITION]
    ]);
  }
});

test("the workflow does not begin data-center pathfinding until City Hall arrival is confirmed", async () => {
  const context = createContext({
    findDexterOnAttempt: () => true,
    confirmCityHall: false
  });

  await assert.rejects(
    prepareTradingCityApplication(context, undefined, context.sleep),
    /TRADING_CITY_CITY_HALL_UNCONFIRMED/
  );

  assert.deepEqual(context.flows, ["teleportCityHall"]);
  assert.equal(context.holds.length, 0);
  assert.equal(context.events.some(([type]) => type === "waitAnyText"), false);
});

test("the diagnostic can select Monday and stop without submitting the form", async () => {
  const context = createContext({ findDexterOnAttempt: () => true });
  await prepareTradingCityApplication(context, undefined, context.sleep);
  await selectTradingCityWeekday(context, 1, undefined, context.sleep);

  assert.deepEqual(context.taps, [TRADING_CITY_WEEKDAY_POSITIONS[1]]);
  assert.equal(context.submitted, false);
  assert.deepEqual(context.events.filter(([type]) => ["tap", "sleep"].includes(type)).slice(-2), [
    ["tap", TRADING_CITY_WEEKDAY_POSITIONS[1]],
    ["sleep", 2_000]
  ]);
});

function commandFor(targetWeekday) {
  return {
    payload: {
      detail: { tradingCity: { targetWeekday } }
    }
  };
}

function createContext({ findDexterOnAttempt, confirmCityHall = true }) {
  const context = {
    config: { adb: { screenWidth: 1920, screenHeight: 1200 } },
    flows: [],
    flowDestinations: [],
    keys: [],
    keyCalls: [],
    holds: [],
    events: [],
    shellCalls: [],
    taps: [],
    reports: [],
    submitted: false,
    dexterAttempts: 0,
    async sleep(ms) { context.events.push(["sleep", ms]); },
    async report(level, step, message, details) {
      context.events.push(["report", step]);
      context.reports.push({ level, step, message, details });
    },
    ui: {
      async executeFlow(name) {
        context.flows.push(name);
        context.ui.lastConfirmedDestination = name === "teleportCityHall"
          ? confirmCityHall ? "市政厅" : null
          : "中心出入口";
        context.flowDestinations.push(context.ui.lastConfirmedDestination);
      },
      async waitAnyText(texts) {
        context.events.push(["waitAnyText", texts]);
        if (context.events.filter(([type]) => type === "waitAnyText").length === 2) {
          context.events.push(["data-center-second-seen"]);
        }
        return { text: "营地数据中心" };
      },
      async clickText() {},
      async tap(point) {
        context.taps.push(point);
        context.events.push(["tap", point]);
        if (point.x === TRADING_CITY_APPLICATION_CONFIRM_POSITION.x) {
          context.submitted = true;
        }
      }
    },
    adb: {
      async key(code, _signal, options) {
        context.keys.push(code);
        context.keyCalls.push({ code, options });
        context.events.push(["key", code]);
      },
      async holdKey(code, durationMs) {
        context.holds.push({ code, durationMs });
        context.events.push(["holdKey", code, durationMs]);
      },
      async shell(args) {
        context.shellCalls.push(args);
        context.events.push(["camera-swipe", args]);
      }
    },
    vision: {
      find(observations, text) {
        return observations.find((item) => item.text.includes(text)) || null;
      },
      async capture(label) {
        context.events.push(["capture", label]);
        if (label.startsWith("trading-city-dexter-")) {
          context.dexterAttempts += 1;
          return {
            observations: findDexterOnAttempt(context.dexterAttempts)
              ? [observation("德克斯特"), observation("交谈（F）")]
              : []
          };
        }
        if (label === "trading-city-conversation") {
          return { observations: [observation("交易之城是什么？"), observation("原来如此")] };
        }
        if (label === "trading-city-application") {
          return {
            observations: [
              observation("交易之城竞标申请表"),
              observation("成为交易之城日期"),
              observation("需求物资确认"),
              ...["周一", "周二", "周三", "周四", "周五", "周六", "周日"].map(observation)
            ]
          };
        }
        if (label === "trading-city-submission") {
          return {
            observations: context.submitted
              ? [observation("综合"), observation("世界"), observation("场景")]
              : [observation("交易之城竞标申请表")]
          };
        }
        throw new Error(`Unexpected vision capture: ${label}`);
      }
    }
  };
  return context;
}

function observation(text) {
  return { text, x: 1200, y: 500, width: 200, height: 32 };
}
