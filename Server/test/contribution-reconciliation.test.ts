import { describe, expect, it } from "vitest";
import { reconcileContributionMembers } from "../src/db";

const contribution = (
  name: string,
  weeklyContribution: number,
  materialContribution = 100
) => ({
  name,
  weeklyContribution,
  technologyPointsUsed: 20,
  materialContribution
});

describe("reconcileContributionMembers", () => {
  it("updates only members in the authoritative profile list", () => {
    const result = reconcileContributionMembers(
      [
        contribution("星河踏月归", 1200),
        contribution("OCR多识别成员", 9999)
      ],
      [
        { name: "星河踏月归", weeklyContribution: 1200 },
        { name: "愿", weeklyContribution: 800 }
      ]
    );

    expect(result.updates.map((member) => member.name)).toEqual(["星河踏月归"]);
    expect(result.ignored).toBe(1);
    expect(result.updates.length).toBeLessThanOrEqual(2);
  });

  it("uses a unique one-character name difference corroborated by weekly contribution", () => {
    const result = reconcileContributionMembers(
      [contribution("星河踏月皈", 17892175)],
      [{ name: "星河踏月归", weeklyContribution: 17892175 }]
    );

    expect(result.updates).toEqual([
      contribution("星河踏月归", 17892175)
    ]);
    expect(result.ignored).toBe(0);
  });

  it("does not fuzzy-merge similar names when weekly contribution disagrees", () => {
    const result = reconcileContributionMembers(
      [contribution("星河踏月皈", 111)],
      [
        { name: "星河踏月归", weeklyContribution: 222 },
        { name: "星河踏月归✨", weeklyContribution: 333 }
      ]
    );

    expect(result.updates).toEqual([]);
    expect(result.ignored).toBe(1);
  });

  it("ignores decorative symbols for exact comparison and never updates twice", () => {
    const result = reconcileContributionMembers(
      [
        contribution("愿!", 100),
        contribution("成员一", 200),
        contribution("成员一", 201)
      ],
      [
        { name: "愿", weeklyContribution: 100 },
        { name: "成员一", weeklyContribution: 200 }
      ]
    );

    expect(result.updates.map((member) => member.name)).toEqual(["愿", "成员一"]);
    expect(result.ignored).toBe(1);
  });

  it("accepts exact normalized names even when contribution OCR differs", () => {
    const result = reconcileContributionMembers(
      [contribution("Ａｌｉｃｅ ", 1234)],
      [{ name: "Alice", weeklyContribution: 1204 }]
    );

    expect(result.updates[0]?.name).toBe("Alice");
    expect(result.ignored).toBe(0);
  });

  it("accepts a unique two-character OCR difference when contribution corroborates", () => {
    const result = reconcileContributionMembers(
      [contribution("星河踏用皈", 17892175)],
      [{ name: "星河踏月归", weeklyContribution: 17892175 }]
    );

    expect(result.updates[0]?.name).toBe("星河踏月归");
    expect(result.ignored).toBe(0);
  });

  it("allows two OCR errors in a long contribution number", () => {
    const result = reconcileContributionMembers(
      [contribution("星河踏月皈", 17892175)],
      [{ name: "星河踏月归", weeklyContribution: 17882115 }]
    );

    expect(result.updates[0]?.name).toBe("星河踏月归");
  });

  it("accepts a unique name correction even when the contribution total changed", () => {
    const result = reconcileContributionMembers(
      [contribution("星河踏月皈", 17)],
      [{ name: "星河踏月归", weeklyContribution: 987654 }]
    );

    expect(result.updates[0]?.name).toBe("星河踏月归");
    expect(result.ignored).toBe(0);
  });

  it("keeps an ambiguous best name unmatched", () => {
    const result = reconcileContributionMembers(
      [contribution("星河踏月皈", 1000)],
      [
        { name: "星河踏月归", weeklyContribution: 1000 },
        { name: "星河踏月回", weeklyContribution: 1000 }
      ]
    );

    expect(result.updates).toEqual([]);
    expect(result.ambiguous).toBe(1);
  });

  it("uses weekly contribution when two roster names share the same text", () => {
    const result = reconcileContributionMembers(
      [contribution("慕离", 200)],
      [
        { id: "solid-flower", name: "✿慕离✿", weeklyContribution: 100 },
        { id: "hollow-flower", name: "❀慕离❀", weeklyContribution: 200 }
      ]
    );

    expect(result.updates).toEqual([
      { ...contribution("慕离", 200), name: "❀慕离❀", memberId: "hollow-flower" }
    ]);
    expect(result.ignored).toBe(0);
  });

  it("does not accept an OCR-only contribution player", () => {
    const result = reconcileContributionMembers(
      [contribution("不存在的玩家", 200)],
      [{ id: "member-a", name: "慕离✨", weeklyContribution: 200 }]
    );

    expect(result.updates).toEqual([]);
    expect(result.ignored).toBe(1);
  });
});
