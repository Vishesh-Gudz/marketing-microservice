import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { createMockAdsProvider, mockCredential } from "../providers/mock";
import {
  connectMock,
  drainScheduler,
  linkMock,
  newBackend,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";
import { SYNC_LIMITS } from "./config";

// The worker protocol step by step: claim -> provider call -> commit/failure.
// Tests drive individual steps instead of draining the scheduler.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-04-10T15:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Connects + links Google 4445556666 and runs ONE planner tick (nothing executed yet). */
async function startRun(t: Backend) {
  await setupSyncOrg(t);
  const connectionId = await connectMock(t, "google_ads");
  const [account] = await linkMock(t, connectionId, ["4445556666"]);
  await t.mutation(internal.sync.planner.tick, {});
  const run = await t.run(async (ctx) => (await ctx.db.query("syncRuns").first())!);
  return { run, adAccountId: account!.id as Id<"adAccounts"> };
}

async function tasksOf(t: Backend, runId: Id<"syncRuns">) {
  return await t.run((ctx) =>
    ctx.db
      .query("syncTasks")
      .filter((q) => q.eq(q.field("runId"), runId))
      .collect(),
  );
}

async function task(t: Backend, id: Id<"syncTasks">) {
  return (await t.run((ctx) => ctx.db.get(id)))!;
}

async function current(t: Backend, runId: Id<"syncRuns">) {
  const tasks = await tasksOf(t, runId);
  return tasks
    .sort((a, b) => a.seq - b.seq)
    .find((x) => !["succeeded", "failed", "skipped", "cancelled"].includes(x.status))!;
}

const claim = (t: Backend, taskId: Id<"syncTasks">) =>
  t.mutation(internal.sync.runs.claimTask, { taskId });

const step = (t: Backend, taskId: Id<"syncTasks">) =>
  t.action(internal.sync.worker.runTask, { taskId });

/** Test-only: jump the run to its first task of `operation` (earlier tasks marked done). */
async function skipTo(t: Backend, runId: Id<"syncRuns">, operation: Doc<"syncTasks">["operation"]) {
  const tasks = (await tasksOf(t, runId)).sort((a, b) => a.seq - b.seq);
  const target = tasks.find((x) => x.operation === operation)!;
  await t.run(async (ctx) => {
    for (const x of tasks) {
      if (x.seq < target.seq) await ctx.db.patch(x._id, { status: "succeeded" });
    }
  });
  return target;
}

describe("claims and leases", () => {
  it("only one worker can claim a task", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const first = await current(t, run._id);
    expect((await claim(t, first._id)).status).toBe("fetch");
    expect((await claim(t, first._id)).status).toBe("skip");
  });

  it("only the run's current task is claimable (strict order)", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const later = (await tasksOf(t, run._id)).find((x) => x.seq === 3)!;
    expect((await claim(t, later._id)).status).toBe("skip");
  });

  it("discards a stale worker's commit after lease recovery", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const first = await current(t, run._id);
    const stale = await claim(t, first._id);
    if (stale.status !== "fetch") throw new Error("expected claim");

    // The worker "dies": lease expires, the planner recovers the task.
    vi.advanceTimersByTime(SYNC_LIMITS.taskLeaseMs + 1_000);
    await t.mutation(internal.sync.planner.tick, {});
    expect((await task(t, first._id)).claimSeq).toBe(stale.claimSeq + 1);
    expect((await task(t, first._id)).staleRecoveries).toBe(1);

    // The dead worker's late commit is ignored.
    const provider = createMockAdsProvider({ platform: "google_ads" });
    const record = await provider.getAccount(
      { credential: mockCredential(), attempt: 1 },
      { accountExternalId: "4445556666" },
    );
    const late = await t.mutation(internal.sync.runs.commitPage, {
      taskId: first._id,
      claimSeq: stale.claimSeq,
      page: { kind: "adAccount", items: [record] },
    });
    expect(late).toEqual({ ok: false, reason: "stale_claim" });

    await drainScheduler(t);
    const done = await t.run((ctx) => ctx.db.get(run._id));
    expect(done!.status).toBe("succeeded");
  });

  it("fails a task that stalls repeatedly", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const first = await current(t, run._id);
    for (let i = 0; i <= SYNC_LIMITS.maxStaleRecoveries; i++) {
      await claim(t, first._id);
      vi.advanceTimersByTime(SYNC_LIMITS.taskLeaseMs + 1_000);
      await t.mutation(internal.sync.planner.tick, {});
    }
    // The preflight is fatal: the run fails.
    expect(await task(t, first._id)).toMatchObject({
      status: "failed",
      lastError: { kind: "stale_lease" },
    });
    expect((await t.run((ctx) => ctx.db.get(run._id)))!.status).toBe("failed");
  });

  it("cancels runs that exceed the maximum duration", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    vi.advanceTimersByTime(SYNC_LIMITS.maxRunDurationMs + 60_000);
    await t.mutation(internal.sync.planner.tick, {});
    expect(await t.run((ctx) => ctx.db.get(run._id))).toMatchObject({
      status: "cancelled",
      cancelReason: "timeout",
    });
  });
});

describe("checkpoints and pagination guards", () => {
  it("commits the checkpoint with the page; a duplicate or out-of-order commit is discarded", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const first = await current(t, run._id);
    await step(t, first._id); // getAccount page committed
    const campaigns = await current(t, run._id);
    expect(campaigns.operation).toBe("listCampaigns");
    const c = await claim(t, campaigns._id);
    if (c.status !== "fetch") throw new Error("expected claim");

    const empty = { kind: "campaign" as const, items: [], nextCursor: "cursor-1" };
    expect(
      await t.mutation(internal.sync.runs.commitPage, {
        taskId: campaigns._id,
        claimSeq: c.claimSeq,
        requestCursor: "wrong",
        page: empty,
      }),
    ).toEqual({ ok: false, reason: "stale_cursor" });

    // An empty page WITH a cursor is valid: checkpoint advances.
    expect(
      await t.mutation(internal.sync.runs.commitPage, {
        taskId: campaigns._id,
        claimSeq: c.claimSeq,
        page: empty,
      }),
    ).toEqual({ ok: true });
    expect(await task(t, campaigns._id)).toMatchObject({
      status: "queued",
      cursor: "cursor-1",
      pages: 1,
      emptyPagesInRow: 1,
    });
    // The same page delivered twice is a no-op.
    expect(
      await t.mutation(internal.sync.runs.commitPage, {
        taskId: campaigns._id,
        claimSeq: c.claimSeq,
        page: empty,
      }),
    ).toEqual({ ok: false, reason: "stale_claim" });
  });

  it("fails a task whose cursor does not advance (loop) without retrying", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    await step(t, (await current(t, run._id))._id);
    const campaigns = await current(t, run._id);
    let c = await claim(t, campaigns._id);
    if (c.status !== "fetch") throw new Error("expected claim");
    await t.mutation(internal.sync.runs.commitPage, {
      taskId: campaigns._id,
      claimSeq: c.claimSeq,
      page: { kind: "campaign", items: [], nextCursor: "loop" },
    });
    c = await claim(t, campaigns._id);
    if (c.status !== "fetch") throw new Error("expected claim");
    expect(c.request.cursor).toBe("loop");
    const result = await t.mutation(internal.sync.runs.commitPage, {
      taskId: campaigns._id,
      claimSeq: c.claimSeq,
      requestCursor: "loop",
      page: { kind: "campaign", items: [], nextCursor: "loop" },
    });
    expect(result).toEqual({ ok: false, reason: "cursor_loop" });
    expect(await task(t, campaigns._id)).toMatchObject({
      status: "failed",
      lastError: { kind: "cursor_loop" },
    });
    // The run moved on to the next task.
    expect((await current(t, run._id)).operation).toBe("listAdGroups");
  });

  it("enforces the per-task page limit", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    await step(t, (await current(t, run._id))._id);
    const campaigns = await current(t, run._id);
    await t.run((ctx) => ctx.db.patch(campaigns._id, { pages: SYNC_LIMITS.maxPagesPerTask - 1 }));
    const c = await claim(t, campaigns._id);
    if (c.status !== "fetch") throw new Error("expected claim");
    const result = await t.mutation(internal.sync.runs.commitPage, {
      taskId: campaigns._id,
      claimSeq: c.claimSeq,
      page: { kind: "campaign", items: [], nextCursor: "more" },
    });
    expect(result).toEqual({ ok: false, reason: "page_limit" });
  });

  it("rejects out-of-scope metric rows before writing anything", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const daily = await skipTo(t, run._id, "fetchDailyMetrics");
    const c = await claim(t, daily._id);
    if (c.status !== "fetch") throw new Error("expected claim");
    const row = {
      platform: "google_ads" as const,
      accountExternalId: "4445556666",
      entityExternalId: "4445556666",
      level: daily.level!,
      date: "2025-01-01", // outside the task window
      placement: "all" as const,
      currency: "JPY",
      spendMicros: 1_000_000n,
    };
    const result = await t.mutation(internal.sync.runs.commitPage, {
      taskId: daily._id,
      claimSeq: c.claimSeq,
      page: { kind: "metricRow", items: [row] },
    });
    expect(result).toEqual({ ok: false, reason: "out_of_scope" });
    expect(await t.run((ctx) => ctx.db.query("metricsDaily").collect())).toHaveLength(0);
  });

  it("restarts a task once when a checkpoint is too old", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const campaigns = await skipTo(t, run._id, "listCampaigns");
    await t.run((ctx) =>
      ctx.db.patch(campaigns._id, {
        cursor: "old",
        cursorSavedAt: NOW.getTime() - SYNC_LIMITS.staleCursorMs - 1,
      }),
    );
    const c = await claim(t, campaigns._id);
    if (c.status !== "fetch") throw new Error("expected claim");
    expect(c.request.cursor).toBeUndefined();
    expect(await task(t, campaigns._id)).toMatchObject({ restartedFromScratch: true });
  });
});

describe("failure policy through the protocol", () => {
  async function fail(
    t: Backend,
    taskId: Id<"syncTasks">,
    failure: { source: "provider"; kind: string; retryAfterMs?: number },
  ) {
    const now = Date.now();
    const pending = await task(t, taskId);
    if (pending.nextAttemptAt !== undefined && pending.nextAttemptAt > now) {
      vi.setSystemTime(pending.nextAttemptAt);
    }
    const c = await claim(t, taskId);
    if (c.status !== "fetch") throw new Error(`expected claim, task ${pending.status}`);
    await t.mutation(internal.sync.runs.recordFailure, {
      taskId,
      claimSeq: c.claimSeq,
      failure,
    });
    return c;
  }

  it("gives up after 5 transient attempts of one page", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const campaigns = await skipTo(t, run._id, "listCampaigns");
    const attempts: number[] = [];
    for (let i = 0; i < SYNC_LIMITS.maxPageAttempts; i++) {
      attempts.push(
        (await fail(t, campaigns._id, { source: "provider", kind: "transient" })).attempt,
      );
    }
    expect(attempts).toEqual([1, 2, 3, 4, 5]);
    expect(await task(t, campaigns._id)).toMatchObject({
      status: "failed",
      lastError: { kind: "transient" },
    });
  });

  it("gives up after 10 rate-limit hits and throttles the account meanwhile", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const campaigns = await skipTo(t, run._id, "listCampaigns");
    for (let i = 0; i < SYNC_LIMITS.maxRateLimitHits; i++) {
      await fail(t, campaigns._id, {
        source: "provider",
        kind: "rate_limited",
        retryAfterMs: 60_000,
      });
      if (i === 0) {
        const state = await t.run(async (ctx) => (await ctx.db.query("syncAccounts").first())!);
        expect(state.throttledUntil).toBeGreaterThanOrEqual(Date.now() + 60_000);
      }
    }
    expect(await task(t, campaigns._id)).toMatchObject({ status: "failed", rateLimitHits: 9 });
  });

  it("restarts from page 1 once when the platform rejects a cursor", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const campaigns = await skipTo(t, run._id, "listCampaigns");
    await t.run((ctx) =>
      ctx.db.patch(campaigns._id, { cursor: "expired", cursorSavedAt: NOW.getTime() }),
    );
    await fail(t, campaigns._id, { source: "provider", kind: "invalid_request" });
    expect(await task(t, campaigns._id)).toMatchObject({
      status: "queued",
      restartedFromScratch: true,
    });
    expect((await task(t, campaigns._id)).cursor).toBeUndefined();
    await t.run((ctx) => ctx.db.patch(campaigns._id, { cursor: "expired-again" }));
    await fail(t, campaigns._id, { source: "provider", kind: "invalid_request" });
    expect((await task(t, campaigns._id)).status).toBe("failed");
  });

  it("skips unsupported operations and continues", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const campaigns = await skipTo(t, run._id, "listCampaigns");
    await fail(t, campaigns._id, { source: "provider", kind: "unsupported" });
    expect((await task(t, campaigns._id)).status).toBe("skipped");
    expect((await current(t, run._id)).operation).toBe("listAdGroups");
  });

  it("never prunes after a failed metric task (and does after a successful one)", async () => {
    const t = newBackend();
    const { run } = await startRun(t);
    const tasks = (await tasksOf(t, run._id)).sort((a, b) => a.seq - b.seq);
    const accountDaily = tasks.find(
      (x) => x.operation === "fetchDailyMetrics" && x.level === "account",
    )!;
    const accountActions = tasks.find(
      (x) => x.operation === "fetchActionMetrics" && x.level === "account",
    )!;
    const account = await t.run(async (ctx) => (await ctx.db.query("adAccounts").first())!);
    // Stale rows inside both tasks' windows (e.g. restated away since the last sync).
    await t.run(async (ctx) => {
      const base = {
        orgId: account.orgId,
        platform: account.platform,
        adAccountId: account._id,
        level: "account" as const,
        entityId: account._id,
        date: accountDaily.to!,
        placement: "all" as const,
        currency: account.currency,
        syncedAt: NOW.getTime() - 86_400_000,
      };
      await ctx.db.insert("metricsDaily", { ...base, placement: "youtube", impressions: 1 });
      await ctx.db.insert("actionMetricsDaily", {
        ...base,
        actionType: "other",
        rawActionType: "Vanished action",
        attributionWindow: "30d_click",
        attributionBasis: "impression_or_click_date",
        count: 1,
      });
    });

    // Run everything until the account-level daily task, then make it fail permanently.
    while ((await current(t, run._id))._id !== accountDaily._id) {
      await step(t, (await current(t, run._id))._id);
      await t.finishInProgressScheduledFunctions();
      const next = await current(t, run._id);
      if (next.phase === "finalize") {
        await t.mutation(internal.sync.runs.finalizeTask, {
          taskId: next._id,
          claimSeq: next.claimSeq,
        });
      }
    }
    await fail(t, accountDaily._id, { source: "provider", kind: "data" });
    await drainScheduler(t);

    const rows = await t.run(async (ctx) => ({
      metrics: await ctx.db.query("metricsDaily").collect(),
      actions: await ctx.db.query("actionMetricsDaily").collect(),
    }));
    expect(rows.metrics.some((r) => r.placement === "youtube")).toBe(true); // failed task: kept
    expect(rows.actions.some((r) => r.rawActionType === "Vanished action")).toBe(false); // pruned
    expect(await task(t, accountActions._id)).toMatchObject({ status: "succeeded" });
    const finished = (await t.run((ctx) => ctx.db.get(run._id)))!;
    expect(finished.status).toBe("partial");
    expect(finished.counts.pruned).toBeGreaterThanOrEqual(1);
  });
});
