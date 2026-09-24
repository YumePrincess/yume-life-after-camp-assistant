import { describe, expect, it } from "vitest";
import {
  localCalendarMonthRange,
  localDailyDateRange,
  normalizeDailyVoteConfig,
  normalizeDailyVoteInput,
  selectRandomDrawWinners
} from "../src/daily-vote";

function drawInput(batchNumber?: unknown) {
  return {
    kind: "draw",
    localizedContent: {
      "zh-cn": {
        titleBlocks: [{ type: "text", text: "测试抽签" }],
        descriptionBlocks: [],
        options: []
      }
    },
    startAt: "2026-09-09T08:00:00.000Z",
    endAt: "2026-09-09T09:00:00.000Z",
    revealBeforeSeconds: 0,
    drawCount: 1,
    ...(batchNumber === undefined ? {} : { batchNumber })
  };
}

describe("daily vote admin local times", () => {
  it("filters a selected calendar date using the configured timezone, including DST days", () => {
    expect(localDailyDateRange("2026-09-23", "Asia/Taipei")).toEqual({
      startAt: "2026-09-22T16:00:00.000Z",
      endAt: "2026-09-23T16:00:00.000Z"
    });
    expect(localDailyDateRange("2026-11-01", "America/New_York")).toEqual({
      startAt: "2026-11-01T04:00:00.000Z",
      endAt: "2026-11-02T05:00:00.000Z"
    });
  });

  it("uses the configured timezone's calendar month boundaries", () => {
    expect(localCalendarMonthRange(new Date("2026-05-31T16:00:00.000Z"), "Asia/Taipei")).toEqual({
      key: "2026-06",
      startAt: "2026-05-31T16:00:00.000Z",
      endAt: "2026-06-30T16:00:00.000Z"
    });
    expect(localCalendarMonthRange(new Date("2026-03-15T12:00:00.000Z"), "America/New_York")).toEqual({
      key: "2026-03",
      startAt: "2026-03-01T05:00:00.000Z",
      endAt: "2026-04-01T04:00:00.000Z"
    });
  });

  it("interprets datetime-local values in the configured camp timezone", () => {
    const input = normalizeDailyVoteInput(
      {
        kind: "poll",
        localizedContent: {
          "zh-cn": {
            titleBlocks: [{ type: "text", text: "测试事项" }],
            descriptionBlocks: [],
            options: [
              { id: "a", blocks: [{ type: "text", text: "A" }] },
              { id: "b", blocks: [{ type: "text", text: "B" }] }
            ]
          }
        },
        startAtLocal: "2026-09-09T16:45",
        endAtLocal: "2026-09-09T17:00",
        revealBeforeSeconds: 0,
        maxSelections: 1
      },
      undefined,
      "Asia/Shanghai"
    );

    expect(input.startAt).toBe("2026-09-09T08:45:00.000Z");
    expect(input.endAt).toBe("2026-09-09T09:00:00.000Z");
  });
});

describe("daily draw winner selection", () => {
  it("selects the requested number of unique participants without using record order", () => {
    const participants = ["first", "second", "third", "last"];
    const winners = selectRandomDrawWinners(participants, 2, () => 0);

    expect(winners).toHaveLength(2);
    expect(new Set(winners).size).toBe(2);
    expect(winners).toEqual(["first", "second"]);
  });

  it("returns all available participants when fewer than N people entered", () => {
    expect(selectRandomDrawWinners(["first", "second"], 5, () => 0)).toEqual([
      "first",
      "second"
    ]);
  });
});

describe("daily draw batch numbers", () => {
  it("preserves leading zeroes and accepts the special zero batch", () => {
    expect(normalizeDailyVoteInput(drawInput("001")).batchNumber).toBe("001");
    expect(normalizeDailyVoteInput(drawInput("0")).batchNumber).toBe("0");
    expect(normalizeDailyVoteInput(drawInput(12)).batchNumber).toBe("12");
  });

  it("requires one to eight digits for every new draw", () => {
    expect(() => normalizeDailyVoteInput(drawInput())).toThrow(
      "batchNumber must contain 1 to 8 digits"
    );
    expect(() => normalizeDailyVoteInput(drawInput("123456789"))).toThrow(
      "batchNumber must contain 1 to 8 digits"
    );
    expect(() => normalizeDailyVoteInput(drawInput("12A"))).toThrow(
      "batchNumber must contain 1 to 8 digits"
    );
  });
});

describe("daily draw limits", () => {
  it("defaults new draws to the global limit and allows opting out", () => {
    expect(normalizeDailyVoteInput(drawInput("001")).drawLimitEnabled).toBe(true);
    expect(normalizeDailyVoteInput({ ...drawInput("001"), drawLimitEnabled: false }).drawLimitEnabled).toBe(false);
  });

  it("defaults the monthly cap to four, accepts the legacy setting key, and validates values", () => {
    expect(normalizeDailyVoteConfig({})).toEqual({
      drawMaxWinsPerMonth: 4,
      voteEligibilityEnabled: true,
      voteEligibility: {
        weeklyContribution: 1500,
        technologyPoints: 0,
        materialContribution: 50000,
        weeklyActivityPoints: 25
      }
    });
    expect(normalizeDailyVoteConfig({ drawMaxWinsPerMonth: 8 })).toEqual({
      drawMaxWinsPerMonth: 8,
      voteEligibilityEnabled: true,
      voteEligibility: {
        weeklyContribution: 1500,
        technologyPoints: 0,
        materialContribution: 50000,
        weeklyActivityPoints: 25
      }
    });
    expect(normalizeDailyVoteConfig({ drawMaxWins28Days: 7 }).drawMaxWinsPerMonth).toBe(7);
    expect(() => normalizeDailyVoteConfig({ drawMaxWinsPerMonth: 10_001 })).toThrow(
      "drawMaxWinsPerMonth must be an integer between 0 and 10000"
    );
  });
});
