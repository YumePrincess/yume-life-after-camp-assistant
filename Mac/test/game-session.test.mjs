import test from "node:test";
import assert from "node:assert/strict";
import { waitForGameReady } from "../src/game-session.mjs";

test("zero promotion pages reaches HUD without a bottom tap", async () => {
  const fixture = createFixture([["背包"]]);
  await waitForGameReady(fixture.context);
  assert.equal(fixture.taps.length, 0);
  assert.match(fixture.messages.at(-1), /未出现活动宣传页/);
});

test("the newspaper is recognized as a promotion page", async () => {
  const fixture = createFixture([["登录游戏"], ["明日希望报"], ["背包"]]);
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [
    { x: 960, y: 945 },
    { x: 960, y: 1135 }
  ]);
  assert.match(fixture.messages.at(-1), /已关闭 1 张/);
});

test("resource update restart is handled before login and promotion dismissal", async () => {
  const fixture = createFixture([
    ["资源更新", "重启游戏"],
    ["登录游戏"],
    ["背包"]
  ]);
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [
    { x: 5, y: 5 },
    { x: 960, y: 945 }
  ]);
  assert.ok(
    fixture.messages.some((message) => message.includes("资源更新/状态检测"))
  );
});

test("pre-login announcement closes by its top-right X before clicking login", async () => {
  const fixture = createFixture([
    ["系统公告", "经典服"],
    ["点击登录游戏"],
    ["背包"]
  ]);
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [
    { x: 1742, y: 155 },
    { x: 960, y: 945 }
  ]);
  assert.ok(
    fixture.messages.some((message) => message.includes("登录角色前的系统公告"))
  );
});

test("a local-model login hallucination never clicks or advances the workflow", async () => {
  const fixture = createFixture(
    [[], ["背包"]],
    {
      state: "login",
      action: "wait",
      confidence: 0.99,
      evidence: "误判"
    }
  );
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, []);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("不会点击或推动任务流程")
    )
  );
});

function createFixture(frames, modelAdvice = null) {
  const taps = [];
  const messages = [];
  let frameIndex = 0;
  const vision = {
    advisor: modelAdvice
      ? {
          enabled: true,
          config: {
            mode: "shadow",
            intervalSeconds: 2,
            minimumConfidence: 0.9,
            consecutiveMatches: 2
          }
        }
      : undefined,
    async captureTransient() {
      const texts = frames[Math.min(frameIndex++, frames.length - 1)];
      return {
        observations: texts.map((text) => ({
          text,
          confidence: 1,
          x: 0,
          y: 0,
          width: 10,
          height: 10
        }))
      };
    },
    find(observations, text) {
      return observations.find((item) => item.text.includes(text));
    },
    async adviseCurrent() {
      return modelAdvice;
    }
  };
  const context = {
    config: {
      timeouts: { gameLaunchSeconds: 2 },
      adb: { loginButton: { x: 960, y: 945 } },
      postLoginPromotions: {
        maxPages: 2,
        initialWaitMs: 0,
        betweenPagesMs: 0,
        dismissPoint: { x: 960, y: 1135 },
        readyTexts: ["配方", "背包", "营地"]
      },
      preLoginAnnouncements: {
        enabled: true,
        maxClosures: 2,
        closePoint: { x: 1742, y: 155 },
        texts: ["系统公告", "更新公告", "游戏公告"]
      }
    },
    adb: {
      async key() {},
      async gameHealth() {
        return { running: true, anr: false };
      },
      async launchGame() {}
    },
    ui: {
      async tap(point) {
        taps.push(point);
      },
      async afterAction() {},
      async keyIfAnyText() {}
    },
    vision,
    async report(_level, _step, message) {
      messages.push(message);
    }
  };
  return { context, taps, messages };
}
