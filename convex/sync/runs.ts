import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { providerRegistry } from "../connections/config";
import { markConnectionNeedsReauth } from "../connections/lifecycle";
import { AUDIT_ACTIONS, SYSTEM_SYNC_SUBJECT, writeAudit } from "../lib/audit";
import type { AuditChanges } from "../lib/validation";
import { accountScopeFromDoc, orgScopeFromOrganization } from "../mapping/scope";
import type { AdsProviderCapabilities } from "../providers/capabilities";
import type { ProviderAdAccount } from "../providers/types";
import { SYNC_CADENCE, SYNC_LIMITS } from "./config";
import { checkPageShape, checkRecordsInScope, OPERATION_RECORD_KIND } from "./guards";
import {
  isMetricOperation,
  isStructureOperation,
  mergeCoverage,
  nextDueAt,
  failureBackoffMs,
  prunePlacements,
  removalTableFor,
  type RunPlan,
  type SyncRunKind,
} from "./plan";
import {
  decideFailure,
  isBlockingError,
  retainBlockingError,
  sanitizeFailure,
  toSyncFailure,
  type SyncFailure,
} from "./policy";
import { findSyncAccount } from "./state";
import {
  accountDrift,
  addCounts,
  emptyCounts,
  markRemovedBatch,
  pruneMetricsBatch,
  refreshAdAccount,
  writeEntityPage,
  writeMetricPage,
  type EntityPage,
  type MetricPage,
  type PruneCursor,
  type RemovalCursor,
  type SyncCounts,
} from "./upsert";
import {
  claimResultValidator,
  commitResultValidator,
  failureValidator,
  providerPageValidator,
  type ClaimResult,
} from "./validators";

/**
 * Run/task state machine. Every transition is a mutation, so checkpoints,
 * canonical writes and the scheduling of the next step commit atomically.
 *
 *   run:  queued -> running -> succeeded | partial | failed | cancelled
 *   task: queued -> running -> (queued: next page / retry) -> succeeded | failed | skipped | cancelled
 *         fetch phase (worker action, one page per claim) -> finalize phase (DB-only mutation)
 *
 * Tenant identity comes ONLY from stored rows (task -> run -> account ->
 * connection); every hop is checked to belong to the same org.
 */

type Ctx = Pick<MutationCtx, "db" | "scheduler">;
type SyncError = NonNullable<Doc<"syncRuns">["error"]>;

const ACTIVE_RUN = new Set(["queued", "running"]);
const TERMINAL_TASK = new Set(["succeeded", "failed", "skipped", "cancelled"]);

class TenantInvariantError extends Error {
  constructor() {
    super("Sync rows belong to different organizations");
    this.name = "TenantInvariantError";
  }
}

export type Loaded = {
  task: Doc<"syncTasks">;
  run: Doc<"syncRuns">;
  account: Doc<"adAccounts">;
  syncAccount: Doc<"syncAccounts">;
};

/** Loads task -> run -> account -> sync state, verifying they share one org. */
export async function loadTask(ctx: Ctx, taskId: Id<"syncTasks">): Promise<Loaded | null> {
  const task = await ctx.db.get(taskId);
  if (task === null) return null;
  const run = await ctx.db.get(task.runId);
  if (run === null) return null;
  const account = await ctx.db.get(run.adAccountId);
  if (account === null) return null;
  if (
    run.orgId !== task.orgId ||
    run.adAccountId !== task.adAccountId ||
    account.orgId !== run.orgId
  ) {
    throw new TenantInvariantError();
  }
  const syncAccount = await findSyncAccount(ctx.db, run.orgId, run.adAccountId);
  if (syncAccount === null) return null;
  return { task, run, account, syncAccount };
}

type Linkage = "account_unlinked" | "account_relinked" | "connection_inactive";

/** Why a run can no longer use its pinned connection (undefined = still valid). */
async function linkageProblem(
  ctx: Ctx,
  run: Doc<"syncRuns">,
  account: Doc<"adAccounts">,
): Promise<{ problem?: Linkage; connection?: Doc<"connections"> }> {
  if (account.connectionId === undefined) return { problem: "account_unlinked" };
  if (account.connectionId !== run.connectionId) return { problem: "account_relinked" };
  const connection = await ctx.db.get(run.connectionId);
  if (connection === null || connection.orgId !== run.orgId || connection.status !== "active") {
    return { problem: "connection_inactive" };
  }
  return { connection };
}

function capabilitiesOf(platform: Doc<"adAccounts">["platform"]): AdsProviderCapabilities {
  return providerRegistry().ads(platform).capabilities;
}

async function runTasks(ctx: Ctx, run: Doc<"syncRuns">): Promise<Doc<"syncTasks">[]> {
  return await ctx.db
    .query("syncTasks")
    .withIndex("by_org_run_seq", (q) => q.eq("orgId", run.orgId).eq("runId", run._id))
    .take(SYNC_LIMITS.maxTasksPerRun + 1);
}

async function setLease(ctx: Ctx, syncAccount: Doc<"syncAccounts">, until: number, now: number) {
  await ctx.db.patch(syncAccount._id, { leaseExpiresAt: until, nextPlanAt: until, updatedAt: now });
}

/** Schedules the step that continues `task`: a worker action (fetch) or a finalize mutation. */
async function scheduleTask(ctx: Ctx, task: Doc<"syncTasks">, delayMs: number) {
  if (task.phase === "finalize") {
    await ctx.scheduler.runAfter(delayMs, internal.sync.runs.finalizeTask, {
      taskId: task._id,
      claimSeq: task.claimSeq,
    });
  } else {
    await ctx.scheduler.runAfter(delayMs, internal.sync.worker.runTask, { taskId: task._id });
  }
}

async function writeSyncAudit(
  ctx: Ctx,
  orgId: Id<"organizations">,
  action: string,
  targetId: string,
  changes?: AuditChanges,
) {
  const org = await ctx.db.get(orgId);
  await writeAudit(
    ctx.db,
    { orgId, issuer: org?.issuer ?? "", subject: SYSTEM_SYNC_SUBJECT },
    { action, targetType: "adAccount", targetId, ...(changes ? { changes } : {}) },
  );
}

// ---------------------------------------------------------------------------
// Run creation
// ---------------------------------------------------------------------------

function newTaskFields(now: number) {
  return {
    phase: "fetch" as const,
    status: "queued" as const,
    pages: 0,
    emptyPagesInRow: 0,
    records: 0,
    attempt: 1,
    pageTransientFailures: 0,
    totalAttempts: 0,
    rateLimitHits: 0,
    staleRecoveries: 0,
    restartedFromScratch: false,
    claimSeq: 0,
    counts: emptyCounts(),
    createdAt: now,
    updatedAt: now,
  };
}

/** Deletes the oldest runs (and their tasks) beyond the per-account retention. */
async function applyRetention(ctx: Ctx, orgId: Id<"organizations">, adAccountId: Id<"adAccounts">) {
  const keep = SYNC_LIMITS.runsKeptPerAccount - 1; // the run about to be created is the newest
  const recent = await ctx.db
    .query("syncRuns")
    .withIndex("by_org_account_created", (q) => q.eq("orgId", orgId).eq("adAccountId", adAccountId))
    .order("desc")
    .take(keep + SYNC_LIMITS.runsDeletedPerCreate);
  for (const old of recent.slice(keep)) {
    if (ACTIVE_RUN.has(old.status)) continue;
    const tasks = await ctx.db
      .query("syncTasks")
      .withIndex("by_org_run_seq", (q) => q.eq("orgId", orgId).eq("runId", old._id))
      .take(SYNC_LIMITS.maxTasksPerRun + 1);
    for (const task of tasks) await ctx.db.delete(task._id);
    await ctx.db.delete(old._id);
  }
}

/**
 * Creates a run and ALL its tasks, takes the account lease and schedules the
 * first task, in one transaction. The account lease (activeRunId) makes a
 * second concurrent creation impossible: concurrent planners conflict on the
 * syncAccounts row and one retries, then sees the active run.
 */
export async function createRun(
  ctx: Ctx,
  input: {
    syncAccount: Doc<"syncAccounts">;
    account: Doc<"adAccounts">;
    connection: Doc<"connections">;
    plan: RunPlan;
    trigger: Doc<"syncRuns">["trigger"];
    now: number;
  },
): Promise<{ runId: Id<"syncRuns">; created: boolean }> {
  const { syncAccount, account, connection, plan, now } = input;
  if (
    syncAccount.orgId !== account.orgId ||
    connection.orgId !== account.orgId ||
    syncAccount.adAccountId !== account._id ||
    account.connectionId !== connection._id
  ) {
    throw new TenantInvariantError();
  }
  if (syncAccount.activeRunId !== undefined) {
    const active = await ctx.db.get(syncAccount.activeRunId);
    if (active !== null && ACTIVE_RUN.has(active.status)) {
      return { runId: active._id, created: false };
    }
  }

  const slot = Math.floor(now / (SYNC_CADENCE.plannerIntervalMinutes * 60_000));
  const idempotencyKey = `${plan.kind}:${plan.window?.from ?? "-"}:${plan.window?.to ?? "-"}:${slot}`;
  // Same kind + window in the same planner slot already ran (or runs): don't repeat it.
  // Cancelled/failed runs don't count, so a relink or reconnect can retry immediately.
  const sameSlot = await ctx.db
    .query("syncRuns")
    .withIndex("by_org_account_key", (q) =>
      q
        .eq("orgId", account.orgId)
        .eq("adAccountId", account._id)
        .eq("idempotencyKey", idempotencyKey),
    )
    .take(10);
  const duplicate = sameSlot.find((r) => r.status !== "cancelled" && r.status !== "failed");
  if (duplicate !== undefined) return { runId: duplicate._id, created: false };

  await applyRetention(ctx, account.orgId, account._id);

  const provider = providerRegistry().ads(account.platform);
  const runId = await ctx.db.insert("syncRuns", {
    orgId: account.orgId,
    adAccountId: account._id,
    connectionId: connection._id,
    platform: account.platform,
    providerId: provider.providerId,
    kind: plan.kind,
    trigger: input.trigger,
    status: "queued",
    ...(plan.window ? { window: plan.window } : {}),
    structureMode: plan.structureMode,
    ...(plan.updatedSince !== undefined ? { updatedSince: plan.updatedSince } : {}),
    idempotencyKey,
    taskCount: plan.tasks.length,
    tasksSucceeded: 0,
    tasksFailed: 0,
    tasksSkipped: 0,
    counts: emptyCounts(),
    createdAt: now,
    updatedAt: now,
  });

  let firstTaskId: Id<"syncTasks"> | undefined;
  for (const [seq, spec] of plan.tasks.entries()) {
    const taskId = await ctx.db.insert("syncTasks", {
      orgId: account.orgId,
      runId,
      adAccountId: account._id,
      seq,
      operation: spec.operation,
      ...(spec.level !== undefined ? { level: spec.level } : {}),
      ...(spec.from !== undefined ? { from: spec.from } : {}),
      ...(spec.to !== undefined ? { to: spec.to } : {}),
      ...(spec.breakdown !== undefined ? { breakdown: spec.breakdown } : {}),
      ...(spec.updatedSince !== undefined ? { updatedSince: spec.updatedSince } : {}),
      fullListing: spec.fullListing,
      ...newTaskFields(now),
    });
    firstTaskId ??= taskId;
  }

  await ctx.db.patch(syncAccount._id, {
    state: "running",
    activeRunId: runId,
    leaseExpiresAt: now + SYNC_LIMITS.taskLeaseMs,
    nextPlanAt: now + SYNC_LIMITS.taskLeaseMs,
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.sync.worker.runTask, { taskId: firstTaskId! });
  return { runId, created: true };
}

// ---------------------------------------------------------------------------
// Run completion / cancellation
// ---------------------------------------------------------------------------

async function cancelOpenTasks(ctx: Ctx, run: Doc<"syncRuns">, now: number) {
  for (const task of await runTasks(ctx, run)) {
    if (!TERMINAL_TASK.has(task.status)) {
      await ctx.db.patch(task._id, {
        status: "cancelled",
        leaseExpiresAt: undefined,
        nextAttemptAt: undefined,
        finishedAt: now,
        updatedAt: now,
      });
    }
  }
}

type CancelReason = NonNullable<Doc<"syncRuns">["cancelReason"]>;

/** Cancels an active run; nothing it fetches afterwards can be committed. */
export async function cancelRun(
  ctx: Ctx,
  run: Doc<"syncRuns">,
  reason: CancelReason,
  now: number,
): Promise<void> {
  if (!ACTIVE_RUN.has(run.status)) return;
  await cancelOpenTasks(ctx, run, now);
  await ctx.db.patch(run._id, {
    status: "cancelled",
    cancelReason: reason,
    finishedAt: now,
    updatedAt: now,
  });
  const syncAccount = await findSyncAccount(ctx.db, run.orgId, run.adAccountId);
  if (syncAccount === null || syncAccount.activeRunId !== run._id) return;

  const base = {
    activeRunId: undefined,
    leaseExpiresAt: undefined,
    lastRunId: run._id,
    updatedAt: now,
  };
  // A cancellation never overwrites a blocking reason (retainBlockingError); the
  // account stays "blocked" until a successful run clears it (audited).
  const settle = (incoming: SyncError | undefined) => {
    const lastError =
      incoming === undefined
        ? syncAccount.lastError
        : retainBlockingError(syncAccount.lastError, incoming);
    return {
      state: isBlockingError(lastError) ? ("blocked" as const) : ("idle" as const),
      lastError,
    };
  };
  switch (reason) {
    case "account_unlinked":
      await ctx.db.patch(syncAccount._id, { ...base, state: "parked", nextPlanAt: undefined });
      break;
    case "connection_inactive":
      await ctx.db.patch(syncAccount._id, {
        ...base,
        ...settle(sanitizeFailure({ kind: "connection_inactive" }, now)),
        nextPlanAt: now + SYNC_LIMITS.inactiveRecheckMs,
      });
      break;
    case "timeout": {
      const failures = syncAccount.consecutiveFailures + 1;
      await ctx.db.patch(syncAccount._id, {
        ...base,
        ...settle(sanitizeFailure({ kind: "internal" }, now)),
        consecutiveFailures: failures,
        nextPlanAt: now + failureBackoffMs(failures),
      });
      break;
    }
    default:
      await ctx.db.patch(syncAccount._id, { ...base, ...settle(undefined), nextPlanAt: now });
  }
}

/**
 * Metric windows whose every task succeeded WITHOUT unresolved or rejected
 * records (coverage only grows for complete windows). A skipped record means a
 * missing row inside the window would not mean "no delivery", so such a window
 * must not be covered; the next run (structure is stale) covers it.
 */
function completedWindows(tasks: Doc<"syncTasks">[]) {
  const byWindow = new Map<string, { from: string; to: string; ok: boolean }>();
  for (const task of tasks) {
    if (!isMetricOperation(task.operation) || task.from === undefined || task.to === undefined) {
      continue;
    }
    const key = `${task.from}|${task.to}`;
    const entry = byWindow.get(key) ?? { from: task.from, to: task.to, ok: true };
    entry.ok &&= task.status === "succeeded" && task.counts.unresolved + task.counts.rejected === 0;
    byWindow.set(key, entry);
  }
  return [...byWindow.values()].filter((w) => w.ok).map(({ from, to }) => ({ from, to }));
}

/**
 * Finishes a run once no task is left, computes its status, and moves the
 * account's schedule, structure freshness and coverage forward.
 */
async function completeRun(
  ctx: Ctx,
  run: Doc<"syncRuns">,
  now: number,
  override?: { status: "failed"; error: SyncError; accountPatch?: Partial<Doc<"syncAccounts">> },
): Promise<void> {
  const tasks = await runTasks(ctx, run);
  const failed = tasks.filter((t) => t.status === "failed");
  const skipped = tasks.filter((t) => t.status === "skipped");
  const preflightFailed = tasks.some(
    (t) => t.operation === "getAccount" && t.status !== "succeeded",
  );
  const warning = tasks.find((t) => t.status === "succeeded" && t.lastError !== undefined);
  const unresolved = run.counts.unresolved + run.counts.rejected > 0;

  const status: Doc<"syncRuns">["status"] =
    override?.status ??
    (preflightFailed || (failed.length > 0 && failed.length === tasks.length - skipped.length)
      ? "failed"
      : failed.length > 0 || unresolved || warning !== undefined
        ? "partial"
        : "succeeded");
  const error: SyncError | undefined =
    override?.error ?? failed[0]?.lastError ?? warning?.lastError;

  await ctx.db.patch(run._id, {
    status,
    ...(error !== undefined ? { error } : {}),
    tasksFailed: failed.length,
    tasksSkipped: skipped.length,
    tasksSucceeded: tasks.filter((t) => t.status === "succeeded").length,
    finishedAt: now,
    updatedAt: now,
  });

  const syncAccount = await findSyncAccount(ctx.db, run.orgId, run.adAccountId);
  if (syncAccount === null || syncAccount.activeRunId !== run._id) return;
  const base = {
    activeRunId: undefined,
    leaseExpiresAt: undefined,
    lastRunId: run._id,
    updatedAt: now,
  };

  if (status === "failed") {
    const failures = syncAccount.consecutiveFailures + 1;
    // A non-blocking failure keeps an existing blocking reason (and the blocked state);
    // a new blocking reason (blockAccount) replaces it via accountPatch.
    const lastError =
      error === undefined
        ? syncAccount.lastError
        : retainBlockingError(syncAccount.lastError, error);
    await ctx.db.patch(syncAccount._id, {
      ...base,
      state: isBlockingError(lastError) ? "blocked" : "idle",
      consecutiveFailures: failures,
      lastError,
      nextPlanAt: Math.max(nextDueAt(syncAccount, now), now + failureBackoffMs(failures)),
      ...override?.accountPatch,
    });
    return;
  }

  // Succeeded or partial: the account is healthy enough to advance its schedule. This is
  // the ONLY place a blocking reason is cleared, and it is audited.
  if (syncAccount.lastError !== undefined && isBlockingError(syncAccount.lastError)) {
    await writeSyncAudit(ctx, run.orgId, AUDIT_ACTIONS.syncAccountUnblocked, run.adAccountId, {
      reason: { from: syncAccount.lastError.kind, to: null },
    });
  }

  const structureTasks = tasks.filter((t) => isStructureOperation(t.operation));
  const structureOk =
    structureTasks.length > 0 && structureTasks.every((t) => t.status === "succeeded");
  const structureStartedAt = Math.min(...structureTasks.map((t) => t.fetchStartedAt ?? now), now);
  const coverage = mergeCoverage(
    syncAccount.coveredFrom !== undefined && syncAccount.coveredThrough !== undefined
      ? { from: syncAccount.coveredFrom, through: syncAccount.coveredThrough }
      : undefined,
    completedWindows(tasks),
  );

  const schedule: Partial<Doc<"syncAccounts">> = {};
  const kind: SyncRunKind = run.kind;
  if (kind === "initial") {
    schedule.initialDoneAt = now;
    schedule.nextIncrementalAt = now + SYNC_CADENCE.incrementalIntervalMs;
    schedule.nextLookbackAt = now + SYNC_CADENCE.lookbackIntervalMs;
  } else if (kind === "incremental") {
    schedule.nextIncrementalAt = now + SYNC_CADENCE.incrementalIntervalMs;
  } else if (kind === "lookback") {
    schedule.nextLookbackAt = now + SYNC_CADENCE.lookbackIntervalMs;
    schedule.nextIncrementalAt = now + SYNC_CADENCE.incrementalIntervalMs;
  }

  const next = {
    ...syncAccount,
    ...schedule,
    structureStale: unresolved
      ? true
      : structureOk && run.structureMode === "full"
        ? false
        : syncAccount.structureStale,
    ...(coverage ? { coveredFrom: coverage.from, coveredThrough: coverage.through } : {}),
  };

  await ctx.db.patch(syncAccount._id, {
    ...base,
    ...schedule,
    state: "idle",
    consecutiveFailures: 0,
    lastSuccessAt: now,
    lastError: error,
    structureStale: next.structureStale,
    ...(structureOk ? { lastStructureStartedAt: structureStartedAt } : {}),
    ...(structureOk && run.structureMode === "full" ? { lastFullStructureAt: now } : {}),
    ...(coverage ? { coveredFrom: coverage.from, coveredThrough: coverage.through } : {}),
    nextPlanAt: nextDueAt(next, now),
  });
}

/** Schedules the next queued task, or completes the run. */
async function advanceRun(ctx: Ctx, runId: Id<"syncRuns">, now: number): Promise<void> {
  const run = await ctx.db.get(runId);
  if (run === null || !ACTIVE_RUN.has(run.status)) return;
  const tasks = await runTasks(ctx, run);
  const next = tasks.find((t) => t.status === "queued");
  if (next !== undefined) {
    await scheduleTask(ctx, next, 0);
    const syncAccount = await findSyncAccount(ctx.db, run.orgId, run.adAccountId);
    if (syncAccount !== null) await setLease(ctx, syncAccount, now + SYNC_LIMITS.taskLeaseMs, now);
    return;
  }
  await completeRun(ctx, run, now);
}

async function finishTask(
  ctx: Ctx,
  task: Doc<"syncTasks">,
  status: "succeeded" | "failed" | "skipped",
  now: number,
  error?: SyncError,
): Promise<void> {
  await ctx.db.patch(task._id, {
    status,
    ...(error !== undefined ? { lastError: error } : {}),
    leaseExpiresAt: undefined,
    nextAttemptAt: undefined,
    finishedAt: now,
    updatedAt: now,
  });
  await advanceRun(ctx, task.runId, now);
}

/** Ends the run as failed now (fatal task failure): open tasks are cancelled. */
async function failRun(
  ctx: Ctx,
  loaded: Loaded,
  error: SyncError,
  now: number,
  accountPatch?: Partial<Doc<"syncAccounts">>,
): Promise<void> {
  await ctx.db.patch(loaded.task._id, {
    status: "failed",
    lastError: error,
    leaseExpiresAt: undefined,
    nextAttemptAt: undefined,
    finishedAt: now,
    updatedAt: now,
  });
  await cancelOpenTasks(ctx, loaded.run, now);
  const run = (await ctx.db.get(loaded.run._id))!;
  await completeRun(ctx, run, now, {
    status: "failed",
    error,
    ...(accountPatch ? { accountPatch } : {}),
  });
}

// ---------------------------------------------------------------------------
// Failure handling
// ---------------------------------------------------------------------------

/** Provider `auth`: connection -> needs_reauth, this run fails, sibling runs are cancelled. */
async function handleAuthFailure(ctx: Ctx, loaded: Loaded, error: SyncError, now: number) {
  const { run } = loaded;
  await markConnectionNeedsReauth(
    ctx.db,
    run.connectionId,
    "provider_auth_error",
    SYSTEM_SYNC_SUBJECT,
  );
  await failRun(ctx, loaded, error, now, {
    nextPlanAt: now + SYNC_LIMITS.inactiveRecheckMs,
    consecutiveFailures: loaded.syncAccount.consecutiveFailures,
  });

  const siblings = await ctx.db
    .query("adAccounts")
    .withIndex("by_org_connection", (q) =>
      q.eq("orgId", run.orgId).eq("connectionId", run.connectionId),
    )
    .take(500);
  for (const sibling of siblings) {
    if (sibling._id === run.adAccountId) continue;
    const state = await findSyncAccount(ctx.db, run.orgId, sibling._id);
    if (state?.activeRunId === undefined) continue;
    const active = await ctx.db.get(state.activeRunId);
    if (active !== null && active.orgId === run.orgId) {
      await cancelRun(ctx, active, "connection_inactive", now);
    }
  }
}

/** permission / not_found / account drift: only THIS account is blocked (rechecked in 24 h). */
async function blockAccount(ctx: Ctx, loaded: Loaded, error: SyncError, now: number) {
  const previous = loaded.syncAccount.lastError?.kind;
  await failRun(ctx, loaded, error, now, {
    state: "blocked",
    lastError: error,
    nextPlanAt: now + SYNC_LIMITS.blockedRecheckMs,
    consecutiveFailures: loaded.syncAccount.consecutiveFailures,
  });
  if (previous !== error.kind) {
    await writeSyncAudit(
      ctx,
      loaded.run.orgId,
      AUDIT_ACTIONS.syncAccountBlocked,
      loaded.account._id,
      {
        reason: { from: null, to: error.kind },
      },
    );
  }
}

/** Applies the retry/error policy to a failed page of a RUNNING task. */
async function applyFailure(ctx: Ctx, loaded: Loaded, failure: SyncFailure, now: number) {
  const { task } = loaded;
  const decision = decideFailure(
    failure,
    {
      attempt: task.attempt,
      pageTransientFailures: task.pageTransientFailures,
      rateLimitHits: task.rateLimitHits,
      hasCursor: task.cursor !== undefined,
      restartedFromScratch: task.restartedFromScratch,
    },
    task._id,
  );
  const error = sanitizeFailure(failure, now);

  switch (decision.action) {
    case "retry": {
      const updated = {
        status: "queued" as const,
        attempt: task.attempt + 1,
        pageTransientFailures: task.pageTransientFailures + (decision.transient ? 1 : 0),
        rateLimitHits: task.rateLimitHits + (decision.throttle ? 1 : 0),
        nextAttemptAt: now + decision.delayMs,
        leaseExpiresAt: undefined,
        lastError: error,
        updatedAt: now,
      };
      await ctx.db.patch(task._id, updated);
      await ctx.scheduler.runAfter(decision.delayMs, internal.sync.worker.runTask, {
        taskId: task._id,
      });
      await ctx.db.patch(loaded.syncAccount._id, {
        ...(decision.throttle ? { throttledUntil: now + decision.delayMs } : {}),
        leaseExpiresAt: now + decision.delayMs + SYNC_LIMITS.taskLeaseMs,
        nextPlanAt: now + decision.delayMs + SYNC_LIMITS.taskLeaseMs,
        updatedAt: now,
      });
      return;
    }
    case "restart":
      await ctx.db.patch(task._id, {
        status: "queued",
        cursor: undefined,
        previousCursor: undefined,
        cursorSavedAt: undefined,
        fetchStartedAt: undefined,
        restartedFromScratch: true,
        emptyPagesInRow: 0,
        attempt: 1,
        pageTransientFailures: 0,
        leaseExpiresAt: undefined,
        lastError: error,
        updatedAt: now,
      });
      await ctx.scheduler.runAfter(0, internal.sync.worker.runTask, { taskId: task._id });
      await setLease(ctx, loaded.syncAccount, now + SYNC_LIMITS.taskLeaseMs, now);
      return;
    case "fail_task":
      // The preflight is fatal: without a verified account nothing else may run.
      if (task.operation === "getAccount") await failRun(ctx, loaded, error, now);
      else await finishTask(ctx, task, "failed", now, error);
      return;
    case "skip_task":
      await finishTask(ctx, task, "skipped", now, error);
      return;
    case "block_account":
      await blockAccount(ctx, loaded, error, now);
      return;
    case "reauth":
      await handleAuthFailure(ctx, loaded, error, now);
      return;
    case "cancel_run":
      await cancelRun(ctx, loaded.run, "connection_inactive", now);
      return;
  }
}

// ---------------------------------------------------------------------------
// Worker protocol: claim -> (provider call in the action) -> commit | failure
// ---------------------------------------------------------------------------

/**
 * Claims the next page of a task for ONE worker. Returns "skip" when the task
 * is not claimable (already running under a live lease, finished, not the
 * run's current task, or the run was cancelled). Each claim increments
 * claimSeq; commits carrying an older claimSeq are discarded.
 */
export const claimTask = internalMutation({
  args: { taskId: v.id("syncTasks") },
  returns: claimResultValidator,
  handler: async (ctx, { taskId }): Promise<ClaimResult> => {
    const now = Date.now();
    const loaded = await loadTask(ctx, taskId);
    if (loaded === null) return { status: "skip" };
    const { task, run, account, syncAccount } = loaded;
    if (!ACTIVE_RUN.has(run.status) || task.status !== "queued" || task.phase !== "fetch") {
      return { status: "skip" };
    }
    if (syncAccount.activeRunId !== run._id) {
      await cancelRun(ctx, run, "superseded", now);
      return { status: "skip" };
    }
    const tasks = await runTasks(ctx, run);
    const current = tasks.find((t) => !TERMINAL_TASK.has(t.status));
    if (current?._id !== task._id) return { status: "skip" };
    if ((task.nextAttemptAt ?? 0) > now) {
      await ctx.scheduler.runAfter(task.nextAttemptAt! - now, internal.sync.worker.runTask, {
        taskId,
      });
      return { status: "skip" };
    }

    const { problem, connection } = await linkageProblem(ctx, run, account);
    if (problem !== undefined) {
      await cancelRun(ctx, run, problem, now);
      return { status: "skip" };
    }
    if (connection!.tokenExpiresAt !== undefined && connection!.tokenExpiresAt < now) {
      await handleAuthFailure(ctx, loaded, sanitizeFailure({ kind: "auth" }, now), now);
      return { status: "skip" };
    }
    if (now - run.createdAt > SYNC_LIMITS.maxRunDurationMs) {
      await cancelRun(ctx, run, "timeout", now);
      return { status: "skip" };
    }

    // Platform cursors can expire: a checkpoint older than staleCursorMs restarts the task once.
    const staleCursor =
      task.cursor !== undefined &&
      !task.restartedFromScratch &&
      now - (task.cursorSavedAt ?? now) > SYNC_LIMITS.staleCursorMs;
    const claimSeq = task.claimSeq + 1;
    await ctx.db.patch(task._id, {
      status: "running",
      claimSeq,
      leaseExpiresAt: now + SYNC_LIMITS.taskLeaseMs,
      nextAttemptAt: undefined,
      startedAt: task.startedAt ?? now,
      fetchStartedAt: staleCursor ? now : (task.fetchStartedAt ?? now),
      totalAttempts: task.totalAttempts + 1,
      ...(staleCursor
        ? {
            cursor: undefined,
            previousCursor: undefined,
            cursorSavedAt: undefined,
            restartedFromScratch: true,
            emptyPagesInRow: 0,
          }
        : {}),
      updatedAt: now,
    });
    if (run.status === "queued") {
      await ctx.db.patch(run._id, { status: "running", startedAt: now, updatedAt: now });
    }
    await setLease(ctx, syncAccount, now + SYNC_LIMITS.taskLeaseMs, now);

    const cursor = staleCursor ? undefined : task.cursor;
    return {
      status: "fetch",
      claimSeq,
      orgId: run.orgId,
      connectionId: run.connectionId,
      platform: run.platform,
      attempt: task.attempt,
      request: {
        operation: task.operation,
        accountExternalId: account.externalId,
        ...(task.level !== undefined ? { level: task.level } : {}),
        ...(task.from !== undefined ? { from: task.from } : {}),
        ...(task.to !== undefined ? { to: task.to } : {}),
        ...(task.breakdown !== undefined ? { breakdown: task.breakdown } : {}),
        ...(task.updatedSince !== undefined ? { updatedSince: task.updatedSince } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      },
    };
  },
});

/** Loads a task for a worker callback; null when the claim is stale (discard silently). */
async function loadClaimed(ctx: Ctx, taskId: Id<"syncTasks">, claimSeq: number) {
  const loaded = await loadTask(ctx, taskId);
  if (loaded === null) return null;
  const { task, run } = loaded;
  if (
    task.claimSeq !== claimSeq ||
    task.status !== "running" ||
    task.phase !== "fetch" ||
    !ACTIVE_RUN.has(run.status) ||
    loaded.syncAccount.activeRunId !== run._id
  ) {
    return null;
  }
  return loaded;
}

function needsFinalize(task: Doc<"syncTasks">, counts: SyncCounts): boolean {
  if (isMetricOperation(task.operation)) return true;
  // Removal marking only after a COMPLETE, fully resolved full listing.
  return (
    task.fullListing &&
    removalTableFor(task.operation) !== undefined &&
    counts.unresolved + counts.rejected === 0
  );
}

/**
 * Commits one fetched page: guards, mapping and canonical writes, the cursor
 * checkpoint and the scheduling of the next step, all in ONE transaction.
 */
export const commitPage = internalMutation({
  args: {
    taskId: v.id("syncTasks"),
    claimSeq: v.number(),
    requestCursor: v.optional(v.string()),
    page: providerPageValidator,
  },
  returns: commitResultValidator,
  handler: async (ctx, { taskId, claimSeq, requestCursor, page }) => {
    const now = Date.now();
    const loaded = await loadClaimed(ctx, taskId, claimSeq);
    if (loaded === null) return { ok: false, reason: "stale_claim" };
    const { task, run, account } = loaded;
    // Duplicate or out-of-order delivery of a page: the checkpoint already moved.
    if ((task.cursor ?? null) !== (requestCursor ?? null))
      return { ok: false, reason: "stale_cursor" };

    const { problem } = await linkageProblem(ctx, run, account);
    if (problem !== undefined) {
      await cancelRun(ctx, run, problem, now);
      return { ok: false, reason: problem };
    }

    const caps = capabilitiesOf(account.platform);
    const guard =
      page.kind !== OPERATION_RECORD_KIND[task.operation]
        ? ("invalid_record" as const)
        : (checkPageShape({
            itemCount: page.items.length,
            nextCursor: page.nextCursor,
            requestCursor,
            previousCursor: task.previousCursor,
            pagesSoFar: task.pages,
            emptyPagesInRow: task.emptyPagesInRow,
            maxPageSize: caps.maxPageSize,
          }) ??
          checkRecordsInScope(page.kind, page.items, {
            operation: task.operation,
            platform: account.platform,
            accountExternalId: account.externalId,
            currency: account.currency,
            ...(task.level !== undefined ? { level: task.level } : {}),
            ...(task.from !== undefined ? { from: task.from } : {}),
            ...(task.to !== undefined ? { to: task.to } : {}),
            ...(task.breakdown !== undefined ? { breakdown: task.breakdown } : {}),
            capabilities: caps,
          }));
    if (guard !== undefined) {
      await applyFailure(ctx, loaded, { source: "guard", kind: guard }, now);
      return { ok: false, reason: guard };
    }

    let counts: SyncCounts;
    const scope = accountScopeFromDoc(account);
    switch (page.kind) {
      case "adAccount": {
        // Structure was validated against the real table validators (RECORD_VALIDATORS).
        const record = page.items[0] as ProviderAdAccount;
        const drift = accountDrift(account, record);
        if (drift !== undefined) {
          await writeSyncAudit(
            ctx,
            run.orgId,
            AUDIT_ACTIONS.syncAccountAttributesChanged,
            account._id,
            { attribute: { from: null, to: drift } },
          );
          await applyFailure(ctx, loaded, { source: "account", kind: "account_changed" }, now);
          return { ok: false, reason: "account_changed" };
        }
        const org = await ctx.db.get(run.orgId);
        if (org === null) throw new TenantInvariantError();
        counts = await refreshAdAccount(
          ctx.db,
          account,
          record,
          orgScopeFromOrganization(org),
          now,
        );
        break;
      }
      case "campaign":
      case "adGroup":
      case "creative":
      case "ad":
        counts = await writeEntityPage(ctx.db, page as EntityPage, scope, now);
        break;
      case "metricRow":
      case "actionRow":
        counts = await writeMetricPage(ctx.db, page as MetricPage, task.level!, scope, now);
        break;
    }
    counts.pages = 1;

    const taskCounts = addCounts(task.counts, counts);
    const checkpoint = {
      pages: task.pages + 1,
      records: task.records + page.items.length,
      emptyPagesInRow: page.items.length === 0 ? task.emptyPagesInRow + 1 : 0,
      attempt: 1,
      pageTransientFailures: 0,
      cursor: page.nextCursor,
      previousCursor: requestCursor,
      cursorSavedAt: now,
      counts: taskCounts,
      // A committed page clears the error of an earlier (retried) attempt.
      lastError: undefined,
      leaseExpiresAt: undefined,
      updatedAt: now,
    };
    await ctx.db.patch(run._id, { counts: addCounts(run.counts, counts), updatedAt: now });

    if (page.nextCursor !== undefined) {
      await ctx.db.patch(task._id, { ...checkpoint, status: "queued" });
      await ctx.scheduler.runAfter(0, internal.sync.worker.runTask, { taskId });
      await setLease(ctx, loaded.syncAccount, now + SYNC_LIMITS.taskLeaseMs, now);
      return { ok: true };
    }

    // Fetch complete.
    if (needsFinalize(task, taskCounts)) {
      await ctx.db.patch(task._id, { ...checkpoint, phase: "finalize", finalizeCursor: undefined });
      await ctx.scheduler.runAfter(0, internal.sync.runs.finalizeTask, { taskId, claimSeq });
      await setLease(ctx, loaded.syncAccount, now + SYNC_LIMITS.taskLeaseMs, now);
      return { ok: true };
    }
    await ctx.db.patch(task._id, checkpoint);
    await finishTask(ctx, { ...task, ...checkpoint }, "succeeded", now);
    return { ok: true };
  },
});

/** Records a failed page (provider error, unusable credential, internal error). */
export const recordFailure = internalMutation({
  args: { taskId: v.id("syncTasks"), claimSeq: v.number(), failure: failureValidator },
  returns: v.null(),
  handler: async (ctx, { taskId, claimSeq, failure }) => {
    const loaded = await loadClaimed(ctx, taskId, claimSeq);
    if (loaded === null) return null;
    await applyFailure(ctx, loaded, toSyncFailure(failure), Date.now());
    return null;
  },
});

/**
 * DB-only finalize step of a COMPLETED fetch: prune stale metric rows or mark
 * removed entities, one bounded batch per call. Never runs for failed tasks.
 */
export const finalizeTask = internalMutation({
  args: { taskId: v.id("syncTasks"), claimSeq: v.number() },
  returns: v.null(),
  handler: async (ctx, { taskId, claimSeq }) => {
    const now = Date.now();
    const loaded = await loadTask(ctx, taskId);
    if (loaded === null) return null;
    const { task, run, account, syncAccount } = loaded;
    if (
      task.claimSeq !== claimSeq ||
      task.status !== "running" ||
      task.phase !== "finalize" ||
      !ACTIVE_RUN.has(run.status) ||
      syncAccount.activeRunId !== run._id ||
      task.fetchStartedAt === undefined
    ) {
      return null;
    }
    const scope = accountScopeFromDoc(account);
    const continueWith = async (finalizeCursor: string, counts: Partial<SyncCounts>) => {
      await ctx.db.patch(task._id, {
        finalizeCursor,
        counts: addCounts(task.counts, counts),
        updatedAt: now,
      });
      await ctx.db.patch(run._id, { counts: addCounts(run.counts, counts), updatedAt: now });
      await ctx.scheduler.runAfter(0, internal.sync.runs.finalizeTask, { taskId, claimSeq });
      await setLease(ctx, syncAccount, now + SYNC_LIMITS.taskLeaseMs, now);
    };
    const done = async (counts: Partial<SyncCounts>, warning?: SyncError) => {
      const merged = addCounts(task.counts, counts);
      await ctx.db.patch(task._id, { counts: merged, finalizeCursor: undefined, updatedAt: now });
      await ctx.db.patch(run._id, { counts: addCounts(run.counts, counts), updatedAt: now });
      await finishTask(ctx, { ...task, counts: merged }, "succeeded", now, warning);
    };

    if (isMetricOperation(task.operation)) {
      const result = await pruneMetricsBatch(ctx.db, {
        table: task.operation === "fetchDailyMetrics" ? "metricsDaily" : "actionMetricsDaily",
        scope,
        level: task.level!,
        placements: prunePlacements(task.breakdown ?? "none"),
        from: task.from!,
        to: task.to!,
        before: task.fetchStartedAt,
        cursor: task.finalizeCursor ? (JSON.parse(task.finalizeCursor) as PruneCursor) : undefined,
        limit: SYNC_LIMITS.finalizeBatch,
      });
      if (result.next !== undefined) {
        await continueWith(JSON.stringify(result.next), { pruned: result.pruned });
      } else {
        await done({ pruned: result.pruned });
      }
      return null;
    }

    const table = removalTableFor(task.operation);
    if (table === undefined) {
      await done({});
      return null;
    }
    const result = await markRemovedBatch(ctx.db, {
      table,
      scope,
      before: task.fetchStartedAt,
      now,
      cursor: task.finalizeCursor ? (JSON.parse(task.finalizeCursor) as RemovalCursor) : undefined,
      limit: SYNC_LIMITS.finalizeBatch,
      maxShare: SYNC_LIMITS.massRemovalMaxShare,
      minCount: SYNC_LIMITS.massRemovalMinCount,
    });
    if (result.status === "continue") {
      await continueWith(JSON.stringify(result.next), { removed: result.removed });
    } else if (result.status === "done") {
      await done({ removed: result.removed });
    } else {
      await writeSyncAudit(ctx, run.orgId, AUDIT_ACTIONS.syncRemovalSkipped, account._id, {
        table: { from: null, to: table },
        candidates: { from: result.alive, to: result.candidates },
      });
      await done({}, sanitizeFailure({ kind: "suspicious_empty_listing" }, now));
    }
    return null;
  },
});

// ---------------------------------------------------------------------------
// Recovery (planner)
// ---------------------------------------------------------------------------

/**
 * Recovers a run whose lease expired (a worker action died or a scheduled
 * step was lost): the current task is re-claimable under a NEW claimSeq, so
 * a late commit from the old worker is discarded. Repeated stalls fail the task.
 */
export async function recoverStalledRun(ctx: Ctx, run: Doc<"syncRuns">, now: number) {
  const tasks = await runTasks(ctx, run);
  const current = tasks.find((t) => !TERMINAL_TASK.has(t.status));
  if (current === undefined) {
    await completeRun(ctx, run, now);
    return;
  }
  const loaded = await loadTask(ctx, current._id);
  if (loaded === null) return;
  if (current.staleRecoveries + 1 > SYNC_LIMITS.maxStaleRecoveries) {
    const error = sanitizeFailure({ kind: "stale_lease" }, now);
    if (current.operation === "getAccount") await failRun(ctx, loaded, error, now);
    else await finishTask(ctx, current, "failed", now, error);
    return;
  }
  const claimSeq = current.claimSeq + 1;
  const status = current.phase === "finalize" ? ("running" as const) : ("queued" as const);
  await ctx.db.patch(current._id, {
    status,
    claimSeq,
    staleRecoveries: current.staleRecoveries + 1,
    attempt: current.phase === "fetch" ? current.attempt + 1 : current.attempt,
    leaseExpiresAt: undefined,
    nextAttemptAt: undefined,
    updatedAt: now,
  });
  await scheduleTask(ctx, { ...current, status, claimSeq }, 0);
  await setLease(ctx, loaded.syncAccount, now + SYNC_LIMITS.taskLeaseMs, now);
}
