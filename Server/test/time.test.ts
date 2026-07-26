import { describe, expect, it } from "vitest";
import {
  addWeeksToWeekKey,
  nextTechnologyTargetDate,
  nextWeeklyApplyWeek,
  targetDateForTechnologyRun,
  weekKeyForDateKey
} from "../src/time";

describe("technology target date", () => {
  it("treats Monday 02:00 as Sunday's game day but Monday's effective tech", () => {
    const mondayAtTwoShanghai = new Date("2026-07-26T18:00:00.000Z");
    expect(
      targetDateForTechnologyRun(mondayAtTwoShanghai, "Asia/Shanghai", "03:00")
    ).toBe("2026-07-27");
  });

  it("points public voting at the next scheduled run target", () => {
    const sundayAfternoonShanghai = new Date("2026-07-26T05:00:00.000Z");
    expect(
      nextTechnologyTargetDate(
        sundayAfternoonShanghai,
        "Asia/Shanghai",
        "02:00",
        "03:00"
      )
    ).toBe("2026-07-27");
  });
});

describe("weekly cutoff", () => {
  it("uses current ISO week before Sunday cutoff", () => {
    const sundayAtTenShanghai = new Date("2026-07-26T14:00:00.000Z");
    expect(
      nextWeeklyApplyWeek(sundayAtTenShanghai, "Asia/Shanghai", "22:30")
    ).toBe(weekKeyForDateKey("2026-07-26"));
  });

  it("moves changes after cutoff to next week", () => {
    const sundayAtElevenShanghai = new Date("2026-07-26T15:00:00.000Z");
    const current = weekKeyForDateKey("2026-07-26");
    expect(
      nextWeeklyApplyWeek(sundayAtElevenShanghai, "Asia/Shanghai", "22:30")
    ).toBe(addWeeksToWeekKey(current, 1));
  });
});
