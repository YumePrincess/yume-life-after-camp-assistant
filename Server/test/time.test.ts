import { describe, expect, it } from "vitest";
import {
  isWithinDailyClockWindow,
  nextTechnologyTargetDate,
  targetDateForTechnologyRun,
  zonedDateTimeToIso
} from "../src/time";

describe("daily voting window", () => {
  it("accepts the default 06:30–24:00 window in the configured timezone", () => {
    expect(
      isWithinDailyClockWindow(
        new Date("2026-07-26T10:30:00.000Z"),
        "Asia/Shanghai",
        "06:30",
        "24:00"
      )
    ).toBe(true);
    expect(
      isWithinDailyClockWindow(
        new Date("2026-07-25T22:29:00.000Z"),
        "Asia/Shanghai",
        "06:30",
        "24:00"
      )
    ).toBe(false);
  });

  it("converts a configured local expiry date and reset time to UTC", () => {
    expect(
      zonedDateTimeToIso("2026-07-31", "03:00", "Asia/Shanghai")
    ).toBe("2026-07-30T19:00:00.000Z");
    expect(
      zonedDateTimeToIso("2026-07-31", "03:00", "America/New_York")
    ).toBe("2026-07-31T07:00:00.000Z");
  });

  it("supports a voting window that crosses midnight", () => {
    expect(
      isWithinDailyClockWindow(
        new Date("2026-07-26T17:00:00.000Z"),
        "Asia/Shanghai",
        "20:00",
        "02:00"
      )
    ).toBe(true);
  });
});

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
