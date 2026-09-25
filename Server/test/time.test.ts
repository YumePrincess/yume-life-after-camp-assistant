import { describe, expect, it } from "vitest";
import {
  isWithinDailyClockWindow,
  formatUtcOffsetTimestamp,
  isWithinScheduledTaskPollingWindow,
  nextTechnologyTargetDate,
  nextScheduledTaskPollingWindowStart,
  normalizeUtcTimezone,
  rebaseTimestampToTimezone,
  scheduledTaskClocks,
  technologyEffectiveDateAtDailyReset,
  withTimestampDisplayFields,
  targetDateForTechnologyRun,
  zonedDateTimeToIso,
  zonedParts
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
    expect(
      isWithinDailyClockWindow(
        new Date("2026-07-26T19:00:00.000Z"),
        "Asia/Shanghai",
        "03:00",
        "02:30"
      )
    ).toBe(true);
  });

  it("uses the configured daily reset as the archive boundary", () => {
    expect(
      technologyEffectiveDateAtDailyReset(
        new Date("2026-07-30T19:01:00.000Z"),
        "Asia/Shanghai",
        "03:00"
      )
    ).toBe("2026-07-31");
    expect(
      technologyEffectiveDateAtDailyReset(
        new Date("2026-07-30T18:59:00.000Z"),
        "Asia/Shanghai",
        "03:00"
      )
    ).toBe("2026-07-30");
  });
});

describe("UTC offset display fields", () => {
  it("adds display siblings and preserves ISO values used by business logic", () => {
    const source = {
      startAt: "2026-09-25T22:14:00.000Z",
      nested: [{ created_at: "2026-09-25T22:15:00.000Z" }]
    };
    expect(withTimestampDisplayFields(source, "UTC+08:00")).toEqual({
      startAt: "2026-09-25T22:14:00.000Z",
      startAtDisplay: "2026/09/26 06:14 (UTC+08:00)",
      nested: [{
        created_at: "2026-09-25T22:15:00.000Z",
        created_at_display: "2026/09/26 06:15 (UTC+08:00)"
      }]
    });
  });

  it("keeps a configured wall-clock unchanged after an offset change", () => {
    const before = "2026-09-25T22:00:00.000Z";
    const after = rebaseTimestampToTimezone(before, "UTC+08:00", "UTC+10:00");
    expect(after).toBe("2026-09-25T20:00:00.000Z");
    expect(formatUtcOffsetTimestamp(before, "UTC+08:00")).toBe("2026/09/26 06:00 (UTC+08:00)");
    expect(formatUtcOffsetTimestamp(after, "UTC+10:00")).toBe("2026/09/26 06:00 (UTC+10:00)");
  });

  it("rebases future items by the source offset at their scheduled date", () => {
    const winterEvent = "2026-12-01T15:00:00.000Z";
    expect(
      rebaseTimestampToTimezone(winterEvent, "America/New_York", "UTC-04:00")
    ).toBe("2026-12-01T14:00:00.000Z");
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
    expect(
      nextTechnologyTargetDate(
        new Date("2026-07-26T19:00:00.000Z"),
        "Asia/Shanghai",
        "03:00",
        "03:00"
      )
    ).toBe("2026-07-28");
  });

  it("keeps the next-day result through midnight until the daily refresh", () => {
    expect(
      nextTechnologyTargetDate(
        new Date("2026-07-26T18:30:00.000Z"),
        "Asia/Shanghai",
        "02:00",
        "03:00"
      )
    ).toBe("2026-07-27");
    expect(
      nextTechnologyTargetDate(
        new Date("2026-07-27T19:01:00.000Z"),
        "Asia/Shanghai",
        "02:00",
        "03:00"
      )
    ).toBe("2026-07-29");
  });
});

describe("scheduled Agent polling windows", () => {
  const tasks = {
    patrol: { enabled: true, time: "19:20" },
    member_profile_sync: { enabled: true, times: ["00:05", "12:00"] },
    disabled: { enabled: false, time: "12:30" }
  };

  it("derives wake clocks from enabled task schedules", () => {
    expect(scheduledTaskClocks(tasks)).toEqual(["19:20", "00:05", "12:00"]);
    expect(
      isWithinScheduledTaskPollingWindow(
        new Date("2026-09-02T19:05:00.000Z"),
        "UTC",
        tasks,
        15
      )
    ).toBe(true);
    expect(
      isWithinScheduledTaskPollingWindow(
        new Date("2026-09-02T19:36:00.000Z"),
        "UTC",
        tasks,
        15
      )
    ).toBe(false);
  });

  it("finds the next task window start, including the next local day", () => {
    const next = nextScheduledTaskPollingWindowStart(
      new Date("2026-09-02T19:36:00.000Z"),
      "UTC",
      tasks,
      15
    );
    expect(next?.toISOString()).toBe("2026-09-02T23:50:00.000Z");
  });

  it("handles a wake window that crosses midnight", () => {
    expect(
      isWithinScheduledTaskPollingWindow(
        new Date("2026-09-02T23:55:00.000Z"),
        "UTC",
        { patrol: { enabled: true, time: "00:05" } },
        15
      )
    ).toBe(true);
  });
});

describe("timezone-aware task weekdays", () => {
  it("derives the weekday from the automation timezone instead of UTC", () => {
    const instant = new Date("2026-09-06T16:30:00.000Z");
    expect(zonedParts(instant, "Asia/Shanghai").weekday).toBe(1);
    expect(zonedParts(instant, "America/New_York").weekday).toBe(7);
  });
});

describe("fixed UTC-offset site timezone", () => {
  it("keeps the configured wall-clock time when changing the UTC offset", () => {
    const utc8 = zonedDateTimeToIso("2026-09-25", "06:00", "UTC+08:00");
    const utc10 = zonedDateTimeToIso("2026-09-25", "06:00", "UTC+10:00");

    expect(utc8).toBe("2026-09-24T22:00:00.000Z");
    expect(utc10).toBe("2026-09-24T20:00:00.000Z");
    expect(zonedParts(new Date(utc8), "UTC+08:00").hour).toBe(6);
    expect(zonedParts(new Date(utc10), "UTC+10:00").hour).toBe(6);
  });

  it("normalizes saved legacy IANA settings into UTC offsets", () => {
    expect(normalizeUtcTimezone("Asia/Shanghai")).toBe("UTC+08:00");
    expect(normalizeUtcTimezone("UTC+8")).toBe("UTC+08:00");
  });
});
