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
      tech_switch: { enabled: true, time: "02:00" },
      contribution_sync: { enabled: true, time: "02:30" },
      inactivity_sync: { enabled: true, time: "02:50" },
      member_profile_sync: { enabled: true, time: "03:10" },
      patrol: { enabled: true, time: "19:20" }
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
});
