import { describe, expect, it } from "vitest";
import type { AutomationConfig } from "../src/domain";
import { isManualRetryEligible } from "../src/tasks";
import {
  preserveAutomationScheduleTimes,
  validateAutomationConfig,
  validateCampConfig
} from "../src/validate";

describe("five-task automation configuration", () => {
  const base = {
    timezone: "Asia/Shanghai",
    gameResetTime: "03:00",
    voteWindowStart: "06:30",
    voteWindowEnd: "24:00",
    currentCampType: "agriculture",
    agentId: "",
    publicSiteName: "Site",
    campName: "Camp",
    serverName: "Server",
    publicMembersEnabled: true,
    inactivityWarningDays: 1
  };

  it("allows manual retries only inside the scheduled task window", () => {
    const bundle = {
      automationConfig: {
        timezone: "Asia/Shanghai",
        tasks: {
          tech_switch: { time: "02:00", times: ["02:00"] },
          contribution_sync: { time: "02:30", times: ["02:30", "12:30"] },
          inactivity_sync: { time: "02:45", times: ["02:45"] },
          member_profile_sync: { time: "02:15", times: ["02:15"] },
          patrol: { time: "19:20", deadline: "21:25" }
        }
      }
    } as any;
    expect(
      isManualRetryEligible(
        bundle,
        "contribution_sync",
        new Date("2026-07-26T18:40:00.000Z")
      )
    ).toBe(true);
    expect(
      isManualRetryEligible(
        bundle,
        "contribution_sync",
        new Date("2026-07-26T18:45:00.000Z")
      )
    ).toBe(false);
    expect(
      isManualRetryEligible(
        bundle,
        "patrol",
        new Date("2026-07-26T13:00:00.000Z")
      )
    ).toBe(true);
    expect(
      isManualRetryEligible(
        bundle,
        "patrol",
        new Date("2026-07-26T13:25:00.000Z")
      )
    ).toBe(false);
  });

  it("defaults the reserved special daily refresh to midnight", () => {
    expect(validateCampConfig(base).specialDailyRefreshTime).toBe("00:00");
    expect(
      validateCampConfig({ ...base, specialDailyRefreshTime: "01:15" })
        .specialDailyRefreshTime
    ).toBe("01:15");
  });

  it("defaults manual retries to zero and accepts a separate manual retry count", () => {
    const baseAutomation = {
      timezone: "Asia/Shanghai",
      schedulerGraceMinutes: 5,
      scheduledRetryCount: 2,
      agentPolling: { activeSeconds: 2, idleSeconds: 300, windows: [] },
      gameWatchdog: {
        enabled: true,
        healthCheckSeconds: 10,
        actionTimeoutSeconds: 45,
        frozenScreenSeconds: 90,
        maxRestarts: 2,
        restartCooldownSeconds: 8
      },
      tasks: {
        patrol: {
          enabled: true,
          time: "19:20",
          teamReadyTime: "19:30",
          shareIntervalMinutes: 10,
          chatPollSeconds: 5,
          deadline: "21:25"
        }
      }
    };
    expect(validateAutomationConfig(baseAutomation).manualRetryCount).toBe(0);
    expect(
      validateAutomationConfig({ ...baseAutomation, manualRetryCount: 3 }).manualRetryCount
    ).toBe(3);
  });

  it("keeps an overnight vote cutoff before the next game refresh", () => {
    const overnight = validateCampConfig({
      ...base,
      voteWindowStart: "03:00",
      voteWindowEnd: "02:30"
    });
    expect(overnight.voteWindowStart).toBe("03:00");
    expect(overnight.voteWindowEnd).toBe("02:30");
    expect(() =>
      validateCampConfig({
        ...base,
        voteWindowStart: "03:30",
        voteWindowEnd: "03:30"
      })
    ).toThrow("campConfig vote window cannot be empty");
    expect(() =>
      validateCampConfig({
        ...base,
        voteWindowStart: "04:30",
        voteWindowEnd: "03:00"
      })
    ).toThrow("跨日科技投票截止时间必须早于游戏每日刷新时间");
  });

  it("defaults the four daytime tasks and removes legacy routines", () => {
    const config = validateAutomationConfig({
      timezone: "Asia/Shanghai",
      schedulerGraceMinutes: 5,
      agentPolling: {
        activeSeconds: 2,
        idleSeconds: 300,
        windows: []
      },
      gameWatchdog: {
        enabled: true,
        healthCheckSeconds: 10,
        actionTimeoutSeconds: 45,
        frozenScreenSeconds: 90,
        maxRestarts: 2,
        restartCooldownSeconds: 8
      },
      tasks: {
        patrol: {
          enabled: true,
          time: "19:20",
          teamReadyTime: "19:30",
          shareIntervalMinutes: 10,
          chatPollSeconds: 5,
          deadline: "21:25"
        }
      },
      routines: [
        {
          id: "legacy",
          name: "旧组合任务",
          enabled: true,
          time: "02:30",
          weekdays: [1],
          groups: [["member_sync"]]
        }
      ]
    });

    expect(config.tasks).toMatchObject({
      tech_switch: { enabled: true, time: "02:00", times: ["02:00"] },
      contribution_sync: { enabled: true, time: "02:30", times: ["02:30"] },
      inactivity_sync: { enabled: true, time: "02:45", times: ["02:45"] },
      member_profile_sync: { enabled: true, time: "02:15", times: ["02:15"] },
      patrol: { enabled: true, time: "19:20", times: ["19:20"] }
    });
    expect(config.tasks.tech_switch.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(config.tasks.contribution_sync.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(config.tasks.inactivity_sync.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(config.tasks.member_profile_sync.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(config.tasks.patrol.weekdays).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(config.tasks).not.toHaveProperty("member_sync");
    expect(config.routines).toEqual([]);
    expect(config.agent.claimTimeoutMinutes).toBe(45);
  });

  it("accepts a custom Agent claim timeout", () => {
    const config = validateAutomationConfig({
      timezone: "Asia/Shanghai",
      schedulerGraceMinutes: 5,
      agent: { claimTimeoutMinutes: 90 },
      gameWatchdog: {
        enabled: true,
        healthCheckSeconds: 10,
        actionTimeoutSeconds: 180,
        frozenScreenSeconds: 180,
        maxRestarts: 3,
        restartCooldownSeconds: 30
      },
      tasks: {
        patrol: {
          enabled: true,
          time: "19:20",
          teamReadyTime: "19:30",
          shareIntervalMinutes: 10,
          chatPollSeconds: 5,
          deadline: "21:25"
        }
      }
    });
    expect(config.agent.claimTimeoutMinutes).toBe(90);
    expect(config).not.toHaveProperty("agentPolling");
  });

  it("normalizes legacy polling settings without retaining obsolete intervals", () => {
    const config = validateAutomationConfig({
      timezone: "Asia/Shanghai",
      schedulerGraceMinutes: 5,
      agentPolling: {
        activeSeconds: 1,
        idleSeconds: 2,
        scheduledWindowMinutes: 1,
        claimTimeoutMinutes: 73,
        windows: [{ malformed: true }]
      },
      tasks: {
        patrol: {
          enabled: true,
          time: "19:20",
          teamReadyTime: "19:30",
          shareIntervalMinutes: 10,
          chatPollSeconds: 5,
          deadline: "21:25"
        }
      }
    });
    expect(config.agent.claimTimeoutMinutes).toBe(73);
    expect(config).not.toHaveProperty("agentPolling");
  });

  it("preserves the execution policy values used by the Mac Agent", () => {
    const config = validateAutomationConfig({
      timezone: "Asia/Shanghai",
      schedulerGraceMinutes: 5,
      agentPolling: { activeSeconds: 2, idleSeconds: 30, windows: [] },
      gameWatchdog: {
        enabled: true,
        healthCheckSeconds: 15,
        actionTimeoutSeconds: 180,
        frozenScreenSeconds: 180,
        maxRestarts: 3,
        restartCooldownSeconds: 30
      },
      tasks: {
        patrol: {
          enabled: true,
          time: "19:20",
          teamReadyTime: "19:30",
          shareIntervalMinutes: 10,
          chatPollSeconds: 5,
          deadline: "21:25"
        }
      }
    });

    expect(config.gameWatchdog).toEqual({
      enabled: true,
      healthCheckSeconds: 15,
      actionTimeoutSeconds: 180,
      frozenScreenSeconds: 180,
      maxRestarts: 3,
      restartCooldownSeconds: 30
    });
  });

  it("supports multiple daytime executions for non-technology, non-patrol tasks", () => {
    const config = validateAutomationConfig({
      timezone: "Asia/Shanghai",
      schedulerGraceMinutes: 5,
      scheduledRetryCount: 4,
      agentPolling: { activeSeconds: 2, idleSeconds: 300, windows: [] },
      gameWatchdog: {
        enabled: true,
        healthCheckSeconds: 10,
        actionTimeoutSeconds: 45,
        frozenScreenSeconds: 90,
        maxRestarts: 2,
        restartCooldownSeconds: 8
      },
      tasks: {
        tech_switch: { enabled: true, time: "02:00", times: ["02:00"] },
        contribution_sync: { enabled: true, time: "02:30", times: ["02:30", "12:30"] },
        inactivity_sync: { enabled: true, time: "02:45", times: ["02:45", "13:45"] },
        member_profile_sync: { enabled: true, time: "02:15", times: ["02:15", "14:15"] },
        patrol: {
          enabled: true,
          time: "19:20",
          teamReadyTime: "19:30",
          shareIntervalMinutes: 10,
          chatPollSeconds: 5,
          deadline: "21:25"
        }
      }
    });
    expect(config.scheduledRetryCount).toBe(4);
    expect(config.tasks.contribution_sync.times).toEqual(["02:30", "12:30"]);
    expect(config.tasks.inactivity_sync.times).toEqual(["02:45", "13:45"]);
    expect(config.tasks.member_profile_sync.times).toEqual(["02:15", "14:15"]);
    expect(config.tasks.tech_switch.times).toEqual(["02:00"]);
    expect(config.tasks.patrol.times).toEqual(["19:20"]);
  });

  it("accepts selected execution weekdays for every task and rejects an empty selection", () => {
    const config = validateAutomationConfig({
      timezone: "Asia/Shanghai",
      schedulerGraceMinutes: 5,
      agentPolling: { activeSeconds: 2, idleSeconds: 300, windows: [] },
      gameWatchdog: {
        enabled: true,
        healthCheckSeconds: 10,
        actionTimeoutSeconds: 45,
        frozenScreenSeconds: 90,
        maxRestarts: 2,
        restartCooldownSeconds: 8
      },
      tasks: {
        tech_switch: {
          enabled: true,
          time: "02:00",
          weekdays: [2, 4, 6]
        },
        contribution_sync: {
          enabled: true,
          time: "02:30",
          weekdays: [1, 3, 5]
        },
        patrol: {
          enabled: true,
          time: "19:20",
          weekdays: [2, 4, 6],
          teamReadyTime: "19:30",
          shareIntervalMinutes: 10,
          chatPollSeconds: 5,
          deadline: "21:25"
        }
      }
    });
    expect(config.tasks.tech_switch.weekdays).toEqual([2, 4, 6]);
    expect(config.tasks.contribution_sync.weekdays).toEqual([1, 3, 5]);
    expect(config.tasks.patrol.weekdays).toEqual([2, 4, 6]);
    expect(() => validateAutomationConfig({
      timezone: "Asia/Shanghai",
      schedulerGraceMinutes: 5,
      agentPolling: { activeSeconds: 2, idleSeconds: 300, windows: [] },
      gameWatchdog: {
        enabled: true,
        healthCheckSeconds: 10,
        actionTimeoutSeconds: 45,
        frozenScreenSeconds: 90,
        maxRestarts: 2,
        restartCooldownSeconds: 8
      },
      tasks: {
        tech_switch: { enabled: true, time: "02:00", weekdays: [] },
        patrol: {
          enabled: true,
          time: "19:20",
          teamReadyTime: "19:30",
          shareIntervalMinutes: 10,
          chatPollSeconds: 5,
          deadline: "21:25"
        }
      }
    })).toThrow("automationConfig.tasks.tech_switch.weekdays must contain weekdays");
  });

  it("keeps technology and patrol as single scheduled times", () => {
    expect(() => validateAutomationConfig({
      timezone: "Asia/Shanghai",
      schedulerGraceMinutes: 5,
      agentPolling: { activeSeconds: 2, idleSeconds: 300, windows: [] },
      gameWatchdog: {
        enabled: true,
        healthCheckSeconds: 10,
        actionTimeoutSeconds: 45,
        frozenScreenSeconds: 90,
        maxRestarts: 2,
        restartCooldownSeconds: 8
      },
      tasks: {
        tech_switch: { enabled: true, time: "02:00", times: ["02:00", "12:00"] },
        patrol: {
          enabled: true,
          time: "19:20",
          times: ["19:20"],
          teamReadyTime: "19:30",
          shareIntervalMinutes: 10,
          chatPollSeconds: 5,
          deadline: "21:25"
        }
      }
    })).toThrow("tech_switch.times supports only one time");
  });

  it("rejects multiple patrol execution times", () => {
    expect(() => validateAutomationConfig({
      timezone: "Asia/Shanghai",
      schedulerGraceMinutes: 5,
      agentPolling: { activeSeconds: 2, idleSeconds: 300, windows: [] },
      gameWatchdog: {
        enabled: true,
        healthCheckSeconds: 10,
        actionTimeoutSeconds: 45,
        frozenScreenSeconds: 90,
        maxRestarts: 2,
        restartCooldownSeconds: 8
      },
      tasks: {
        patrol: {
          enabled: true,
          time: "19:20",
          times: ["19:20", "20:20"],
          teamReadyTime: "19:30",
          shareIntervalMinutes: 10,
          chatPollSeconds: 5,
          deadline: "21:25"
        }
      }
    })).toThrow("patrol.times supports only one time");
  });

  it("preserves later slots when a legacy client omits times", () => {
    const current = {
      tech_switch: { enabled: true, time: "02:00", times: ["02:00"] },
      contribution_sync: {
        enabled: true,
        time: "02:30",
        times: ["02:30", "12:30", "18:30"],
        weekdays: [1, 3, 5]
      },
      inactivity_sync: {
        enabled: true,
        time: "02:45",
        times: ["02:45", "13:45"]
      },
      member_profile_sync: {
        enabled: true,
        time: "02:15",
        times: ["02:15", "14:15"]
      },
      weekly_activity_sync: {
        enabled: true,
        time: "22:00",
        times: ["22:00"],
        weekdays: [7]
      },
      patrol: {
        enabled: true,
        time: "19:20",
        times: ["19:20"],
        teamReadyTime: "19:30",
        shareIntervalMinutes: 10,
        chatPollSeconds: 5,
        deadline: "21:25"
      }
    } satisfies AutomationConfig["tasks"];
    const submitted = {
      ...current,
      contribution_sync: { ...current.contribution_sync, time: "03:00", times: ["03:00"] },
      inactivity_sync: { ...current.inactivity_sync, time: "04:00", times: ["04:00"] },
      member_profile_sync: { ...current.member_profile_sync, time: "05:00", times: ["05:00"] }
    } satisfies AutomationConfig["tasks"];

    const merged = preserveAutomationScheduleTimes(
      current,
      submitted,
      {
        automationConfig: {
          tasks: {
            contribution_sync: { enabled: true, time: "03:00" },
            inactivity_sync: { enabled: true, time: "04:00" },
            member_profile_sync: { enabled: true, time: "05:00" }
          }
        }
      }
    );

    expect(merged.contribution_sync.times).toEqual(["03:00", "12:30", "18:30"]);
    expect(merged.inactivity_sync.times).toEqual(["04:00", "13:45"]);
    expect(merged.member_profile_sync.times).toEqual(["05:00", "14:15"]);
    expect(merged.contribution_sync.weekdays).toEqual([1, 3, 5]);

    const explicitlyReduced = preserveAutomationScheduleTimes(
      current,
      submitted,
      {
        automationConfig: {
          tasks: {
            contribution_sync: {
              enabled: true,
              time: "03:00",
              times: ["03:00"],
              replaceTimes: true
            }
          }
        }
      }
    );
    expect(explicitlyReduced.contribution_sync.times).toEqual(["03:00"]);
  });
});
