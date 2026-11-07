import { getDisplayLocale } from "@/lib/analytics/format";
import { dayKey, daysBetween } from "./short-time";

// Times inside an open conversation (Kinso K3): the day breaks in the history, each message's
// clock time, and how long a reply window has left. Days are counted in the organization's time
// zone, like the conversation list.

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The label of a day break: "Today", "Yesterday", the weekday ("Monday") within the last week,
 * the date ("Nov 3") this year, with the year ("Nov 3, 2025") before. A time in the future
 * (clock skew) reads "Today".
 */
export function dayLabel(iso: string, now: number, timeZone: string): string {
  const at = Date.parse(iso);
  const days = daysBetween(dayKey(at, timeZone), dayKey(now, timeZone));
  const locale = getDisplayLocale();
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return new Intl.DateTimeFormat(locale, { weekday: "long", timeZone }).format(at);
  const sameYear = dayKey(at, timeZone).slice(0, 4) === dayKey(now, timeZone).slice(0, 4);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
    timeZone,
  }).format(at);
}

/** The clock time of an instant ("2:30 PM" in English), in the organization's time zone. */
export function clockTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(getDisplayLocale(), {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(Date.parse(iso));
}

/**
 * How long is left before `expiresAt`, rounded down: "2d left" from two days, "21h left" from
 * an hour, "35m left" below (at least "1m left"). Undefined once it has passed.
 */
export function timeLeft(expiresAt: string, now: number): string | undefined {
  const left = Date.parse(expiresAt) - now;
  if (!(left > 0)) return undefined;
  if (left >= 2 * DAY) return `${Math.floor(left / DAY)}d left`;
  if (left >= HOUR) return `${Math.floor(left / HOUR)}h left`;
  return `${Math.max(1, Math.floor(left / MINUTE))}m left`;
}

/** Whether a message continues the one before it: same side, same day, within five minutes. */
export function continuesPrevious(
  previous: { outbound: boolean; at: string } | undefined,
  current: { outbound: boolean; at: string },
  timeZone: string,
): boolean {
  if (previous === undefined || previous.outbound !== current.outbound) return false;
  const before = Date.parse(previous.at);
  const at = Date.parse(current.at);
  return (
    at - before >= 0 &&
    at - before < 5 * MINUTE &&
    dayKey(before, timeZone) === dayKey(at, timeZone)
  );
}
