import { describe, expect, it } from "vitest";
import { reconcileActivityMembers } from "../src/db";

const activity = (
  name: string,
  inactiveDays = 2,
  lastActiveText = `${inactiveDays}天前`
) => ({
  name,
  lastActiveText,
  inactiveDays
});

describe("reconcileActivityMembers", () => {
  it("keeps warnings independent from the authoritative member roster", () => {
    const result = reconcileActivityMembers(
      [
        activity("星河踏月归"),
        activity("扫描多出的陌生成员")
      ]
    );

    expect(result.updates).toEqual([
      activity("星河踏月归"),
      activity("扫描多出的陌生成员")
    ]);
    expect(result.ignored).toBe(0);
  });

  it("retains names that differ only by verified decorative symbols", () => {
    const result = reconcileActivityMembers([
      activity("#星河踏月归✨"),
      activity("星河踏月归")
    ]);

    expect(result.updates[0]?.name).toBe("#星河踏月归✨");
    expect(result.updates[1]?.name).toBe("星河踏月归");
    expect(result.ignored).toBe(0);
  });

  it("does not fuzzy-merge different OCR names", () => {
    const result = reconcileActivityMembers([
      activity("星河踏月皈"),
      activity("星河踏月归")
    ]);

    expect(result.updates.map((item) => item.name)).toEqual([
      "星河踏月皈",
      "星河踏月归"
    ]);
  });

  it("keeps separate symbol variants even when inactivity values disagree", () => {
    const result = reconcileActivityMembers([
      activity("愿", 2),
      activity("愿✨", 8)
    ]);

    expect(result.updates).toEqual([activity("愿", 2), activity("愿✨", 8)]);
    expect(result.ignored).toBe(0);
  });

  it("never fuzzy-matches short or symbol-only names", () => {
    const result = reconcileActivityMembers([
      activity("愿!"),
      activity("☆")
    ]);

    expect(result.updates.map((member) => member.name)).toEqual(["愿!", "☆"]);
    expect(result.ignored).toBe(0);
  });

  it("does not collapse two warning rows with different visual symbols", () => {
    const result = reconcileActivityMembers([
      activity("#星河踏月归"),
      activity("星河踏月归✨")
    ]);

    expect(result.updates).toHaveLength(2);
    expect(result.ignored).toBe(0);
  });

  it("matches activity only to the authoritative roster and never adds OCR-only players", () => {
    const result = reconcileActivityMembers(
      [activity("愿"), activity("扫描出的陌生人")],
      [{ id: "member-a", name: "愿✨" }]
    );

    expect(result.updates).toEqual([
      { ...activity("愿"), memberId: "member-a", name: "愿✨" }
    ]);
    expect(result.ignored).toBe(1);
  });
});
