import test from "node:test";
import assert from "node:assert/strict";
import {
  createPatrolTeam,
  patrolTeamIsFull,
  sharePatrolTeam
} from "../src/workflows/patrol.mjs";

test("patrol team creation follows only region-verified live-device steps", async () => {
  const taps = [];
  const reports = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    adb: {
      async key() {
        throw new Error("voice prompt was not present");
      }
    },
    vision: {
      async capture(label) {
        return {
          path: `${label}.png`,
          observations: observationsFor(label)
        };
      },
      async captureAccurateTransient() {
        return { path: null, observations: [] };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact"
            ? item.text === query
            : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report(_level, step) {
      reports.push(step);
    }
  };

  await createPatrolTeam(context);

  assert.deepEqual(taps, [
    { x: 48, y: 327 },
    { x: 211, y: 180 },
    { x: 470, y: 900 },
    { x: 900, y: 386 },
    { x: 1419, y: 891 }
  ]);
  assert.ok(reports.includes("patrol_flag_click"));
  assert.ok(reports.includes("patrol_team_created_verified"));
});

test("patrol creation refuses a world click when the flag anchor is absent", async () => {
  const taps = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    adb: { async key() {} },
    vision: {
      async capture() {
        return { path: "unknown.png", observations: [] };
      },
      find() {
        return null;
      }
    },
    async sleep() {},
    async report() {}
  };

  await assert.rejects(
    createPatrolTeam(context),
    /PATROL_FLAG_NOT_VISIBLE/
  );
  assert.deepEqual(taps, []);
});

test("two bottom channel anchors safely permit the calibrated flag click", async () => {
  const taps = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    adb: { async key() {} },
    vision: {
      async capture(label) {
        if (label === "patrol-team-entry") {
          return {
            path: "hud.png",
            observations: [
              observation("综合", 20, 1080),
              observation("营地", 200, 1080)
            ]
          };
        }
        if (label === "patrol-team-menu-open") {
          return {
            path: "menu.png",
            observations: [observation("创建队伍", 120, 160)]
          };
        }
        if (label === "patrol-team-creator-open") {
          return {
            path: "creator.png",
            observations: [
              observation("队伍目标", 390, 250),
              observation("创建队伍", 1340, 865)
            ]
          };
        }
        if (label === "patrol-camp-affairs-selected") {
          return {
            path: "category.png",
            observations: [observation("营地巡逻任务", 700, 360)]
          };
        }
        if (label === "patrol-target-selected") {
          return {
            path: "target.png",
            observations: [
              observation("营地巡逻任务", 700, 360),
              observation("创建队伍", 1340, 865)
            ]
          };
        }
        return {
          path: "created.png",
          observations: [
            observation("目标：营地事务>营地巡逻任务", 200, 20),
            observation("等待队员加入", 650, 600)
          ]
        };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact"
            ? item.text === query
            : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report() {}
  };

  await createPatrolTeam(context);
  assert.deepEqual(taps[0], { x: 48, y: 327 });
});

test("an existing patrol team is recognized without toggling the flag", async () => {
  const taps = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    adb: { async key() {} },
    vision: {
      async capture() {
        return {
          path: "team.png",
          observations: [
            observation("目标：营地事务>营地巡逻任务", 200, 20),
            observation("等待队员加入", 650, 600)
          ]
        };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact"
            ? item.text === query
            : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report() {}
  };

  await createPatrolTeam(context);
  assert.deepEqual(taps, []);
});

test("a missed flag click falls back to Ctrl+Q and stops once the menu opens", async () => {
  const taps = [];
  const combinations = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    adb: {
      async keyCombination(codes) {
        combinations.push(codes);
      },
      async key() {}
    },
    vision: {
      async capture(label) {
        if (label === "patrol-team-entry") {
          return {
            path: "hud.png",
            observations: [observation("CtrlQ", 20, 300)]
          };
        }
        if (label === "patrol-team-menu-open") {
          return { path: "miss.png", observations: [] };
        }
        return {
          path: `${label}.png`,
          observations: observationsFor(
            label === "patrol-team-menu-key-fallback-1"
              ? "patrol-team-menu-open"
              : label
          )
        };
      },
      async captureAccurateTransient() {
        return { path: null, observations: [] };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact"
            ? item.text === query
            : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report() {}
  };

  await createPatrolTeam(context);

  assert.equal(combinations.length, 1);
  assert.deepEqual(combinations[0], [
    "KEYCODE_CTRL_LEFT",
    "KEYCODE_Q"
  ]);
  assert.deepEqual(taps, [
    { x: 48, y: 327 },
    { x: 48, y: 327 },
    { x: 211, y: 180 },
    { x: 470, y: 900 },
    { x: 900, y: 386 },
    { x: 1419, y: 891 }
  ]);
});

test("patrol share uses calibrated recruit and camp-channel points and verifies success", async () => {
  const taps = [];
  const reports = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    vision: {
      async capture(label) {
        if (label === "patrol-share-team-page") {
          return {
            path: "team.png",
            observations: [
              observation("目标：营地事务>营地巡逻任务", 160, 20),
              observation("招募", 300, 1100)
            ]
          };
        }
        if (label === "patrol-share-channel-menu-1") {
          return {
            path: "channels.png",
            observations: [observation("营地频道", 350, 870)]
          };
        }
        return {
          path: "success.png",
          observations: [
            observation("成功分享至营地频道", 780, 210)
          ]
        };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact"
            ? item.text === query
            : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report(_level, step) {
      reports.push(step);
    }
  };

  await sharePatrolTeam(context);

  assert.deepEqual(taps, [
    { x: 343, y: 1128 },
    { x: 416, y: 895 }
  ]);
  assert.ok(reports.includes("patrol_share_success"));
});

test("patrol share retries recruit once when the first click only acquires input", async () => {
  const taps = [];
  let channelAttempts = 0;
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    vision: {
      async capture(label) {
        if (label === "patrol-share-team-page") {
          return {
            path: "team.png",
            observations: [observation("保卫古籍", 160, 20)]
          };
        }
        if (label.startsWith("patrol-share-channel-menu")) {
          channelAttempts += 1;
          return {
            path: "channels.png",
            observations:
              channelAttempts === 1
                ? []
                : [observation("营地频道", 350, 870)]
          };
        }
        return {
          path: "success.png",
          observations: [
            observation("成功分享至营地频道", 780, 210)
          ]
        };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact"
            ? item.text === query
            : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report() {}
  };

  await sharePatrolTeam(context);
  assert.deepEqual(taps, [
    { x: 343, y: 1128 },
    { x: 343, y: 1128 },
    { x: 416, y: 895 }
  ]);
});

test("patrol share never clicks the channel point unless the selector is verified", async () => {
  const taps = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    vision: {
      async capture(label) {
        return {
          path: `${label}.png`,
          observations:
            label === "patrol-share-team-page"
              ? [observation("营地巡逻任务", 160, 20)]
              : []
        };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact"
            ? item.text === query
            : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report() {}
  };

  await assert.rejects(
    sharePatrolTeam(context),
    /PATROL_SHARE_CHANNEL_MENU_UNVERIFIED/
  );
  assert.deepEqual(taps, [
    { x: 343, y: 1128 },
    { x: 343, y: 1128 }
  ]);
});

test("patrol team is not full when a member slot has no occupied evidence", async () => {
  const reports = [];
  const full = await patrolTeamIsFull(
    {
      config: { patrolTeamUi: patrolUiConfig() },
      vision: {
        find(observations, query) {
          return observations.find((item) => item.text.includes(query));
        },
      },
      async report(_level, step) {
        reports.push(step);
      }
    },
    {
      observations: [observation("2D模式", 1650, 55)]
    }
  );
  assert.equal(full, false);
  assert.ok(reports.includes("patrol_team_full_unverified"));
});

test("any waiting member card prevents a full-team result", async () => {
  const reports = [];
  const full = await patrolTeamIsFull(
    {
      config: { patrolTeamUi: patrolUiConfig() },
      vision: {
        find(observations, query) {
          return observations.find((item) => item.text.includes(query));
        },
      },
      async report(_level, step) {
        reports.push(step);
      }
    },
    {
      observations: [
        observation("玩家甲", 620, 700),
        observation("115", 620, 330),
        observation("玩家乙", 1020, 700),
        observation("130", 1020, 330),
        observation("等待队员加入", 1420, 600)
      ]
    }
  );
  assert.equal(full, false);
  assert.ok(reports.includes("patrol_team_waiting"));
});

test("patrol team becomes full when all three member cards are occupied", async () => {
  const reports = [];
  const full = await patrolTeamIsFull(
    {
      config: { patrolTeamUi: patrolUiConfig() },
      vision: {
        find(observations, query) {
          return observations.find((item) => item.text.includes(query));
        },
      },
      async report(_level, step) {
        reports.push(step);
      }
    },
    {
      observations: [
        observation("玩家甲", 620, 700),
        observation("115", 620, 330),
        observation("玩家乙", 1020, 700),
        observation("130", 1020, 330),
        observation("玩家丙", 1420, 700),
        observation("115", 1420, 330)
      ]
    }
  );
  assert.equal(full, true);
  assert.ok(reports.includes("patrol_team_full_verified"));
});

function observationsFor(label) {
  if (label === "patrol-team-entry") {
    return [observation("CtrlQ", 20, 300)];
  }
  if (label === "patrol-team-menu-open") {
    return [observation("创建队伍", 120, 160)];
  }
  if (label === "patrol-team-creator-open") {
    return [
      observation("队伍目标", 390, 250),
      observation("创建队伍", 1340, 865)
    ];
  }
  if (label === "patrol-camp-affairs-selected") {
    return [observation("营地巡逻任务", 700, 360)];
  }
  if (label === "patrol-target-selected") {
    return [
      observation("营地巡逻任务", 700, 360),
      observation("创建队伍", 1340, 865)
    ];
  }
  if (label === "patrol-team-created") {
    return [
      observation("目标：营地事务>营地巡逻任务", 200, 20),
      observation("等待队员加入", 650, 600)
    ];
  }
  return [];
}

function patrolUiConfig() {
  return {
    flagButton: { x: 48, y: 327 },
    flagClickAttempts: 2,
    flagReadyTexts: ["CtrlQ", "Ctrl Q"],
    flagReadyRegion: { left: 0, top: 260, right: 130, bottom: 390 },
    teamMenuRegion: { left: 70, top: 115, right: 360, bottom: 365 },
    createMenuPoint: { x: 211, y: 180 },
    creatorTitleRegion: { left: 350, top: 235, right: 1565, bottom: 325 },
    campAffairsPoint: { x: 470, y: 900 },
    patrolTargetRegion: { left: 650, top: 330, right: 1170, bottom: 540 },
    patrolTargetPoint: { x: 900, y: 386 },
    createButtonRegion: { left: 1285, top: 845, right: 1555, bottom: 935 },
    createButtonPoint: { x: 1419, y: 891 },
    createdTargetRegion: { left: 150, top: 0, right: 830, bottom: 100 },
    createdBodyRegion: { left: 0, top: 280, right: 1920, bottom: 1180 },
    teamMemberSlotRegions: [
      { left: 560, top: 290, right: 955, bottom: 960 },
      { left: 960, top: 290, right: 1355, bottom: 960 },
      { left: 1360, top: 290, right: 1750, bottom: 960 }
    ],
    focusAcquiredTexts: [
      "创建队伍",
      "自动匹配",
      "暂无队员加入",
      "调整",
      "离开队伍"
    ],
    focusAcquiredRegion: {
      left: 0,
      top: 0,
      right: 620,
      bottom: 1180
    },
    comboFallbackAttempts: 1,
    stepSettleMs: 1,
    share: {
      teamPageTexts: [
        "营地巡逻任务",
        "保卫古籍",
        "招募",
        "离开队伍"
      ],
      teamPageRegion: {
        left: 0,
        top: 0,
        right: 830,
        bottom: 1180
      },
      recruitPoint: { x: 343, y: 1128 },
      recruitAttempts: 2,
      channelMenuRegion: {
        left: 280,
        top: 760,
        right: 550,
        bottom: 1080
      },
      campChannelPoint: { x: 416, y: 895 },
      channelAttempts: 2,
      successTexts: ["成功分享至营地频道", "分享成功"],
      successRegion: {
        left: 650,
        top: 150,
        right: 1300,
        bottom: 330
      },
      stepSettleMs: 1
    }
  };
}

function patrolConfig() {
  return {
    patrolTeamUi: patrolUiConfig(),
    postLoginPromotions: {
      channelReadyTexts: ["综合", "世界", "场景", "营地", "队伍"],
      channelReadyRegion: {
        left: 0,
        top: 980,
        right: 760,
        bottom: 1200
      },
      channelReadyMinimumTexts: 2
    }
  };
}

function observation(text, x, y) {
  return { text, confidence: 1, x, y, width: 140, height: 40 };
}
