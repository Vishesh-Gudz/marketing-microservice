/**
 * Sync engine limits and cadence (docs/sync.md). Every loop in the engine is
 * bounded by one of these values.
 */
export const SYNC_LIMITS = {
  /** Tasks are created up front; a plan exceeding this is a programming error. */
  maxTasksPerRun: 64,
  maxPagesPerTask: 500,
  maxConsecutiveEmptyPages: 25,
  /** Absolute cap on records per page, on top of the provider's maxPageSize. */
  hardMaxRecordsPerPage: 500,
  /** Metric window per task (further capped by capabilities.maxMetricsRangeDays). */
  maxWindowDays: 31,
  maxManualWindowDays: 93,
  initialWindowDays: 30,
  maxLookbackDays: 30,
  /** Incremental runs catch up at most this far after an outage; older gaps are backfilled. */
  maxCatchUpDays: 62,
  backfillHorizonDays: 395,

  maxPageAttempts: 5,
  transientBaseDelayMs: 30_000,
  transientMaxDelayMs: 15 * 60_000,
  maxRateLimitHits: 10,
  rateLimitBaseDelayMs: 30_000,
  maxBackoffMs: 60 * 60_000,

  taskLeaseMs: 5 * 60_000,
  maxStaleRecoveries: 3,
  maxRunDurationMs: 6 * 60 * 60_000,
  staleCursorMs: 30 * 60_000,
  finalizeBatch: 500,

  plannerBatch: 50,
  maxRunsStartedPerTick: 25,
  maxPlannerContinuations: 20,
  runsKeptPerAccount: 50,
  /** Old runs deleted per new run (retention stays bounded per transaction). */
  runsDeletedPerCreate: 5,

  inactiveRecheckMs: 60 * 60_000,
  blockedRecheckMs: 24 * 60 * 60_000,
  failureBaseBackoffMs: 15 * 60_000,
  maxFailureBackoffMs: 6 * 60 * 60_000,

  attributesMaxKeys: 50,
  attributeKeyMaxLength: 64,
  attributeValueMaxLength: 1_024,
  extrasMaxKeys: 50,
  textArrayMaxItems: 20,

  /** Removal marking is skipped when it would remove more than this share AND count. */
  massRemovalMaxShare: 0.5,
  massRemovalMinCount: 20,
} as const;

export const SYNC_CADENCE = {
  plannerIntervalMinutes: 15,
  incrementalIntervalMs: 60 * 60_000,
  lookbackIntervalMs: 24 * 60 * 60_000,
  /** updatedSince overlap for incremental structure listings. */
  structureOverlapMs: 60 * 60_000,
} as const;
