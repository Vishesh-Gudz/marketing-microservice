import { defineTable } from "convex/server";
import { v } from "convex/values";
import { adPlatformValidator, dateKeyValidator, entityLevelValidator } from "../domain/validators";
import { orgIdField } from "./common";

// Phase 5: sync engine state. INTERNAL-ONLY (no public function reads these
// tables in Phase 5). Cursors, leases and claim sequence numbers never leave
// internal functions. Fields a future DTO may expose: run kind/status/window/
// counts/timestamps, sanitized error kind+message, coverage, lastSuccessAt, state.

/** Sanitized failure: kind + optional platform code + generic message. Never payloads. */
export const syncErrorValidator = v.object({
  kind: v.string(),
  code: v.optional(v.string()),
  message: v.string(),
  at: v.number(),
});

export const syncCountsValidator = v.object({
  pages: v.number(),
  records: v.number(),
  inserted: v.number(),
  updated: v.number(),
  removed: v.number(),
  reappeared: v.number(),
  metricRows: v.number(),
  actionRows: v.number(),
  pruned: v.number(),
  unresolved: v.number(),
  rejected: v.number(),
  truncated: v.number(),
  duplicatesRepaired: v.number(),
});

export const syncRunKindValidator = v.union(
  v.literal("initial"),
  v.literal("incremental"),
  v.literal("lookback"),
  v.literal("backfill"),
  v.literal("manual"),
);

export const syncRunStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("partial"),
  v.literal("failed"),
  v.literal("cancelled"),
);

export const syncTaskStatusValidator = v.union(
  v.literal("queued"),
  v.literal("running"),
  v.literal("succeeded"),
  v.literal("failed"),
  v.literal("skipped"),
  v.literal("cancelled"),
);

export const syncOperationValidator = v.union(
  v.literal("getAccount"),
  v.literal("listCampaigns"),
  v.literal("listAdGroups"),
  v.literal("listCreatives"),
  v.literal("listAds"),
  v.literal("fetchDailyMetrics"),
  v.literal("fetchActionMetrics"),
);

export const syncCancelReasonValidator = v.union(
  v.literal("connection_inactive"),
  v.literal("account_unlinked"),
  v.literal("account_relinked"),
  v.literal("account_blocked"),
  v.literal("timeout"),
  v.literal("superseded"),
);

export const syncTables = {
  /** One row per ad account ever linked: sync state, schedule, coverage and the account lease. */
  syncAccounts: defineTable({
    orgId: orgIdField,
    adAccountId: v.id("adAccounts"),
    state: v.union(
      v.literal("idle"),
      v.literal("running"),
      v.literal("blocked"),
      v.literal("parked"),
    ),
    activeRunId: v.optional(v.id("syncRuns")),
    /** When the active run's current step must have started/finished; stale => planner recovers. */
    leaseExpiresAt: v.optional(v.number()),
    /** Next time the planner looks at this row. Absent = parked (not linked). */
    nextPlanAt: v.optional(v.number()),
    nextIncrementalAt: v.optional(v.number()),
    nextLookbackAt: v.optional(v.number()),
    initialDoneAt: v.optional(v.number()),
    lastStructureStartedAt: v.optional(v.number()),
    lastFullStructureAt: v.optional(v.number()),
    /** Unresolved references seen: the next run lists the full structure. */
    structureStale: v.boolean(),
    /** Contiguous account-local days for which every planned metric task succeeded. */
    coveredFrom: v.optional(dateKeyValidator),
    coveredThrough: v.optional(dateKeyValidator),
    /** Oldest day the backfill intends to hold (fixed when the row is created). */
    backfillHorizon: dateKeyValidator,
    throttledUntil: v.optional(v.number()),
    consecutiveFailures: v.number(),
    lastRunId: v.optional(v.id("syncRuns")),
    lastSuccessAt: v.optional(v.number()),
    lastError: v.optional(syncErrorValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_account", ["orgId", "adAccountId"])
    // GLOBAL (approved exception, Phase 5): the planner finds due accounts across
    // orgs. Every row read through it is re-verified for tenant ownership.
    .index("by_next_plan", ["nextPlanAt"]),

  /** One sync of one ad account; its tasks run sequentially in `seq` order. */
  syncRuns: defineTable({
    orgId: orgIdField,
    adAccountId: v.id("adAccounts"),
    /** Pinned at creation: a relink/disconnect cancels the run instead of mixing connections. */
    connectionId: v.id("connections"),
    platform: adPlatformValidator,
    providerId: v.string(),
    kind: syncRunKindValidator,
    trigger: v.union(
      v.literal("schedule"),
      v.literal("link"),
      v.literal("manual"),
      v.literal("recovery"),
    ),
    status: syncRunStatusValidator,
    window: v.optional(v.object({ from: dateKeyValidator, to: dateKeyValidator })),
    structureMode: v.union(v.literal("full"), v.literal("incremental"), v.literal("none")),
    updatedSince: v.optional(v.number()),
    idempotencyKey: v.string(),
    taskCount: v.number(),
    tasksSucceeded: v.number(),
    tasksFailed: v.number(),
    tasksSkipped: v.number(),
    counts: syncCountsValidator,
    error: v.optional(syncErrorValidator),
    cancelReason: v.optional(syncCancelReasonValidator),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    updatedAt: v.number(),
  })
    .index("by_org_account_created", ["orgId", "adAccountId", "createdAt"])
    .index("by_org_account_key", ["orgId", "adAccountId", "idempotencyKey"])
    .index("by_org_status", ["orgId", "status"]),

  /** One provider operation (one request, many pages) plus its finalize step. */
  syncTasks: defineTable({
    orgId: orgIdField,
    runId: v.id("syncRuns"),
    adAccountId: v.id("adAccounts"),
    seq: v.number(),
    operation: syncOperationValidator,
    level: v.optional(entityLevelValidator),
    from: v.optional(dateKeyValidator),
    to: v.optional(dateKeyValidator),
    breakdown: v.optional(v.union(v.literal("none"), v.literal("placement"))),
    updatedSince: v.optional(v.number()),
    /** Complete listing without updatedSince: allows removal marking. */
    fullListing: v.boolean(),
    /** finalize = prune stale metric rows / mark removed entities (DB only). */
    phase: v.union(v.literal("fetch"), v.literal("finalize")),
    status: syncTaskStatusValidator,
    cursor: v.optional(v.string()),
    previousCursor: v.optional(v.string()),
    cursorSavedAt: v.optional(v.number()),
    /** Opaque finalize progress (JSON). */
    finalizeCursor: v.optional(v.string()),
    /** Generation marker: rows not rewritten since this instant are stale. */
    fetchStartedAt: v.optional(v.number()),
    pages: v.number(),
    emptyPagesInRow: v.number(),
    records: v.number(),
    /** 1-based attempt of the CURRENT page; passed to ProviderContext.attempt. */
    attempt: v.number(),
    /** Transient failures of the current page (budget: maxPageAttempts). */
    pageTransientFailures: v.number(),
    totalAttempts: v.number(),
    rateLimitHits: v.number(),
    staleRecoveries: v.number(),
    restartedFromScratch: v.boolean(),
    /** Incremented on every claim; commits from older claims are discarded. */
    claimSeq: v.number(),
    leaseExpiresAt: v.optional(v.number()),
    nextAttemptAt: v.optional(v.number()),
    counts: syncCountsValidator,
    lastError: v.optional(syncErrorValidator),
    createdAt: v.number(),
    startedAt: v.optional(v.number()),
    finishedAt: v.optional(v.number()),
    updatedAt: v.number(),
  }).index("by_org_run_seq", ["orgId", "runId", "seq"]),
};
