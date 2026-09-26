import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { RATE_LIMIT_RETRY_AFTER_MS } from "../providers/mock";
import {
  connectMock,
  drainScheduler,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";
import { SYNC_CADENCE, SYNC_LIMITS } from "./config";
import { failureBackoffMs } from "./plan";
import { rateLimitDelayMs } from "./policy";

// Phase 8 D34: the two narrow Phase 5 compatibility corrections, pinned end to end.
//  (a) rateLimitHits is a PER-PAGE budget: it resets at the page commit (checkpoint), so a
//      long task throttled on many pages still completes; 10 throttles on ONE page still fail.
//  (c) a backfill that ends partial without completing any window backs off like a failed run
//      instead of re-planning the same window at every planner tick.

vi.setConfig({ testTimeout: 180_000 });
const NOW = new Date("2026-04-10T15:00:00Z");
const MINUTE = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function snapshot(t: Backend) {
  return await t.run(async (ctx) => ({
    runs: await ctx.db.query("syncRuns").collect(),
    tasks: await ctx.db.query("syncTasks").collect(),
    states: await ctx.db.query("syncAccounts").collect(),
    campaigns: await ctx.db.query("campaigns").collect(),
  }));
}

async function task(t: Backend, id: Id<"syncTasks">) {
  return (await t.run((ctx) => ctx.db.get(id)))!;
}

describe("D34(a): the rate-limit budget resets at the page checkpoint", () => {
  it("a task throttled on every page (>= 11 pages) completes with bounded delays", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "meta", "1");
    const [account] = await linkMock(t, connectionId, ["1001"]);
    await planAndDrain(t);
    // Reconnect the same identity with the scenario credential (see scenarios.test.ts), then
    // sync one full month: the ad-level placement task needs well over 10 pages.
    expect(await connectMock(t, "meta", "1--rate_limited")).toBe(connectionId);
    vi.advanceTimersByTime(20 * MINUTE);
    const requestedAt = Date.now();
    const result = await t.mutation(internal.sync.admin.requestSync, {
      adAccountId: account!.id as Id<"adAccounts">,
      kind: "manual",
      from: "2026-01-01",
      to: "2026-01-31",
    });
    expect(result.status).toBe("started");
    await drainScheduler(t);

    const db = await snapshot(t);
    const run = db.runs.find((r) => r.kind === "manual")!;
    expect(run.status).toBe("succeeded");
    const tasks = db.tasks.filter((x) => x.runId === run._id);
    const longest = Math.max(...tasks.map((x) => x.pages));
    // Before D34(a) a task with >= 11 pages hit maxRateLimitHits and failed.
    expect(longest).toBeGreaterThanOrEqual(SYNC_LIMITS.maxRateLimitHits + 1);
    for (const x of tasks) {
      expect(x.status, x.operation).toBe("succeeded");
      expect(x.rateLimitHits, x.operation).toBe(0);
      // Every page after the first is throttled exactly once, then retried.
      expect(x.totalAttempts, x.operation).toBe(2 * x.pages - 1);
    }
    // Each throttled page waits about the BASE delay (hits = 1), never the exponential tail
    // (before D34(a) the 10th throttled page alone waited >= 30 s * 2^8 = 2 h 8 min).
    const throttledPages = tasks.reduce((sum, x) => sum + x.pages - 1, 0);
    const maxWait = Math.ceil(rateLimitDelayMs(1, RATE_LIMIT_RETRY_AFTER_MS, "bound") * 1.2) + 1;
    expect(run.finishedAt! - requestedAt).toBeLessThanOrEqual(throttledPages * maxWait);
  });

  it("10 consecutive throttles on ONE page still fail the task; a commit restarts the budget", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "google_ads", "1");
    await linkMock(t, connectionId, ["4445556666"]);
    await t.mutation(internal.sync.planner.tick, {});
    const byOperation = async (operation: string) =>
      await t.run(
        async (ctx) =>
          (await ctx.db
            .query("syncTasks")
            .filter((q) => q.eq(q.field("operation"), operation))
            .first())!,
      );
    await t.action(internal.sync.worker.runTask, { taskId: (await byOperation("getAccount"))._id });
    const campaigns = await byOperation("listCampaigns");

    async function claimAt(taskId: Id<"syncTasks">) {
      const pending = await task(t, taskId);
      if (pending.nextAttemptAt !== undefined && pending.nextAttemptAt > Date.now()) {
        vi.setSystemTime(pending.nextAttemptAt);
      }
      const c = await t.mutation(internal.sync.runs.claimTask, { taskId });
      if (c.status !== "fetch") throw new Error("expected claim");
      return c;
    }
    async function throttle(taskId: Id<"syncTasks">) {
      const c = await claimAt(taskId);
      await t.mutation(internal.sync.runs.recordFailure, {
        taskId,
        claimSeq: c.claimSeq,
        failure: { source: "provider", kind: "rate_limited", retryAfterMs: 1_000 },
      });
      return await task(t, taskId);
    }

    // Page 1 of the campaign listing: 5 throttles, then the page commits (with a continuation cursor).
    for (let i = 0; i < 5; i++) await throttle(campaigns._id);
    expect((await task(t, campaigns._id)).rateLimitHits).toBe(5);
    const c = await claimAt(campaigns._id);
    expect(
      await t.mutation(internal.sync.runs.commitPage, {
        taskId: campaigns._id,
        claimSeq: c.claimSeq,
        page: { kind: "campaign", items: [], nextCursor: "page-2" },
      }),
    ).toEqual({ ok: true });
    expect(await task(t, campaigns._id)).toMatchObject({
      status: "queued",
      rateLimitHits: 0,
      attempt: 1,
      pageTransientFailures: 0,
    });

    // Page 2: the backoff restarts from the base delay, not from hit #6.
    const before = Date.now();
    const afterFirst = await throttle(campaigns._id);
    expect(afterFirst.rateLimitHits).toBe(1);
    expect(afterFirst.nextAttemptAt! - before).toBeLessThanOrEqual(
      SYNC_LIMITS.rateLimitBaseDelayMs * 1.2 + 1,
    );
    // ...and the per-page limit still applies: 10 consecutive throttles fail the task.
    for (let i = 1; i < SYNC_LIMITS.maxRateLimitHits; i++) await throttle(campaigns._id);
    expect(await task(t, campaigns._id)).toMatchObject({
      status: "failed",
      rateLimitHits: SYNC_LIMITS.maxRateLimitHits - 1,
      lastError: { kind: "rate_limited" },
    });
  });
});

describe("D34(c): a stalled partial backfill backs off", () => {
  /** Initial sync of Google 1112223333, then the synced structure disappears locally. */
  async function stalledBackfillSetup(t: Backend) {
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "google_ads", "1");
    await linkMock(t, connectionId, ["1112223333"]);
    await planAndDrain(t);
    const initial = await snapshot(t);
    expect(initial.runs[0]).toMatchObject({ kind: "initial", status: "succeeded" });
    expect(initial.states[0]!.consecutiveFailures).toBe(0);
    // Test-only: remove the entities so backfill metric rows cannot resolve (backfills
    // list no structure), i.e. the run ends partial without completing its window.
    await t.run(async (ctx) => {
      for (const table of ["ads", "adGroups", "campaigns"] as const) {
        for (const row of await ctx.db.query(table).collect()) await ctx.db.delete(row._id);
      }
    });
    return initial.states[0]!;
  }

  it("consecutive stalled backfills back off 15, 30, 60 minutes; a successful run resets", async () => {
    const t = newBackend();
    const initialState = await stalledBackfillSetup(t);

    let previousPlanAt = Date.now();
    for (const failures of [1, 2, 3]) {
      vi.setSystemTime(previousPlanAt);
      await planAndDrain(t);
      const db = await snapshot(t);
      const backfills = db.runs
        .filter((r) => r.kind === "backfill")
        .sort((a, b) => a._creationTime - b._creationTime);
      expect(backfills, `stall #${failures}`).toHaveLength(failures);
      const run = backfills[failures - 1]!;
      expect(run.status).toBe("partial");
      const state = db.states[0]!;
      const nextPlanAt = state.nextPlanAt!;
      expect(state.consecutiveFailures).toBe(failures);
      // 15 min, 30 min, 60 min (failureBackoffMs doubles, capped at 6 h).
      expect(nextPlanAt - run.finishedAt!).toBeGreaterThanOrEqual(
        15 * MINUTE * 2 ** (failures - 1),
      );
      expect(nextPlanAt).toBeGreaterThanOrEqual(run.finishedAt! + failureBackoffMs(failures));
      // Coverage did not move and the account is not blocked.
      expect(state.coveredFrom).toBe(initialState.coveredFrom);
      expect(state.state).toBe("idle");

      // A planner tick before the backoff elapses plans nothing.
      vi.setSystemTime(nextPlanAt - 1);
      await planAndDrain(t);
      expect((await snapshot(t)).runs).toHaveLength(1 + failures);
      previousPlanAt = nextPlanAt;
    }
    expect(failureBackoffMs(10)).toBe(SYNC_LIMITS.maxFailureBackoffMs);

    // The due incremental (structure stale: full listing) restores the entities and succeeds.
    vi.setSystemTime(Math.max(previousPlanAt, initialState.nextIncrementalAt ?? 0));
    await planAndDrain(t);
    const db = await snapshot(t);
    const latest = db.runs.sort((a, b) => b._creationTime - a._creationTime)[0]!;
    expect(latest.kind).not.toBe("backfill");
    expect(latest.status).toBe("succeeded");
    expect(db.states[0]!.consecutiveFailures).toBe(0);
    expect(db.campaigns.length).toBeGreaterThan(0);
  });

  it("unchanged: a partial backfill that DID merge its window continues immediately", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "google_ads", "1");
    await linkMock(t, connectionId, ["1112223333"]);
    await planAndDrain(t);
    const coveredFrom = (await snapshot(t)).states[0]!.coveredFrom!;

    // Plan the backfill, then mark the RUN partial (test-only: one rejected record at run
    // level) while every task of its window still succeeds cleanly and merges the window.
    await t.mutation(internal.sync.planner.tick, {});
    await t.run(async (ctx) => {
      const run = (await ctx.db
        .query("syncRuns")
        .filter((q) => q.eq(q.field("kind"), "backfill"))
        .first())!;
      await ctx.db.patch(run._id, { counts: { ...run.counts, rejected: 1 } });
    });
    await drainScheduler(t);

    const db = await snapshot(t);
    const backfill = db.runs.find((r) => r.kind === "backfill")!;
    expect(backfill.status).toBe("partial");
    const state = db.states[0]!;
    // The window was merged: coverage moved back, no failure streak, next backfill due now.
    expect(state.coveredFrom! < coveredFrom).toBe(true);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.nextPlanAt).toBeLessThanOrEqual(backfill.finishedAt!);
  });

  it("unchanged: an INITIAL partial run does not back off (not a backfill)", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "meta", "1");
    await linkMock(t, connectionId, ["1001"]);
    expect(await connectMock(t, "meta", "1--malformed")).toBe(connectionId);
    await planAndDrain(t);
    const db = await snapshot(t);
    const run = db.runs[0]!;
    expect(run).toMatchObject({ kind: "initial", status: "partial" });
    // No failure streak: the next plan is the regular cadence, not a failure backoff.
    expect(db.states[0]!.consecutiveFailures).toBe(0);
    expect(db.states[0]!.nextPlanAt! - run.finishedAt!).toBeLessThanOrEqual(
      SYNC_CADENCE.incrementalIntervalMs,
    );
  });
});
