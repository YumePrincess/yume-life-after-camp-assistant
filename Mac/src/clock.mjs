const OFFSET_PATTERN = /^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i;

export function utcOffsetMinutes(timezone, date = new Date()) {
  const source = String(timezone || "").trim();
  if (/^(?:UTC|GMT|Z|Etc\/(?:UTC|GMT))$/i.test(source)) return 0;
  const match = OFFSET_PATTERN.exec(source);
  if (match) {
    const hours = Number(match[2]);
    const minutes = Number(match[3] || 0);
    const total = (hours * 60 + minutes) * (match[1] === "-" ? -1 : 1);
    if (minutes > 59 || Math.abs(total) > 14 * 60) {
      throw new RangeError(`Invalid UTC offset: ${source}`);
    }
    return total;
  }

  // Read older local configs once; config loading normalizes them to a fixed offset.
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: source,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value])
  );
  const localAsUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour), Number(parts.minute), Number(parts.second)
  );
  return Math.round((localAsUtc - date.getTime()) / 60_000);
}

export function normalizeTimezone(timezone, date = new Date()) {
  const offset = utcOffsetMinutes(timezone, date);
  const sign = offset < 0 ? "-" : "+";
  const absolute = Math.abs(offset);
  return `UTC${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

export function zonedClock(timezone, date = new Date()) {
  const shifted = new Date(date.getTime() + utcOffsetMinutes(timezone, date) * 60_000);
  return {
    date: `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`,
    minute: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds()
  };
}

export function clockMinutes(value) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export function reached(timezone, value) {
  return zonedClock(timezone).minute >= clockMinutes(value);
}

export function inside(timezone, start, end) {
  const now = zonedClock(timezone).minute;
  const a = clockMinutes(start);
  const b = clockMinutes(end);
  return a <= b ? now >= a && now < b : now >= a || now < b;
}
