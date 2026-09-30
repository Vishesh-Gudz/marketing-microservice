/** Deterministic hashing / pseudo-randomness. No Math.random, no clock. */

/** 32-bit FNV-1a hash of a string. */
export function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Stable short fingerprint (base36) of any JSON-serializable parts. */
export function fingerprint(parts: readonly unknown[]): string {
  return fnv1a(
    JSON.stringify(parts, (_k, value) => (typeof value === "bigint" ? `${value}n` : value)),
  ).toString(36);
}

/** mulberry32 PRNG seeded from a string key; returns floats in [0, 1). */
export function seededRandom(key: string): () => number {
  let state = fnv1a(key);
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
