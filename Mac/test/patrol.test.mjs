import test from "node:test";
import assert from "node:assert/strict";
import {
  closePatrolPanelBeforeExit,
  createPatrolTeam,
  patrolTeamIsFull,
  removeFirstPatrolMemberOutsideCamp,
  sharePatrolTeam
} from "../src/workflows/patrol.mjs";

test("patrol deadline closes the team panel before the session returns to center", async () => {
  const flows = [];
  const reports = [];
  let captures = 0;
  const context = {
    config: patrolConfig(),
    ui: {
      async executeFlow(name) {
        flows.push(name);
      }
    },
    vision: {
      async capture() {
        captures += 1;
        return {
          path: "team.png",
          observations: captures === 1
            ? [observation("调整", 80, 40), observation("离开队伍", 1520, 1080)]
            : []
        };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact" ? item.text === query : item.text.includes(query)
        );
      }
    },
    async report(_level, step) {
      reports.push(step);
    }
  };

  await closePatrolPanelBeforeExit(context);

  assert.deepEqual(flows, ["closeTeamPanel"]);
  assert.ok(reports.includes("patrol_deadline_team_closed"));
});

test("patrol team creation follows only region-verified live-device steps", async () => {
  const taps = [];
  const reports = [];
  const sleeps = [];
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
    async sleep(ms) {
      sleeps.push(ms);
    },
    async report(_level, step) {
      reports.push(step);
    }
  };

  await createPatrolTeam(context);

  assert.deepEqual(taps, [
    { x: 48, y: 327 },
    { x: 220, y: 180 },
    { x: 480, y: 906 },
    { x: 1419, y: 891 }
  ]);
  assert.ok(sleeps.filter((ms) => ms === 5_000).length >= 2);
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
        if (label.startsWith("patrol-team-creator-open-")) {
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

test("patrol create-menu uses bounded late host mouse release retries after its verified entry click fails", async () => {
  let mouseTapCount = 0;
  let hostUnlockCount = 0;
  const config = patrolConfig();
  config.patrolTeamUi.hostMouseUnlockBeforeCreate = true;
  const context = {
    config,
    ui: {
      async tap() {
        mouseTapCount += 1;
      }
    },
    adb: {
      async key() {}
    },
    mumu: {
      async releaseContainerMouseCapture() {
        hostUnlockCount += 1;
        return { mouseReleased: true };
      }
    },
    vision: {
      async capture() {
        return {
          path: "menu.png",
          observations: [observation("创建队伍", 120, 160)]
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

  await assert.rejects(
    createPatrolTeam(context),
    /PATROL_TEAM_CREATOR_DID_NOT_OPEN/
  );
  // The initial capture already has the flag menu open, so no pre-flag release is
  // permitted. Each failed create-entry retry may use the shared late recovery
  // path, but never before the first verified click and never beyond its limit.
  assert.equal(mouseTapCount, 6);
  assert.equal(hostUnlockCount, 5);
});

test("patrol flag opens directly without toggling host mouse release", async () => {
  let hostUnlockCount = 0;
  const config = patrolConfig();
  config.patrolTeamUi.hostMouseUnlockBeforeCreate = true;
  const context = {
    config,
    ui: { async tap() {} },
    adb: { async key() {} },
    mumu: {
      async releaseContainerMouseCapture() {
        hostUnlockCount += 1;
        return { mouseReleased: true };
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
          mode === "exact" ? item.text === query : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report() {}
  };

  await createPatrolTeam(context);
  assert.equal(hostUnlockCount, 0);
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
    { x: 220, y: 180 },
    { x: 480, y: 906 },
    { x: 1419, y: 891 }
  ]);
});

test("patrol category fallback reuses the contribution-list ADB mouse swipe", async () => {
  const taps = [];
  const swipes = [];
  const context = {
    config: patrolConfig(),
    ui: { async tap(point) { taps.push(point); } },
    adb: {
      async releaseGameMouseCapture() {},
      async mouseTap() {},
      async mouseSwipe(from, to, durationMs) {
        swipes.push({ from, to, durationMs });
      },
      async key() {}
    },
    vision: {
      async capture(label) {
        if (label === "patrol-team-entry") {
          return { path: "hud.png", observations: [observation("CtrlQ", 20, 300)] };
        }
        if (label === "patrol-team-menu-open") {
          return { path: "menu.png", observations: [observation("创建队伍", 120, 160)] };
        }
        if (label.startsWith("patrol-team-creator-open-")) {
          return {
            path: "creator.png",
            observations: [observation("队伍目标", 390, 250), observation("创建队伍", 1340, 865)]
          };
        }
        if (label.startsWith("patrol-camp-affairs-selected")) {
          return { path: "miss.png", observations: [] };
        }
        if (label === "patrol-camp-affairs-scroll-1") {
          return { path: "scroll.png", observations: [observation("营地事务", 400, 800)] };
        }
        if (label.startsWith("patrol-camp-affairs-scroll-reread")) {
          return { path: "target.png", observations: [observation("营地巡逻任务", 700, 360)] };
        }
        if (label === "patrol-target-selected") {
          return {
            path: "selected.png",
            observations: [observation("营地巡逻任务", 700, 360), observation("创建队伍", 1340, 865)]
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
      async captureAccurateTransient() { return { path: null, observations: [] }; },
      find(observations, query, mode) {
        return observations.find((item) => mode === "exact" ? item.text === query : item.text.includes(query));
      }
    },
    async sleep() {},
    async report() {}
  };

  await createPatrolTeam(context);

  assert.deepEqual(swipes, [{
    from: { x: 480, y: 820 },
    to: { x: 480, y: 510 },
    durationMs: 500
  }]);
  assert.deepEqual(taps, [
    { x: 48, y: 327 },
    { x: 220, y: 180 },
    { x: 480, y: 906 },
    { x: 470, y: 820 },
    { x: 1419, y: 891 }
  ]);
});

test("Ctrl+Q fallback is sent one at a time until the second recognition succeeds", async () => {
  const combinations = [];
  const reports = [];
  const context = {
    config: patrolConfig(),
    ui: { async tap() {} },
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
        if (
          label === "patrol-team-menu-open" ||
          label === "patrol-team-menu-open-2" ||
          label === "patrol-team-menu-key-fallback-1"
        ) {
          return { path: `${label}.png`, observations: [] };
        }
        return {
          path: `${label}.png`,
          observations: observationsFor(
            label === "patrol-team-menu-key-fallback-2"
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
    async report(_level, _step, message) {
      reports.push(message);
    }
  };

  await createPatrolTeam(context);

  assert.equal(combinations.length, 2);
  assert.ok(reports.some((message) => message.includes("第 2/6 次 Ctrl+Q")));
});

test("Ctrl+Q fallback stops after six recognition attempts", async () => {
  const combinations = [];
  const context = {
    config: patrolConfig(),
    ui: { async tap() {} },
    adb: {
      async keyCombination(codes) {
        combinations.push(codes);
      },
      async key() {}
    },
    vision: {
      async capture(label) {
        return {
          path: `${label}.png`,
          observations:
            label === "patrol-team-entry"
              ? [observation("CtrlQ", 20, 300)]
              : []
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

  await assert.rejects(
    createPatrolTeam(context),
    /6 次逐次 Ctrl\+Q 备用/
  );
  assert.equal(combinations.length, 6);
});

test("patrol share uses calibrated recruit and camp-channel points and verifies success", async () => {
  const taps = [];
  let mouseReleases = 0;
  const reports = [];
  const sleeps = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    adb: {
      async releaseGameMouseCapture() {
        mouseReleases += 1;
      }
    },
    vision: {
      async capture(label) {
        if (
          label === "patrol-share-team-page" ||
          label.startsWith("patrol-share-recruit-verify")
        ) {
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
    async sleep(ms) {
      sleeps.push(ms);
    },
    async report(_level, step) {
      reports.push(step);
    }
  };

  await sharePatrolTeam(context);

  assert.deepEqual(taps, [
    { x: 343, y: 1128 },
    { x: 420, y: 890 }
  ]);
  assert.equal(mouseReleases, 1);
  assert.ok(sleeps.includes(3_000));
  assert.ok(reports.includes("patrol_share_camp_channel_verified"));
  assert.ok(reports.includes("patrol_share_success"));
});

test("book-defense patrol share verifies and clicks the fixed camp-channel row", async () => {
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
        if (label.startsWith("patrol-share-recruit-verify")) {
          return {
            path: "team.png",
            observations: [observation("招募", 300, 1100)]
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
    { x: 420, y: 890 }
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
  assert.deepEqual(taps, []);
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

test("an out-of-camp member is removed from the leftmost member slot by OCR", async () => {
  const taps = [];
  const sleeps = [];
  const reports = [];
  const removed = await removeFirstPatrolMemberOutsideCamp(
    {
      config: { patrolTeamUi: patrolUiConfig() },
      ui: {
        async tap(point) {
          taps.push(point);
        }
      },
      vision: {
        async capture(label) {
          if (label === "patrol-member-remove-confirm-slot-2") {
            return {
              path: "member-confirm.png",
              observations: [observation("确认(F)", 950, 590)]
            };
          }
          assert.equal(label, "patrol-member-remove-menu-slot-2");
          return {
            path: "member-menu.png",
            observations: [observation("移出队伍", 700, 900)]
          };
        },
        find(observations, query, mode) {
          return observations.find((item) =>
            mode === "exact" ? item.text === query : item.text.includes(query)
          );
        }
      },
      async sleep(ms) {
        sleeps.push(ms);
      },
      async report(_level, step) {
        reports.push(step);
      }
    },
    {
      observations: [
        observation("翎音", 650, 800),
        observation("密斯卡镇", 650, 860),
        observation("雨梦", 1050, 800),
        observation("愿", 1050, 860),
        observation("玩家丙", 1450, 800),
        observation("愿", 1450, 860)
      ]
    },
    undefined,
    "愿"
  );

  assert.equal(removed, true);
  assert.deepEqual(taps, [
    { x: 758, y: 625 },
    { x: 770, y: 920 },
    { x: 1020, y: 610 }
  ]);
  assert.deepEqual(sleeps, [3_000, 500, 800]);
  assert.ok(reports.includes("patrol_member_outside_camp"));
  assert.ok(reports.includes("patrol_member_remove_confirmed"));
  assert.ok(reports.includes("patrol_member_remove_final_confirmed"));
});

test("members whose card-bottom location is the camp are never removed", async () => {
  const reports = [];
  const removed = await removeFirstPatrolMemberOutsideCamp(
    {
      config: { patrolTeamUi: patrolUiConfig() },
      ui: {
        async tap() {
          throw new Error("should not remove an in-camp member");
        }
      },
      vision: {
        find(observations, query, mode) {
          return observations.find((item) =>
            mode === "exact" ? item.text === query : item.text.includes(query)
          );
        }
      },
      async report(_level, step) {
        reports.push(step);
      }
    },
    {
      observations: [
        observation("玩家甲", 650, 800),
        observation("愿", 650, 860),
        observation("玩家乙", 1050, 800),
        observation("愿", 1050, 860),
        observation("玩家丙", 1450, 800),
        observation("愿", 1450, 860)
      ]
    },
    undefined,
    "愿"
  );

  assert.equal(removed, false);
  assert.ok(reports.includes("patrol_member_locations_verified"));
});

function observationsFor(label) {
  if (label === "patrol-team-entry") {
    return [observation("CtrlQ", 20, 300)];
  }
  if (label === "patrol-team-menu-open") {
    return [observation("创建队伍", 120, 160)];
  }
  if (label.startsWith("patrol-team-creator-open-")) {
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
    createMenuPoint: { x: 220, y: 180 },
    creatorTitleRegion: { left: 350, top: 235, right: 1565, bottom: 325 },
    campAffairsPoint: { x: 480, y: 906 },
    campAffairsFallback: {
      texts: ["营地事务", "营地事物"],
      region: { left: 350, top: 285, right: 620, bottom: 975 },
      from: { x: 480, y: 820 },
      to: { x: 480, y: 510 },
      durationMs: 500,
      settleAfterSwipeMs: 3000,
      maxSwipes: 2
    },
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
    comboFallbackAttempts: 6,
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
      recruitTextRegion: {
        left: 220,
        top: 1040,
        right: 480,
        bottom: 1180
      },
      recruitAttempts: 6,
      channelMenuRegion: {
        left: 280,
        top: 760,
        right: 550,
        bottom: 1080
      },
      campChannelTextRegion: {
        left: 280,
        top: 840,
        right: 550,
        bottom: 960
      },
      campChannelPoint: { x: 416, y: 895 },
      channelAttempts: 6,
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
