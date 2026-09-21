import { describe, expect, it } from "vitest";
import {
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

  it("defaults the 28-day cap to four and validates configured values", () => {
    expect(normalizeDailyVoteConfig({})).toEqual({ drawMaxWins28Days: 4 });
    expect(normalizeDailyVoteConfig({ drawMaxWins28Days: 8 })).toEqual({ drawMaxWins28Days: 8 });
    expect(() => normalizeDailyVoteConfig({ drawMaxWins28Days: 10_001 })).toThrow(
      "drawMaxWins28Days must be an integer between 0 and 10000"
    );
  });
});
