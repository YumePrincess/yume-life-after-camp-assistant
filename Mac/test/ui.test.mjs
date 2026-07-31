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
  assert.deepEqual(fixture.keys, ["KEYCODE_M"]);
  assert.deepEqual(fixture.taps, [
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

test("a model map prediction never unlocks destination clicks without map OCR", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("背包", 120, 900)],
      [],
      [observation("查看庄园", 260, 150)]
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

test("destination approach uses five upward joystick drags then five held-W fallbacks", async () => {
  const fixture = createUi({
    fastFrames: Array.from({ length: 11 }, () => [])
  });
  const verified = await fixture.ui.verifyDestination({
    name: "公告版",
    approachUntilReady: true,
    approachMaxRounds: 5,
    approachGesture: {
      from: { x: 480, y: 600 },
      to: { x: 480, y: 360 },
      durationMs: 1_500
    },
    approachIntervalMs: 250,
    approachFallbackKey: "KEYCODE_W",
    approachFallbackMaxRounds: 5,
    approachFallbackHoldMs: 1_500,
    approachFallbackIntervalMs: 250,
    readyTexts: ["营地巡逻"],
    readyRegion: { left: 1180, top: 300, right: 1920, bottom: 1050 }
  });

  assert.equal(verified, false);
  assert.equal(fixture.swipes.length, 5);
  assert.deepEqual(
    fixture.swipes,
    Array.from({ length: 5 }, () => ({
      from: { x: 480, y: 600 },
      to: { x: 480, y: 360 },
      durationMs: 1_500
    }))
  );
  assert.deepEqual(fixture.keys, Array.from({ length: 5 }, () => "KEYCODE_W"));
  assert.deepEqual(
    fixture.holds,
    Array.from({ length: 5 }, () => ({ code: "KEYCODE_W", durationMs: 1_500 }))
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

test("HUD panel close retries with container mouse release until panel text disappears", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("调整", 80, 40)],
      [observation("调整", 80, 40)],
      []
    ],
    accurateFrames: [[], [], []]
  });
  let releases = 0;
  fixture.adb.releaseGameMouseCapture = async () => {
    releases += 1;
  };
  fixture.adb.touchTap = async (x, y) => {
    fixture.taps.push({ x, y });
  };

  await fixture.ui.tapUntilNoneTexts({
    texts: ["调整", "离开队伍"],
    region: { left: 0, top: 0, right: 1920, bottom: 1200 },
    x: 48,
    y: 327,
    maxAttempts: 6,
    intervalMs: 200,
    mouseReleaseSettleMs: 100,
    hud: true
  });

  assert.equal(releases, 2);
  assert.deepEqual(fixture.taps, [
    { x: 48, y: 327 },
    { x: 48, y: 327 }
  ]);
});

test("patrol overlay exit stops only after two bottom HUD anchors appear", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("巡逻路线", 900, 200)],
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
    region: { left: 0, top: 980, right: 760, bottom: 1200 },
    x: 75,
    y: 1120,
    maxAttempts: 6,
    intervalMs: 200
  });

  assert.deepEqual(fixture.taps, [{ x: 75, y: 1120 }]);
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

test("full patrol team closes through the calibrated flag only when the team UI is visible", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    assert.deepEqual(config.flows.closeTeamPanel, [
      {
        op: "tapUntilNoneTexts",
        texts: ["调整", "离开队伍"],
        x: 48,
        y: 327,
        region: { left: 0, top: 0, right: 1920, bottom: 1200 },
        maxAttempts: 6,
        intervalMs: 500,
        hud: true
      }
    ]);
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

function createUi({
  fastFrames = [[]],
  accurateFrames = [[]],
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
    async captureTransient() {
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
    },
    async focusGameInput(x, y) {
      focusPoints.push({ x, y });
    },
    async releaseGameMouseCapture() {},
    async touchSwipe(from, to, durationMs) {
      swipes.push({ from, to, durationMs });
    },
    async holdKey(code, durationMs) {
      holds.push({ code, durationMs });
    }
  };
  const ui = new GameUi(
    { timeouts: { actionDelayMs: 0 } },
    adb,
    vision,
    async (_level, _step, message) => messages.push(message)
  );
  return {
    ui,
    adb,
    taps,
    keys,
    keyCalls,
    focusPoints,
    swipes,
    holds,
    messages
  };
}

function observation(text, x, y) {
  return { text, confidence: 1, x, y, width: 20, height: 20 };
}
