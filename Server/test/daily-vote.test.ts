import { describe, expect, it } from "vitest";
import { normalizeDailyVoteInput } from "../src/daily-vote";

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
