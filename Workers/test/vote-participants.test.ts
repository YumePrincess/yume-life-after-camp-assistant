import { describe, expect, it } from "vitest";
import { technologyVoteOptionsForParticipants } from "../src/vote-participants";

describe("technology vote participant options", () => {
  const liveOptions = [{ key: "tech-a" }];
  const archivedHistory = {
    pollDate: "2026-09-21",
    options: [{ key: "tech-b" }]
  };

  it("uses live options after voting closes and before the history snapshot exists", () => {
    expect(technologyVoteOptionsForParticipants(
      "2026-09-23",
      "2026-09-23",
      liveOptions,
      null
    )).toBe(liveOptions);
  });

  it("uses archived options for historical poll dates", () => {
    expect(technologyVoteOptionsForParticipants(
      "2026-09-21",
      "2026-09-23",
      liveOptions,
      archivedHistory
    )).toBe(archivedHistory.options);
  });

  it("does not resolve unrelated poll dates", () => {
    expect(technologyVoteOptionsForParticipants(
      "2026-09-20",
      "2026-09-23",
      liveOptions,
      archivedHistory
    )).toBeNull();
  });
});
