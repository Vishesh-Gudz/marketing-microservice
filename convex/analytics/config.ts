/**
 * Analytics limits (docs/analytics.md, ADR 0007). The read budgets are
 * APPLICATION-LEVEL Phase 6 safety limits (not Convex platform limits): every
 * read of a query shares one budget per table family, and exceeding it fails
 * the query deterministically with INVALID_ARGUMENT `too_many_rows` instead of
 * returning truncated data.
 */
export const ANALYTICS_LIMITS = {
  /** metricsDaily rows plus ad-account/entity documents read by one query, across all its reads. */
  maxMetricRows: 8_000,
  /** actionMetricsDaily rows read by one query. */
  maxActionRows: 8_000,
  /** Inclusive range length. */
  maxRangeDays: 400,
  /** Performance rows per page (the v1 pagination cap). */
  maxPageSize: 100,
  /** Explicit account filter size. */
  maxAccountIds: 50,
  /** An FX rate may be at most this many days older than the metric date. */
  fxFallbackDays: 7,
} as const;
