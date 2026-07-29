import test from "node:test";
import assert from "node:assert/strict";
import { GameUi } from "../src/ui.mjs";

test("camp page is recognized by two stable, region-bound anchors", () => {
  const ui = createUi().ui;
  assert.equal(
    ui.isCampPanel([
      observation("量子时代", 330, 330),
      observation("营地周活跃", 760, 320)
    ]),
    true
  );
});

test("dynamic camp content alone never confirms the camp page", () => {
  const ui = createUi().ui;
  assert.equal(
    ui.isCampPanel([
      observation("参与活动", 1600, 390),
      observation("前往庄园", 1660, 540),
      observation("欢迎参观", 1250, 540)
    ]),
    false
  );
});

test("accurate Chinese OCR can confirm a camp page missed by fast OCR", async () => {
  const fixture = createUi({
    fastFrames: [[], []],
    accurateFrames: [
      [],
      [
        observation("营地", 150, 145),
        observation("市长：雨梦", 260, 450)
      ]
    ]
  });
  await fixture.ui.openCampPanelViaChat({
    attempts: 1,
    verifySeconds: 1,
    chatDelayMs: 1,
    channelDelayMs: 1
  });
  assert.deepEqual(fixture.taps, [
    { x: 250, y: 1060 },
    { x: 1740, y: 355 },
    { x: 980, y: 65 }
  ]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("高精度中文 OCR")
    )
  );
});

test("an already-open camp page is confirmed before any click", async () => {
  const fixture = createUi({
    fastFrames: [[]],
    accurateFrames: [[
      observation("量子时代", 330, 330),
      observation("营地周活跃", 760, 320)
    ]]
  });
  await fixture.ui.openCampPanelViaChat({ attempts: 1 });
  assert.deepEqual(fixture.taps, []);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("原本就已打开")
    )
  );
});

test("map preparation closes the camp page, collapses chat, then confirms HUD", async () => {
  const fixture = createUi({
    fastFrames: [
      [
        observation("首页", 450, 180),
        observation("玩法", 700, 180),
        observation("成员", 1150, 180)
      ],
      [
        observation("营地", 1660, 360),
        observation("世界", 1660, 220),
        observation("收起", 1690, 1030)
      ],
      [observation("背包", 120, 900)]
    ]
  });
  const result = await fixture.ui.closePagesBeforeMap(
    { mapPreparationMaxClosures: 6, mapReadyTexts: ["标志查看"] }
  );
  assert.equal(result, "hud");
  assert.deepEqual(fixture.taps, [
    { x: 1750, y: 145 },
    { x: 1700, y: 1040 }
  ]);
  assert.deepEqual(fixture.keys, []);
});

test("map preparation permits only a high-confidence AI safe close control", async () => {
  const fixture = createUi({
    fastFrames: [[], [observation("背包", 120, 900)]],
    overlayAdvice: {
      control: "close_x",
      confidence: 0.97,
      evidence: "右上角关闭X"
    }
  });
  const result = await fixture.ui.closePagesBeforeMap(
    { mapPreparationMaxClosures: 2, mapReadyTexts: ["标志查看"] }
  );
  assert.equal(result, "hud");
  assert.deepEqual(fixture.taps, [{ x: 1750, y: 145 }]);
});

function createUi({
  fastFrames = [[]],
  accurateFrames = [[]],
  overlayAdvice = null
} = {}) {
  const taps = [];
  const keys = [];
  const messages = [];
  let fastIndex = 0;
  let accurateIndex = 0;
  const vision = {
    advisor: overlayAdvice
      ? {
          enabled: true,
          config: {
            mode: "guarded",
            minimumActionConfidence: 0.95
          }
        }
      : undefined,
    async captureTransient() {
      return {
        observations:
          fastFrames[Math.min(fastIndex++, fastFrames.length - 1)] || []
      };
    },
    async captureAccurateTransient() {
      return {
        observations:
          accurateFrames[
            Math.min(accurateIndex++, accurateFrames.length - 1)
          ] || []
      };
    },
    async adviseOverlayControlCurrent() {
      return overlayAdvice;
    },
    async adviseCurrent() {
      return null;
    },
    find(observations, query) {
      return observations.find((item) => item.text.includes(query));
    }
  };
  const adb = {
    async mouseTap(x, y) {
      taps.push({ x, y });
    },
    async key(code) {
      keys.push(code);
    }
  };
  const ui = new GameUi(
    { timeouts: { actionDelayMs: 0 } },
    adb,
    vision,
    async (_level, _step, message) => messages.push(message)
  );
  return { ui, taps, keys, messages };
}

function observation(text, x, y) {
  return { text, confidence: 1, x, y, width: 20, height: 20 };
}
