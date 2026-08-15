import { describe, expect, it } from "vitest";
import type { AutomationConfig } from "../src/domain";
import {
  preserveAutomationScheduleTimes,
  validateAutomationConfig,
  validateCampConfig
} from "../src/validate";

describe("five-task automation configuration", () => {
  it("defaults the reserved special daily refresh to midnight", () => {
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

    expect(validateCampConfig(base).specialDailyRefreshTime).toBe("00:00");
    expect(
      validateCampConfig({ ...base, specialDailyRefreshTime: "01:15" })
        .specialDailyRefreshTime
    ).toBe("01:15");
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
    expect(config.tasks).not.toHaveProperty("member_sync");
    expect(config.routines).toEqual([]);
    expect(config.agentPolling.claimTimeoutMinutes).toBe(45);
  });

  it("accepts a custom Agent claim timeout", () => {
    const config = validateAutomationConfig({
      timezone: "Asia/Shanghai",
      schedulerGraceMinutes: 5,
      agentPolling: {
        activeSeconds: 2,
        idleSeconds: 15,
        claimTimeoutMinutes: 90,
        windows: []
      },
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
    expect(config.agentPolling.claimTimeoutMinutes).toBe(90);
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
        times: ["02:30", "12:30", "18:30"]
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
