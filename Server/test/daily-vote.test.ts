import { describe, expect, it } from "vitest";
import { normalizeDailyVoteInput, selectRandomDrawWinners } from "../src/daily-vote";

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
