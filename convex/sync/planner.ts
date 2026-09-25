import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type MutationCtx } from "../_generated/server";
import { providerRegistry } from "../connections/config";
import { SYNC_CADENCE, SYNC_LIMITS } from "./config";
import { buildRunPlan, dueKind, nextDueAt } from "./plan";
import { isBlockingError, retainBlockingError, sanitizeFailure } from "./policy";
import { cancelRun, createRun, recoverStalledRun } from "./runs";

/**
 * Cron planner (every 15 min, convex/crons.ts). Reads due accounts through the
 * ONE approved global index `syncAccounts.by_next_plan`, re-verifies tenant
 * ownership of every row it returns, and for each account either starts a
 * bounded run, recovers a stalled one, or moves `nextPlanAt` forward.
 *
 * Invariant: every processed row leaves with nextPlanAt > now or absent, so a
 * continuation never sees the same row twice.
 */

type Outcome = "started" | "waiting" | "recovered" | "parked" | "deferred";

async function park(ctx: MutationCtx, row: Doc<"syncAccounts">, now: number) {
  await ctx.db.patch(row._id, { state: "parked", nextPlanAt: undefined, updatedAt: now });
}

async function defer(
  ctx: MutationCtx,
  row: Doc<"syncAccounts">,
  until: number,
  now: number,
  extra: Partial<Doc<"syncAccounts">> = {},
) {
  await ctx.db.patch(row._id, { nextPlanAt: Math.max(until, now + 1), updatedAt: now, ...extra });
}

async function planAccount(
  ctx: MutationCtx,
  row: Doc<"syncAccounts">,
  now: number,
): Promise<Outcome> {
  // Tenant re-verification: the global index row must point at an account of the SAME org.
  const account = await ctx.db.get(row.adAccountId);
  if (account === null || account.orgId !== row.orgId) {
    await park(ctx, row, now);
    return "parked";
  }

  if (row.activeRunId !== undefined) {
    const run = await ctx.db.get(row.activeRunId);
    const active =
      run !== null &&
      run.orgId === row.orgId &&
      run.adAccountId === row.adAccountId &&
      (run.status === "queued" || run.status === "running");
    if (active) {
      if (now - run.createdAt > SYNC_LIMITS.maxRunDurationMs) {
        await cancelRun(ctx, run, "timeout", now);
        return "deferred";
      }
      if ((row.leaseExpiresAt ?? 0) < now) {
        await recoverStalledRun(ctx, run, now);
        const after = await ctx.db.get(row._id);
        if (after !== null && (after.nextPlanAt ?? Infinity) <= now) {
          await defer(ctx, after, now + SYNC_LIMITS.taskLeaseMs, now);
        }
        return "recovered";
      }
      await defer(ctx, row, row.leaseExpiresAt!, now);
      return "waiting";
    }
    // Stale pointer (run finished or deleted without releasing the lease).
    await ctx.db.patch(row._id, { activeRunId: undefined, leaseExpiresAt: undefined });
    row = { ...row, activeRunId: undefined, leaseExpiresAt: undefined };
  }

  if (account.connectionId === undefined) {
    await park(ctx, row, now);
    return "parked";
  }
  const connection = await ctx.db.get(account.connectionId);
  if (connection === null || connection.orgId !== row.orgId || connection.status !== "active") {
    // A recheck is an observation, not a new event: it never overwrites a blocking
    // reason, and repeated rechecks keep the original connection_inactive timestamp.
    const lastError =
      row.lastError?.kind === "connection_inactive"
        ? row.lastError
        : retainBlockingError(row.lastError, sanitizeFailure({ kind: "connection_inactive" }, now));
    await defer(ctx, row, now + SYNC_LIMITS.inactiveRecheckMs, now, {
      state: row.state === "blocked" || isBlockingError(lastError) ? "blocked" : "idle",
      lastError,
    });
    return "deferred";
  }
  if (row.throttledUntil !== undefined && row.throttledUntil > now) {
    await defer(ctx, row, row.throttledUntil, now);
    return "deferred";
  }

  const kind = dueKind(row, now);
  const registry = providerRegistry();
  if (kind === undefined || !registry.hasAds(account.platform)) {
    await defer(
      ctx,
      row,
      kind === undefined ? nextDueAt(row, now) : now + SYNC_LIMITS.inactiveRecheckMs,
      now,
    );
    return "deferred";
  }

  const plan = buildRunPlan({
    kind,
    state: row,
    capabilities: registry.ads(account.platform).capabilities,
    timezone: account.timezone,
    now,
  });
  const { created } = await createRun(ctx, {
    syncAccount: row,
    account,
    connection,
    plan,
    trigger: kind === "initial" ? "link" : "schedule",
    now,
  });
  if (!created) {
    // Same kind/window already ran in this planner slot: try again next slot.
    await defer(ctx, row, now + SYNC_CADENCE.plannerIntervalMinutes * 60_000, now);
    return "deferred";
  }
  return "started";
}

export const tick = internalMutation({
  args: { continuation: v.optional(v.number()), started: v.optional(v.number()) },
  returns: v.object({ processed: v.number(), started: v.number() }),
  handler: async (ctx, args) => {
    const now = Date.now();
    let started = args.started ?? 0;
    let processed = 0;
    // gte(0): parked rows have no nextPlanAt, and undefined sorts first in Convex indexes.
    const due = await ctx.db
      .query("syncAccounts")
      .withIndex("by_next_plan", (q) => q.gte("nextPlanAt", 0).lte("nextPlanAt", now))
      .take(SYNC_LIMITS.plannerBatch);

    let capped = false;
    for (const row of due) {
      if (started >= SYNC_LIMITS.maxRunsStartedPerTick) {
        capped = true;
        break;
      }
      const outcome = await planAccount(ctx, row, now);
      processed++;
      if (outcome === "started") started++;
    }

    const continuation = args.continuation ?? 0;
    if (
      !capped &&
      due.length === SYNC_LIMITS.plannerBatch &&
      continuation < SYNC_LIMITS.maxPlannerContinuations
    ) {
      await ctx.scheduler.runAfter(0, internal.sync.planner.tick, {
        continuation: continuation + 1,
        started,
      });
    }
    return { processed, started };
  },
});
