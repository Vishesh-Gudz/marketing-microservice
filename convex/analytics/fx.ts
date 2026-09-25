import type { DatabaseReader } from "../_generated/server";
import { addDays, compareDateKeys, diffDays, type DateKey } from "../lib/dates";
import { ANALYTICS_LIMITS } from "./config";
import { roundDiv } from "./numeric";

/**
 * Reporting-currency conversion (docs/analytics.md "Currency").
 * - Rates are "units of quote per 1 USD" (USD pivot), stored as exact decimal
 *   strings with at most 12 fractional digits; parsed to bigint x 10^12.
 * - A money amount of an account-local day is converted with the rate for that
 *   day, or the latest rate at most `fxFallbackDays` older; otherwise the rate
 *   is missing and no reporting-currency value is produced.
 * - Conversion is one exact rational step: micros * rate(to) / rate(from),
 *   rounded half away from zero.
 */

export const FX_PIVOT = "USD";
export const RATE_DECIMALS = 12;
const RATE_SCALE = 10n ** BigInt(RATE_DECIMALS);
const RATE = /^(\d{1,12})(?:\.(\d{1,12}))?$/;

export class RateParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateParseError";
  }
}

/** Positive decimal string -> bigint scaled by 10^12. */
export function parseRate(value: string): bigint {
  const match = RATE.exec(value.trim());
  if (!match) throw new RateParseError(`Invalid rate "${value}"`);
  const scaled =
    BigInt(match[1]!) * RATE_SCALE + BigInt((match[2] ?? "").padEnd(RATE_DECIMALS, "0"));
  if (scaled <= 0n) throw new RateParseError("Rate must be positive");
  return scaled;
}

type RatePoint = { date: DateKey; scaled: bigint };

/** In-memory rate table for the currencies and days one query needs. */
export class RateTable {
  private readonly rates = new Map<string, RatePoint[]>();

  add(currency: string, date: DateKey, rate: string): void {
    const list = this.rates.get(currency) ?? [];
    list.push({ date, scaled: parseRate(rate) });
    this.rates.set(currency, list);
  }

  /** Rate of `currency` per 1 USD on `date` (with fallback), or undefined. */
  lookup(currency: string, date: DateKey): bigint | undefined {
    if (currency === FX_PIVOT) return RATE_SCALE;
    const list = this.rates.get(currency);
    if (!list) return undefined;
    let best: RatePoint | undefined;
    for (const point of list) {
      if (compareDateKeys(point.date, date) > 0) continue;
      if (best === undefined || compareDateKeys(point.date, best.date) > 0) best = point;
    }
    if (best === undefined || diffDays(best.date, date) > ANALYTICS_LIMITS.fxFallbackDays) {
      return undefined;
    }
    return best.scaled;
  }
}

/**
 * Converts native amounts into the reporting currency and records which
 * (currency, day) pairs lacked a rate.
 */
export class FxConverter {
  private readonly missing = new Map<string, Set<DateKey>>();
  private needed = false;

  constructor(
    readonly reportingCurrency: string,
    private readonly table: RateTable,
  ) {}

  convert(micros: bigint, currency: string, date: DateKey): bigint | undefined {
    if (currency === this.reportingCurrency) return micros;
    this.needed = true;
    const from = this.table.lookup(currency, date);
    const to = this.table.lookup(this.reportingCurrency, date);
    if (from === undefined || to === undefined) {
      const key = from === undefined ? currency : this.reportingCurrency;
      const days = this.missing.get(key) ?? new Set<DateKey>();
      days.add(date);
      this.missing.set(key, days);
      return undefined;
    }
    return roundDiv(micros * to, from);
  }

  /** not_needed: every amount was already in the reporting currency. */
  status(): {
    reportingCurrency: string;
    status: "not_needed" | "complete" | "missing";
    missing?: { currency: string; days: number }[];
  } {
    if (this.missing.size > 0) {
      return {
        reportingCurrency: this.reportingCurrency,
        status: "missing",
        missing: [...this.missing.entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([currency, days]) => ({ currency, days: days.size })),
      };
    }
    return {
      reportingCurrency: this.reportingCurrency,
      status: this.needed ? "complete" : "not_needed",
    };
  }
}

/**
 * Loads the rates needed to convert `currencies` into `reportingCurrency`
 * over `range` (plus the fallback window). Reads nothing when every currency
 * already is the reporting currency.
 */
export async function loadRateTable(
  db: DatabaseReader,
  currencies: Iterable<string>,
  reportingCurrency: string,
  range: { from: DateKey; to: DateKey },
): Promise<RateTable> {
  const table = new RateTable();
  const needed = new Set<string>();
  for (const currency of currencies) {
    if (currency === reportingCurrency) continue;
    needed.add(currency);
    needed.add(reportingCurrency);
  }
  needed.delete(FX_PIVOT);
  const from = addDays(range.from, -ANALYTICS_LIMITS.fxFallbackDays);
  for (const quote of [...needed].sort()) {
    const rows = await db
      .query("fxRates")
      .withIndex("by_quote_date", (q) =>
        q.eq("quote", quote).gte("date", from).lte("date", range.to),
      )
      .collect();
    for (const row of rows) table.add(row.quote, row.date, row.rate);
  }
  return table;
}
