/**
 * Cross-page accumulation for staged insights (Phase 8, R9).
 *
 * Some canonical keys can receive contributions from SEVERAL raw Graph rows — today only
 * placement "other", which collects every publisher_platform value we do not recognize. Those
 * raw rows can arrive on different Graph pages, and the sync REPLACES a canonical row per
 * page, so emitting them page by page would lose data. Instead the engine accumulates such
 * records in a "carry" that travels inside the request-bound cursor (which the sync commits
 * atomically with each page) and emits them once the stage has no more Graph pages.
 *
 * Merge semantics (missing vs zero is preserved exactly):
 * - a metric reported by every contribution → the exact sum (an explicit 0 stays 0);
 * - a metric reported by no contribution → absent;
 * - a metric reported by some contributions but not others → absent (the total is unknown;
 *   a partial sum is never presented as exact and an unreported part never counts as 0).
 * Identity fields (entity, date, currency, action identity, …) must agree, else the rows
 * are inconsistent and the page is a "data" error.
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

/** Accumulated record plus the additive fields that became unknown. */
type Partial = { record: Record<string, unknown>; unknown: Set<string> };
export type Carry = Map<string, Partial>;

/** Raw placement values of merged rows: sorted, comma-joined, de-duplicated. */
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
  const fields = new Set([...Object.keys(seen.record), ...Object.keys(record)]);
  for (const field of fields) {
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

/** The accumulated records, in first-seen order. */
export function carryRecords(carry: Carry): Record<string, unknown>[] {
  return [...carry.values()].map((partial) => partial.record);
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

// ---------------------------------------------------------------------------
// Cursor encoding
// ---------------------------------------------------------------------------

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
