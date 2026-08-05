import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("a marked game-mouse entry skips keyevent 70 when the icon is visible", async () => {
  const fixture = createUi();
  const touchTaps = [];
  fixture.vision.gameMouseIconVisible = async () => true;
  fixture.adb.touchTap = async (x, y) => touchTaps.push({ x, y });
  let prepareCalls = 0;
  fixture.adb.prepareGameMouseForClick = async () => {
    prepareCalls += 1;
  };

  await fixture.ui.gameMouseTap({ x: 48, y: 327 });

  assert.equal(prepareCalls, 0);
  assert.deepEqual(touchTaps, [{ x: 48, y: 327 }]);
  assert.deepEqual(fixture.taps, []);
});

test("a panel touch tap never inspects the HUD game-mouse icon", async () => {
  const fixture = createUi();
  const touchTaps = [];
  fixture.vision.gameMouseIconVisible = async () => {
    throw new Error("panel has no game-mouse icon");
  };
  fixture.adb.touchTap = async (x, y) => touchTaps.push({ x, y });

  await fixture.ui.tap({ x: 1050, y: 450 });

  assert.deepEqual(touchTaps, [{ x: 1050, y: 450 }]);
  assert.deepEqual(fixture.taps, []);
});

test("an absent game-mouse icon sends keyevent 70 once, verifies it, then taps", async () => {
  const fixture = createUi();
  const states = [false, true];
  const touchTaps = [];
  const prepareCalls = [];
  fixture.vision.gameMouseIconVisible = async () => states.shift() ?? true;
  fixture.adb.prepareGameMouseForClick = async (_signal, options) => {
    prepareCalls.push(options);
  };
  fixture.adb.touchTap = async (x, y) => touchTaps.push({ x, y });

  await fixture.ui.gameMouseTap({ x: 220, y: 180 });

  assert.deepEqual(prepareCalls, [{ force: true }]);
  assert.deepEqual(touchTaps, [{ x: 220, y: 180 }]);
  assert.deepEqual(fixture.taps, []);
});

test("retry-only game-mouse fallback waits until the first panel tap fails", async () => {
  const fixture = createUi({
    fastFrames: [[], [], [observation("调整", 100, 100)]]
  });
  const states = [false, true];
  const prepareCalls = [];
  fixture.vision.gameMouseIconVisible = async () => states.shift() ?? true;
  fixture.adb.prepareGameMouseForClick = async (_signal, options) => {
    prepareCalls.push(options);
  };

  await fixture.ui.tapUntilAnyTexts({
    texts: ["调整"],
    x: 50,
    y: 325,
    maxAttempts: 2,
    intervalMs: 1,
    gameMouseOnRetry: true
  });

  assert.deepEqual(prepareCalls, [{ force: true }]);
  assert.deepEqual(fixture.taps, [
    { x: 50, y: 325 },
    { x: 50, y: 325 }
  ]);
});

test("a HUD label alone never enables game-mouse detection", async () => {
  const fixture = createUi({
    fastFrames: [[observation("调整", 100, 100)]]
  });
  fixture.vision.gameMouseIconVisible = async () => {
    throw new Error("ordinary HUD retry must not inspect the game-mouse icon");
  };

  await fixture.ui.tapUntilAnyTexts({
    texts: ["调整"],
    x: 50,
    y: 325,
    maxAttempts: 1,
    intervalMs: 1,
    controlLabel: "队伍卡片旗帜展开"
  });

  assert.deepEqual(fixture.taps, []);
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

test("a map blocking the camp panel is closed before any chat click", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("标志查看", 190, 35)],
      [observation("背包", 120, 900)],
      [observation("背包", 120, 900)],
      [
        observation("量子时代", 330, 330),
        observation("营地周活跃", 760, 320)
      ]
    ]
  });
  await fixture.ui.openCampPanelViaChat({
    attempts: 1,
    chatDelayMs: 1,
    channelDelayMs: 1,
    verifySeconds: 1
  });
  assert.deepEqual(fixture.keys, []);
  assert.deepEqual(fixture.taps, [
    { x: 1850, y: 70 },
    { x: 250, y: 1060 },
    { x: 1740, y: 355 },
    { x: 980, y: 65 }
  ]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("检测到地图遮挡")
    )
  );
});

test("camp navigation summons the game mouse once and uses ADB clicks", async () => {
  const fixture = createUi({
    transientCapture(label) {
      if (label === "camp-chat-verify-1") {
        return [observation("营地频道", 1660, 180)];
      }
      if (label.startsWith("camp-panel-verify")) {
        return [
          observation("量子时代", 330, 330),
          observation("营地周活跃", 760, 320)
        ];
      }
      return [];
    },
    mumu: null
  });
  const mouseTaps = fixture.taps;
  let summons = 0;
  let mouseReady = false;
  fixture.adb.prepareGameMouseForClick = async () => {
    if (!mouseReady) {
      summons += 1;
      mouseReady = true;
    }
  };

  await fixture.ui.openCampPanelViaChat({
    attempts: 1,
    chatReadyTexts: ["营地频道"],
    chatReadyRegion: { left: 1200, top: 100, right: 1900, bottom: 1150 },
    chatReadyMinimumTexts: 1,
    chatDelayMs: 1,
    channelDelayMs: 1,
    verifySeconds: 1
  });

  assert.equal(summons, 1);
  assert.deepEqual(mouseTaps, [
    { x: 250, y: 1060 },
    { x: 1740, y: 355 },
    { x: 980, y: 65 }
  ]);
});

test("a game-mouse entry click command failure rechecks the cursor before retrying", async () => {
  const fixture = createUi();
  const prepareCalls = [];
  let clicks = 0;
  fixture.adb.prepareGameMouseForClick = async (_signal, options = {}) => {
    prepareCalls.push(options);
  };
  fixture.adb.mouseTap = async () => {
    clicks += 1;
    if (clicks === 1) throw new Error("ADB click injection failed");
  };

  await fixture.ui.gameMouseTap({ x: 48, y: 327 });

  assert.deepEqual(prepareCalls, [{}, { force: true }]);
  assert.equal(clicks, 2);
  assert.ok(
    fixture.messages.some((message) => message.includes("图标"))
  );
});

test("camp navigation retries ADB clicks without toggling the game mouse", async () => {
  const fixture = createUi({
    transientCapture(label) {
      if (label === "camp-panel-verify-3") {
        return [
          observation("量子时代", 330, 330),
          observation("营地周活跃", 760, 320)
        ];
      }
      return [];
    }
  });
  let summons = 0;
  let mouseReady = false;
  fixture.adb.prepareGameMouseForClick = async () => {
    if (!mouseReady) {
      summons += 1;
      mouseReady = true;
    }
  };

  await fixture.ui.openCampPanelViaChat({
    attempts: 3,
    chatDelayMs: 1,
    channelDelayMs: 1,
    verifySeconds: 1
  });

  assert.equal(summons, 1);
  assert.equal(fixture.taps.length, 9);
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
    { x: 1850, y: 70 },
    { x: 1700, y: 1040 }
  ]);
  assert.deepEqual(fixture.keys, []);
});

test("an NPC interaction menu is HUD context, not a map-blocking overlay", async () => {
  const fixture = createUi({
    fastFrames: [
      [
        observation("查看玩法", 1320, 690),
        observation("营地巡逻", 1320, 750),
        observation("营地竞赛", 1320, 810)
      ]
    ]
  });
  const result = await fixture.ui.closePagesBeforeMap(
    { mapPreparationMaxClosures: 6, mapReadyTexts: ["标志查看"] }
  );
  assert.equal(result, "hud");
  assert.deepEqual(fixture.taps, []);
  assert.deepEqual(fixture.keys, []);
});

test("bottom-left channels plus an NPC menu never collapse or open camp chat", async () => {
  const fixture = createUi({
    fastFrames: [
      [
        observation("综合", 40, 1080),
        observation("世界", 110, 1080),
        observation("场景", 180, 1080),
        observation("营地", 250, 1080),
        observation("队伍", 320, 1080),
        observation("查看玩法", 1320, 690),
        observation("营地巡逻", 1320, 750),
        observation("交谈", 1320, 810),
        observation("收起", 1700, 1030)
      ]
    ]
  });
  const result = await fixture.ui.closePagesBeforeMap(
    { mapPreparationMaxClosures: 6, mapReadyTexts: ["标志查看"] }
  );
  assert.equal(result, "hud");
  assert.deepEqual(fixture.taps, []);
  assert.deepEqual(fixture.keys, []);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("右侧没有深灰色聊天大框")
    )
  );
});

test("1920x1200 map flow closes every overlay and opens map with M after input focus", async () => {
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
        observation("收起", 1700, 1040)
      ],
      [observation("背包", 120, 900)],
      [observation("标志查看", 260, 150)]
    ]
  });
  await fixture.ui.ensureMapOpen({
    mapKey: "KEYCODE_M",
    mapReadyTexts: ["标志查看"],
    mapPreparationMaxClosures: 6,
    mapOpenPollMs: 1
  });
  assert.deepEqual(fixture.taps, [
    { x: 1850, y: 70 },
    { x: 1710, y: 1050 }
  ]);
  assert.deepEqual(fixture.keys, ["KEYCODE_M"]);
  assert.deepEqual(fixture.focusPoints.at(-1), { x: 1782, y: 128 });
});

test("M is the primary map action and still requires map OCR", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("背包", 120, 900)],
      [],
      [observation("标志查看", 260, 150)]
    ]
  });
  await fixture.ui.ensureMapOpen({
    mapButton: { x: 1780, y: 120 },
    mapKey: "KEYCODE_M",
    mapButtonFallbackDelayMs: 30_000,
    mapReadyTexts: ["标志查看"],
    mapPreparationMaxClosures: 2,
    mapOpenPollMs: 1
  });
  assert.deepEqual(fixture.taps, []);
  assert.deepEqual(fixture.keys, ["KEYCODE_M"]);
  assert.deepEqual(fixture.focusPoints, [{ x: 1780, y: 120 }]);
});

test("map click fallback uses the calibrated minimap center, never the camera button", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("背包", 120, 900)],
      [],
      [observation("标志查看", 260, 150)]
    ]
  });

  await fixture.ui.ensureMapOpen({
    mapButton: { x: 1782, y: 128 },
    mapKey: "KEYCODE_M",
    mapButtonFallbackDelayMs: 0,
    mapReadyTexts: ["标志查看"],
    mapPreparationMaxClosures: 2,
    mapOpenPollMs: 1
  });

  assert.deepEqual(fixture.keys, ["KEYCODE_M"]);
  assert.deepEqual(fixture.taps, [{ x: 1782, y: 128 }]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("右上角圆盘中心")
    )
  );
});

test("a model map prediction never unlocks destination clicks without the top-left marker", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("背包", 120, 900)],
      [],
      [observation("标志查看", 260, 150)]
    ],
    generalAdvice: {
      state: "map",
      confidence: 0.99,
      evidence: "模型误判地图"
    }
  });
  await fixture.ui.ensureMapOpen({
    mapButton: { x: 1780, y: 120 },
    mapKey: "KEYCODE_M",
    mapButtonFallbackDelayMs: 30_000,
    mapReadyTexts: ["标志查看", "查看庄园"],
    mapPreparationMaxClosures: 2,
    mapOpenPollMs: 1
  });
  assert.deepEqual(fixture.taps, []);
  assert.deepEqual(fixture.keys, ["KEYCODE_M"]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("模型地图候选仅供记录")
    )
  );
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("已通过地图固定文字确认")
    )
  );
});

test("map opening retries M after the OCR verification window", async () => {
  const fixture = createUi({
    fastFrames: [[observation("背包", 120, 900)], []]
  });
  await assert.rejects(
    fixture.ui.ensureMapOpen({
      mapButton: { x: 1780, y: 120 },
      mapKey: "KEYCODE_M",
      mapButtonFallbackDelayMs: 30_000,
      mapKeyRetryAttempts: 2,
      mapOpenTimeoutSeconds: 1,
      mapReadyTexts: ["标志查看"],
      mapPreparationMaxClosures: 2,
      mapOpenPollMs: 1
    }),
    /MAP_DID_NOT_OPEN/
  );
  assert.deepEqual(fixture.keys, ["KEYCODE_M", "KEYCODE_M"]);
  assert.deepEqual(fixture.focusPoints, [
    { x: 1780, y: 120 },
    { x: 1780, y: 120 }
  ]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("仍未在左上角 OCR 识别“标志查看”")
    )
  );
});

test("a non-marker map text never confirms map opening", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("背包", 120, 900)],
      [observation("查看庄园", 260, 150)],
      [observation("标志查看", 900, 150)],
      [observation("标志查看", 260, 150)]
    ]
  });
  await fixture.ui.ensureMapOpen({
    mapKey: "KEYCODE_M",
    mapButtonFallbackDelayMs: 30_000,
    mapReadyTexts: ["标志查看", "查看庄园"],
    mapPreparationMaxClosures: 2,
    mapOpenPollMs: 1
  });
  assert.deepEqual(fixture.keys, ["KEYCODE_M"]);
});

test("map preparation permits only a high-confidence AI safe close control", async () => {
  const fixture = createUi({
    fastFrames: [[], [observation("背包", 120, 900)]],
    overlayAdvice: {
      control: "close_x",
      confidence: 0.97,
      evidence: "右上角关闭X"
    },
    generalAdvice: {
      state: "panel",
      confidence: 0.99,
      evidence: "功能窗口"
    }
  });
  const result = await fixture.ui.closePagesBeforeMap(
    { mapPreparationMaxClosures: 2, mapReadyTexts: ["标志查看"] }
  );
  assert.equal(result, "hud");
  assert.deepEqual(fixture.taps, [{ x: 1850, y: 70 }]);
});

test("overlay AI keeps a 0.95 safety floor when the general model threshold is lower", async () => {
  const fixture = createUi({
    fastFrames: [[]],
    overlayAdvice: {
      control: "close_x",
      confidence: 0.9,
      evidence: "疑似右上角关闭X"
    },
    minimumActionConfidence: 0.7
  });
  const result = await fixture.ui.closePagesBeforeMap(
    { mapPreparationMaxClosures: 2, mapReadyTexts: ["标志查看"] }
  );
  assert.equal(result, "unverified");
  assert.deepEqual(fixture.taps, []);
  assert.deepEqual(fixture.keys, []);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("未识别到需要关闭的窗口")
    )
  );
});

test("unknown HUD never triggers blind back clicks before opening the map", async () => {
  const fixture = createUi({
    fastFrames: [[]],
    generalAdvice: {
      state: "unknown",
      confidence: 0.99,
      evidence: "OCR 未读到 HUD 字样"
    }
  });
  const result = await fixture.ui.closePagesBeforeMap(
    { mapPreparationMaxClosures: 6, mapReadyTexts: ["标志查看"] }
  );
  assert.equal(result, "unverified");
  assert.deepEqual(fixture.taps, []);
  assert.deepEqual(fixture.keys, []);
});

test("an accurately recognized open map is never mistaken for an X overlay", async () => {
  const fixture = createUi({
    fastFrames: [[]],
    accurateFrames: [[observation("标志查看", 260, 150)]],
    overlayAdvice: {
      control: "close_x",
      confidence: 0.99,
      evidence: "右上角存在 X"
    },
    generalAdvice: {
      state: "panel",
      confidence: 0.99,
      evidence: "疑似窗口"
    }
  });
  const result = await fixture.ui.closePagesBeforeMap(
    { mapPreparationMaxClosures: 6, mapReadyTexts: ["标志查看"] }
  );
  assert.equal(result, "map");
  assert.deepEqual(fixture.taps, []);
  assert.deepEqual(fixture.keys, []);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("地图原本就已打开")
    )
  );
});

test("an activity page found only by accurate OCR is closed with the calibrated back button", async () => {
  const fixture = createUi({
    fastFrames: [[], [observation("背包", 120, 900)]],
    accurateFrames: [
      [observation("在线情况", 1560, 230)],
      []
    ]
  });
  const result = await fixture.ui.closePagesBeforeMap(
    { mapPreparationMaxClosures: 2, mapReadyTexts: ["标志查看"] }
  );
  assert.equal(result, "hud");
  assert.deepEqual(fixture.taps, [{ x: 80, y: 1080 }]);
});

test("city-hall data and sand-table pages both close through the bottom-left back button", async () => {
  const fixture = createUi({
    fastFrames: [
      [
        observation("一周贡献", 1470, 225),
        observation("贡献物资", 1800, 225)
      ],
      [
        observation("时代信息", 130, 350),
        observation("成员信息", 840, 350),
        observation("财政信息", 1050, 700)
      ],
      [observation("背包", 120, 900)]
    ]
  });
  const result = await fixture.ui.closePagesBeforeMap(
    { mapPreparationMaxClosures: 3, mapReadyTexts: ["标志查看"] }
  );
  assert.equal(result, "hud");
  assert.deepEqual(fixture.taps, [
    { x: 80, y: 1080 },
    { x: 80, y: 1080 }
  ]);
});

test("destination verification walks forward only until the interaction text appears", async () => {
  const fixture = createUi({
    fastFrames: [
      [],
      [observation("营地管理", 1370, 715)]
    ]
  });
  const verified = await fixture.ui.verifyDestination(
    {
      name: "市政厅",
      approachUntilReady: true,
      approachMaxSteps: 8,
      readyTexts: ["营地数据中心", "营地管理"],
      readyRegion: { left: 1180, top: 540, right: 1580, bottom: 820 }
    }
  );
  assert.equal(verified, true);
  assert.deepEqual(fixture.keys, ["KEYCODE_W"]);
  assert.deepEqual(fixture.focusPoints, [{ x: 960, y: 600 }]);
  assert.deepEqual(fixture.taps, []);
});

test("destination approach sends five W presses per round and stops after six rounds", async () => {
  const fixture = createUi({
    fastFrames: Array.from({ length: 7 }, () => [])
  });
  const startedAt = Date.now();
  const verified = await fixture.ui.verifyDestination(
    {
      name: "公告版",
      approachUntilReady: true,
      approachMaxRounds: 12,
      approachPressesPerRound: 5,
      approachIntervalMs: 250,
      readyTexts: ["查看玩法", "营地巡逻"],
      readyRegion: { left: 1180, top: 540, right: 1580, bottom: 900 }
    }
  );
  assert.equal(verified, false);
  assert.deepEqual(
    fixture.keys,
    Array.from({ length: 6 }, () => "KEYCODE_W")
  );
  assert.deepEqual(
    fixture.keyCalls,
    Array.from({ length: 6 }, () => ({
      code: "KEYCODE_W",
      options: { repeat: 5 }
    }))
  );
  assert.deepEqual(
    fixture.focusPoints,
    Array.from({ length: 6 }, () => ({ x: 960, y: 600 }))
  );
  assert.ok(Date.now() - startedAt >= 1_500);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("每轮连续按 5 次，最多 6 轮")
    )
  );
});

test("destination approach uses only five held-W rounds and never drags the joystick", async () => {
  const fixture = createUi({
    fastFrames: Array.from({ length: 6 }, () => [])
  });
  const verified = await fixture.ui.verifyDestination({
    name: "公告版",
    approachUntilReady: true,
    approachMaxRounds: 5,
    approachIntervalMs: 250,
    approachFallbackKey: "KEYCODE_W",
    approachFallbackMaxRounds: 5,
    approachFallbackHoldMs: 900,
    approachFallbackIntervalMs: 250,
    readyTexts: ["营地巡逻"],
    readyRegion: { left: 1180, top: 300, right: 1920, bottom: 1050 }
  });

  assert.equal(verified, false);
  assert.equal(fixture.approachActions.includes("swipe"), false);
  assert.equal(fixture.swipes.length, 0);
  assert.deepEqual(fixture.keys, Array.from({ length: 5 }, () => "KEYCODE_W"));
  assert.deepEqual(
    fixture.holds,
    Array.from({ length: 5 }, () => ({ code: "KEYCODE_W", durationMs: 900 }))
  );
});

test("failed destination approach recovers through center exit up to the target again", async () => {
  const fixture = createUi();
  const calls = [];
  const results = [
    { state: "nearby", text: "寻路后仍无交互" },
    { state: "nearby", text: "已在中心出入口" },
    { state: "nearby", text: "第一次返回仍无交互" },
    { state: "nearby", text: "已在中心出入口" },
    { state: "success", text: "营地巡逻" }
  ];
  fixture.ui.attemptTeleport = async (_action, destination) => {
    calls.push(destination.name);
    return results.shift();
  };

  const result = await fixture.ui.teleportWithFallback({
    target: { name: "公告版" },
    fallback: { name: "中心出入口" },
    fallbackMaxAttempts: 6,
    cooldownSeconds: 0
  });

  assert.equal(result.state, "success");
  assert.deepEqual(calls, [
    "公告版",
    "中心出入口",
    "公告版",
    "中心出入口",
    "公告版"
  ]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("第 2/6 次寻路恢复")
    )
  );
});

test("destination recovery never exceeds six center-target cycles", async () => {
  const fixture = createUi();
  const calls = [];
  fixture.ui.attemptTeleport = async (_action, destination) => {
    calls.push(destination.name);
    return { state: "nearby", text: "仍未出现交互" };
  };

  await assert.rejects(
    fixture.ui.teleportWithFallback({
      target: { name: "公告版" },
      fallback: { name: "中心出入口" },
      fallbackMaxAttempts: 99,
      cooldownSeconds: 0
    }),
    /after 6 recovery attempts/
  );
  assert.equal(calls.filter((name) => name === "中心出入口").length, 6);
  assert.equal(calls.filter((name) => name === "公告版").length, 7);
});

test("HUD panel close retries ADB clicks without container mouse release", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("调整", 80, 40)],
      [observation("调整", 80, 40)],
      []
    ],
    accurateFrames: [[], [], []]
  });
  await fixture.ui.tapUntilNoneTexts({
    texts: ["调整", "离开队伍"],
    region: { left: 0, top: 0, right: 1920, bottom: 1200 },
    x: 48,
    y: 327,
    maxAttempts: 6,
    intervalMs: 200,
    hud: true
  });

  assert.deepEqual(fixture.taps, [
    { x: 48, y: 327 },
    { x: 48, y: 327 }
  ]);
});

test("patrol team close waits, closes accidental camp chat, then verifies HUD", async () => {
  const fixture = createUi({
    fastFrames: [
      [
        observation("综合", 40, 1080),
        observation("营地", 250, 1080),
        observation("营地频道", 1400, 130),
        observation("成员", 1500, 130),
        observation("收起", 1700, 1040)
      ],
      [
        observation("综合", 40, 1080),
        observation("世界", 110, 1080),
        observation("营地", 250, 1080),
        observation("查看玩法", 1320, 690)
      ]
    ],
    accurateFrames: [[], []]
  });

  await fixture.ui.closePatrolTeamPanelBeforeAccept({
    x: 74,
    y: 1110,
    hud: true,
    settleAfterClickMs: 5000,
    collapseSettleMs: 1000
  });

  assert.deepEqual(fixture.taps, [
    { x: 74, y: 1110 },
    { x: 1710, y: 1050 }
  ]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("误打开了营地聊天")
    )
  );
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("右下角未显示“收起”")
    )
  );
});

test("patrol team close accepts stale leave-team OCR when HUD is already visible", async () => {
  const fixture = createUi({
    fastFrames: [[
      observation("调整", 80, 40),
      observation("离开队伍", 1520, 1080),
      observation("综合", 40, 1080),
      observation("世界", 110, 1080)
    ]]
  });

  await fixture.ui.closePatrolTeamPanelBeforeAccept({
    x: 74,
    y: 1110,
    hud: true,
    settleAfterClickMs: 1,
    collapseSettleMs: 1
  });

  assert.deepEqual(fixture.taps, [{ x: 74, y: 1110 }]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("OCR 仍残留“调整/离开队伍”文字")
    )
  );
});

test("patrol result exit uses the calibrated HUD return arrow until bottom HUD anchors appear", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("巡逻路线", 900, 200)],
      [
        observation("综合", 40, 1080),
        observation("营地", 220, 1080)
      ],
      [
        observation("综合", 40, 1080),
        observation("营地", 220, 1080)
      ]
    ],
    accurateFrames: [[], []]
  });

  await fixture.ui.tapUntilAnyTexts({
    texts: ["综合", "世界", "场景", "营地", "队伍"],
    minimumTexts: 2,
    minimumTapsBeforeSuccess: 2,
    region: { left: 0, top: 980, right: 760, bottom: 1200 },
    x: 75,
    y: 1120,
    maxAttempts: 6,
    intervalMs: 200,
    hud: true
  });

  assert.deepEqual(fixture.taps, [
    { x: 75, y: 1120 },
    { x: 75, y: 1120 }
  ]);
});

test("a stable post-teleport HUD advances to W-based destination verification", async () => {
  const fixture = createUi({
    fastFrames: [
      [
        observation("综合", 40, 1080),
        observation("营地", 220, 1080)
      ]
    ]
  });
  const result = await fixture.ui.waitTeleportResult(
    ["查看玩法", "营地巡逻"],
    ["已在目标点附近"],
    30
  );
  assert.equal(result.state, "arrived_hud");
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("立即按 W 分段接近")
    )
  );
});

test("waitAnyText accepts accurate OCR before asking the model again", async () => {
  const fixture = createUi({
    fastFrames: [[]],
    accurateFrames: [[observation("在线情况", 1560, 230)]]
  });
  const found = await fixture.ui.waitAnyText(
    ["在线情况", "所在场景"],
    { timeoutSeconds: 1 }
  );
  assert.equal(found.text, "在线情况");
  assert.equal(found.accurateOcr, true);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("高精度 OCR 确认界面文字")
    )
  );
});

test("strict waitAnyText timeout returns control for retryable patrol states", async () => {
  const fixture = createUi({ fastFrames: [[]], accurateFrames: [[]] });
  fixture.ui.config.timeouts.neverAbortHealthyTaskOnTimeout = true;
  fixture.ui.config.timeouts.screenTransitionSeconds = 0.01;

  await assert.rejects(
    fixture.ui.waitAnyText(
      ["已经拥有巡逻路线"],
      { timeoutSeconds: 0.01, strictTimeout: true }
    ),
    /Timed out waiting for/
  );
  assert.equal(
    fixture.messages.some((message) => message.includes("继续等待界面文字")),
    false
  );
});

test("clickText uses accurate OCR before waiting indefinitely", async () => {
  const fixture = createUi({
    fastFrames: [[]],
    accurateFrames: [[observation("接取", 1730, 940)]]
  });
  fixture.ui.config.timeouts.screenTransitionSeconds = 1;
  fixture.ui.config.timeouts.neverAbortHealthyTaskOnTimeout = false;

  await fixture.ui.clickText("接取", {
    mode: "exact",
    region: { left: 1450, top: 820, right: 1920, bottom: 1120 },
    timeoutSeconds: 1
  });

  assert.deepEqual(fixture.taps, [{ x: 1740, y: 950 }]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("全屏高精度 OCR")
    )
  );
});

test("open-patrol navigation clicks below the verified notice-board anchor when patrol OCR is missed", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("查看玩法", 1360, 720)],
      [observation("困难巡逻路线", 1500, 250)]
    ]
  });
  const result = await fixture.ui.clickTextsUntilAnyText({
    clickTexts: ["营地巡逻", "交谈", "查看巡逻进度"],
    targetTexts: ["简单巡逻路线", "普通巡逻路线", "困难巡逻路线"],
    clickRegion: { left: 1200, top: 640, right: 1520, bottom: 1010 },
    anchorClickFallbacks: [
      {
        anchorText: "查看玩法",
        targetText: "营地巡逻",
        offsetY: 75
      }
    ],
    timeoutSeconds: 1,
    intervalMs: 1
  });
  assert.equal(result.text, "困难巡逻路线");
  assert.deepEqual(fixture.taps, [{ x: 1370, y: 805 }]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("点击其相邻的“营地巡逻”按钮")
    )
  );
});

test("open-patrol navigation can use the notice-board title as the patrol-button anchor", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("营地公告版", 1360, 620)],
      [observation("困难巡逻路线", 1500, 250)]
    ]
  });
  const result = await fixture.ui.clickTextsUntilAnyText({
    clickTexts: ["营地巡逻", "交谈", "查看巡逻进度"],
    targetTexts: ["简单巡逻路线", "普通巡逻路线", "困难巡逻路线"],
    clickRegion: { left: 1200, top: 540, right: 1520, bottom: 1010 },
    anchorClickFallbacks: [
      {
        anchorText: "营地公告版",
        targetText: "营地巡逻",
        offsetY: 140
      }
    ],
    timeoutSeconds: 1,
    intervalMs: 1
  });
  assert.equal(result.text, "困难巡逻路线");
  assert.deepEqual(fixture.taps, [{ x: 1370, y: 770 }]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("点击其相邻的“营地巡逻”按钮")
    )
  );
});

test("NPC patrol navigation advances to progress instead of clicking talk repeatedly", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("交谈", 1360, 720)],
      [
        observation("交谈", 1360, 720),
        observation("查看巡逻队当前进程", 1360, 810)
      ],
      [observation("困难巡逻路线", 1500, 250)]
    ]
  });
  const result = await fixture.ui.clickTextsUntilAnyText({
    clickTexts: [
      "查看巡逻队当前进程",
      "查看巡逻进度",
      "营地巡逻",
      "交谈"
    ],
    targetTexts: ["简单巡逻路线", "普通巡逻路线", "困难巡逻路线"],
    clickRegion: { left: 1200, top: 540, right: 1520, bottom: 1010 },
    timeoutSeconds: 1,
    intervalMs: 1
  });
  assert.equal(result.text, "困难巡逻路线");
  assert.deepEqual(fixture.taps, [
    { x: 1370, y: 730 },
    { x: 1370, y: 820 }
  ]);
});

test("hard patrol flow clicks the difficult-row accept button and confirms it", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    const flow = config.flows.startHardPatrol;
    assert.equal(flow[1].op, "clickText");
    assert.equal(flow[1].text, "接取");
    assert.equal(flow[3].op, "clickText");
    assert.equal(flow[3].text, "确定");
    assert.equal(flow[3].mode, "includes");
    assert.equal(flow[5].op, "clickIfText");
    assert.equal(flow[5].text, "确定");
    assert.equal(flow[5].mode, "includes");
    assert.deepEqual(flow.at(-1), {
      op: "waitAnyText",
      texts: ["已经拥有巡逻路线"],
      timeoutSeconds: 15,
      strictTimeout: true
    });
    assert.deepEqual(flow[1].region, {
      left: 1450,
      top: 820,
      right: 1920,
      bottom: 1120
    });
    assert.equal(
      flow.some((action) =>
        action.op === "tap" && action.x === 1770 && action.y === 995
      ),
      false
    );
  }
});

test("open team panel retries the flag expansion until the team card is visible", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    assert.deepEqual(config.flows.openTeamPanel[2], {
      op: "tapUntilAnyTexts",
      texts: ["调整", "离开队伍"],
      minimumTexts: 1,
      x: 50,
      y: 325,
      maxAttempts: 6,
      intervalMs: 500,
      hud: true,
      gameMouse: true,
      controlLabel: "队伍卡片旗帜展开"
    });
  }
});

test("patrol result exit and book-defense adjustment use calibrated HUD controls", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    assert.deepEqual(config.flows.exitPatrolPages, [
      {
        op: "tapUntilAnyTexts",
        texts: ["综合", "世界", "场景", "营地", "队伍"],
        minimumTexts: 2,
        minimumTapsBeforeSuccess: 2,
        region: { left: 0, top: 980, right: 760, bottom: 1200 },
        x: 75,
        y: 1120,
        maxAttempts: 6,
        intervalMs: 500,
        hud: true,
        controlLabel: "巡逻页左下角返回箭头"
      }
    ]);
    assert.deepEqual(config.flows.switchToBookDefense[1], {
      op: "tapUntilAnyTexts",
      texts: ["调整队伍目标"],
      minimumTexts: 1,
      x: 105,
      y: 49,
      maxAttempts: 4,
      intervalMs: 700,
      hud: true,
      controlLabel: "队伍页左上角调整按钮"
    });
  }
});

test("full patrol team closes through the calibrated bottom-left return arrow", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    assert.deepEqual(config.flows.closeTeamPanel, [
      {
        op: "tapUntilNoneTexts",
        texts: ["调整", "离开队伍"],
        x: 74,
        y: 1110,
        controlLabel: "队伍页左下角返回箭头",
        region: { left: 0, top: 0, right: 1920, bottom: 1200 },
        maxAttempts: 6,
        intervalMs: 500,
        hud: true
      }
    ]);
  }
});

test("patrol acceptance uses the guarded close flow with a five-second settle", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    assert.deepEqual(config.flows.closePatrolTeamPanelBeforeAccept, [
      {
        op: "closePatrolTeamPanelBeforeAccept",
        x: 74,
        y: 1110,
        hud: true,
        panelTexts: ["调整", "离开队伍"],
        hudTexts: ["综合", "世界", "场景", "营地", "队伍"],
        hudRegion: { left: 0, top: 930, right: 760, bottom: 1200 },
        minimumHudTexts: 2,
        collapseText: "收起",
        collapseRegion: { left: 1450, top: 850, right: 1900, bottom: 1150 },
        collapsePoint: { x: 1740, y: 1110 },
        chatTexts: ["营地频道", "成员", "私聊", "萌芽邀约", "聊天室"],
        chatRegion: { left: 1200, top: 100, right: 1900, bottom: 1150 },
        settleAfterClickMs: 5000,
        collapseSettleMs: 1500
      }
    ]);
  }
});

test("post-login click flows use input keyevent 70 and no host release config", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    assert.equal(config.adb.gameMouseToggleKey, 70);
    assert.equal(config.adb.gameMouseToggleSettleMs, 350);
    assert.equal(Object.hasOwn(config.mumu, "hostMouseUnlock"), false);
    assert.equal(
      Object.hasOwn(config.flows.openCampPanel[0], "hostMouseUnlockBeforeCampChannel"),
      false
    );
    assert.equal(Object.hasOwn(config.patrolTeamUi, "hostMouseUnlockBeforeCreate"), false);
  }
});

test("both city-hall data tasks enter the sand table with F, never a HUD mouse click", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    assert.deepEqual(config.flows.navigateToSandTable[0], {
      op: "key",
      code: "KEYCODE_W",
      longPress: true,
      repeat: 3
    });
    assert.deepEqual(config.flows.navigateToSandTable[1], {
      op: "waitAnyText",
      texts: ["营地管理", "营地数据中心"],
      region: { left: 1180, top: 540, right: 1580, bottom: 820 },
      timeoutSeconds: 12
    });
    assert.deepEqual(config.flows.navigateToSandTable[2], {
      op: "key",
      code: "KEYCODE_F",
      longPress: false
    });
    assert.equal(
      config.flows.navigateToSandTable.some((action) => action.op === "tap"),
      false
    );
  }
});

test("notice-board recovery accepts a stable fallback HUD without an impossible left-side text region", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    const [teleport] = config.flows.teleportNoticeBoard;
    assert.equal(teleport.fallback.name, "中心出入口");
    assert.equal(
      Object.hasOwn(teleport.fallback, "readyRegion"),
      false
    );
  }
});

test("city-hall data tasks use the same held-W approach fallback as patrol", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    const [teleport] = config.flows.teleportCityHall;
    assert.equal(teleport.target.approachFallbackKey, "KEYCODE_W");
    assert.equal(teleport.target.approachFallbackMaxRounds, 5);
    assert.equal(teleport.target.approachFallbackHoldMs, 900);
    assert.equal(teleport.target.approachFallbackIntervalMs, 2000);
    assert.equal(teleport.fallback.name, "中心出入口");
  }
});

function createUi({
  fastFrames = [[]],
  accurateFrames = [[]],
  transientCapture = null,
  mumu = null,
  overlayAdvice = null,
  generalAdvice = null,
  minimumActionConfidence = 0.95
} = {}) {
  const taps = [];
  const keys = [];
  const keyCalls = [];
  const focusPoints = [];
  const swipes = [];
  const holds = [];
  const approachActions = [];
  const messages = [];
  let fastIndex = 0;
  let accurateIndex = 0;
  const vision = {
    advisor: overlayAdvice || generalAdvice
      ? {
          enabled: true,
          config: {
            mode: "guarded",
            minimumActionConfidence
          }
        }
      : undefined,
    async captureTransient(label) {
      if (typeof transientCapture === "function") {
        return { observations: transientCapture(label) || [] };
      }
      return {
        observations:
          fastFrames[Math.min(fastIndex++, fastFrames.length - 1)] || []
      };
    },
    async capture() {
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
      return generalAdvice;
    },
    find(observations, query) {
      return observations.find((item) => item.text.includes(query));
    }
  };
  const adb = {
    async mouseTap(x, y) {
      taps.push({ x, y });
    },
    async key(code, _signal, options = {}) {
      keys.push(code);
      keyCalls.push({ code, options });
      approachActions.push("key");
    },
    async focusGameInput(x, y) {
      focusPoints.push({ x, y });
    },
    async touchSwipe(from, to, durationMs) {
      swipes.push({ from, to, durationMs });
      approachActions.push("swipe");
    },
    async holdKey(code, durationMs) {
      holds.push({ code, durationMs });
      approachActions.push("hold");
    }
  };
  const ui = new GameUi(
    { timeouts: { actionDelayMs: 0 } },
    adb,
    vision,
    async (_level, _step, message) => messages.push(message),
    mumu
  );
  return {
    ui,
    adb,
    vision,
    taps,
    keys,
    keyCalls,
    focusPoints,
    swipes,
    holds,
    approachActions,
    messages
  };
}

function observation(text, x, y) {
  return { text, confidence: 1, x, y, width: 20, height: 20 };
}
