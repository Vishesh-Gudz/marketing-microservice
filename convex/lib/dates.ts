/**
 * Date conventions (docs/data-model.md):
 * - Instants: epoch ms numbers in the database, ISO-8601 UTC strings in DTOs.
 * - Calendar days: DateKey "YYYY-MM-DD" strings (lexicographic order = time order,
 *   so index range queries work). Ad metric days are in the AD ACCOUNT timezone.
 * - Ranges are inclusive [from, to].
 * Pure helpers built on Intl only (no date library).
 */
export type DateKey = string;

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Upper bound for day enumerations, to avoid runaway loops on bad input. */
export const MAX_DAY_SPAN = 3_660;

export class DateKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DateKeyError";
  }
}

export function isDateKey(value: unknown): value is DateKey {
  if (typeof value !== "string") return false;
  const match = DATE_KEY.exec(value);
  if (!match) return false;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(m) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

export function assertDateKey(value: unknown, label = "date"): DateKey {
  if (!isDateKey(value)) throw new DateKeyError(`${label} must be a valid YYYY-MM-DD date`);
  return value;
}

function toUtcMs(key: DateKey): number {
  const [y, m, d] = assertDateKey(key).split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function fromUtcMs(ms: number): DateKey {
  return new Date(ms).toISOString().slice(0, 10);
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Calendar day of `instantMs` in the IANA `timeZone`. */
export function toDateKey(instantMs: number, timeZone: string): DateKey {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(instantMs)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function todayIn(timeZone: string, nowMs: number = Date.now()): DateKey {
  return toDateKey(nowMs, timeZone);
}

export function addDays(key: DateKey, days: number): DateKey {
  return fromUtcMs(toUtcMs(key) + days * DAY_MS);
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function diffDays(from: DateKey, to: DateKey): number {
  return Math.round((toUtcMs(to) - toUtcMs(from)) / DAY_MS);
}

export function compareDateKeys(a: DateKey, b: DateKey): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Every day in the inclusive range. */
export function eachDay(from: DateKey, to: DateKey): DateKey[] {
  const span = diffDays(from, to);
  if (span < 0) throw new DateKeyError("`from` must not be after `to`");
  if (span >= MAX_DAY_SPAN) throw new DateKeyError(`Range exceeds ${MAX_DAY_SPAN} days`);
  return Array.from({ length: span + 1 }, (_, i) => addDays(from, i));
}

/** "YYYY-MM". */
export function monthKey(key: DateKey): string {
  return assertDateKey(key).slice(0, 7);
}

/** Splits an inclusive range at calendar month boundaries (used for backfill chunking). */
export function monthChunks(from: DateKey, to: DateKey): { from: DateKey; to: DateKey }[] {
  if (diffDays(from, to) < 0) throw new DateKeyError("`from` must not be after `to`");
  const chunks: { from: DateKey; to: DateKey }[] = [];
  let start = from;
  while (compareDateKeys(start, to) <= 0) {
    const [y, m] = start.split("-").map(Number) as [number, number];
    const monthEnd = fromUtcMs(Date.UTC(y, m, 0));
    const end = compareDateKeys(monthEnd, to) < 0 ? monthEnd : to;
    chunks.push({ from: start, to: end });
    start = addDays(end, 1);
  }
  return chunks;
}

/** Monday of the ISO week containing `key`. */
export function startOfIsoWeek(key: DateKey): DateKey {
  const weekday = (new Date(toUtcMs(key)).getUTCDay() + 6) % 7; // Monday = 0
  return addDays(key, -weekday);
}

/** ISO-8601 week key, e.g. "2026-W01" (week-year may differ from calendar year). */
export function isoWeekKey(key: DateKey): string {
  const thursday = addDays(startOfIsoWeek(key), 3);
  const weekYear = Number(thursday.slice(0, 4));
  const firstThursday = addDays(startOfIsoWeek(`${weekYear}-01-04`), 3);
  const week = diffDays(firstThursday, thursday) / 7 + 1;
  return `${weekYear}-W${String(week).padStart(2, "0")}`;
}
