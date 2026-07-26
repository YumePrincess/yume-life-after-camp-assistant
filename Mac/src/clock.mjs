export function zonedClock(timezone, date = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
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
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute),
    second: Number(parts.second)
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
