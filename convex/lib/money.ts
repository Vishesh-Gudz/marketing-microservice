import { v, type Infer } from "convex/values";

/**
 * Money is stored as int64 micros (bigint) of the owning account's currency:
 * 1 currency unit = 1_000_000 micros. bigint keeps sums exact even for
 * high-denomination currencies (IDR, VND) where float micros would exceed 2^53.
 * Conversion to the org reporting currency happens at read time (Phase 6).
 */
export const MICROS_PER_UNIT = 1_000_000n;
const MICRO_DIGITS = 6;

export class MoneyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyParseError";
  }
}

const DECIMAL = /^([+-])?(\d+)(?:\.(\d+))?$/;

/**
 * Exact decimal string -> micros (no floating point). Meta returns amounts as
 * decimal strings ("123.45"). More than 6 fractional digits are rounded half
 * away from zero. Exponent notation and empty/partial numbers are rejected.
 */
export function parseDecimalToMicros(input: string): bigint {
  const match = DECIMAL.exec(input.trim());
  if (!match) throw new MoneyParseError(`Not a decimal amount: "${input}"`);
  const [, sign, whole = "0", fraction = ""] = match;

  let micros =
    BigInt(whole) * MICROS_PER_UNIT +
    BigInt(fraction.slice(0, MICRO_DIGITS).padEnd(MICRO_DIGITS, "0"));
  const nextDigit = fraction.charAt(MICRO_DIGITS);
  if (nextDigit !== "" && Number(nextDigit) >= 5) micros += 1n;

  return sign === "-" ? -micros : micros;
}

/**
 * Float -> micros, rounding half away from zero. Google reports some values as
 * doubles in account currency units (e.g. conversions_value). Prefer
 * `parseDecimalToMicros` or native micros (cost_micros) where available.
 */
export function numberToMicros(value: number): bigint {
  if (!Number.isFinite(value)) throw new MoneyParseError(`Not a finite amount: ${value}`);
  if (Math.abs(value) >= 1e21) throw new MoneyParseError(`Amount out of range: ${value}`);
  return parseDecimalToMicros(value.toFixed(MICRO_DIGITS + 1));
}

/** Exact micros -> canonical decimal string without trailing zeros ("123.45", "-0.5", "0"). */
export function microsToDecimalString(micros: bigint): string {
  const negative = micros < 0n;
  const abs = negative ? -micros : micros;
  const whole = abs / MICROS_PER_UNIT;
  const fraction = (abs % MICROS_PER_UNIT)
    .toString()
    .padStart(MICRO_DIGITS, "0")
    .replace(/0+$/, "");
  const text = fraction ? `${whole}.${fraction}` : whole.toString();
  return negative && abs !== 0n ? `-${text}` : text;
}

/**
 * Sums present values; returns undefined when every value is absent
 * (missing-data semantics: absent stays absent, it does not become 0).
 */
export function sumMicros(values: Iterable<bigint | undefined>): bigint | undefined {
  let total: bigint | undefined;
  for (const value of values) {
    if (value !== undefined) total = (total ?? 0n) + value;
  }
  return total;
}

export function addMicros(a: bigint | undefined, b: bigint | undefined): bigint | undefined {
  return sumMicros([a, b]);
}

/** Number of minor-unit digits of an ISO 4217 currency (USD 2, JPY 0, KWD 3). */
export function currencyMinorUnits(currency: string): number {
  return (
    new Intl.NumberFormat("en-US", { style: "currency", currency }).resolvedOptions()
      .maximumFractionDigits ?? 2
  );
}

// ---------------------------------------------------------------------------
// DTO convention (used by v1 from Phase 6): micros travel as a decimal STRING
// so they survive JSON / the Convex HTTP API without precision loss.
// ---------------------------------------------------------------------------

export const moneyDto = v.object({ currency: v.string(), micros: v.string() });
export type MoneyDto = Infer<typeof moneyDto>;

export function toMoneyDto(micros: bigint, currency: string): MoneyDto {
  return { currency, micros: micros.toString() };
}
