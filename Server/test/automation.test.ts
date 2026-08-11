import { describe, expect, it } from "vitest";
import { validateAutomationConfig } from "../src/validate";

describe("five-task automation configuration", () => {
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
});
