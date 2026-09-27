import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  GameUi,
  TaskRestartRequestedError,
  findDeathRecoveryEvidence
} from "../src/ui.mjs";

test("death recovery requires the death notice and OCR-located return-to-camp button", async () => {
  const deathFrame = [
    observation("昏迷通知单", 260, 120),
    observation("回到营地", 1_620, 1_020)
  ];
  const fixture = createUi({
    fastFrames: [deathFrame, [observation("背包", 100, 100), observation("营地", 220, 100)]],
    accurateFrames: [deathFrame],
    config: {
      deathRecovery: {
        reviveSettleMs: 0,
        reviveConfirmationTimeoutSeconds: 2,
        reviveConfirmationPollMs: 10,
        cooldownSeconds: 8
      }
    }
  });
  fixture.ui.setTaskActive(true);

  await assert.rejects(
    fixture.ui.afterAction(),
    (error) => error instanceof TaskRestartRequestedError
  );

  assert.deepEqual(fixture.taps, [{ x: 1_630, y: 1_030 }]);
  assert.ok(fixture.messages.some((message) => message.includes("回到营地复活")));
  assert.ok(fixture.messages.some((message) => message.includes("从头重新执行原任务")));
});

test("death recovery never clicks a return button without a death notice", () => {
  const evidence = findDeathRecoveryEvidence(
    { find(observations, text) {
      return observations.find((item) => item.text.includes(text));
    } },
    [observation("回到营地", 1_620, 1_020)],
    {
      dialogRegion: { left: 0, top: 0, right: 1_920, bottom: 1_200 },
      buttonRegion: { left: 1_320, top: 820, right: 1_900, bottom: 1_170 },
      deathTexts: ["昏迷通知单", "昏迷于"],
      returnToCampTexts: ["回到营地"]
    }
  );
  assert.equal(evidence.detected, false);
});

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

test("profile-card camp navigation uses the avatar and camp-card ADB points", async () => {
  const fixture = createUi({
    config: { timeouts: { actionDelayMs: 0 } },
    transientCapture(label) {
      if (label === "camp-profile-verify-1") {
        return [
          observation("营地", 900, 300),
          observation("天赋能力", 900, 700),
          observation("潜能强化", 1200, 700),
          observation("核芯", 1600, 700)
        ];
      }
      if (label.startsWith("camp-profile-panel-verify")) {
        return [
          observation("量子时代", 330, 330),
          observation("营地周活跃", 760, 320)
        ];
      }
      return [];
    }
  });

  await fixture.ui.openCampPanelViaProfile({
    attempts: 1,
    profileButton: { x: 70, y: 64 },
    profileOpenSettleMs: 1,
    profileReadyMinimumTexts: 4,
    profileReadyRegion: { left: 650, top: 160, right: 1850, bottom: 1080 },
    campCardButton: { x: 1005, y: 420 },
    campCardSettleMs: 1,
    verifySeconds: 1.5
  });

  assert.deepEqual(fixture.taps, [
    { x: 70, y: 64 },
    { x: 1005, y: 420 }
  ]);
  assert.ok(fixture.messages.some((message) => message.includes("个人卡片")));
});

test("a marked game-mouse entry stays a direct tap after the HUD phase", async () => {
  const fixture = createUi();
  const touchTaps = [];
  fixture.vision.gameMouseIconVisible = async () => {
    throw new Error("entry tap must not inspect the reference icon");
  };
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

test("task guide overlay closes by tapping a safe blank point on the right half", async () => {
  const fixture = createUi({
    fastFrames: [
      [
        observation("任务", 120, 80),
        observation("当前", 120, 140),
        observation("导航", 120, 200),
        observation("追踪", 120, 260)
      ],
      [],
      [observation("调整", 100, 100)]
    ]
  });

  await fixture.ui.closeTaskGuideOverlay({
    texts: ["任务", "当前", "导航", "追踪"],
    region: { left: 0, top: 0, right: 960, bottom: 1200 },
    minimumTexts: 3,
    dismissPoint: { x: 1600, y: 600 },
    maxAttempts: 2,
    intervalMs: 1
  });

  assert.deepEqual(fixture.taps, [{ x: 1600, y: 600 }]);
  assert.ok(
    fixture.messages.some((message) => message.includes("右半屏安全空白位置"))
  );
});

test("task guide overlay rejects a close point inside the left overlay region", async () => {
  const fixture = createUi();

  await assert.rejects(
    fixture.ui.closeTaskGuideOverlay({
      region: { left: 0, top: 0, right: 960, bottom: 1200 },
      dismissPoint: { x: 500, y: 600 }
    }),
    /TASK_GUIDE_OVERLAY_DISMISS_POINT_UNSAFE/
  );
});

test("HUD initialization taps CtrlF and sends keyevent 70 without toggling C", async () => {
  const fixture = createUi();
  const events = [];
  fixture.ui.config.adb = {
    gameMouseCClickDelayMs: 0,
    gameMouseCKeyEventDelayMs: 0
  };
  let detectorCalls = 0;
  fixture.vision.gameMouseCIconLit = async () => {
    detectorCalls += 1;
    return true;
  };
  fixture.adb.touchTap = async (x, y) => events.push(["tap", x, y]);
  fixture.adb.prepareGameMouseForClick = async () => events.push(["key70"]);

  await fixture.ui.summonGameMouseAfterHud(undefined, 6);

  assert.deepEqual(events, [
    ["tap", 1782, 1110],
    ["key70"]
  ]);
  assert.equal(detectorCalls, 0);
  assert.ok(fixture.messages.some((message) => message.includes("跳过 C+C")));
});

test("a retry recheck repeats the CtrlF/C/keyevent release state machine", async () => {
  const fixture = createUi();
  fixture.ui.config.adb = {
    gameMouseCClickDelayMs: 0,
    gameMouseCKeyEventDelayMs: 0
  };
  const states = [true, false];
  const touchTaps = [];
  const prepareCalls = [];
  fixture.vision.gameMouseCIconLit = async () => states.shift() ?? false;
  fixture.adb.prepareGameMouseForClick = async (_signal, options) => {
    prepareCalls.push(options);
  };
  fixture.adb.touchTap = async (x, y) => touchTaps.push({ x, y });

  await fixture.ui.recheckGameMouseForRetry(
    undefined,
    "同一步点击连续失败 2 次"
  );

  assert.deepEqual(prepareCalls, [{ force: true }]);
  assert.deepEqual(touchTaps, [
    { x: 1782, y: 1110 },
    { x: 1865, y: 1130 },
    { x: 1865, y: 1130 }
  ]);
  assert.deepEqual(fixture.taps, []);
});

test("a retry does not click C again when dim verification is obscured", async () => {
  const fixture = createUi();
  fixture.ui.config.adb = {
    gameMouseCClickDelayMs: 0,
    gameMouseCKeyEventDelayMs: 0
  };
  const states = [true, true, true];
  const touchTaps = [];
  fixture.vision.gameMouseCIconLit = async () => states.shift() ?? true;
  fixture.adb.prepareGameMouseForClick = async () => {};
  fixture.adb.touchTap = async (x, y) => touchTaps.push({ x, y });

  await fixture.ui.recheckGameMouseForRetry(undefined, "入口点击失败");

  assert.deepEqual(touchTaps, [
    { x: 1782, y: 1110 },
    { x: 1865, y: 1130 },
    { x: 1865, y: 1130 }
  ]);
  assert.equal(
    touchTaps.filter((point) => point.x === 1865 && point.y === 1130).length,
    2
  );
  assert.ok(
    fixture.messages.some((message) => message.includes("不再重复点击 C"))
  );
});

test("retry-only game-mouse fallback waits until two taps fail", async () => {
  const fixture = createUi({
    fastFrames: [[], [], [], [observation("调整", 100, 100)]]
  });
  fixture.ui.config.adb = {
    gameMouseCClickDelayMs: 0,
    gameMouseCKeyEventDelayMs: 0
  };
  const cStates = [true, false];
  const prepareCalls = [];
  fixture.vision.gameMouseCIconLit = async () => {
    const state = cStates.shift() ?? false;
    return state;
  };
  fixture.adb.touchTap = async (x, y) => fixture.taps.push({ x, y });
  fixture.adb.prepareGameMouseForClick = async (_signal, options) => {
    prepareCalls.push(options);
  };

  await fixture.ui.tapUntilAnyTexts({
    texts: ["调整"],
    x: 50,
    y: 325,
    maxAttempts: 3,
    intervalMs: 1,
    gameMouseOnRetry: true
  });

  assert.deepEqual(prepareCalls, [{ force: true }]);
  assert.deepEqual(fixture.taps, [
    { x: 50, y: 325 },
    { x: 50, y: 325 },
    { x: 1782, y: 1110 },
    { x: 1865, y: 1130 },
    { x: 1865, y: 1130 },
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

test("flag retry closes the task guide overlay before attempting another flag tap", async () => {
  const fixture = createUi({
    fastFrames: [
      [
        observation("任务", 120, 80),
        observation("当前", 120, 140),
        observation("导航", 120, 200),
        observation("追踪", 120, 260)
      ],
      [
        observation("任务", 120, 80),
        observation("当前", 120, 140),
        observation("导航", 120, 200),
        observation("追踪", 120, 260)
      ],
      [],
      [observation("调整", 100, 100)]
    ]
  });

  await fixture.ui.tapUntilAnyTexts({
    texts: ["调整", "离开队伍"],
    x: 50,
    y: 325,
    maxAttempts: 1,
    intervalMs: 1,
    taskGuideOverlay: {
      texts: ["任务", "当前", "导航", "追踪"],
      region: { left: 0, top: 0, right: 960, bottom: 1200 },
      minimumTexts: 3,
      dismissPoint: { x: 1600, y: 600 },
      maxAttempts: 1,
      intervalMs: 1
    }
  });

  assert.deepEqual(fixture.taps, [{ x: 1600, y: 600 }]);
  assert.ok(
    fixture.messages.some((message) => message.includes("暂不重复点击旗帜"))
  );
});

test("guarded team-panel opening clicks the team card once and never the flag retry point", async () => {
  const fixture = createUi({
    fastFrames: [
      [
        observation("自动匹配", 350, 180),
        observation("暂无队员加入", 350, 220)
      ],
      [
        observation("调整", 350, 150),
        observation("离开队伍", 350, 220),
        observation("静音", 1600, 260),
        observation("目标", 1600, 320)
      ]
    ]
  });

  await fixture.ui.openTeamPanelGuarded({
    cardPoint: { x: 350, y: 150 },
    requiredCardTexts: ["自动匹配"],
    memberStateTexts: ["暂无队员加入", "等待队员加入"],
    panelTexts: [
      "调整", "离开队伍", "静音", "闭麦", "2D模式", "3D模式",
      "目标", "更换队伍", "招募"
    ],
    minimumPanelTexts: 4,
    settleMs: 1
  });

  assert.deepEqual(fixture.taps, [{ x: 350, y: 150 }]);
  assert.equal(
    fixture.taps.some((point) => point.x === 50 && point.y === 325),
    false
  );
});

test("a concrete player name in the calibrated card region is valid team evidence", async () => {
  const fixture = createUi({
    fastFrames: [
      [
        observation("自动匹配", 240, 180),
        observation("玩家甲", 240, 260)
      ],
      [
        observation("调整", 350, 150),
        observation("离开队伍", 350, 220),
        observation("静音", 1600, 260),
        observation("目标", 1600, 320)
      ]
    ]
  });

  await fixture.ui.openTeamPanelGuarded({
    cardPoint: { x: 350, y: 150 },
    requiredCardTexts: ["自动匹配"],
    memberStateTexts: ["暂无队员加入", "等待队员加入"],
    memberNameRegion: { left: 0, top: 120, right: 620, bottom: 520 },
    panelTexts: [
      "调整", "离开队伍", "静音", "闭麦", "2D模式", "3D模式",
      "目标", "更换队伍", "招募"
    ],
    minimumPanelTexts: 4,
    settleMs: 1
  });

  assert.deepEqual(fixture.taps, [{ x: 350, y: 150 }]);
});

test("automatic matching alone confirms a team card", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("自动匹配", 240, 180)],
      [
        observation("调整", 350, 150),
        observation("离开队伍", 350, 220),
        observation("静音", 1600, 260),
        observation("目标", 1600, 320)
      ]
    ]
  });

  await fixture.ui.openTeamPanelGuarded({
    cardPoint: { x: 350, y: 150 },
    requiredCardTexts: ["自动匹配"],
    memberStateTexts: ["暂无队员加入", "等待队员加入"],
    panelTexts: [
      "调整", "离开队伍", "静音", "闭麦", "2D模式", "3D模式",
      "目标", "更换队伍", "招募"
    ],
    minimumPanelTexts: 4,
    settleMs: 1
  });
  assert.deepEqual(fixture.taps, [{ x: 350, y: 150 }]);
});

test("cancel matching also confirms an existing team card", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("取消匹配", 240, 180)],
      [
        observation("调整", 350, 150),
        observation("离开队伍", 350, 220),
        observation("静音", 1600, 260),
        observation("目标", 1600, 320)
      ]
    ]
  });

  await fixture.ui.openTeamPanelGuarded({
    cardPoint: { x: 350, y: 150 },
    memberStateTexts: ["暂无队员加入", "等待队员加入"],
    panelTexts: [
      "调整", "离开队伍", "静音", "闭麦", "2D模式", "3D模式",
      "目标", "更换队伍", "招募"
    ],
    minimumPanelTexts: 4,
    settleMs: 1
  });
  assert.deepEqual(fixture.taps, [{ x: 350, y: 150 }]);
});

test("a member state without automatic matching is auxiliary team evidence", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("暂无队员加入", 240, 220)],
      [
        observation("调整", 350, 150),
        observation("离开队伍", 350, 220),
        observation("静音", 1600, 260),
        observation("目标", 1600, 320)
      ]
    ]
  });

  await fixture.ui.openTeamPanelGuarded({
    cardPoint: { x: 350, y: 150 },
    requiredCardTexts: ["自动匹配"],
    memberStateTexts: ["暂无队员加入", "等待队员加入"],
    panelTexts: [
      "调整", "离开队伍", "静音", "闭麦", "2D模式", "3D模式",
      "目标", "更换队伍", "招募"
    ],
    minimumPanelTexts: 4,
    settleMs: 1
  });
  assert.deepEqual(fixture.taps, [{ x: 350, y: 150 }]);
});

test("a concrete player name is auxiliary team evidence when matching text is unreadable", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("玩家甲", 240, 260)],
      [
        observation("调整", 350, 150),
        observation("离开队伍", 350, 220),
        observation("静音", 1600, 260),
        observation("目标", 1600, 320)
      ]
    ]
  });

  await fixture.ui.openTeamPanelGuarded({
    cardPoint: { x: 350, y: 150 },
    requiredCardTexts: ["自动匹配", "取消匹配"],
    memberStateTexts: ["暂无队员加入", "等待队员加入"],
    memberNameRegion: { left: 0, top: 120, right: 620, bottom: 520 },
    panelTexts: [
      "调整", "离开队伍", "静音", "闭麦", "2D模式", "3D模式",
      "目标", "更换队伍", "招募"
    ],
    minimumPanelTexts: 4,
    settleMs: 1
  });
  assert.deepEqual(fixture.taps, [{ x: 350, y: 150 }]);
});

test("member evidence is optional when automatic matching is present", async () => {
  const fixture = createUi({
    fastFrames: [
      [
        observation("自动匹配", 240, 180),
        observation("暂无队员加入", 240, 220),
        observation("玩家甲", 240, 260)
      ],
      [
        observation("调整", 350, 150),
        observation("离开队伍", 350, 220),
        observation("静音", 1600, 260),
        observation("目标", 1600, 320)
      ]
    ]
  });

  await fixture.ui.openTeamPanelGuarded({
    cardPoint: { x: 350, y: 150 },
    requiredCardTexts: ["自动匹配"],
    memberStateTexts: ["暂无队员加入", "等待队员加入"],
    memberNameRegion: { left: 0, top: 120, right: 620, bottom: 520 },
    panelTexts: [
      "调整", "离开队伍", "静音", "闭麦", "2D模式", "3D模式",
      "目标", "更换队伍", "招募"
    ],
    minimumPanelTexts: 4,
    settleMs: 1
  });
  assert.deepEqual(fixture.taps, [{ x: 350, y: 150 }]);
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
    fastFrames: [
      [],
      [],
      [observation("频道", 1600, 50)],
      [observation("营地", 1700, 355)],
      [],
      []
    ],
    accurateFrames: [
      [],
      [],
      [observation("营地频道", 900, 115)],
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
    channelDelayMs: 1,
    chatCardSettleMs: 1,
    chatTabSettleMs: 1,
    campChannelSettleMs: 1,
    chatNavigationTimeoutSeconds: 1
  });
  assert.deepEqual(fixture.taps, [
    { x: 250, y: 1060 },
    { x: 1610, y: 60 },
    { x: 1710, y: 365 },
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
      [observation("频道", 1600, 50)],
      [observation("营地", 1700, 355)]
    ],
    transientCapture(label) {
      if (label === "camp-panel-map-check-1") {
        return [observation("标志查看", 190, 35)];
      }
      if (label === "camp-panel-map-check-2") {
        return [observation("背包", 120, 900)];
      }
      if (label === "camp-panel-before-1") {
        return [observation("背包", 120, 900)];
      }
      if (label.startsWith("camp-channel-verify")) {
        return [observation("营地频道", 900, 115)];
      }
      if (label.startsWith("camp-panel-verify")) {
        return [
          observation("量子时代", 330, 330),
          observation("营地周活跃", 760, 320)
        ];
      }
      return [];
    }
  });
  await fixture.ui.openCampPanelViaChat({
    attempts: 1,
    chatDelayMs: 1,
    channelDelayMs: 1,
    chatCardSettleMs: 1,
    chatTabSettleMs: 1,
    campChannelSettleMs: 1,
    chatNavigationTimeoutSeconds: 1,
    verifySeconds: 1
  });
  assert.deepEqual(fixture.keys, []);
  assert.deepEqual(fixture.taps, [
    { x: 1850, y: 70 },
    { x: 250, y: 1060 },
    { x: 1610, y: 60 },
    { x: 1710, y: 365 },
    { x: 980, y: 65 }
  ]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("检测到地图遮挡")
    )
  );
});

test("camp navigation uses direct ADB clicks after the HUD phase", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("频道", 1600, 50)],
      [observation("营地", 1700, 355)]
    ],
    transientCapture(label) {
      if (label === "camp-chat-verify-1") {
        return [observation("营地频道", 1660, 180)];
      }
      if (label.startsWith("camp-channel-verify")) {
        return [observation("营地频道", 900, 115)];
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
  fixture.vision.gameMouseIconVisible = async () => {
    throw new Error("camp navigation must not inspect the reference icon");
  };
  fixture.adb.prepareGameMouseForClick = async () => {
    summons += 1;
  };

  await fixture.ui.openCampPanelViaChat({
    attempts: 1,
    chatReadyTexts: ["营地频道"],
    chatReadyRegion: { left: 1200, top: 100, right: 1900, bottom: 1150 },
    chatReadyMinimumTexts: 1,
    chatDelayMs: 1,
    channelDelayMs: 1,
    chatCardSettleMs: 1,
    chatTabSettleMs: 1,
    campChannelSettleMs: 1,
    chatNavigationTimeoutSeconds: 1,
    verifySeconds: 1
  });

  assert.equal(summons, 0);
  assert.deepEqual(mouseTaps, [
    { x: 250, y: 1060 },
    { x: 1610, y: 60 },
    { x: 1710, y: 365 },
    { x: 980, y: 65 }
  ]);
});

test("camp navigation waits and verifies channel then camp before city hall", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("频道", 1600, 50)],
      [observation("营地", 1700, 355)]
    ],
    transientCapture(label) {
      if (label === "camp-chat-verify-1") {
        return [observation("营地频道", 1300, 115)];
      }
      if (label.startsWith("camp-channel-verify")) {
        return [observation("营地频道", 900, 115)];
      }
      if (label.startsWith("camp-panel-verify")) {
        return [
          observation("量子时代", 330, 330),
          observation("营地周活跃", 760, 320)
        ];
      }
      return [];
    }
  });

  await fixture.ui.openCampPanelViaChat({
    attempts: 1,
    chatDelayMs: 1,
    chatCardSettleMs: 1,
    chatTabSettleMs: 1,
    campChannelSettleMs: 1,
    chatNavigationTimeoutSeconds: 1,
    chatReadyTexts: ["营地频道"],
    chatReadyRegion: { left: 1200, top: 100, right: 1900, bottom: 1150 },
    chatTabText: "频道",
    chatTabMode: "exact",
    chatTabRegion: { left: 1450, top: 0, right: 1900, bottom: 180 },
    campChannelText: "营地",
    campChannelMode: "includes",
    campChannelRegion: { left: 1450, top: 120, right: 1900, bottom: 800 },
    campChannelReadyTexts: ["营地频道"],
    campChannelReadyRegion: { left: 700, top: 0, right: 1450, bottom: 180 },
    verifySeconds: 1
  });

  assert.deepEqual(fixture.taps, [
    { x: 250, y: 1060 },
    { x: 1610, y: 60 },
    { x: 1710, y: 365 },
    { x: 980, y: 65 }
  ]);
  assert.ok(
    fixture.messages.some((message) => message.includes("营地频道"))
  );
});

test("legacy camp flow still navigates through channel before using city hall", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("频道", 1600, 50)],
      [observation("营地", 1700, 355)]
    ],
    transientCapture(label) {
      if (label === "camp-chat-verify-1") {
        return [observation("私聊", 1830, 115)];
      }
      if (label.startsWith("camp-channel-verify")) {
        return [observation("营地频道", 900, 115)];
      }
      if (label.startsWith("camp-panel-verify")) {
        return [
          observation("量子时代", 330, 330),
          observation("营地周活跃", 760, 320)
        ];
      }
      return [];
    }
  });

  await fixture.ui.openCampPanelViaChat({
    attempts: 1,
    chatDelayMs: 1,
    chatCardSettleMs: 1,
    chatTabSettleMs: 1,
    campChannelSettleMs: 1,
    chatNavigationTimeoutSeconds: 1,
    verifySeconds: 1
  });

  assert.deepEqual(fixture.taps, [
    { x: 250, y: 1060 },
    { x: 1610, y: 60 },
    { x: 1710, y: 365 },
    { x: 980, y: 65 }
  ]);
  assert.ok(
    fixture.messages.some((message) => message.includes("聊天顶部“频道”"))
  );
});

test("an already-open camp chat skips the chat toggle and clicks city hall", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("频道", 1600, 50)],
      [observation("营地", 1700, 355)]
    ],
    transientCapture(label) {
      if (label === "camp-panel-before-1") {
        return [
          observation("营地频道", 820, 115),
          observation("成员(97)", 1400, 115),
          observation("收起", 1700, 1080)
        ];
      }
      if (label.startsWith("camp-panel-verify")) {
        return [
          observation("量子时代", 330, 330),
          observation("营地周活跃", 760, 320)
        ];
      }
      if (label.startsWith("camp-channel-verify")) {
        return [observation("营地频道", 900, 115)];
      }
      return [];
    },
    mumu: null
  });

  await fixture.ui.openCampPanelViaChat({
    attempts: 1,
    chatReadyTexts: ["营地频道", "成员", "私聊"],
    chatReadyRegion: { left: 1200, top: 100, right: 1900, bottom: 1150 },
    chatReadyMinimumTexts: 1,
    chatDelayMs: 1,
    channelDelayMs: 1,
    chatCardSettleMs: 1,
    chatTabSettleMs: 1,
    campChannelSettleMs: 1,
    chatNavigationTimeoutSeconds: 1,
    verifySeconds: 1
  });

  assert.deepEqual(fixture.taps, [
    { x: 1610, y: 60 },
    { x: 1710, y: 365 },
    { x: 980, y: 65 }
  ]);
  assert.ok(
    fixture.messages.some((message) => message.includes("聊天面板已经打开"))
  );
});

test("a direct game-mouse entry click does not toggle keyevent 70 on one command failure", async () => {
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

  await assert.rejects(
    fixture.ui.gameMouseTap({ x: 48, y: 327 }),
    /ADB click injection failed/
  );

  assert.deepEqual(prepareCalls, []);
  assert.equal(clicks, 1);
});

test("camp navigation rechecks the game mouse once after two failed attempts", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("频道", 1600, 50)],
      [observation("营地", 1700, 355)],
      [observation("频道", 1600, 50)],
      [observation("营地", 1700, 355)],
      [observation("频道", 1600, 50)],
      [observation("营地", 1700, 355)]
    ],
    transientCapture(label) {
      if (label.startsWith("camp-channel-verify")) {
        return [observation("营地频道", 900, 115)];
      }
      if (label === "camp-panel-verify-3") {
        return [
          observation("量子时代", 330, 330),
          observation("营地周活跃", 760, 320)
        ];
      }
      return [];
    }
  });
  fixture.ui.config.adb = {
    gameMouseCClickDelayMs: 0,
    gameMouseCKeyEventDelayMs: 0
  };
  const cStates = [true, false];
  fixture.vision.gameMouseCIconLit = async () => cStates.shift() ?? false;
  fixture.adb.touchTap = async (x, y) => fixture.taps.push({ x, y });
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
    chatCardSettleMs: 1,
    chatTabSettleMs: 1,
    campChannelSettleMs: 1,
    chatNavigationTimeoutSeconds: 1,
    verifySeconds: 1
  });

  assert.equal(summons, 1);
  assert.equal(fixture.taps.length, 15);
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

test("1920x1200 map flow closes every overlay and opens map with keyevent 41", async () => {
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
      [
        observation("标志查看", 260, 150),
        observation("查看庄园", 520, 150)
      ]
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
  assert.deepEqual(fixture.keys, ["41"]);
  assert.deepEqual(fixture.focusPoints, []);
});

test("M is the primary map action and still requires map OCR", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("背包", 120, 900)],
      [],
      [
        observation("标志查看", 260, 150),
        observation("查看庄园", 520, 150)
      ]
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
  assert.deepEqual(fixture.keys, ["41"]);
  assert.deepEqual(fixture.focusPoints, []);
});

test("map opening never falls back to a calibrated mouse click after M", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("背包", 120, 900)],
      [],
      [
        observation("标志查看", 260, 150),
        observation("查看庄园", 520, 150)
      ]
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

  assert.deepEqual(fixture.keys, ["41"]);
  assert.deepEqual(fixture.taps, []);
  assert.ok(
    !fixture.messages.some((message) =>
      message.includes("map_open_button_fallback")
    )
  );
});

test("a model map prediction never unlocks destination clicks without two map keywords", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("背包", 120, 900)],
      [],
      [
        observation("标志查看", 260, 150),
        observation("查看庄园", 520, 150)
      ]
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
  assert.deepEqual(fixture.keys, ["41"]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("模型地图候选仅供记录")
    )
  );
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("（2 项）确认地图页面打开")
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
  assert.deepEqual(fixture.keys, ["41", "41"]);
  assert.deepEqual(fixture.taps, []);
  assert.deepEqual(fixture.focusPoints, []);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("至少 2 个地图关键词")
    )
  );
});

test("two map keywords confirm map opening on the estate tab", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("背包", 120, 900)],
      [
        observation("查看庄园", 520, 150),
        observation("中心花园", 650, 420),
        observation("我的庄园", 220, 180),
        observation("坐标", 220, 1080)
      ]
    ]
  });
  await fixture.ui.ensureMapOpen({
    mapKey: "KEYCODE_M",
    mapButtonFallbackDelayMs: 30_000,
    mapReadyTexts: ["标志查看", "查看庄园"],
    mapPreparationMaxClosures: 2,
    mapOpenPollMs: 1
  });
  assert.deepEqual(fixture.keys, ["41"]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("查看庄园、中心花园、我的庄园、坐标")
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
    accurateFrames: [[
      observation("标志查看", 260, 150),
      observation("查看庄园", 520, 150)
    ]],
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

test("map teleport clicks the OCR-confirmed target row instead of fixed coordinates", async () => {
  const fixture = createUi({
    fastFrames: [[observation("公告板", 250, 560)]]
  });
  const result = await fixture.ui.tapMapDestinationByOcr(
    { mapDestinationRegion: { left: 80, top: 120, right: 680, bottom: 1150 } },
    {
      name: "公告板",
      mapTexts: ["公告板", "公告版"],
      mapTextMode: "exact",
      x: 270,
      y: 577
    }
  );

  assert.equal(result.text, "公告板");
  assert.deepEqual(fixture.taps, [{ x: 260, y: 570 }]);
  assert.ok(
    fixture.messages.some((message) => message.includes("地图 OCR 已确认目标传送点"))
  );
});

test("map teleport refuses a fixed fallback when the target name is not OCR-confirmed", async () => {
  const fixture = createUi({
    fastFrames: [[observation("交易摊位", 250, 560)]]
  });

  await assert.rejects(
    fixture.ui.tapMapDestinationByOcr(
      {},
      { name: "公告板", x: 270, y: 577 }
    ),
    /TELEPORT_TARGET_OCR_NOT_FOUND/
  );
  assert.deepEqual(fixture.taps, []);
});

test("map estate-list anchors force a marker-tab click before target OCR", async () => {
  const fixture = createUi({
    fastFrames: [[
      observation("查看庄园", 360, 35),
      observation("标志查看", 160, 35),
      observation("中心花园", 260, 100),
      observation("1a", 150, 145),
      observation("1b", 150, 185)
    ]]
  });

  await fixture.ui.ensureMapDestinationList({
    mapModeText: "标志查看",
    mapEstateMarkerTexts: ["中心花园", "1a", "1b"],
    mapEstateMinimumMarkers: 2,
    mapModeDelayMs: 0
  });

  assert.deepEqual(fixture.taps, [{ x: 170, y: 45 }]);
  assert.ok(
    fixture.messages.some((message) =>
      message.includes("查看庄园") && message.includes("标志查看")
    )
  );
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
    approachFallbackHoldMs: 700,
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
    Array.from({ length: 5 }, () => ({ code: "KEYCODE_W", durationMs: 700 }))
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

test("patrol team close retries the return arrow when the panel remains without HUD", async () => {
  const fixture = createUi({
    fastFrames: [
      [observation("调整", 80, 40)],
      [observation("调整", 80, 40)],
      [observation("综合", 40, 1080), observation("世界", 110, 1080)]
    ]
  });

  await fixture.ui.closePatrolTeamPanelBeforeAccept({
    x: 74,
    y: 1110,
    hud: true,
    settleAfterClickMs: 1,
    collapseSettleMs: 1,
    maxAttempts: 6
  });

  assert.ok(fixture.taps.length >= 2 && fixture.taps.length <= 6);
  assert.ok(fixture.taps.every((point) => point.x === 74 && point.y === 1110));
  assert.ok(
    fixture.messages.some((message) => message.includes("重试点击队伍页左下角返回箭头"))
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

test("open team panel requires a verified card click and never configures a flag retry", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    const guarded = config.flows.openTeamPanel.find(
      (action) => action.op === "openTeamPanelGuarded"
    );
    assert.deepEqual(guarded, {
      op: "openTeamPanelGuarded",
      cardPoint: { x: 350, y: 150 },
      requiredCardTexts: ["自动匹配", "取消匹配"],
      memberStateTexts: [
        "暂无队员加入",
        "等待队员加入",
        "当前队员信息",
        "当前队员",
        "队员信息"
      ],
      panelTexts: [
        "调整", "离开队伍", "静音", "闭麦", "2D模式", "3D模式",
        "目标", "更换队伍", "招募"
      ],
      minimumPanelTexts: 4,
      panelRegion: { left: 0, top: 0, right: 1920, bottom: 1180 },
      cardRegion: { left: 0, top: 0, right: 1920, bottom: 1180 },
      memberNameRegion: { left: 0, top: 120, right: 620, bottom: 520 },
      settleMs: 500,
      hud: true,
      taskGuideOverlay: {
        texts: ["任务", "当前", "导航", "追踪"],
        region: { left: 0, top: 0, right: 960, bottom: 1200 },
        minimumTexts: 3,
        dismissPoint: { x: 1600, y: 600 },
        maxAttempts: 4,
        intervalMs: 500,
        regionOcrMinimumConfidence: 0.2,
        regionOcrScale: 2
      }
    });
    assert.equal(config.flows.openTeamPanel[0].op, "closeTaskGuideOverlay");
    assert.equal(
      config.flows.openTeamPanel.some(
        (action) => action.x === 50 && action.y === 325
      ),
      false
    );
    const postAccept = config.flows.openPatrolTeamPanelAfterAccept.find(
      (action) => action.op === "openTeamPanelGuarded"
    );
    assert.equal(postAccept.allowKnownTeamCard, true);
    assert.deepEqual(postAccept.requiredCardTexts, ["自动匹配", "取消匹配"]);
  }
});

test("patrol creation changes 3D to 2D only when the 3D label is visible", async () => {
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    assert.deepEqual(config.flows.ensurePatrolTeamTwoD, [
      {
        op: "tapIfAnyText",
        texts: ["3D模式"],
        x: 1655,
        y: 55,
        hud: true,
        region: { left: 1500, top: 0, right: 1850, bottom: 120 }
      },
      { op: "sleep", ms: 500 },
      {
        op: "waitAnyText",
        texts: ["2D模式"],
        region: { left: 1500, top: 0, right: 1850, bottom: 120 },
        timeoutSeconds: 8
      }
    ]);
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
        maxAttempts: 6,
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
    assert.deepEqual(config.adb.gameMouseHudInitialTapPoint, { x: 1782, y: 1110 });
    assert.deepEqual(config.adb.gameMouseHudTapPoint, { x: 1865, y: 1130 });
    assert.equal(Object.hasOwn(config.mumu, "hostMouseUnlock"), false);
    assert.equal(Object.hasOwn(config.patrolTeamUi, "hostMouseUnlockBeforeCreate"), false);
  }
  const { config: technologyConfig } = await import("../plugins/technology/config.mjs");
  assert.equal(technologyConfig.flows.openCampPanel[0].op, "openCampPanelViaProfile");
  assert.deepEqual(technologyConfig.flows.openCampPanel[0].profileButton, { x: 70, y: 64 });
  assert.equal(
    Object.hasOwn(technologyConfig.flows.openCampPanel[0], "hostMouseUnlockBeforeCampChannel"),
    false
  );
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
    assert.equal(teleport.target.approachFallbackHoldMs, 700);
    assert.equal(teleport.target.approachFallbackIntervalMs, 2000);
    assert.equal(teleport.fallback.name, "中心出入口");
  }
});

test("all map teleport flows require two independent map keywords", async () => {
  const expected = [
    "标志查看",
    "查看庄园",
    "可快捷前往地标",
    "中心花园",
    "我的庄园",
    "坐标"
  ];
  for (const file of ["config.json", "config.example.json"]) {
    const config = JSON.parse(
      await readFile(new URL(`../${file}`, import.meta.url), "utf8")
    );
    for (const flowName of [
      "teleportNoticeBoard",
      "teleportCityHall",
      "teleportCentralExit"
    ]) {
      const [teleport] = config.flows[flowName];
      assert.deepEqual(teleport.mapVerificationTexts, expected);
      assert.equal(teleport.mapVerificationMinimumMatches, 2);
    }
  }
});

function createUi({
  fastFrames = [[]],
  accurateFrames = [[]],
  transientCapture = null,
  mumu = null,
  overlayAdvice = null,
  generalAdvice = null,
  minimumActionConfidence = 0.95,
  config = {}
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
    {
      timeouts: { actionDelayMs: 0, ...(config.timeouts || {}) },
      ...config
    },
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
