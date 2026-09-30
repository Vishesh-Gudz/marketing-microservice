import { v } from "convex/values";
import { internalMutation, internalQuery } from "../_generated/server";
import { providerRegistry } from "../connections/config";
import { dateKeyValidator } from "../domain/validators";
import { syncCountsValidator, syncErrorValidator } from "../tables/sync";
import { buildRunPlan, validateManualWindow, type SyncRunKind } from "./plan";
import { createRun } from "./runs";
import { ensureSyncAccount, findSyncAccount } from "./state";

/**
 * INTERNAL operator/dev functions (`npx convex run sync/admin:<fn>`). Not part
 * of the public v1 contract; Phase 5 exposes no public sync functions.
 * Status views omit cursors, leases and claim sequence numbers.
 */

const requestResult = v.union(
  v.object({ status: v.literal("started"), runId: v.id("syncRuns") }),
  v.object({ status: v.literal("busy"), runId: v.id("syncRuns") }),
  v.object({ status: v.literal("rejected"), reason: v.string() }),
);

/** Starts a sync of one linked account now (default: incremental). */
export const requestSync = internalMutation({
  args: {
    adAccountId: v.id("adAccounts"),
    kind: v.optional(v.union(v.literal("incremental"), v.literal("lookback"), v.literal("manual"))),
    from: v.optional(dateKeyValidator),
    to: v.optional(dateKeyValidator),
  },
  returns: requestResult,
  handler: async (ctx, args) => {
    const now = Date.now();
    const account = await ctx.db.get(args.adAccountId);
    if (account === null) return { status: "rejected" as const, reason: "account_not_found" };
    if (account.connectionId === undefined) {
      return { status: "rejected" as const, reason: "account_unlinked" };
    }
    const connection = await ctx.db.get(account.connectionId);
    if (
      connection === null ||
      connection.orgId !== account.orgId ||
      connection.status !== "active"
    ) {
      return { status: "rejected" as const, reason: "connection_inactive" };
    }
    await ensureSyncAccount(ctx.db, account, { relinked: false }, now);
    const syncAccount = (await findSyncAccount(ctx.db, account.orgId, account._id))!;
    if (syncAccount.activeRunId !== undefined) {
      const active = await ctx.db.get(syncAccount.activeRunId);
      if (active !== null && (active.status === "queued" || active.status === "running")) {
        return { status: "busy" as const, runId: active._id };
      }
    }

    const kind: SyncRunKind =
      args.kind ?? (syncAccount.initialDoneAt === undefined ? "initial" : "incremental");
    let manualWindow: { from: string; to: string } | undefined;
    if (kind === "manual") {
      if (args.from === undefined || args.to === undefined) {
        return { status: "rejected" as const, reason: "manual_window_required" };
      }
      manualWindow = { from: args.from, to: args.to };
      let invalid: string | undefined;
      try {
        invalid = validateManualWindow(manualWindow, account.timezone, now);
      } catch {
        invalid = "invalid_window";
      }
      if (invalid !== undefined) return { status: "rejected" as const, reason: invalid };
    }

    const plan = buildRunPlan({
      kind,
      state: syncAccount,
      capabilities: providerRegistry().ads(account.platform).capabilities,
      timezone: account.timezone,
      now,
      ...(manualWindow ? { manualWindow } : {}),
    });
    const { runId, created } = await createRun(ctx, {
      syncAccount,
      account,
      connection,
      plan,
      trigger: "manual",
      now,
    });
    return created ? { status: "started" as const, runId } : { status: "busy" as const, runId };
  },
});

const taskSummary = v.object({
  seq: v.number(),
  operation: v.string(),
  level: v.optional(v.string()),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  breakdown: v.optional(v.string()),
  phase: v.string(),
  status: v.string(),
  pages: v.number(),
  records: v.number(),
  attempt: v.number(),
  rateLimitHits: v.number(),
  counts: syncCountsValidator,
  lastError: v.optional(syncErrorValidator),
});

/** Run status with task summaries (no cursors, leases or claim sequence numbers). */
export const runStatus = internalQuery({
  args: { runId: v.id("syncRuns") },
  returns: v.union(
    v.null(),
    v.object({
      kind: v.string(),
      status: v.string(),
      trigger: v.string(),
      window: v.optional(v.object({ from: v.string(), to: v.string() })),
      structureMode: v.string(),
      counts: syncCountsValidator,
      error: v.optional(syncErrorValidator),
      cancelReason: v.optional(v.string()),
      tasks: v.array(taskSummary),
    }),
  ),
  handler: async (ctx, { runId }) => {
    const run = await ctx.db.get(runId);
    if (run === null) return null;
    const tasks = await ctx.db
      .query("syncTasks")
      .withIndex("by_org_run_seq", (q) => q.eq("orgId", run.orgId).eq("runId", run._id))
      .take(100);
    return {
      kind: run.kind,
      status: run.status,
      trigger: run.trigger,
      ...(run.window ? { window: run.window } : {}),
      structureMode: run.structureMode,
      counts: run.counts,
      ...(run.error ? { error: run.error } : {}),
      ...(run.cancelReason ? { cancelReason: run.cancelReason } : {}),
      tasks: tasks.map((t) => ({
        seq: t.seq,
        operation: t.operation,
        ...(t.level !== undefined ? { level: t.level } : {}),
        ...(t.from !== undefined ? { from: t.from } : {}),
        ...(t.to !== undefined ? { to: t.to } : {}),
        ...(t.breakdown !== undefined ? { breakdown: t.breakdown } : {}),
        phase: t.phase,
        status: t.status,
        pages: t.pages,
        records: t.records,
        attempt: t.attempt,
        rateLimitHits: t.rateLimitHits,
        counts: t.counts,
        ...(t.lastError ? { lastError: t.lastError } : {}),
      })),
    };
  },
});

/** Sync state of one account (schedule, coverage, last error). */
export const accountState = internalQuery({
  args: { adAccountId: v.id("adAccounts") },
  returns: v.union(
    v.null(),
    v.object({
      state: v.string(),
      activeRunId: v.optional(v.id("syncRuns")),
      lastRunId: v.optional(v.id("syncRuns")),
      nextPlanAt: v.optional(v.number()),
      coveredFrom: v.optional(v.string()),
      coveredThrough: v.optional(v.string()),
      backfillHorizon: v.string(),
      structureStale: v.boolean(),
      consecutiveFailures: v.number(),
      lastSuccessAt: v.optional(v.number()),
      lastError: v.optional(syncErrorValidator),
    }),
  ),
  handler: async (ctx, { adAccountId }) => {
    const account = await ctx.db.get(adAccountId);
    if (account === null) return null;
    const row = await findSyncAccount(ctx.db, account.orgId, account._id);
    if (row === null) return null;
    return {
      state: row.state,
      ...(row.activeRunId !== undefined ? { activeRunId: row.activeRunId } : {}),
      ...(row.lastRunId !== undefined ? { lastRunId: row.lastRunId } : {}),
      ...(row.nextPlanAt !== undefined ? { nextPlanAt: row.nextPlanAt } : {}),
      ...(row.coveredFrom !== undefined ? { coveredFrom: row.coveredFrom } : {}),
      ...(row.coveredThrough !== undefined ? { coveredThrough: row.coveredThrough } : {}),
      backfillHorizon: row.backfillHorizon,
      structureStale: row.structureStale,
      consecutiveFailures: row.consecutiveFailures,
      ...(row.lastSuccessAt !== undefined ? { lastSuccessAt: row.lastSuccessAt } : {}),
      ...(row.lastError ? { lastError: row.lastError } : {}),
    };
  },
});
