import { describe, expect, it } from "vitest";
import { validateConfigBundle } from "../src/validate";

describe("site timezone authority", () => {
  it("normalizes automation timezone to the administrator's site timezone", () => {
    const bundle = validateConfigBundle({
      campConfig: {
        timezone: "Asia/Taipei",
        gameResetTime: "03:00",
        voteWindowStart: "06:30",
        voteWindowEnd: "24:00",
        currentCampType: "agriculture",
        agentId: "",
        publicSiteName: "Site",
        campName: "Camp",
        serverName: "Server",
        publicMembersEnabled: true
      },
      authConfig: { temporaryKeyLoginEnabled: true },
      publicOverview: { announcement: "", highlights: [] },
      technologyConfig: { catalog: [] },
      automationConfig: {
        timezone: "America/New_York",
        schedulerGraceMinutes: 5,
        tasks: {
          tech_switch: { enabled: true, time: "02:00" },
          contribution_sync: { enabled: true, time: "02:30" },
          inactivity_sync: { enabled: true, time: "02:45" },
          member_profile_sync: { enabled: true, time: "02:15" },
          weekly_activity_sync: { enabled: true, time: "22:00" },
          patrol: {
            enabled: true,
            time: "19:20",
            teamReadyTime: "19:20",
            deadline: "21:25",
            shareIntervalMinutes: 10,
            chatPollSeconds: 5
          }
        }
      }
    });

    expect(bundle.campConfig.timezone).toBe("UTC+08:00");
    expect(bundle.automationConfig.timezone).toBe("UTC+08:00");
    expect(bundle.automationConfig.tasks.weekly_activity_sync.time).toBe("22:00");
  });

  it("accepts UTC offsets as the new site timezone setting", () => {
    const bundle = validateConfigBundle({
      campConfig: {
        timezone: "UTC+10:00",
        gameResetTime: "03:00",
        voteWindowStart: "06:00",
        voteWindowEnd: "24:00",
        currentCampType: "agriculture",
        agentId: "",
        publicSiteName: "Site",
        campName: "Camp",
        serverName: "Server",
        publicMembersEnabled: true
      },
      authConfig: { temporaryKeyLoginEnabled: true },
      publicOverview: { announcement: "", highlights: [] },
      technologyConfig: { catalog: [] },
      automationConfig: {
        timezone: "UTC+08:00",
        schedulerGraceMinutes: 5,
        tasks: {
          tech_switch: { enabled: true, time: "02:00" },
          contribution_sync: { enabled: true, time: "02:30" },
          inactivity_sync: { enabled: true, time: "02:45" },
          member_profile_sync: { enabled: true, time: "02:15" },
          weekly_activity_sync: { enabled: true, time: "22:00" },
          patrol: {
            enabled: true,
            time: "19:20",
            teamReadyTime: "19:20",
            deadline: "21:25",
            shareIntervalMinutes: 10,
            chatPollSeconds: 5
          }
        }
      }
    });

    expect(bundle.campConfig.timezone).toBe("UTC+10:00");
    expect(bundle.automationConfig.timezone).toBe("UTC+10:00");
    expect(bundle.campConfig.voteWindowStart).toBe("06:00");
  });
});
