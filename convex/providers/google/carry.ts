/**
 * Cross-page accumulation for staged Google insights (Phase 9, G-D11 = A: a Google-local
 * implementation with the same semantics as the Phase 8 Meta carry; the Meta module is not
 * shared or modified).
 *
 * A canonical key that can collect several raw rows (for example placement "other", which
 * collects every ad_network_type value without a canonical placement) may receive rows on
 * different Google pages — and one Google page is served as several provider pages. The
 * sync REPLACES a canonical row per key, so such records are accumulated in a carry inside
 * the request-bound cursor (committed atomically with each page) and emitted once the stage
 * has no more pages.
 *
 * Merge semantics (missing vs zero is preserved exactly):
 * - a field reported by every contribution → the exact sum (an explicit 0 stays 0);
 * - a field reported by no contribution → absent;
 * - a field reported by only some contributions → absent (the total is unknown).
 * Identity fields must agree, else the rows are inconsistent (a "data" error).
 */

export type CarrySpec = {
  /** The canonical upsert key of a record (includes the placement). */
  key(record: Record<string, unknown>): string;
  /** Records that may collect several raw rows and are therefore accumulated. */
  accumulates(record: Record<string, unknown>): boolean;
  /** Additive fields (summed per the merge semantics above). */
  additive: readonly string[];
  /** bigint-valued fields (money micros), encoded as decimal strings in the cursor. */
  bigints: readonly string[];
  /** Fields derived from the request (dropped from the cursor, restored on decode). */
  derived: readonly string[];
};

type Partial = { record: Record<string, unknown>; unknown: Set<string> };
export type Carry = Map<string, Partial>;

function joinRaw(a: unknown, b: unknown): string | undefined {
  const parts = new Set(
    [a, b].flatMap((v) => (typeof v === "string" && v !== "" ? v.split(",") : [])),
  );
  return parts.size > 0 ? [...parts].sort().join(",") : undefined;
}

export function addToCarry(carry: Carry, record: Record<string, unknown>, spec: CarrySpec): void {
  const key = spec.key(record);
  const seen = carry.get(key);
  if (seen === undefined) {
    carry.set(key, { record: { ...record }, unknown: new Set() });
    return;
  }
  for (const field of new Set([...Object.keys(seen.record), ...Object.keys(record)])) {
    if (field === "rawPlacement" || spec.additive.includes(field)) continue;
    if (seen.record[field] !== record[field]) throw new Error("inconsistent rows for one key");
  }
  const raw = joinRaw(seen.record.rawPlacement, record.rawPlacement);
  if (raw !== undefined) seen.record.rawPlacement = raw;
  for (const field of spec.additive) {
    if (seen.unknown.has(field)) continue;
    const a = seen.record[field];
    const b = record[field];
    if (a === undefined && b === undefined) continue;
    if (a === undefined || b === undefined) {
      seen.unknown.add(field);
      delete seen.record[field];
      continue;
    }
    seen.record[field] =
      typeof a === "bigint" && typeof b === "bigint" ? a + b : (a as number) + (b as number);
  }
}

/** Splits off the first `count` accumulated records (flushing), keeping the rest. */
export function takeFromCarry(carry: Carry, count: number): Record<string, unknown>[] {
  const taken: Record<string, unknown>[] = [];
  for (const [key, partial] of carry) {
    if (taken.length >= count) break;
    taken.push(partial.record);
    carry.delete(key);
  }
  return taken;
}

type Encoded = { r: Record<string, unknown>; u?: string[] };

export function encodeCarry(carry: Carry, spec: CarrySpec): Encoded[] {
  return [...carry.values()].map(({ record, unknown }) => {
    const r: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(record)) {
      if (spec.derived.includes(field)) continue;
      r[field] = typeof value === "bigint" ? value.toString() : value;
    }
    return unknown.size > 0 ? { r, u: [...unknown].sort() } : { r };
  });
}

/** Rebuilds a carry from its cursor form; throws on any malformed entry. */
export function decodeCarry(
  encoded: unknown,
  spec: CarrySpec,
  derived: Record<string, unknown>,
): Carry {
  const carry: Carry = new Map();
  if (encoded === undefined) return carry;
  if (!Array.isArray(encoded)) throw new Error("carry is not a list");
  for (const entry of encoded as unknown[]) {
    if (entry === null || typeof entry !== "object") throw new Error("bad carry entry");
    const { r, u } = entry as { r?: unknown; u?: unknown };
    if (r === null || typeof r !== "object" || Array.isArray(r)) throw new Error("bad record");
    const unknown = new Set<string>();
    if (u !== undefined) {
      if (!Array.isArray(u) || !u.every((f) => spec.additive.includes(f as string))) {
        throw new Error("bad unknown list");
      }
      for (const field of u as string[]) unknown.add(field);
    }
    const record: Record<string, unknown> = { ...derived };
    for (const [field, value] of Object.entries(r as Record<string, unknown>)) {
      if (spec.derived.includes(field)) throw new Error("derived field in carry");
      if (spec.bigints.includes(field)) {
        if (typeof value !== "string" || !/^\d{1,30}$/.test(value)) throw new Error("bad amount");
        record[field] = BigInt(value);
      } else {
        record[field] = value;
      }
    }
    const key = spec.key(record);
    if (carry.has(key)) throw new Error("duplicate carry key");
    carry.set(key, { record, unknown });
  }
  return carry;
}
