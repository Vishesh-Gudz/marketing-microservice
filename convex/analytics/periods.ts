import {
  addDays,
  compareDateKeys,
  diffDays,
  isDateKey,
  monthKey,
  startOfIsoWeek,
  type DateKey,
} from "../lib/dates";

/**
 * Reporting periods. PURE and clock-free: analytics queries take explicit
 * inclusive DateKey ranges; presets are resolved here from a caller-supplied
 * "today" (the org timezone's today, see `todayIn`), so the dashboard and the
 * SDK use the same contract. Ranges apply to each ad account's own local days.
 */

export type DateRange = { from: DateKey; to: DateKey };

export const PERIOD_PRESETS = [
  "today",
  "yesterday",
  "last_7_days",
  "last_30_days",
  "month_to_date",
  "previous_month",
  "week_to_date",
  "previous_week",
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

function monthStart(key: DateKey): DateKey {
  return `${monthKey(key)}-01`;
}

/**
 * Our explicit API contract (inclusive ranges):
 *   today          today .. today
 *   yesterday      today-1 .. today-1
 *   last_7_days    today-7 .. today-1   (complete days only; today excluded)
 *   last_30_days   today-30 .. today-1  (complete days only; today excluded)
 *   month_to_date  1st of this month .. today
 *   previous_month the full previous calendar month
 *   week_to_date   this ISO week's Monday .. today
 *   previous_week  previous ISO week, Monday .. Sunday
 */
export function resolvePreset(preset: PeriodPreset, today: DateKey): DateRange {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case "last_7_days":
      return { from: addDays(today, -7), to: addDays(today, -1) };
    case "last_30_days":
      return { from: addDays(today, -30), to: addDays(today, -1) };
    case "month_to_date":
      return { from: monthStart(today), to: today };
    case "previous_month": {
      const lastOfPrevious = addDays(monthStart(today), -1);
      return { from: monthStart(lastOfPrevious), to: lastOfPrevious };
    }
    case "week_to_date":
      return { from: startOfIsoWeek(today), to: today };
    case "previous_week": {
      const monday = addDays(startOfIsoWeek(today), -7);
      return { from: monday, to: addDays(monday, 6) };
    }
  }
}

export function rangeDays(range: DateRange): number {
  return diffDays(range.from, range.to) + 1;
}

/** The same number of days immediately before `range`. */
export function previousPeriod(range: DateRange): DateRange {
  const days = rangeDays(range);
  return { from: addDays(range.from, -days), to: addDays(range.from, -1) };
}

export type RangeProblem = "invalid_date" | "from_after_to" | "too_long";

/**
 * Validates an explicit range from the range alone (no clock): real calendar
 * days, from <= to, at most `maxDays` long. Days without synced data (for
 * example future days) are not rejected; they come back as "unknown".
 */
export function rangeProblem(
  range: DateRange,
  options: { maxDays: number },
): RangeProblem | undefined {
  if (!isDateKey(range.from) || !isDateKey(range.to)) return "invalid_date";
  if (compareDateKeys(range.from, range.to) > 0) return "from_after_to";
  if (rangeDays(range) > options.maxDays) return "too_long";
  return undefined;
}

export type Granularity = "day" | "week" | "month";

/** Bucket key: day = the date, week = ISO week's Monday, month = "YYYY-MM". */
export function bucketKey(date: DateKey, granularity: Granularity): string {
  switch (granularity) {
    case "day":
      return date;
    case "week":
      return startOfIsoWeek(date);
    case "month":
      return monthKey(date);
  }
}

export type Bucket = { key: string; from: DateKey; to: DateKey; partial: boolean };

/** Buckets covering `range` in order; edge buckets are clipped to the range and marked partial. */
export function bucketsOf(range: DateRange, granularity: Granularity): Bucket[] {
  const buckets: Bucket[] = [];
  let start = range.from;
  while (compareDateKeys(start, range.to) <= 0) {
    let fullFrom: DateKey;
    let fullTo: DateKey;
    if (granularity === "day") {
      fullFrom = start;
      fullTo = start;
    } else if (granularity === "week") {
      fullFrom = startOfIsoWeek(start);
      fullTo = addDays(fullFrom, 6);
    } else {
      fullFrom = monthStart(start);
      fullTo = addDays(monthStart(addDays(fullFrom, 31)), -1);
    }
    const to = compareDateKeys(fullTo, range.to) < 0 ? fullTo : range.to;
    const from = compareDateKeys(fullFrom, range.from) > 0 ? fullFrom : range.from;
    buckets.push({
      key: bucketKey(start, granularity),
      from,
      to,
      partial: from !== fullFrom || to !== fullTo,
    });
    start = addDays(to, 1);
  }
  return buckets;
}

/** Number of days of `range` inside the inclusive coverage [from, through] (0 if none). */
export function overlapDays(
  range: DateRange,
  coverage: { from?: DateKey; through?: DateKey },
): number {
  if (coverage.from === undefined || coverage.through === undefined) return 0;
  const from = compareDateKeys(range.from, coverage.from) > 0 ? range.from : coverage.from;
  const to = compareDateKeys(range.to, coverage.through) < 0 ? range.to : coverage.through;
  const days = diffDays(from, to) + 1;
  return days > 0 ? days : 0;
}
