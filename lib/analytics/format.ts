import { microsToDecimalString } from "@/convex/lib/money";
import type { Money, MoneyAmounts } from "./types";

/**
 * Display formatting (D7). Money TEXT is exact: micros strings are turned into
 * decimal strings with bigint math and handed to Intl.NumberFormat, which
 * formats numeric strings without going through floating point. `toPlotNumber`
 * is the only lossy conversion and is used for chart geometry only.
 */

/**
 * Numbers and dates use the browser's locale (D7; UI copy is English, full
 * internationalisation is out of scope). `undefined` = the runtime default.
 * Tests pin a locale with `setDisplayLocale` so they are machine-independent.
 */
let displayLocale: string | undefined;

export function setDisplayLocale(locale: string | undefined) {
  displayLocale = locale;
}

export function getDisplayLocale(): string | undefined {
  return displayLocale;
}

export function moneyDecimal(micros: string): string {
  return microsToDecimalString(BigInt(micros));
}

export function formatMoney(money: Money, locale: string | undefined = displayLocale): string {
  const formatter = new Intl.NumberFormat(locale, { style: "currency", currency: money.currency });
  // Intl formats numeric strings exactly (ES2023); typed as number for older lib typings.
  return formatter.format(moneyDecimal(money.micros) as unknown as number);
}

/** Approximate number of currency units, for chart geometry only. */
export function toPlotNumber(micros: string): number {
  return Number(moneyDecimal(micros));
}

export function formatCount(value: number, locale: string | undefined = displayLocale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(value);
}

/** Fractional metrics such as data-driven conversions. */
export function formatDecimal(value: number, locale: string | undefined = displayLocale): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
}

/** A fraction (0.0123) as a percent ("1.23%"). */
export function formatPercent(
  fraction: number,
  locale: string | undefined = displayLocale,
  digits = 2,
): string {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(fraction);
}

/** A multiplier such as ROAS or value per spend (4.05 -> "4.05×"). */
export function formatMultiple(value: number, locale: string | undefined = displayLocale): string {
  return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value)}×`;
}

/** A relative change fraction (0.123 -> "+12.3%"). Display only. */
export function formatChange(fraction: number, locale: string | undefined = displayLocale): string {
  const text = new Intl.NumberFormat(locale, {
    style: "percent",
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(fraction);
  return text;
}

export type MoneyDisplay =
  | { kind: "reporting"; money: Money }
  | { kind: "native"; money: Money }
  | { kind: "multiple"; native: Money[] }
  | { kind: "none" };

/**
 * Which money value to show (D11): the reporting-currency value when present,
 * else the single native value, else "multiple currencies". Never converted here.
 */
export function moneyDisplay(amounts: MoneyAmounts | undefined): MoneyDisplay {
  if (amounts === undefined) return { kind: "none" };
  if (amounts.reporting !== undefined) return { kind: "reporting", money: amounts.reporting };
  if (amounts.native.length === 1) return { kind: "native", money: amounts.native[0]! };
  if (amounts.native.length === 0) return { kind: "none" };
  return { kind: "multiple", native: amounts.native };
}
