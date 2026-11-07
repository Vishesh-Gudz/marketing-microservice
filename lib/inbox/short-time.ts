import { getDisplayLocale } from "@/lib/analytics/format";

// A conversation row's time, as short as a messaging app shows it (Kinso K2). Days are counted
// in the organization's time zone; the full date and time stay available to the row (title and
// <time dateTime>).

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** "YYYY-MM-DD" of an instant in a time zone. */
function dayKey(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
}

/** Whole calendar days between two "YYYY-MM-DD" keys. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * "now", "5m", "3h" within the last day; "Yesterday"; a weekday ("Mon") within the last week; a
 * date ("Nov 3") this year; with the year ("Nov 3, 2025") before. A time in the future (clock
 * skew) reads "now".
 */
export function shortTime(iso: string, now: number, timeZone: string): string {
  const at = Date.parse(iso);
  const ago = now - at;
  const locale = getDisplayLocale();
  if (ago < MINUTE) return "now";
  const days = daysBetween(dayKey(at, timeZone), dayKey(now, timeZone));
  if (days === 0 || ago < HOUR) {
    return ago < HOUR ? `${Math.floor(ago / MINUTE)}m` : `${Math.floor(ago / HOUR)}h`;
  }
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone }).format(at);
  const sameYear = dayKey(at, timeZone).slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  }).format(at);
}
