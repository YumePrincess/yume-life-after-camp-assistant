import { describe, expect, it } from "vitest";
import { upcomingLiveVoteTransitions } from "../src/live-vote-transitions";

describe("WebSocket time-boundary scheduling", () => {
  it("uses the administrator timezone for reset and voting-window transitions", () => {
    const transitions = upcomingLiveVoteTransitions({
      now: new Date("2026-07-30T19:19:00.000Z"),
      timezone: "Asia/Taipei",
      campConfig: {
        gameResetTime: "03:00",
        voteWindowStart: "00:30",
        voteWindowEnd: "03:00"
      },
      dailyItems: []
    });

    expect(transitions).toContain(Date.parse("2026-07-31T16:30:00.000Z"));
    expect(transitions).toContain(Date.parse("2026-07-31T19:00:00.000Z"));
    expect(transitions).not.toContain(Date.parse("2026-07-30T19:30:00.000Z"));
  });

  it("schedules daily reveal/open/close and identity expiry instants", () => {
    const transitions = upcomingLiveVoteTransitions({
      now: new Date("2026-09-22T00:00:00.000Z"),
      timezone: "Asia/Taipei",
      campConfig: {
        gameResetTime: "03:00",
        voteWindowStart: "06:30",
        voteWindowEnd: "24:00"
      },
      dailyItems: [{
        startAt: "2026-09-23T12:00:00.000Z",
        endAt: "2026-09-24T12:00:00.000Z",
        revealBeforeSeconds: 3600
      }],
      identityExpiryTimes: ["2026-09-22T04:00:00.000Z"]
    });

    expect(transitions).toContain(Date.parse("2026-09-22T04:00:00.000Z"));
    expect(transitions).toContain(Date.parse("2026-09-23T11:00:00.000Z"));
    expect(transitions).toContain(Date.parse("2026-09-23T12:00:00.000Z"));
    expect(transitions).toContain(Date.parse("2026-09-24T12:00:00.000Z"));
    expect(transitions).toContain(Date.parse("2026-09-22T16:00:00.000Z"));
  });
});
