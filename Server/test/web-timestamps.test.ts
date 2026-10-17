import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

interface WebTimezone {
  timestamp(value: unknown, timezone?: string, displayValue?: string): string;
}
const browser: { MrzhTimezone?: WebTimezone } = {};

beforeAll(async () => {
  vi.stubGlobal("window", browser);
  const browserModule = "../public/js/timezone.js";
  await import(browserModule);
});
afterAll(() => vi.unstubAllGlobals());

function timezone(): WebTimezone {
  if (!browser.MrzhTimezone) throw new Error("Web timezone helpers not loaded");
  return browser.MrzhTimezone;
}

describe("web timestamps at minute precision", () => {
  it("converts ISO timestamps using the configured timezone and omits seconds", () => {
    expect(timezone().timestamp("2026-10-16T23:04:59.999Z", "UTC+08:00"))
      .toBe("2026-10-17 07:04 (UTC+8)");
  });

  it("preserves fractional offsets and handles the previous date", () => {
    expect(timezone().timestamp("2026-10-16T02:04:59Z", "UTC-05:30"))
      .toBe("2026-10-15 20:34 (UTC-05:30)");
  });

  it("normalizes legacy display fields without shifting their wall time", () => {
    expect(timezone().timestamp("2026-10-16T23:04:00Z", "UTC+10:00", "2026/10/17 07:04:52 (UTC+08:00)"))
      .toBe("2026-10-17 07:04 (UTC+8)");
    expect(timezone().timestamp(null, "UTC+08:00", "2026-1-2 3:04:05 （GMT - 05:30）"))
      .toBe("2026-01-02 03:04 (UTC-05:30)");
  });

  it("uses the configured timezone for a wall-time display without a suffix", () => {
    expect(timezone().timestamp(null, "UTC+08:45", "2026/10/17 07:04:52"))
      .toBe("2026-10-17 07:04 (UTC+08:45)");
  });

  it("falls back to ISO data when a display field is unusable", () => {
    expect(timezone().timestamp("2026-10-16T23:04:52Z", "UTC+08:00", "invalid"))
      .toBe("2026-10-17 07:04 (UTC+8)");
    expect(timezone().timestamp("invalid", "UTC+08:00")).toBe("—");
    expect(timezone().timestamp(null)).toBe("—");
  });


});
