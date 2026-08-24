import test from "node:test";
import assert from "node:assert/strict";
import {
  closePatrolPanelBeforeExit,
  cleanupPatrolTeamOnFailure,
  createPatrolTeam,
  ensureExistingPatrolTargetForSharing,
  patrolTeamIsFull,
  removeFirstPatrolMemberOutsideCamp,
  sharePatrolTeam,
  startHardPatrolWithRetry,
  dailyDeadlineAt
} from "../src/workflows/patrol.mjs";

test("patrol daily deadline is resolved in the configured timezone", () => {
  const now = new Date("2026-08-10T09:00:00.000Z");
  const deadline = dailyDeadlineAt("Asia/Shanghai", "16:00", now);
  assert.equal(deadline, Date.parse("2026-08-10T08:00:00.000Z"));
});

test("hard patrol acceptance retries the complete flow while the route list remains visible", async () => {
  let flowAttempts = 0;
  const reports = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async executeFlow() {
        flowAttempts += 1;
        if (flowAttempts < 3) {
          throw new Error("Timed out waiting for: 已经拥有巡逻路线");
        }
      }
    },
    vision: {
      async capture() {
        return {
          path: "hard-patrol.png",
          observations: [observation("困难巡逻路线", 1100, 250)]
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

  await startHardPatrolWithRetry(context);

  assert.equal(flowAttempts, 3);
  assert.equal(
    reports.filter((step) => step === "patrol_hard_accept_retry").length,
    2
  );
});

test("hard patrol acceptance treats a timeout with the success text as success", async () => {
  let flowAttempts = 0;
  const reports = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async executeFlow() {
        flowAttempts += 1;
        throw new Error("Timed out waiting for: 已经拥有巡逻路线");
      }
    },
    vision: {
      async capture() {
        return {
          path: "hard-patrol-success.png",
          observations: [observation("已经拥有巡逻路线", 900, 700)]
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

  await startHardPatrolWithRetry(context);

  assert.equal(flowAttempts, 1);
  assert.ok(reports.includes("patrol_hard_accept_confirmed_after_timeout"));
});

test("hard patrol acceptance stops after eight failed attempts", async () => {
  let flowAttempts = 0;
  const context = {
    config: patrolConfig(),
    ui: {
      async executeFlow() {
        flowAttempts += 1;
        throw new Error("Timed out waiting for: 已经拥有巡逻路线");
      }
    },
    vision: {
      async capture() {
        return {
          path: "hard-patrol.png",
          observations: [observation("简单巡逻任务", 1100, 250)]
        };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact" ? item.text === query : item.text.includes(query)
        );
      }
    },
    async report() {}
  };

  await assert.rejects(
    startHardPatrolWithRetry(context),
    /PATROL_HARD_ACCEPT_UNVERIFIED/
  );
  assert.equal(flowAttempts, 8);
});

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

  assert.deepEqual(flows, ["closePatrolTeamPanelBeforeAccept"]);
  assert.ok(reports.includes("patrol_deadline_team_closed"));
});

test("patrol deadline continues to center cleanup when final panel OCR is stale", async () => {
  const reports = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async executeFlow() {
        throw new Error(
          "PATROL_CLOSE_TEAM_PANEL_DID_NOT_CLOSE: stale 离开队伍 OCR"
        );
      }
    },
    vision: {
      async capture() {
        return {
          path: "team-stale.png",
          observations: [observation("离开队伍", 1520, 1080)]
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

  assert.ok(reports.includes("patrol_deadline_panel_close_unverified_continue"));
});

test("patrol failures leave an existing team through the OCR-confirmed red button", async () => {
  const taps = [];
  const reports = [];
  let captures = 0;
  const context = {
    patrolTeamPhase: "created",
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      },
      async executeFlow() {
        throw new Error("team page should already be visible");
      }
    },
    vision: {
      async capture() {
        captures += 1;
        return {
          path: "failure-team.png",
          observations: captures === 1
            ? [observation("离开队伍", 1500, 1080)]
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
    },
    async sleep() {}
  };

  assert.equal(
    await cleanupPatrolTeamOnFailure(
      context,
      undefined,
      new Error("PATROL_TEAM_MENU_DID_NOT_OPEN")
    ),
    true
  );
  assert.deepEqual(taps, [{ x: 1570, y: 1100 }]);
  assert.ok(reports.includes("patrol_failure_team_leave"));
  assert.ok(reports.includes("patrol_failure_team_left"));
});

test("patrol failure cleanup confirms the leave-team dialog before verifying exit", async () => {
  const taps = [];
  let captures = 0;
  const context = {
    patrolTeamPhase: "created",
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    vision: {
      async capture() {
        captures += 1;
        return {
          path: "failure-team-confirm.png",
          observations:
            captures === 1
              ? [observation("离开队伍", 1500, 1080)]
              : captures === 2
                ? [
                    observation("离开队伍", 1500, 1080),
                    observation("确定(F)", 980, 620)
                  ]
                : []
        };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact" ? item.text === query : item.text.includes(query)
        );
      }
    },
    async report() {},
    async sleep() {}
  };

  assert.equal(
    await cleanupPatrolTeamOnFailure(
      context,
      undefined,
      new Error("route not verified")
    ),
    true
  );
  assert.deepEqual(taps, [
    { x: 1570, y: 1100 },
    { x: 1050, y: 640 }
  ]);
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
            observations: [
              observation("营地事务", 400, 800),
              observation("营地巡逻任务", 700, 360)
            ]
          };
        }
        if (label === "patrol-target-selected") {
          return {
            path: "target.png",
            observations: [
              observation("营地事务", 400, 800),
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

test("no-team flag menu prioritizes create entry over stale auto-match text", async () => {
  const taps = [];
  const flows = [];
  const reports = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      },
      async executeFlow(name) {
        flows.push(name);
      }
    },
    adb: {
      async key() {},
      async keyCombination() {}
    },
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
            observations: [
              observation("创建队伍", 120, 160),
              observation("自动匹配", 220, 220)
            ]
          };
        }
        return {
          path: `${label}.png`,
          observations: observationsFor(label)
        };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact" ? item.text === query : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report(_level, step) {
      reports.push(step);
    }
  };

  await createPatrolTeam(context);

  assert.deepEqual(taps.slice(0, 2), [
    { x: 48, y: 327 },
    { x: 220, y: 180 }
  ]);
  assert.ok(!flows.includes("openTeamPanel"));
  assert.ok(reports.includes("patrol_create_entry_verified_after_flag"));
});

test("patrol create-menu retries the same ADB click without toggling mouse state", async () => {
  let mouseTapCount = 0;
  const config = patrolConfig();
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
  assert.equal(mouseTapCount, 6);
});

test("patrol flag click is attempted through the shared ADB clicker", async () => {
  const config = patrolConfig();
  const taps = [];
  const context = {
    config,
    ui: { async tap(point) { taps.push(point); } },
    adb: { async key() {} },
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
            observation("巡逻路线进度 01:31:06", 200, 100),
            observation("我的任务进度 0/4", 200, 150),
            observation("等待队员加入", 650, 600),
            observation("调整", 1450, 300),
            observation("离开队伍", 1500, 1080)
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

  assert.equal(await createPatrolTeam(context), "existing-valid-route");
  assert.deepEqual(taps, []);
});

test("dance-status team cards scan both paging arrows before accepting a patrol route", async () => {
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
          return { path: `${label}.png`, observations: [observation("CtrlQ", 20, 300)] };
        }
        if (label === "patrol-team-menu-open") {
          return {
            path: `${label}.png`,
            observations: [
              observation("自动匹配", 180, 180),
              observation("舞会期间", 180, 220),
              observation("<", 20, 220),
              observation(">", 650, 220)
            ]
          };
        }
        return {
          path: `${label}.png`,
          observations: [
            observation("自动匹配", 180, 180),
            observation("巡逻路线进度", 180, 220),
            observation("我的任务进度", 180, 260),
            observation("<", 20, 220),
            observation(">", 650, 220)
          ]
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
    async report() {},
    async sleep() {}
  };

  assert.equal(await createPatrolTeam(context), "existing-valid-route");
  assert.deepEqual(taps, [
    { x: 48, y: 327 },
    { x: 720, y: 240 }
  ]);
});

test("dance-status cards use the left arrow only when the right arrow is absent", async () => {
  const taps = [];
  let page = 0;
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
        page += 1;
      }
    },
    adb: { async key() {} },
    vision: {
      async capture(label) {
        if (label === "patrol-team-entry") {
          return { path: `${label}.png`, observations: [observation("CtrlQ", 20, 300)] };
        }
        if (label === "patrol-team-menu-open") {
          return {
            path: `${label}.png`,
            observations: [
              observation("自动匹配", 180, 180),
              observation("舞会期间", 180, 220),
              observation("<", 20, 220)
            ]
          };
        }
        return {
          path: `${label}.png`,
          observations: page > 0
            ? [
                observation("自动匹配", 180, 180),
                observation("巡逻路线进度", 180, 220),
                observation("我的任务进度", 180, 260),
                observation("<", 20, 220)
              ]
            : [observation("自动匹配", 180, 180), observation("舞会期间", 180, 220), observation("<", 20, 220)]
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
    async report() {},
    async sleep() {}
  };

  assert.equal(await createPatrolTeam(context), "existing-valid-route");
  assert.deepEqual(taps, [
    { x: 48, y: 327 },
    { x: 90, y: 240 }
  ]);
});

test("route and task progress alone never masquerade as an existing team", async () => {
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
            path: "route-only.png",
            observations: [
              observation("巡逻路线进度 01:31:06", 200, 100),
              observation("我的任务进度 0/4", 200, 150),
              observation("目标：营地事务>营地巡逻任务", 200, 20),
              observation("自动匹配", 80, 220),
              observation("综合", 20, 1080),
              observation("营地", 200, 1080),
              observation("CtrlQ", 20, 300)
            ]
          };
        }
        return {
          path: `${label}.png`,
          observations: observationsFor(label)
        };
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
  assert.deepEqual(taps[0], { x: 48, y: 327 });
});

test("the selected flag color blocks a second flag click before OCR card text", async () => {
  const taps = [];
  const config = patrolConfig();
  config.patrolTeamUi.teamCardColor = {
    enabled: true,
    taskIconPoints: [{ x: 48, y: 150 }],
    taskIconBackgroundPoints: [{ x: 16, y: 150 }, { x: 80, y: 150 }],
    teamFlagIconPoints: [{ x: 48, y: 327 }],
    teamFlagBackgroundPoints: [{ x: 16, y: 327 }, { x: 80, y: 327 }],
    minimumSaturation: 0.45,
    minimumLuminance: 0.42,
    redBlueDelta: 0.2,
    greenBlueDelta: 0.12,
    minimumForegroundBackgroundLuminanceDelta: 0.12,
    minimumForegroundBackgroundChannelDelta: 0.08
  };
  const warm = { meanRed: 0.78, meanGreen: 0.56, meanBlue: 0.28, meanSaturation: 0.62 };
  const cool = { meanRed: 0.46, meanGreen: 0.42, meanBlue: 0.38, meanSaturation: 0.27 };
  const context = {
    config,
    ui: {
      async tap(point) {
        taps.push(point);
      },
      async executeFlow() {}
    },
    vision: {
      async capture(label) {
        return {
          path: `${label}.png`,
          observations: label === "patrol-team-entry"
            ? [observation("CtrlQ", 20, 300)]
            : []
        };
      },
      async probe() {
        return [cool, cool, cool, warm, cool, cool];
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

  await assert.rejects(
    createPatrolTeam(context),
    /PATROL_FLAG_CLICK_FORBIDDEN_TEAM_CARD/
  );
  assert.deepEqual(taps, []);
});

test("only a yellow task icon with a non-yellow team flag permits the flag click", async () => {
  const taps = [];
  const config = patrolConfig();
  config.patrolTeamUi.teamCardColor = {
    enabled: true,
    taskIconPoints: [{ x: 48, y: 150 }],
    taskIconBackgroundPoints: [{ x: 16, y: 150 }, { x: 80, y: 150 }],
    teamFlagIconPoints: [{ x: 48, y: 327 }],
    teamFlagBackgroundPoints: [{ x: 16, y: 327 }, { x: 80, y: 327 }],
    minimumSaturation: 0.45,
    minimumLuminance: 0.42,
    redBlueDelta: 0.2,
    greenBlueDelta: 0.12,
    minimumForegroundBackgroundLuminanceDelta: 0.12,
    minimumForegroundBackgroundChannelDelta: 0.08
  };
  const warm = { meanRed: 0.78, meanGreen: 0.56, meanBlue: 0.28, meanSaturation: 0.62 };
  const cool = { meanRed: 0.46, meanGreen: 0.42, meanBlue: 0.38, meanSaturation: 0.27 };
  let probeCalls = 0;
  const context = {
    config,
    ui: { async tap(point) { taps.push(point); } },
    adb: { async key() {} },
    vision: {
      async capture(label) {
        return { path: `${label}.png`, observations: observationsFor(label) };
      },
      async probe() {
        probeCalls += 1;
        return probeCalls <= 2
          ? [warm, cool, cool, cool, cool, cool]
          : [cool, cool, cool, warm, cool, cool];
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
  assert.deepEqual(taps[0], { x: 48, y: 327 });
});

test("a failed flag click is re-released and retried until the flag turns yellow", async () => {
  const taps = [];
  const rechecks = [];
  const sleeps = [];
  const config = patrolConfig();
  config.patrolTeamUi.teamCardColor = {
    enabled: true,
    taskIconPoints: [{ x: 48, y: 150 }],
    taskIconBackgroundPoints: [{ x: 16, y: 150 }, { x: 80, y: 150 }],
    teamFlagIconPoints: [{ x: 48, y: 327 }],
    teamFlagBackgroundPoints: [{ x: 16, y: 327 }, { x: 80, y: 327 }],
    minimumSaturation: 0.45,
    minimumLuminance: 0.42,
    redBlueDelta: 0.2,
    greenBlueDelta: 0.12,
    minimumForegroundBackgroundLuminanceDelta: 0.12,
    minimumForegroundBackgroundChannelDelta: 0.08
  };
  const warm = { meanRed: 0.78, meanGreen: 0.56, meanBlue: 0.28, meanSaturation: 0.62 };
  const cool = { meanRed: 0.46, meanGreen: 0.42, meanBlue: 0.38, meanSaturation: 0.27 };
  let probeCalls = 0;
  const context = {
    config,
    ui: {
      async tap(point) {
        taps.push(point);
      },
      async recheckGameMouseForRetry(_signal, reason) {
        rechecks.push(reason);
      }
    },
    adb: { async key() {} },
    vision: {
      async capture(label) {
        return {
          path: `${label}.png`,
          observations: label.startsWith("patrol-team-menu-open")
            ? [observation("创建队伍", 120, 160)]
            : observationsFor(label)
        };
      },
      async probe() {
        probeCalls += 1;
        if (probeCalls <= 9) {
          return [warm, cool, cool, cool, cool, cool];
        }
        return [cool, cool, cool, warm, cool, cool];
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
    async report() {}
  };

  await createPatrolTeam(context);
  assert.deepEqual(taps.slice(0, 2), [
    { x: 48, y: 327 },
    { x: 48, y: 327 }
  ]);
  assert.equal(rechecks.length, 1);
  assert.ok(sleeps.filter((ms) => ms === 2000).length >= 2);
});

test("an ambiguous initial color may click once but still requires post-click verification", async () => {
  const taps = [];
  const config = patrolConfig();
  config.patrolTeamUi.teamCardColor = {
    enabled: true,
    taskIconPoints: [{ x: 48, y: 150 }],
    taskIconBackgroundPoints: [{ x: 16, y: 150 }, { x: 80, y: 150 }],
    teamFlagIconPoints: [{ x: 48, y: 327 }],
    teamFlagBackgroundPoints: [{ x: 16, y: 327 }, { x: 80, y: 327 }],
    minimumSaturation: 0.45,
    minimumLuminance: 0.42,
    redBlueDelta: 0.2,
    greenBlueDelta: 0.12,
    minimumForegroundBackgroundLuminanceDelta: 0.12,
    minimumForegroundBackgroundChannelDelta: 0.08
  };
  const context = {
    config,
    ui: { async tap(point) { taps.push(point); } },
    adb: { async key() {} },
    vision: {
      async capture(label) {
        return {
          path: `${label}.png`,
          observations: label === "patrol-team-entry"
            ? [observation("CtrlQ", 20, 300)]
            : observationsFor(label)
        };
      },
      async probe() {
        return [
          { meanRed: 0.78, meanGreen: 0.56, meanBlue: 0.28, meanSaturation: 0.62 },
          { meanRed: 0.90, meanGreen: 0.80, meanBlue: 0.10, meanSaturation: 0.70 },
          { meanRed: 0.90, meanGreen: 0.80, meanBlue: 0.10, meanSaturation: 0.70 },
          { meanRed: 0.46, meanGreen: 0.42, meanBlue: 0.38, meanSaturation: 0.27 },
          { meanRed: 0.30, meanGreen: 0.28, meanBlue: 0.26, meanSaturation: 0.12 },
          { meanRed: 0.30, meanGreen: 0.28, meanBlue: 0.26, meanSaturation: 0.12 }
        ];
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

  await assert.rejects(
    createPatrolTeam(context),
    /PATROL_FLAG_CLICK_NOT_VERIFIED/
  );
  assert.deepEqual(taps, [
    { x: 48, y: 327 },
    { x: 48, y: 327 }
  ]);
});

test("an existing camp patrol route switches its top objective to book defense before sharing", async () => {
  const flows = [];
  const reports = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async executeFlow(name) {
        flows.push(name);
      }
    },
    vision: {
      async capture(label) {
        return {
          path: `${label}.png`,
          observations: [
            observation(
              label.includes("book-defense-confirm")
                ? "目标：营地事务>保卫古籍"
                : "目标：营地事务>营地巡逻任务",
              200,
              20
            )
          ]
        };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact" ? item.text === query : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report(_level, step) {
      reports.push(step);
    }
  };

  assert.equal(
    await ensureExistingPatrolTargetForSharing(context),
    "switched"
  );
  assert.deepEqual(flows, ["switchToBookDefense"]);
  assert.ok(reports.includes("patrol_existing_route_patrol_objective"));
  assert.ok(reports.includes("patrol_existing_route_book_defense_confirmed"));
});

test("an existing team without a patrol route is left before a fresh team is created", async () => {
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
            path: "existing-team.png",
            observations: [
              observation("目标：营地事务>营地巡逻任务", 200, 20),
              observation("等待队员加入", 650, 600),
              observation("调整", 1450, 300),
              observation("离开队伍", 1500, 1080)
            ]
          };
        }
        if (label.includes("after-leave")) {
          return {
            path: "hud.png",
            observations: [
              observation("CtrlQ", 20, 300),
              observation("综合", 20, 1080),
              observation("营地", 200, 1080)
            ]
          };
        }
        return {
          path: `${label}.png`,
          observations: observationsFor(label)
        };
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

  assert.equal(await createPatrolTeam(context), "created");
  assert.deepEqual(taps, [
    { x: 1570, y: 1100 },
    { x: 48, y: 327 },
    { x: 220, y: 180 },
    { x: 480, y: 906 },
    { x: 1419, y: 891 }
  ]);
});

test("stale leave OCR after an existing-team exit does not abort fresh creation", async () => {
  const taps = [];
  const flows = [];
  const reports = [];
  const context = {
    config: {
      ...patrolConfig(),
      flows: { closeTaskGuideOverlay: [{ op: "closeTaskGuideOverlay" }] }
    },
    ui: {
      async tap(point) {
        taps.push(point);
      },
      async executeFlow(name) {
        flows.push(name);
      }
    },
    adb: { async key() {} },
    vision: {
      async capture(label) {
        if (label === "patrol-team-entry") {
          return {
            path: "existing-team-stale.png",
            observations: [
              observation("目标：营地事务>营地巡逻任务", 200, 20),
              observation("等待队员加入", 650, 600),
              observation("调整", 1450, 300),
              observation("离开队伍", 1500, 1080)
            ]
          };
        }
        if (
          label === "patrol-existing-team-after-leave-click-1" ||
          label === "patrol-existing-team-after-leave"
        ) {
          return {
            path: "hud-with-stale-leave.png",
            observations: [
              observation("离开队伍", 1500, 1080),
              observation("CtrlQ", 20, 300),
              observation("综合", 20, 1080),
              observation("营地", 200, 1080)
            ]
          };
        }
        if (label === "patrol-existing-team-after-leave-recovered") {
          return {
            path: "hud-recovered.png",
            observations: [
              observation("CtrlQ", 20, 300),
              observation("综合", 20, 1080),
              observation("营地", 200, 1080)
            ]
          };
        }
        return {
          path: `${label}.png`,
          observations: observationsFor(label)
        };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact" ? item.text === query : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report(_level, step) {
      reports.push(step);
    }
  };

  assert.equal(await createPatrolTeam(context), "created");
  assert.deepEqual(flows, []);
  assert.ok(reports.includes("patrol_existing_team_left_stale_text_recovered"));
  assert.deepEqual(taps, [
    { x: 1570, y: 1100 },
    { x: 48, y: 327 },
    { x: 220, y: 180 },
    { x: 480, y: 906 },
    { x: 1419, y: 891 }
  ]);
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
          return {
            path: "target.png",
            observations: [
              observation("营地事务", 400, 800),
              observation("营地巡逻任务", 700, 360)
            ]
          };
        }
        if (label === "patrol-target-selected") {
          return {
            path: "selected.png",
            observations: [
              observation("营地事务", 400, 800),
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
  const reports = [];
  const sleeps = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    adb: {},
    vision: {
      async capture(label) {
        if (
          label === "patrol-share-team-page" ||
          label.includes("-recruit-verify-")
        ) {
          return {
            path: "team.png",
            observations: [
              observation("目标：营地事务>营地巡逻任务", 160, 20),
              observation("招募", 300, 1100)
            ]
          };
        }
        if (label === "patrol-share-camp-channel-menu-1") {
          return {
            path: "channels.png",
            observations: [observation("营地频道", 350, 870)]
          };
        }
        if (label === "patrol-share-scene-channel-menu-1") {
          return {
            path: "channels.png",
            observations: [observation("场景频道", 350, 870)]
          };
        }
        if (label.includes("-scene-result-")) {
          return {
            path: "success.png",
            observations: [observation("成功分享至场景频道", 780, 210)]
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
    { x: 420, y: 890 },
    { x: 343, y: 1128 },
    { x: 420, y: 890 }
  ]);
  assert.ok(sleeps.includes(3_000));
  assert.ok(reports.includes("patrol_share_camp_channel_verified"));
  assert.ok(reports.includes("patrol_share_success"));
});

test("patrol share rereads a missed recruit button and clicks its OCR position", async () => {
  const taps = [];
  let recovered = false;
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    adb: {},
    vision: {
      async capture(label) {
        if (label === "patrol-share-team-page") {
          return {
            path: "team.png",
            observations: [observation("保卫古籍", 160, 20)]
          };
        }
        if (label.includes("camp-recruit-verify-1")) {
          return { path: "team.png", observations: [] };
        }
        if (label.includes("scene-recruit-verify-1")) {
          return {
            path: "team.png",
            observations: [observation("招募", 300, 1100)]
          };
        }
        if (label.startsWith("patrol-share-camp-channel-menu")) {
          return {
            path: "channels.png",
            observations: [observation("营地频道", 350, 870)]
          };
        }
        if (label.startsWith("patrol-share-scene-channel-menu")) {
          return {
            path: "channels.png",
            observations: [observation("场景频道", 350, 870)]
          };
        }
        if (label.includes("camp-result")) {
          return {
            path: "success.png",
            observations: [observation("成功分享至营地频道", 780, 210)]
          };
        }
        return {
          path: "success.png",
          observations: [observation("成功分享至场景频道", 780, 210)]
        };
      },
      async ocrRegion(_path, _region, label) {
        if (label.includes("camp-recruit-recovery")) {
          recovered = true;
          return [observation("招募", 270, 1100)];
        }
        return [];
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

  await sharePatrolTeam(context);

  assert.equal(recovered, true);
  assert.deepEqual(taps, [
    { x: 340, y: 1120 },
    { x: 420, y: 890 },
    { x: 343, y: 1128 },
    { x: 420, y: 890 }
  ]);
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
        if (label.includes("-recruit-verify-")) {
          return {
            path: "team.png",
            observations: [observation("招募", 300, 1100)]
          };
        }
        if (label.startsWith("patrol-share-camp-channel-menu")) {
          channelAttempts += 1;
          return {
            path: "channels.png",
            observations:
              channelAttempts === 1
                ? []
                : [observation("营地频道", 350, 870)]
          };
        }
        if (label.startsWith("patrol-share-scene-channel-menu")) {
          return {
            path: "channels.png",
            observations: [observation("场景频道", 350, 870)]
          };
        }
        if (label.includes("-scene-result-")) {
          return {
            path: "success.png",
            observations: [observation("成功分享至场景频道", 780, 210)]
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
    { x: 420, y: 890 },
    { x: 343, y: 1128 },
    { x: 420, y: 890 }
  ]);
});

test("patrol share closes the invite card and retries recruit", async () => {
  const taps = [];
  let channelMenus = 0;
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    vision: {
      async capture(label) {
        if (
          label === "patrol-share-team-page" ||
          label.includes("-recruit-verify-")
        ) {
          return {
            path: "team.png",
            observations: [
              observation("保卫古籍", 160, 20),
              observation("招募", 300, 1100)
            ]
          };
        }
        if (label.startsWith("patrol-share-camp-channel-menu")) {
          channelMenus += 1;
          return {
            path: "invite-or-channel.png",
            observations:
              channelMenus === 1
                ? [observation("邀请", 300, 200), observation("推荐组队", 350, 300)]
                : [observation("营地频道", 350, 870)]
          };
        }
        if (label.startsWith("patrol-share-scene-channel-menu")) {
          return {
            path: "channels.png",
            observations: [observation("场景频道", 350, 870)]
          };
        }
        if (label.includes("-scene-result-")) {
          return {
            path: "success.png",
            observations: [observation("成功分享至场景频道", 780, 210)]
          };
        }
        return {
          path: "success.png",
          observations: [observation("成功分享至营地频道", 780, 210)]
        };
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
  context.config.patrolTeamUi.share.recruitOverlayDismissPoint = {
    x: 300,
    y: 300
  };

  await sharePatrolTeam(context);

  assert.deepEqual(taps, [
    { x: 343, y: 1128 },
    { x: 1450, y: 920 },
    { x: 343, y: 1128 },
    { x: 420, y: 890 },
    { x: 343, y: 1128 },
    { x: 420, y: 890 }
  ]);
});

test("patrol share closes an accidental task menu and retries recruit", async () => {
  const taps = [];
  let campMenus = 0;
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    adb: {},
    vision: {
      async capture(label) {
        if (label === "patrol-share-team-page" || label.includes("-recruit-verify-")) {
          return { path: "team.png", observations: [observation("招募", 300, 1100)] };
        }
        if (label.includes("-full-team-immediate-")) {
          return { path: "toast.png", observations: [] };
        }
        if (label.startsWith("patrol-share-camp-channel-menu")) {
          campMenus += 1;
          return {
            path: "camp.png",
            observations:
              campMenus === 1
                ? [observation("联盟行动", 500, 300)]
                : [observation("营地频道", 350, 870)]
          };
        }
        if (label.startsWith("patrol-share-scene-channel-menu")) {
          return { path: "scene.png", observations: [observation("场景频道", 350, 870)] };
        }
        if (label.includes("-camp-result-")) {
          return { path: "camp-result.png", observations: [observation("分享成功", 780, 210)] };
        }
        return { path: "scene-result.png", observations: [observation("分享成功", 780, 210)] };
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

  context.config.patrolTeamUi.share.recruitTaskMenuClosePoint = { x: 1800, y: 80 };
  await sharePatrolTeam(context);
  assert.deepEqual(taps, [
    { x: 343, y: 1128 },
    { x: 1800, y: 80 },
    { x: 343, y: 1128 },
    { x: 420, y: 890 },
    { x: 343, y: 1128 },
    { x: 420, y: 890 }
  ]);
});

test("a short full-team toast skips both channel shares without failing", async () => {
  const taps = [];
  const reports = [];
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    adb: {},
    vision: {
      async capture(label) {
        if (label === "patrol-share-team-page" || label.includes("-recruit-verify-")) {
          return {
            path: "team.png",
            observations: [
              observation("保卫古籍", 160, 20),
              observation("招募", 300, 1100)
            ]
          };
        }
        if (label.includes("-full-team-immediate-")) {
          return {
            path: "toast.png",
            observations: [observation("队伍已满员，无法再加入", 620, 245)]
          };
        }
        return { path: "empty.png", observations: [] };
      },
      find(observations, query, mode) {
        return observations.find((item) =>
          mode === "exact" ? item.text === query : item.text.includes(query)
        );
      }
    },
    async sleep() {},
    async report(_level, step) {
      reports.push(step);
    }
  };

  await sharePatrolTeam(context);

  assert.deepEqual(taps, [{ x: 343, y: 1128 }]);
  assert.ok(reports.includes("patrol_share_full_team_confirmed"));
  assert.ok(reports.includes("patrol_share_skipped_no_target"));
});

test("camp and scene sharing each get their own retry budget", async () => {
  const taps = [];
  let campMenus = 0;
  let sceneMenus = 0;
  const context = {
    config: patrolConfig(),
    ui: {
      async tap(point) {
        taps.push(point);
      }
    },
    adb: {},
    vision: {
      async capture(label) {
        if (label === "patrol-share-team-page" || label.includes("-recruit-verify-")) {
          return {
            path: "team.png",
            observations: [observation("招募", 300, 1100)]
          };
        }
        if (label.includes("-camp-channel-menu-")) {
          campMenus += 1;
          return {
            path: "camp.png",
            observations: campMenus === 1 ? [] : [observation("营地频道", 350, 870)]
          };
        }
        if (label.includes("-scene-channel-menu-")) {
          sceneMenus += 1;
          return {
            path: "scene.png",
            observations: sceneMenus === 1 ? [] : [observation("场景频道", 350, 870)]
          };
        }
        if (label.includes("-camp-result-")) {
          return { path: "camp-result.png", observations: [observation("分享成功", 780, 210)] };
        }
        if (label.includes("-scene-result-")) {
          return { path: "scene-result.png", observations: [observation("分享成功", 780, 210)] };
        }
        return { path: "empty.png", observations: [] };
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

  await sharePatrolTeam(context);

  assert.equal(campMenus, 2);
  assert.equal(sceneMenus, 2);
  assert.deepEqual(taps, [
    { x: 343, y: 1128 },
    { x: 343, y: 1128 },
    { x: 420, y: 890 },
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

test("Latin OCR noise is never treated as a patrol location", async () => {
  const reports = [];
  const removed = await removeFirstPatrolMemberOutsideCamp(
    {
      config: { patrolTeamUi: patrolUiConfig() },
      ui: {
        async tap() {
          throw new Error("should not remove on Latin OCR noise");
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
        observation("COSGH", 650, 860),
        observation("玩家乙", 1050, 800),
        observation("LSGH", 1050, 860),
        observation("玩家丙", 1450, 800),
        observation("愿", 1450, 860)
      ]
    },
    undefined,
    "愿"
  );

  assert.equal(removed, false);
  assert.equal(
    reports.filter((step) => step === "patrol_member_location_unverified").length,
    2
  );
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
    return [
      observation("营地事务", 400, 800),
      observation("营地巡逻任务", 700, 360)
    ];
  }
  if (label === "patrol-target-selected") {
    return [
      observation("营地事务", 400, 800),
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
      recruitAttempts: 10,
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
      channelAttempts: 10,
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
