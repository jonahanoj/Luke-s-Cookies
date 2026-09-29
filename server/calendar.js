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

// Wipes happen every 14 days at local midnight, counted from this Monday.
const WIPE_PERIOD_DAYS = 14;
const WIPE_ANCHOR = { year: 2026, month: 1, day: 5 };
const DAY_MS = 24 * 60 * 60 * 1000;

function dayNumber(year, month, day) {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

function periodBoundary(now, offsetPeriods) {
  const parts = partsInZone(now, WIPE_TIMEZONE);
  const anchor = dayNumber(WIPE_ANCHOR.year, WIPE_ANCHOR.month, WIPE_ANCHOR.day);
  const today = dayNumber(parts.year, parts.month, parts.day);
  const index = Math.floor((today - anchor) / WIPE_PERIOD_DAYS) + offsetPeriods;
  const date = new Date((anchor + index * WIPE_PERIOD_DAYS) * DAY_MS);
  return zonedLocalToUtc(
    date.getUTCFullYear(),
    date.getUTCMonth() + 1,
    date.getUTCDate(),
    0,
    0,
    0,
    WIPE_TIMEZONE
  );
}

// Messages created before this moment (and not pinned) get wiped.
export function startOfCurrentPeriod(now = new Date()) {
  return periodBoundary(now, 0);
}

export function nextWipeAt(now = new Date()) {
  return periodBoundary(now, 1);
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
