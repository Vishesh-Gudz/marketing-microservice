import { microsToDecimalString, numberToMicros } from "../lib/money";

/**
 * Exact numeric primitives for analytics. All arithmetic is bigint; floats
 * only appear at the boundaries (float metrics in, JSON numbers out).
 *
 * - Money: int64 micros (existing convention).
 * - Float metrics (conversions): fixed-point, 6 decimals (x 1_000_000).
 * - Ratios (CTR, conversion rate, ROAS, percent change): fixed-point, 6 decimals.
 * Rounding everywhere: half away from zero (same rule as lib/money).
 */

export const FIXED_SCALE = 1_000_000n;

/** n / d rounded half away from zero. `d` must be positive. */
export function roundDiv(n: bigint, d: bigint): bigint {
  if (d <= 0n) throw new RangeError("roundDiv: divisor must be positive");
  const q = n / d; // truncates toward zero
  const r = n % d;
  if (r === 0n) return q;
  const twice = (r < 0n ? -r : r) * 2n;
  if (twice < d) return q;
  return n < 0n ? q - 1n : q + 1n;
}

/** Float metric -> fixed-point (6 decimals, half away from zero). */
export function toFixed6(value: number): bigint {
  return numberToMicros(value);
}

/** Fixed-point (6 decimals) -> JSON number via its exact decimal representation. */
export function fixed6ToNumber(value: bigint): number {
  return Number(microsToDecimalString(value));
}

/** num / den as a 6-decimal fixed-point ratio (den must be positive). */
export function ratioFixed6(num: bigint, den: bigint): bigint {
  return roundDiv(num * FIXED_SCALE, den);
}

export class UnsafeCountError extends Error {
  constructor() {
    super("Count exceeds the safe integer range");
    this.name = "UnsafeCountError";
  }
}

/** bigint count -> JSON number; counts beyond 2^53 are an invariant violation. */
export function countToNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new UnsafeCountError();
  }
  return Number(value);
}
