export const WIPE_TIMEZONE = process.env.WIPE_TIMEZONE || "America/New_York";

function partsInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const map = Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

function zonedLocalToUtc(year, month, day, hour, minute, second, timeZone) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  const there = partsInZone(new Date(guess), timeZone);
  const thereAsUtc = Date.UTC(
    there.year,
    there.month - 1,
    there.day,
    there.hour,
    there.minute,
    there.second
  );
  return new Date(guess - (thereAsUtc - guess));
}

export function startOfCurrentMonth(now = new Date()) {
  const parts = partsInZone(now, WIPE_TIMEZONE);
  return zonedLocalToUtc(parts.year, parts.month, 1, 0, 0, 0, WIPE_TIMEZONE);
}

export function nextWipeAt(now = new Date()) {
  const parts = partsInZone(now, WIPE_TIMEZONE);
  let year = parts.year;
  let month = parts.month + 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  return zonedLocalToUtc(year, month, 1, 0, 0, 0, WIPE_TIMEZONE);
}

export function wipeLabel(now = new Date()) {
  return nextWipeAt(now).toLocaleDateString("en-US", {
    timeZone: WIPE_TIMEZONE,
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

export function getWipeInfo(now = new Date()) {
  const at = nextWipeAt(now);
  return {
    nextWipeAt: at.toISOString(),
    label: wipeLabel(now),
    timezone: WIPE_TIMEZONE,
  };
}
