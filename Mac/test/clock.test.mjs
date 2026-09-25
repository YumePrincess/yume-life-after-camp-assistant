import test from "node:test";
import assert from "node:assert/strict";
import { normalizeTimezone, utcOffsetMinutes, zonedClock } from "../src/clock.mjs";

test("Agent clock reads fixed UTC offsets without relying on host timezone", () => {
  const instant = new Date("2026-09-25T22:14:00.000Z");
  assert.deepEqual(zonedClock("UTC+08:00", instant), {
    date: "2026-09-26",
    minute: 6 * 60 + 14,
    second: 0
  });
  assert.equal(utcOffsetMinutes("UTC+10:00", instant), 600);
  assert.equal(normalizeTimezone("UTC+10"), "UTC+10:00");
});

test("Agent config migration freezes legacy IANA settings as UTC offsets", () => {
  assert.equal(normalizeTimezone("Asia/Shanghai"), "UTC+08:00");
});
