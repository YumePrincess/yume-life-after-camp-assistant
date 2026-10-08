import test from "node:test";
import assert from "node:assert/strict";
import {
  clickTradingCityWeekday,
  runTradingCityApply,
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

test("a failed six-step Dexter route returns to the central exit before restarting at city hall", async () => {
  const context = createContext({ findDexterOnAttempt: () => false });

  await assert.rejects(
    runTradingCityApply(context, commandFor(1), {}, undefined),
    /TRADING_CITY_DEXTER_NOT_FOUND: 最多重启三轮/
  );

  assert.equal(context.flows.filter((name) => name === "teleportCityHall").length, 4);
  assert.equal(context.flows.filter((name) => name === "navigateToSandTable").length, 4);
  assert.equal(context.flows.filter((name) => name === "teleportCentralExit").length, 3);
  assert.deepEqual(context.flows.slice(0, 5), [
    "teleportCityHall",
    "navigateToSandTable",
    "teleportCentralExit",
    "teleportCityHall",
    "navigateToSandTable"
  ]);
  assert.equal(context.keys.filter((code) => code === "KEYCODE_W").length, 28);
});

test("the workflow moves, turns the camera with the requested swipe, talks to Dexter, and submits the selected weekday", async () => {
  for (let targetWeekday = 1; targetWeekday <= 7; targetWeekday += 1) {
    const context = createContext({ findDexterOnAttempt: () => true });
    await runTradingCityApply(context, commandFor(targetWeekday), {}, undefined);

    assert.deepEqual(context.flows.slice(0, 2), ["teleportCityHall", "navigateToSandTable"]);
    assert.equal(context.keys[0], "KEYCODE_ESCAPE");
    assert.equal(context.keys[1], "KEYCODE_W");
    assert.deepEqual(context.shellCalls, [["input", "swipe", "500", "500", "1000", "500", "800"]]);
    assert.ok(context.keys.includes("KEYCODE_F"));
    assert.deepEqual(context.taps, [
      TRADING_CITY_WEEKDAY_POSITIONS[targetWeekday],
      TRADING_CITY_APPLICATION_CONFIRM_POSITION
    ]);
    const weekdayTapIndex = context.events.findIndex(
      ([type, point]) => type === "tap" && point === TRADING_CITY_WEEKDAY_POSITIONS[targetWeekday]
    );
    assert.deepEqual(context.events.slice(weekdayTapIndex, weekdayTapIndex + 3), [
      ["tap", TRADING_CITY_WEEKDAY_POSITIONS[targetWeekday]],
      ["sleep", 2_000],
      ["tap", TRADING_CITY_APPLICATION_CONFIRM_POSITION]
    ]);
  }
});

function commandFor(targetWeekday) {
  return {
    payload: {
      detail: { tradingCity: { targetWeekday } }
    }
  };
}

function createContext({ findDexterOnAttempt }) {
  const context = {
    config: { adb: { screenWidth: 1920, screenHeight: 1200 } },
    flows: [],
    keys: [],
    events: [],
    shellCalls: [],
    taps: [],
    submitted: false,
    dexterAttempts: 0,
    async sleep(ms) { context.events.push(["sleep", ms]); },
    async report() {},
    ui: {
      async executeFlow(name) { context.flows.push(name); },
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
      async key(code) { context.keys.push(code); },
      async shell(args) { context.shellCalls.push(args); }
    },
    vision: {
      find(observations, text) {
        return observations.find((item) => item.text.includes(text)) || null;
      },
      async capture(label) {
        if (label.startsWith("trading-city-dexter-")) {
          context.dexterAttempts += 1;
          return {
            observations: findDexterOnAttempt(context.dexterAttempts)
              ? [observation("德克斯特"), observation("交谈(F)")]
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
