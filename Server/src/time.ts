const CLOCK_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

export function assertTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

export function assertClock(value: string, field = "time"): void {
  if (!CLOCK_PATTERN.test(value)) {
    throw new Error(`${field} must use HH:mm`);
  }
}

export function clockToMinutes(value: string): number {
  assertClock(value);
  const [hour = "0", minute = "0"] = value.split(":");
  return Number(hour) * 60 + Number(minute);
}

export function zonedParts(date: Date, timezone: string): ZonedParts {
  assertTimezone(timezone);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    weekday: "short"
  });
  const values: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      values[part.type] = part.value;
    }
  }

  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7
  };

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
    weekday: weekdayMap[values.weekday ?? "Mon"] ?? 1
  };
}

export function dateKey(parts: Pick<ZonedParts, "year" | "month" | "day">): string {
  return `${String(parts.year).padStart(4, "0")}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

export function zonedDateKey(date: Date, timezone: string): string {
  return dateKey(zonedParts(date, timezone));
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

export function weekKeyForDateKey(value: string): string {
  const date = new Date(`${value}T12:00:00Z`);
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1, 12));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export function addWeeksToWeekKey(value: string, weeks: number): string {
  const match = /^(\d{4})-W(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid week key: ${value}`);
  const year = Number(match[1]);
  const week = Number(match[2]);
  const januaryFourth = new Date(Date.UTC(year, 0, 4, 12));
  const januaryFourthDay = januaryFourth.getUTCDay() || 7;
  const monday = new Date(januaryFourth);
  monday.setUTCDate(januaryFourth.getUTCDate() - januaryFourthDay + 1 + (week - 1 + weeks) * 7);
  return weekKeyForDateKey(monday.toISOString().slice(0, 10));
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
  const parts = zonedParts(now, timezone);
  const localDate = dateKey(parts);
  const nextRunDate =
    minuteOfDay(parts) < clockToMinutes(taskClock)
      ? localDate
      : addDaysToDateKey(localDate, 1);
  return clockToMinutes(taskClock) < clockToMinutes(resetClock)
    ? nextRunDate
    : addDaysToDateKey(nextRunDate, 1);
}

export function clockIsInsideWindow(clock: string, start: string, end: string): boolean {
  const value = clockToMinutes(clock);
  const startValue = clockToMinutes(start);
  const endValue = clockToMinutes(end);
  if (startValue <= endValue) {
    return value >= startValue && value <= endValue;
  }
  return value >= startValue || value <= endValue;
}

export function nextWeeklyApplyWeek(
  now: Date,
  timezone: string,
  cutoffClock: string
): string {
  const parts = zonedParts(now, timezone);
  const currentWeek = weekKeyForDateKey(dateKey(parts));
  if (parts.weekday < 7) return currentWeek;
  if (parts.weekday === 7 && minuteOfDay(parts) <= clockToMinutes(cutoffClock)) {
    return currentWeek;
  }
  return addWeeksToWeekKey(currentWeek, 1);
}
