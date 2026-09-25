const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const WINDOW_END_CLOCK_PATTERN = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
const UTC_OFFSET_PATTERN = /^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

function parseUtcOffset(timezone: string): number | null {
  const value = String(timezone || "").trim();
  if (/^(?:UTC|GMT|Z|Etc\/(?:UTC|GMT))$/i.test(value)) return 0;
  const match = UTC_OFFSET_PATTERN.exec(value);
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] || 0);
  if (minutes > 59) throw new Error(`Invalid UTC offset: ${timezone}`);
  const total = (hours * 60 + minutes) * (match[1] === "-" ? -1 : 1);
  if (Math.abs(total) > 14 * 60) throw new Error(`Invalid UTC offset: ${timezone}`);
  return total;
}

function offsetFromLegacyTimezone(timezone: string, date: Date): number {
  try {
    const label = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset"
    }).formatToParts(date).find((part) => part.type === "timeZoneName")?.value;
    const match = /^(?:GMT|UTC)(?:([+-])(\d{1,2})(?::?(\d{2}))?)?$/i.exec(label || "");
    if (match) {
      if (!match[1]) return 0;
      const total = (Number(match[2]) * 60 + Number(match[3] || 0)) *
        (match[1] === "-" ? -1 : 1);
      if (Math.abs(total) <= 14 * 60) return total;
    }

    // Older Intl implementations may omit longOffset. Derive a one-time
    // compatibility offset for legacy IANA values; persisted settings are
    // normalized to a fixed UTC offset before scheduling.
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }).formatToParts(date)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value])
    );
    const localAsUtc = Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)
    );
    return Math.round((localAsUtc - date.getTime()) / 60_000);
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

export function utcOffsetMinutes(timezone: string, date = new Date()): number {
  return parseUtcOffset(timezone) ?? offsetFromLegacyTimezone(timezone, date);
}

export function normalizeUtcTimezone(timezone: string, date = new Date()): string {
  const total = utcOffsetMinutes(timezone, date);
  const sign = total < 0 ? "-" : "+";
  const absolute = Math.abs(total);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

/** Compact whole-hour offsets for display without changing canonical config values. */
export function formatUtcTimezoneLabel(timezone: string, date = new Date()): string {
  const total = utcOffsetMinutes(timezone, date);
  const sign = total < 0 ? "-" : "+";
  const absolute = Math.abs(total);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  if (minutes === 0) return `UTC${sign}${hours}`;
  return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function assertTimezone(timezone: string): void {
  utcOffsetMinutes(timezone);
}

export function assertClock(value: string, field = "time"): void {
  if (!CLOCK_PATTERN.test(value)) {
    throw new Error(`${field} must use HH:mm`);
  }
}

export function assertWindowEndClock(value: string, field = "time"): void {
  if (!WINDOW_END_CLOCK_PATTERN.test(value)) {
    throw new Error(`${field} must use HH:mm or 24:00`);
  }
}

export function clockToMinutes(value: string): number {
  assertClock(value);
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

export function windowEndClockToMinutes(value: string): number {
  assertWindowEndClock(value);
  return value === "24:00" ? 24 * 60 : clockToMinutes(value);
}

export function zonedParts(date: Date, timezone: string): ZonedParts {
  const shifted = new Date(date.getTime() + utcOffsetMinutes(timezone, date) * 60_000);
  const nativeWeekday = shifted.getUTCDay();

  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: nativeWeekday === 0 ? 7 : nativeWeekday
  };
}

export function dateAtUtcOffset(date: Date, timezone: string): Date {
  return new Date(date.getTime() + utcOffsetMinutes(timezone, date) * 60_000);
}

/**
 * Recursively add display-only siblings for ISO timestamps returned by the API.
 * Original values remain untouched for comparisons, scheduling and form inputs.
 */
export function withTimestampDisplayFields<T>(value: T, timezone: string): T {
  const visit = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(visit);
    if (!current || typeof current !== "object") return current;

    const source = current as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(source)) {
      result[key] = visit(child);
    }
    for (const [key, child] of Object.entries(source)) {
      if (typeof child !== "string" || !isZonedTimestamp(child)) continue;
      const displayKey = timestampDisplayKey(key);
      if (!displayKey || Object.prototype.hasOwnProperty.call(source, displayKey)) continue;
      result[displayKey] = formatUtcOffsetTimestamp(child, timezone);
    }
    return result;
  };

  return visit(value) as T;
}

function isZonedTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function timestampDisplayKey(key: string): string | null {
  if (/(?:_at|_time|_date)$/.test(key)) return `${key}_display`;
  if (/(?:At|Time|Date)$/.test(key)) return `${key}Display`;
  return null;
}

export function formatUtcOffsetTimestamp(value: string | Date, timezone: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  const parts = zonedParts(date, timezone);
  const timezoneLabel = formatUtcTimezoneLabel(timezone, date);
  const calendarDate = `${String(parts.year).padStart(4, "0")}/${String(parts.month).padStart(2, "0")}/${String(parts.day).padStart(2, "0")}`;
  return `${calendarDate} ${String(parts.hour).padStart(2, "0")}:${String(parts.minute).padStart(2, "0")} (${timezoneLabel})`;
}

/** Preserve the displayed wall-clock value when a fixed site offset changes. */
export function rebaseTimestampToTimezone(
  value: string,
  previousTimezone: string,
  nextTimezone: string
): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid timestamp");
  const offsetDelta = utcOffsetMinutes(previousTimezone, date) -
    utcOffsetMinutes(nextTimezone, date);
  return new Date(date.getTime() + offsetDelta * 60_000).toISOString();
}

export function dateKey(parts: Pick<ZonedParts, "year" | "month" | "day">): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function zonedDateKey(date: Date, timezone: string): string {
  return dateKey(zonedParts(date, timezone));
}

export function zonedDateTimeToIso(
  localDate: string,
  localClock: string,
  timezone: string
): string {
  assertClock(localClock, "localClock");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(localDate);
  if (!match) throw new Error("localDate must use YYYY-MM-DD");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const [hourText = "0", minuteText = "0"] = localClock.split(":");
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const targetEpoch = Date.UTC(year, month - 1, day, hour, minute, 0);
  const targetDate = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    targetDate.getUTCFullYear() !== year ||
    targetDate.getUTCMonth() !== month - 1 ||
    targetDate.getUTCDate() !== day
  ) {
    throw new Error("localDate is not a valid calendar date");
  }

  const offset = utcOffsetMinutes(timezone, new Date(targetEpoch));
  const candidate = new Date(targetEpoch - offset * 60_000);
  const verified = zonedParts(candidate, timezone);
  if (
    verified.year !== year ||
    verified.month !== month ||
    verified.day !== day ||
    verified.hour !== hour ||
    verified.minute !== minute
  ) {
    throw new Error("The selected local date and time does not exist in this timezone");
  }
  return candidate.toISOString();
}

export function addDaysToDateKey(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) {
    throw new Error(`Invalid date key: ${value}`);
  }
  const date = new Date(Date.UTC(year, month - 1, day + days, 12));
  return date.toISOString().slice(0, 10);
}

export function weekdayForDateKey(value: string): number {
  const date = new Date(`${value}T12:00:00Z`);
  const native = date.getUTCDay();
  return native === 0 ? 7 : native;
}

export function minuteOfDay(parts: Pick<ZonedParts, "hour" | "minute">): number {
  return parts.hour * 60 + parts.minute;
}

export function isWithinDueWindow(
  now: Date,
  timezone: string,
  scheduledClock: string,
  graceMinutes: number
): boolean {
  const current = minuteOfDay(zonedParts(now, timezone));
  const scheduled = clockToMinutes(scheduledClock);
  return current >= scheduled && current < scheduled + Math.max(1, graceMinutes);
}

export function targetDateForTechnologyRun(
  now: Date,
  timezone: string,
  resetClock: string
): string {
  const parts = zonedParts(now, timezone);
  const currentDate = dateKey(parts);
  return minuteOfDay(parts) < clockToMinutes(resetClock)
    ? currentDate
    : addDaysToDateKey(currentDate, 1);
}

export function nextTechnologyTargetDate(
  now: Date,
  timezone: string,
  taskClock: string,
  resetClock: string
): string {
  // The public/admin vote page represents the next effective technology day.
  // Keep that date stable across the vote close and the midnight boundary;
  // only the configured daily refresh advances it. The task clock is retained
  // in the signature for callers/config compatibility.
  const parts = zonedParts(now, timezone);
  const localDate = dateKey(parts);
  const refreshDate =
    minuteOfDay(parts) < clockToMinutes(resetClock)
      ? addDaysToDateKey(localDate, -1)
      : localDate;
  // Validate the legacy task clock even though the daily refresh is now the
  // only boundary that changes the displayed target date.
  clockToMinutes(taskClock);
  return addDaysToDateKey(refreshDate, 1);
}

/** Returns the most recent technology effective date at the daily reset. */
export function technologyEffectiveDateAtDailyReset(
  now: Date,
  timezone: string,
  gameResetTime: string
): string {
  const parts = zonedParts(now, timezone);
  const localDate = dateKey(parts);
  return minuteOfDay(parts) >= clockToMinutes(gameResetTime)
    ? localDate
    : addDaysToDateKey(localDate, -1);
}

export function isWithinDailyClockWindow(
  now: Date,
  timezone: string,
  start: string,
  end: string
): boolean {
  assertClock(start, "start");
  assertWindowEndClock(end, "end");
  const current = minuteOfDay(zonedParts(now, timezone));
  const startValue = clockToMinutes(start);
  const endValue = windowEndClockToMinutes(end);
  if (startValue < endValue) {
    return current >= startValue && current < endValue;
  }
  if (startValue > endValue) {
    return current >= startValue || current < endValue;
  }
  return false;
}

type ScheduledTaskLike = {
  enabled?: boolean;
  time?: string;
  times?: string[];
};

/**
 * Return the configured daily task clocks that can cause the Agent to wake.
 * The scheduler stores all task times in the configured automation timezone;
 * this helper deliberately accepts a small structural type so it can be used
 * by the Agent polling endpoint without coupling the clock math to D1 models.
 */
export function scheduledTaskClocks(
  tasks: Record<string, ScheduledTaskLike>
): string[] {
  return [...new Set(
    Object.values(tasks).flatMap((schedule) => {
      if (schedule.enabled === false) return [];
      const values = Array.isArray(schedule.times) && schedule.times.length
        ? schedule.times
        : schedule.time
          ? [schedule.time]
          : [];
      return values.filter((value): value is string => typeof value === "string");
    })
  )];
}

export function isWithinScheduledTaskPollingWindow(
  now: Date,
  timezone: string,
  tasks: Record<string, ScheduledTaskLike>,
  windowMinutes: number
): boolean {
  const current = minuteOfDay(zonedParts(now, timezone));
  const radius = Math.max(1, Math.min(240, Math.floor(windowMinutes)));
  return scheduledTaskClocks(tasks).some((clock) => {
    const scheduled = clockToMinutes(clock);
    const distance = Math.abs(current - scheduled);
    return Math.min(distance, 24 * 60 - distance) <= radius;
  });
}

/**
 * Find the next start of a task polling window. The configured UTC offset is
 * fixed, so conversion is independent of DST. The search includes the previous
 * local day because a window around 00:00 begins on the preceding date.
 */
export function nextScheduledTaskPollingWindowStart(
  now: Date,
  timezone: string,
  tasks: Record<string, ScheduledTaskLike>,
  windowMinutes: number
): Date | null {
  const clocks = scheduledTaskClocks(tasks);
  if (!clocks.length) return null;
  const radius = Math.max(1, Math.min(240, Math.floor(windowMinutes)));
  const localDate = dateKey(zonedParts(now, timezone));
  let next: Date | null = null;
  for (let dayOffset = -1; dayOffset <= 8; dayOffset += 1) {
    const scheduledDate = addDaysToDateKey(localDate, dayOffset);
    for (const clock of clocks) {
      const scheduled = clockToMinutes(clock);
      let startDate = scheduledDate;
      let startMinute = scheduled - radius;
      if (startMinute < 0) {
        startMinute += 24 * 60;
        startDate = addDaysToDateKey(startDate, -1);
      }
      const startClock = `${String(Math.floor(startMinute / 60)).padStart(2, "0")}:${String(startMinute % 60).padStart(2, "0")}`;
      const candidate = new Date(zonedDateTimeToIso(startDate, startClock, timezone));
      if (candidate.getTime() <= now.getTime()) continue;
      if (!next || candidate.getTime() < next.getTime()) next = candidate;
    }
  }
  return next;
}
