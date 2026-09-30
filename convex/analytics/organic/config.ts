/**
 * Organic analytics limits (Phase 10 Stage B, F16). APPLICATION-LEVEL safety limits, like the
 * Phase 6 ad budgets (convex/analytics/config.ts), kept separate from them: every read of one
 * organic query draws from ONE budget, and exceeding it fails the query deterministically with
 * INVALID_ARGUMENT `too_many_rows` instead of returning truncated data.
 */
export const ORGANIC_LIMITS = {
  /** Social account documents, sync states and organic rows read by one query (F16). */
  maxSocialRows: 8_000,
  /** Inclusive range length (UTC days for account metrics; capture days for snapshots). */
  maxRangeDays: 400,
  /** Explicit social account filter size. */
  maxAccountIds: 50,
  /** v1 list page size (F16). */
  maxPageSize: 100,
} as const;
