(() => {
  "use strict";

  const UTC_OFFSET = /^(?:UTC|GMT)\s*([+-])\s*(\d{1,2})(?::?(\d{2}))?$/i;

  function offsetMinutes(value, referenceDate = new Date()) {
    const source = String(value || "").trim();
    if (/^(?:UTC|GMT|Z|Etc\/(?:UTC|GMT))$/i.test(source)) return 0;
    const match = UTC_OFFSET.exec(source);
    if (match) {
      const hours = Number(match[2]);
      const minutes = Number(match[3] || 0);
      const total = (hours * 60 + minutes) * (match[1] === "-" ? -1 : 1);
      if (minutes <= 59 && Math.abs(total) <= 14 * 60) return total;
      throw new RangeError(`Invalid UTC offset: ${source}`);
    }

    // Transitional support for cached responses from pre-offset Workers.
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: source,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23"
      }).formatToParts(referenceDate)
        .filter((part) => part.type !== "literal")
        .map((part) => [part.type, part.value])
    );
    return Math.round((Date.UTC(
      Number(parts.year), Number(parts.month) - 1, Number(parts.day),
      Number(parts.hour), Number(parts.minute), Number(parts.second)
    ) - referenceDate.getTime()) / 60_000);
  }

  function parts(value, timezone = "UTC+08:00") {
    const date = value instanceof Date ? value : new Date(value);
    const shifted = new Date(date.getTime() + offsetMinutes(timezone, date) * 60_000);
    return {
      year: String(shifted.getUTCFullYear()),
      month: String(shifted.getUTCMonth() + 1).padStart(2, "0"),
      day: String(shifted.getUTCDate()).padStart(2, "0"),
      hour: String(shifted.getUTCHours()).padStart(2, "0"),
      minute: String(shifted.getUTCMinutes()).padStart(2, "0"),
      second: String(shifted.getUTCSeconds()).padStart(2, "0")
    };
  }

  function format(value, locale, options = {}, timezone = "UTC+08:00") {
    const local = parts(value, timezone);
    const utcDate = new Date(Date.UTC(
      Number(local.year), Number(local.month) - 1, Number(local.day),
      Number(local.hour), Number(local.minute), Number(local.second)
    ));
    return new Intl.DateTimeFormat(locale, {
      ...options,
      timeZone: "UTC"
    }).format(utcDate);
  }

  function label(timezone = "UTC+08:00", referenceDate = new Date()) {
    const total = offsetMinutes(timezone, referenceDate);
    const sign = total < 0 ? "-" : "+";
    const absolute = Math.abs(total);
    const hours = Math.floor(absolute / 60);
    const minutes = absolute % 60;
    if (minutes === 0) return `UTC${sign}${hours}`;
    return `UTC${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  function timestamp(value, timezone = "UTC+08:00", displayValue = "") {
    // API display fields already contain wall time in their declared timezone.
    // Normalize those without parsing them in the browser's local timezone.
    function wallTime(source) {
      if (typeof source !== "string") return "";
      const match = source.trim().match(
        /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:\s*[（(]\s*((?:UTC|GMT)(?:\s*[+-]\s*\d{1,2}(?::?\d{2})?)?)\s*[）)]|\s+((?:UTC|GMT)(?:\s*[+-]\s*\d{1,2}(?::?\d{2})?)?))?$/i
      );
      if (!match) return "";
      const zone = (match[6] || match[7] || timezone).replace(/\s+/g, "");
      const pad = (part) => part.padStart(2, "0");
      return `${match[1]}-${pad(match[2])}-${pad(match[3])} ${pad(match[4])}:${match[5]} (${label(zone)})`;
    }
    try {
      const preferred = wallTime(displayValue);
      if (preferred) return preferred;
      if (value === null || value === undefined || value === "") return "—";
      const existing = wallTime(value);
      if (existing) return existing;
      const date = value instanceof Date ? value : new Date(value);
      if (!Number.isFinite(date.getTime())) return "—";
      const local = parts(date, timezone);
      return `${local.year}-${local.month}-${local.day} ${local.hour}:${local.minute} (${label(timezone, date)})`;
    } catch {
      return "—";
    }
  }

  window.MrzhTimezone = Object.freeze({ offsetMinutes, parts, format, label, timestamp });
})();
