import test from "node:test";
import assert from "node:assert/strict";
import {
  isRecoverableGameFailure,
  shouldHoldInitialStartup,
  waitForGameReady
} from "../src/game-session.mjs";

test("initial MuMu container startup remains protected for the full configured window", () => {
  assert.equal(shouldHoldInitialStartup(false, 300_000, 299_999), true);
  assert.equal(shouldHoldInitialStartup(false, 300_000, 300_000), false);
  assert.equal(shouldHoldInitialStartup(true, 300_000, 1), false);
});

test("a healthy game is never restarted for a UI or input timeout", () => {
  assert.equal(
    isRecoverableGameFailure(
      new Error("ADB input timeout while approaching destination"),
      { running: true, anr: false },
      "device"
    ),
    false
  );
  assert.equal(
    isRecoverableGameFailure(
      new Error("界面超时"),
      { running: true, anr: false },
      "device"
    ),
    false
  );
});

test("an exited game, ANR, or offline device remains restartable", () => {
  assert.equal(
    isRecoverableGameFailure(
      new Error("GAME_PROCESS_EXITED"),
      { running: false },
      "device"
    ),
    true
  );
  assert.equal(
    isRecoverableGameFailure(
      new Error("GAME_ANR_DETECTED"),
      { running: true, anr: true },
      "device"
    ),
    true
  );
  assert.equal(
    isRecoverableGameFailure(new Error("MUMU_DEVICE_OFFLINE"), {}, "offline"),
    true
  );
});

test("a workflow failure is never upgraded to a MuMu restart", () => {
  assert.equal(
    isRecoverableGameFailure(
      new Error("MEMBER_PROFILE_COUNT_MISMATCH: recognized 91, expected 92"),
      { running: false, anr: true },
      "offline"
    ),
    false
  );
  assert.equal(
    isRecoverableGameFailure(
      new Error("SecurityException: INJECT_EVENTS"),
      { running: false, anr: true },
      "device"
    ),
    false
  );
});

test("zero promotion pages reaches HUD without blindly tapping the map area", async () => {
  const fixture = createFixture([["背包"]]);
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, []);
  assert.match(fixture.messages.at(-1), /未出现活动宣传页/);
});

test("stable HUD sends the game-mouse key once after login, not before it", async () => {
  const fixture = createFixture([["登录游戏"], ["背包"]]);
  const hudCalls = [];
  fixture.context.ui.summonGameMouseAfterHud = async (_signal, attempts) => {
    hudCalls.push(attempts);
  };

  await waitForGameReady(fixture.context);

  assert.deepEqual(hudCalls, [6]);
  assert.deepEqual(fixture.taps, [{ x: 960, y: 945 }]);
});

test("login without a stable world HUD stops at the post-login hard timeout", async () => {
  const fixture = createFixture([["登录游戏"]]);
  fixture.context.config.timeouts.postLoginHudTimeoutSeconds = 1;

  await assert.rejects(
    waitForGameReady(fixture.context),
    /Timed out waiting for world HUD after login for 1s/
  );
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("点击金色登录按钮后 1 秒仍未识别到")
    )
  );
});

test("pre-login fallback uses Android touch and never GameUi.tap", async () => {
  const fixture = createFixture([["登录游戏"], ["背包"]]);
  const touchTaps = [];
  fixture.context.ui.androidTouchTap = undefined;
  fixture.context.ui.tap = async () => {
    throw new Error("pre-login must not use GameUi.tap");
  };
  fixture.context.adb.touchTap = async (x, y) => touchTaps.push({ x, y });

  await waitForGameReady(fixture.context);

  assert.deepEqual(touchTaps, [{ x: 960, y: 945 }]);
});

test("the newspaper is recognized as a promotion page", async () => {
  const fixture = createFixture([["登录游戏"], ["明日希望报"], ["背包"]]);
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [
    { x: 960, y: 945 },
    { x: 960, y: 1140 }
  ]);
  assert.match(fixture.messages.at(-1), /已关闭 1 张/);
});

test("a newspaper remaining after the first tap is retried without consuming another page", async () => {
  const fixture = createFixture([
    ["登录游戏"],
    ["立即前往", "活动时间"],
    ["明日希望报"],
    ["明日希望报"],
    ["背包"]
  ]);
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [
    { x: 960, y: 945 },
    { x: 960, y: 1140 },
    { x: 960, y: 1140 },
    { x: 960, y: 1140 }
  ]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("第 2 次点击底部安全区域")
    )
  );
  assert.match(fixture.messages.at(-1), /已关闭 2 张/);
});

test("an activity call-to-action closes a post-login promotion at the calibrated safe point", async () => {
  const fixture = createFixture([
    ["登录游戏"],
    ["立即前往", "活动时间"],
    ["背包"]
  ]);
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [
    { x: 960, y: 945 },
    { x: 960, y: 1140 }
  ]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("活动宣传页特征")
    )
  );
});

test("an accidental activity page returns through the bottom-left back point", async () => {
  const fixture = createFixture([
    ["登录游戏"],
    ["推荐", "活动", "臻藏"],
    ["背包"]
  ]);
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [
    { x: 960, y: 945 },
    { x: 80, y: 1080 }
  ]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("检测到活动页面左侧")
    )
  );
});

test("guarded AI closes a post-login system announcement with the top-right X", async () => {
  const fixture = createFixture(
    [["登录游戏"], [], [], [], ["背包"]],
    {
      state: "prelogin_announcement",
      action: "wait",
      confidence: 0.97,
      evidence: "全屏活动主视觉"
    },
    [],
    "guarded"
  );
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [
    { x: 960, y: 945 },
    { x: 1742, y: 155 }
  ]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("本地模型确认系统公告")
    )
  );
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

test("a system announcement shown after the login tap still closes by its top-right X", async () => {
  const fixture = createFixture([
    ["点击登录游戏"],
    ["系统公告", "经典服", "亲爱的幸存者"],
    ["背包"]
  ]);
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [
    { x: 960, y: 945 },
    { x: 1742, y: 155 }
  ]);
  assert.ok(
    fixture.messages.some((message) => message.includes("右上角关闭按钮"))
  );
});

test("a very-low-confidence local-model login candidate never clicks", async () => {
  const fixture = createFixture(
    [[], ["背包"]],
    {
      state: "login",
      action: "wait",
      confidence: 0.2,
      evidence: "误判"
    },
    [],
    "guarded"
  );
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, []);
});

test("a clear local-model login candidate clicks the calibrated login button", async () => {
  const fixture = createFixture(
    [[], [], ["背包"]],
    {
      state: "login",
      action: "wait",
      confidence: 0.45,
      evidence: "底部登录按钮"
    },
    [],
    "guarded"
  );
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [{ x: 960, y: 945 }]);
  assert.deepEqual(fixture.touchTaps, [{ x: 960, y: 945 }]);
  assert.ok(
    fixture.messages.some((message) => message.includes("固定登录按钮"))
  );
});

test("accurate OCR recovers a login button missed by fast OCR", async () => {
  const fixture = createFixture(
    [[], [], ["背包"]],
    null,
    [["点击登录游戏"]]
  );
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [{ x: 960, y: 945 }]);
  assert.equal(fixture.accurateCaptures, 1);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("高精度 OCR 确认“点击登录游戏”")
    )
  );
});

test("a slow local model never blocks the deterministic login loop", async () => {
  const fixture = createFixture(
    [[], ["背包"]],
    () => new Promise(() => {})
  );
  const startedAt = Date.now();
  await waitForGameReady(fixture.context);
  assert.ok(Date.now() - startedAt < 1_500);
  assert.deepEqual(fixture.taps, []);
});

test("an accurate OCR timeout degrades to fast OCR without ending login", async () => {
  const fixture = createFixture(
    [[], [], ["背包"]],
    null,
    [new Error("accurate OCR timed out")]
  );
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, []);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("已自动退回快速 OCR")
    )
  );
});

test("guarded mode permits a fixed login tap at 0.95 confidence", async () => {
  const fixture = createFixture(
    [[], [], [], ["背包"]],
    {
      state: "login",
      action: "wait",
      confidence: 0.95,
      evidence: "底部登录按钮清晰可见"
    },
    [],
    "guarded"
  );
  await waitForGameReady(fixture.context);
  assert.deepEqual(fixture.taps, [{ x: 960, y: 945 }]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("高置信度")
    )
  );
});

test("a transient HUD during loading does not start the task", async () => {
  const fixture = createFixture(
    [["背包"], ["加载中"], ["背包"], ["背包"], ["背包"]],
    null,
    [],
    "shadow",
    { readyStableFrames: 3, readyStableMs: 0 }
  );
  await waitForGameReady(fixture.context);
  assert.equal(fixture.captures, 5);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("继续等待登录进度层消失")
    )
  );
});

test("login percentage blocks HUD readiness even when HUD anchors are visible", async () => {
  const fixture = createFixture(
    [
      ["登录游戏"],
      ["背包", "营地", { text: "76.4％", x: 900, y: 1050 }],
      ["背包", "营地", { text: "100%", x: 900, y: 1050 }],
      ["背包", "营地"],
      ["背包", "营地"]
    ],
    null,
    [],
    "shadow",
    {
      readyMinimumTexts: 2,
      readyStableFrames: 2,
      readyStableMs: 0,
      postLoginMinimumWaitMs: 0,
      loadingQuietMs: 0
    }
  );
  await waitForGameReady(fixture.context);
  assert.equal(fixture.captures, 5);
  assert.deepEqual(fixture.taps, [{ x: 960, y: 945 }]);
});

test("HUD distance and status numbers outside the loading bar never reset readiness", async () => {
  const hudFrame = [
    { text: "综合", x: 30, y: 1090 },
    { text: "世界", x: 120, y: 1090 },
    { text: "场景", x: 210, y: 1090 },
    { text: "97%", x: 390, y: 620 },
    { text: "16/27", x: 70, y: 700 }
  ];
  const fixture = createFixture(
    [hudFrame, hudFrame],
    null,
    [],
    "shadow",
    {
      channelReadyStableFrames: 2,
      channelReadyStableMs: 0,
      postLoginMinimumWaitMs: 0,
      loadingQuietMs: 0
    }
  );
  await waitForGameReady(fixture.context);
  assert.ok(fixture.captures >= 2 && fixture.captures <= 3);
  assert.match(fixture.messages.at(-1), /游戏界面已就绪/);
});

test("two bottom-left chat channel anchors confirm HUD without local-model classification", async () => {
  const channelFrame = [
    { text: "综合", x: 30, y: 1090 },
    { text: "世界", x: 120, y: 1090 },
    { text: "营地", x: 300, y: 1090 }
  ];
  const fixture = createFixture(
    [channelFrame, channelFrame],
    {
      state: "unknown",
      action: "wait",
      confidence: 0.99,
      evidence: "整页分类失败"
    },
    [],
    "shadow",
    {
      readyMinimumTexts: 2,
      channelReadyTexts: ["综合", "世界", "场景", "营地", "队伍"],
      channelReadyRegion: {
        left: 0,
        top: 980,
        right: 760,
        bottom: 1200
      },
      channelReadyMinimumTexts: 2,
      channelReadyStableFrames: 2,
      channelReadyStableMs: 1,
      postLoginMinimumWaitMs: 0,
      loadingQuietMs: 0
    }
  );
  await waitForGameReady(fixture.context);
  assert.ok(fixture.captures >= 2);
  assert.deepEqual(fixture.taps, []);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("游戏界面已就绪")
    )
  );
});

test("precise bottom-left channel OCR confirms login when general HUD OCR keeps fluctuating", async () => {
  const fixture = createFixture(
    [["背包"], ["背包"]],
    {
      state: "unknown",
      action: "wait",
      confidence: 0.99,
      evidence: "整页分类持续不稳定"
    },
    [],
    "guarded",
    {
      readyMinimumTexts: 2,
      channelReadyTexts: ["综合", "世界", "场景", "营地", "队伍"],
      channelReadyRegion: {
        left: 0,
        top: 980,
        right: 760,
        bottom: 1200
      },
      channelReadyMinimumTexts: 2,
      channelReadyStableFrames: 1,
      channelReadyStableMs: 0,
      postLoginMinimumWaitMs: 0,
      loadingQuietMs: 0
    },
    [[
      { text: "综合", x: 30, y: 1090 },
      { text: "世界", x: 120, y: 1090 },
      { text: "营地", x: 300, y: 1090 }
    ]]
  );

  await waitForGameReady(fixture.context);

  assert.ok(
    fixture.messages.some((message) =>
      message.includes("稳定多帧高精度 OCR 确认 HUD")
    )
  );
  assert.match(fixture.messages.at(-1), /游戏界面已就绪/);
});

test("merged macOS 27 channel OCR tokens confirm HUD without substring matching", async () => {
  const mergedChannelFrame = [{
    text: "世界 场景「营地“队伍 贾斯…^",
    x: 84,
    y: 1090,
    width: 326,
    height: 36
  }];
  const fixture = createFixture(
    [[], []],
    null,
    [],
    "shadow",
    {
      channelReadyStableFrames: 2,
      channelReadyStableMs: 0,
      channelReadyProbeMs: 250,
      postLoginMinimumWaitMs: 0,
      loadingQuietMs: 0
    },
    [mergedChannelFrame, mergedChannelFrame]
  );

  await waitForGameReady(fixture.context);

  assert.ok(fixture.captures >= 2);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("确认 HUD：世界、场景、营地、队伍")
    )
  );
  assert.match(fixture.messages.at(-1), /游戏界面已就绪/);
});

test("channel OCR uses its own fast probe interval instead of the full-frame cooldown", async () => {
  const channelFrame = [
    { text: "综合", x: 30, y: 1090 },
    { text: "世界", x: 120, y: 1090 },
    { text: "场景", x: 210, y: 1090 }
  ];
  const fixture = createFixture(
    [[], []],
    null,
    [],
    "shadow",
    {
      readyMinimumTexts: 2,
      channelReadyStableFrames: 2,
      channelReadyStableMs: 0,
      channelReadyProbeMs: 250,
      accurateFallbackSeconds: 5,
      postLoginMinimumWaitMs: 0,
      loadingQuietMs: 0
    },
    [channelFrame, channelFrame]
  );

  await waitForGameReady(fixture.context);

  assert.ok(fixture.captures >= 2);
  assert.match(fixture.messages.at(-1), /游戏界面已就绪/);
});

test("login legal disclaimer cannot impersonate standalone HUD channel labels", async () => {
  const legalDisclaimer = [{
    text: "本游戏世界观、故事情节及相关角色场景纯属虚构",
    x: 30,
    y: 1040,
    width: 680,
    height: 28
  }];
  const channelFrame = [
    { text: "综合", x: 30, y: 1090 },
    { text: "世界", x: 120, y: 1090 },
    { text: "场景", x: 210, y: 1090 }
  ];
  const fixture = createFixture(
    [["点击登录游戏"], [], []],
    null,
    [],
    "shadow",
    {
      channelReadyStableFrames: 2,
      channelReadyStableMs: 1_000,
      postLoginMinimumWaitMs: 0,
      loadingQuietMs: 0
    },
    [legalDisclaimer, channelFrame, channelFrame]
  );

  await waitForGameReady(fixture.context);

  assert.deepEqual(fixture.taps, [{ x: 960, y: 945 }]);
  assert.equal(
    fixture.messages.some((message) =>
      message.includes("确认 HUD：世界、场景")
    ),
    false
  );
  assert.match(fixture.messages.at(-1), /游戏界面已就绪/);
});

test("manual login still reaches HUD through bottom-left channel OCR", async () => {
  const fixture = createFixture(
    [[], []],
    null,
    [],
    "shadow",
    {
      readyMinimumTexts: 2,
      channelReadyTexts: ["综合", "世界", "场景", "营地", "队伍"],
      channelReadyRegion: { left: 0, top: 980, right: 760, bottom: 1200 },
      channelReadyMinimumTexts: 2,
      channelReadyStableFrames: 1,
      channelReadyStableMs: 0,
      postLoginMinimumWaitMs: 0,
      loadingQuietMs: 0
    },
    [[
      { text: "综合", x: 30, y: 1090 },
      { text: "世界", x: 120, y: 1090 },
      { text: "营地", x: 300, y: 1090 }
    ]]
  );
  await waitForGameReady(fixture.context);
  assert.match(fixture.messages.at(-1), /游戏界面已就绪/);
});

function createFixture(
  frames,
  modelAdvice = null,
  accurateFrames = [],
  advisorMode = "shadow",
  readyPolicy = {},
  regionalFrames = []
) {
  const taps = [];
  const touchTaps = [];
  const messages = [];
  let frameIndex = 0;
  let accurateFrameIndex = 0;
  let regionalFrameIndex = 0;
  const vision = {
    advisor: modelAdvice
      ? {
          enabled: true,
          config: {
            mode: advisorMode,
            intervalSeconds: 0.05,
            minimumConfidence: 0.9,
            minimumActionConfidence: 0.95,
            consecutiveMatches: 2
          }
        }
      : undefined,
    async captureTransient() {
      const texts = frames[Math.min(frameIndex++, frames.length - 1)];
      return {
        observations: texts.map((item) => {
          const observation =
            typeof item === "string" ? { text: item } : item;
          return {
            confidence: 1,
            x: 0,
            y: 0,
            width: 10,
            height: 10,
            ...observation
          };
        })
      };
    },
    ...(regionalFrames.length
      ? {
          async captureSource() {
            return { path: "/tmp/mock-game-ready-channel.png", observations: [] };
          },
          async ocrRegion() {
            return (
              regionalFrames[
                Math.min(regionalFrameIndex++, regionalFrames.length - 1)
              ] || []
            ).map((item) => ({
              confidence: 1,
              width: 10,
              height: 10,
              ...item
            }));
          }
        }
      : {}),
    async captureAccurateTransient() {
      const texts =
        accurateFrames[
          Math.min(accurateFrameIndex++, accurateFrames.length - 1)
        ] || [];
      if (texts instanceof Error) throw texts;
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
      return typeof modelAdvice === "function"
        ? modelAdvice()
        : modelAdvice;
    }
  };
  const context = {
    config: {
      timeouts: { gameLaunchSeconds: 5 },
      adb: { loginButton: { x: 960, y: 945 } },
      postLoginPromotions: {
        maxDismissAttemptsPerPage: 4,
        dismissRetryCooldownMs: 15_000,
        initialWaitMs: 0,
        betweenPagesMs: 0,
        dismissPoint: { x: 960, y: 1140 },
        activityPageTexts: ["推荐", "活动", "臻藏"],
        activityPageRegion: {
          left: 0,
          top: 0,
          right: 450,
          bottom: 1050
        },
        activityPageMinimumTexts: 3,
        signatureTexts: ["立即前往", "前往查看", "前往活动", "活动时间"],
        readyTexts: ["配方", "背包", "营地"],
        loadingTexts: ["加载中"],
        readyMinimumTexts: 1,
        readyStableFrames: 1,
        readyStableMs: 0,
        postLoginMinimumWaitMs: 0,
        loadingQuietMs: 0,
        ...readyPolicy
      },
      preLoginAnnouncements: {
        enabled: true,
        maxClosures: 2,
        closePoint: { x: 1742, y: 155 },
        fixedCloseIntervalSeconds: 3,
        texts: ["系统公告", "更新公告", "游戏公告", "经典服", "亲爱的幸存者"]
      },
      vision: {
        accurateFallbackSeconds:
          Number(readyPolicy.accurateFallbackSeconds) || 0.05
      }
    },
    adb: {
      async key() {},
      async gameHealth() {
        return { running: true, anr: false };
      },
      async launchGame() {},
      async releaseMouseButton() {}
    },
    ui: {
      async tap(point) {
        taps.push(point);
      },
      async androidTouchTap(point) {
        touchTaps.push(point);
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
  return {
    context,
    taps,
    touchTaps,
    messages,
    get captures() {
      return frameIndex;
    },
    get accurateCaptures() {
      return accurateFrameIndex;
    }
  };
}
