import { addDays, toDateKey, todayIn, type DateKey } from "../../lib/dates";
import { resolvePreset, type DateRange, type PeriodPreset } from "../periods";

/**
 * Organic date semantics (Phase 10 Stage B, R12). Two different calendars, never mixed:
 * - Account metrics (socialAccountMetricsDaily) are keyed by UTC day (I-D11). Ranges apply
 *   to those UTC days as-is, and presets are resolved against TODAY IN UTC.
 * - Posts are filtered by their publish instant; publishedFrom / publishedTo are calendar
 *   days in the ORGANIZATION timezone (converted to instants here).
 * Ranges are inclusive on both ends, as everywhere in analytics.
 */

/** A period preset for account metrics, resolved against today's UTC day (R12). */
export function resolveOrganicPreset(preset: PeriodPreset, nowMs: number): DateRange {
  return resolvePreset(preset, todayIn("UTC", nowMs));
}

const HOUR_MS = 3_600_000;

/**
 * The first instant (epoch ms) whose calendar day in `timeZone` is `day` (local midnight, or
 * the first existing instant after a DST gap at midnight). Binary search over a window that
 * covers every real UTC offset (-12h .. +14h): exact to the millisecond, no offset tables.
 */
export function zonedDayStart(day: DateKey, timeZone: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const utcMidnight = Date.UTC(y, m - 1, d);
  let low = utcMidnight - 15 * HOUR_MS; // local day not yet started
  let high = utcMidnight + 15 * HOUR_MS; // local day already started
  while (high - low > 1) {
    const mid = low + Math.floor((high - low) / 2);
    if (toDateKey(mid, timeZone) >= day) high = mid;
    else low = mid;
  }
  return high;
}

/** [start, end) instants of inclusive org-timezone days (for publishedAt filters). */
export function zonedRangeInstants(
  range: { from?: DateKey; to?: DateKey },
  timeZone: string,
): { start?: number; end?: number } {
  return {
    ...(range.from !== undefined ? { start: zonedDayStart(range.from, timeZone) } : {}),
    ...(range.to !== undefined ? { end: zonedDayStart(addDays(range.to, 1), timeZone) } : {}),
  };
}
