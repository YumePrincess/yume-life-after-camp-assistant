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
  it("updates only members from the authoritative profile roster", () => {
    const result = reconcileActivityMembers(
      [
        activity("星河踏月归"),
        activity("扫描多出的陌生成员")
      ],
      [
        { name: "星河踏月归" },
        { name: "愿" }
      ]
    );

    expect(result.updates).toEqual([
      activity("星河踏月归")
    ]);
    expect(result.ignored).toBe(1);
    expect(result.updates.length).toBeLessThanOrEqual(2);
  });

  it("maps omitted or misread symbols to one unique existing member", () => {
    const result = reconcileActivityMembers(
      [activity("星河踏月归")],
      [
        { name: "#星河踏月归✨" },
        { name: "另一位成员" }
      ]
    );

    expect(result.updates[0]?.name).toBe("#星河踏月归✨");
    expect(result.ignored).toBe(0);
  });

  it("accepts one OCR character error only when the roster match is unique", () => {
    const result = reconcileActivityMembers(
      [activity("星河踏月皈")],
      [
        { name: "星河踏月归" },
        { name: "完全不同成员" }
      ]
    );

    expect(result.updates[0]?.name).toBe("星河踏月归");
  });

  it("rejects ambiguous similar names instead of assigning the warning", () => {
    const result = reconcileActivityMembers(
      [activity("星河踏月皈")],
      [
        { name: "星河踏月归" },
        { name: "星河踏月回" }
      ]
    );

    expect(result.updates).toEqual([]);
    expect(result.ignored).toBe(1);
    expect(result.ambiguous).toBe(1);
  });

  it("never fuzzy-matches short or symbol-only names", () => {
    const result = reconcileActivityMembers(
      [
        activity("愿!"),
        activity("☆")
      ],
      [
        { name: "愿" },
        { name: "★" }
      ]
    );

    expect(result.updates.map((member) => member.name)).toEqual(["愿"]);
    expect(result.ignored).toBe(1);
  });

  it("does not assign two scanned rows to the same roster member", () => {
    const result = reconcileActivityMembers(
      [
        activity("#星河踏月归"),
        activity("星河踏月归✨")
      ],
      [{ name: "星河踏月归" }]
    );

    expect(result.updates).toHaveLength(1);
    expect(result.ignored).toBe(1);
  });
});
