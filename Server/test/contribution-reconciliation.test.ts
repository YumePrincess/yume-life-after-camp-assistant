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

  it("does not fuzzy-match short names or update one member twice", () => {
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

    expect(result.updates.map((member) => member.name)).toEqual(["成员一"]);
    expect(result.ignored).toBe(2);
  });

  it("accepts exact normalized names even when contribution OCR differs", () => {
    const result = reconcileContributionMembers(
      [contribution("Ａｌｉｃｅ ", 1234)],
      [{ name: "Alice", weeklyContribution: 1204 }]
    );

    expect(result.updates[0]?.name).toBe("Alice");
    expect(result.ignored).toBe(0);
  });
});
