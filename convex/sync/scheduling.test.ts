import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  as,
  connectMock,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";
import { SYNC_LIMITS } from "./config";

// Planner cadence: initial -> backfill (when idle) -> incremental (hourly) ->
// lookback (daily), windows in the account timezone, bounded backfill,
// parking, failure backoff and run retention.

vi.setConfig({ testTimeout: 180_000 });
// 15:00Z = 00:00 on April 11 in Tokyo (Google mock account 4445556666).
const NOW = new Date("2026-04-10T15:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function setup(t: Backend) {
  await setupSyncOrg(t);
  const connectionId = await connectMock(t, "google_ads");
  const [account] = await linkMock(t, connectionId, ["4445556666"]);
  return account!.id as Id<"adAccounts">;
}

const runs = (t: Backend) => t.run((ctx) => ctx.db.query("syncRuns").order("asc").collect());
const state = (t: Backend) => t.run(async (ctx) => (await ctx.db.query("syncAccounts").first())!);

describe("cadence", () => {
  it("initial, then backfill while idle, then hourly incremental and daily lookback", async () => {
    const t = newBackend();
    await setup(t);
    await planAndDrain(t);
    let all = await runs(t);
    expect(all.map((r) => [r.kind, r.window])).toEqual([
      ["initial", { from: "2026-03-13", to: "2026-04-11" }],
    ]);
    expect(await state(t)).toMatchObject({
      coveredFrom: "2026-03-13",
      coveredThrough: "2026-04-11",
    });

    // Idle + older history pending: backfill one month per run, extending coverage.
    vi.advanceTimersByTime(15 * MIN);
    await planAndDrain(t);
    vi.advanceTimersByTime(15 * MIN);
    await planAndDrain(t);
    all = await runs(t);
    expect(all.slice(1).map((r) => [r.kind, r.window, r.structureMode])).toEqual([
      ["backfill", { from: "2026-03-01", to: "2026-03-12" }, "none"],
      ["backfill", { from: "2026-02-01", to: "2026-02-28" }, "none"],
    ]);
    expect((await state(t)).coveredFrom).toBe("2026-02-01");

    // One hour after the initial run: incremental (yesterday + today). Google cannot list
    // incrementally, so structure is not re-listed hourly.
    vi.advanceTimersByTime(31 * MIN);
    await planAndDrain(t);
    const incremental = (await runs(t)).at(-1)!;
    expect(incremental).toMatchObject({
      kind: "incremental",
      structureMode: "none",
      window: { from: "2026-04-10", to: "2026-04-11" },
      status: "succeeded",
    });

    // A day later: lookback over the provider's restatement window (Google mock: 30 days).
    vi.advanceTimersByTime(24 * HOUR);
    await planAndDrain(t);
    const lookback = (await runs(t)).find((r) => r.kind === "lookback")!;
    expect(lookback).toMatchObject({
      structureMode: "full",
      window: { from: "2026-03-13", to: "2026-04-12" },
      status: "succeeded",
    });
  });

  it("does not poll aggressively: an idle, fully covered account is left alone", async () => {
    const t = newBackend();
    await setup(t);
    await planAndDrain(t);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("syncAccounts").first())!;
      await ctx.db.patch(row._id, { backfillHorizon: row.coveredFrom!, nextPlanAt: Date.now() });
    });
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(15 * MIN);
      await planAndDrain(t);
    }
    expect(await runs(t)).toHaveLength(1);
    expect((await state(t)).nextPlanAt).toBe(NOW.getTime() + HOUR);
  });

  it("stops backfilling at the horizon", async () => {
    const t = newBackend();
    await setup(t);
    await planAndDrain(t);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("syncAccounts").first())!;
      await ctx.db.patch(row._id, { backfillHorizon: "2026-03-05" });
    });
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(15 * MIN);
      await planAndDrain(t);
    }
    const backfills = (await runs(t)).filter((r) => r.kind === "backfill");
    expect(backfills.map((r) => r.window)).toEqual([{ from: "2026-03-05", to: "2026-03-12" }]);
  });

  it("parks unlinked accounts (they leave the planner index)", async () => {
    const t = newBackend();
    const adAccountId = await setup(t);
    await as(t).mutation(api.v1.connections.unlinkAdAccount, { adAccountId });
    await t.mutation(internal.sync.planner.tick, {});
    expect(await state(t)).toMatchObject({ state: "parked" });
    expect((await state(t)).nextPlanAt).toBeUndefined();
    expect(await runs(t)).toHaveLength(0);
  });

  it("backs off after a failed run instead of retrying every tick", async () => {
    const t = newBackend();
    await setup(t);
    await t.mutation(internal.sync.planner.tick, {});
    const preflight = await t.run(async (ctx) => (await ctx.db.query("syncTasks").first())!);
    const claim = await t.mutation(internal.sync.runs.claimTask, { taskId: preflight._id });
    if (claim.status !== "fetch") throw new Error("expected claim");
    await t.mutation(internal.sync.runs.recordFailure, {
      taskId: preflight._id,
      claimSeq: claim.claimSeq,
      failure: { source: "provider", kind: "data" },
    });
    expect((await runs(t))[0]!.status).toBe("failed");
    const row = await state(t);
    expect(row).toMatchObject({ state: "idle", consecutiveFailures: 1 });
    expect(row.nextPlanAt).toBe(NOW.getTime() + SYNC_LIMITS.failureBaseBackoffMs);
    vi.advanceTimersByTime(5 * MIN);
    await planAndDrain(t);
    expect(await runs(t)).toHaveLength(1);
    vi.advanceTimersByTime(11 * MIN);
    await planAndDrain(t);
    expect((await runs(t)).map((r) => r.status)).toEqual(["failed", "succeeded"]);
    expect((await state(t)).consecutiveFailures).toBe(0);
  });

  it("rechecks blocked accounts daily, not every tick", async () => {
    const t = newBackend();
    const adAccountId = await setup(t);
    await t.run((ctx) => ctx.db.patch(adAccountId, { externalId: "4242424242" }));
    await planAndDrain(t);
    expect((await runs(t))[0]!.status).toBe("failed");
    expect((await state(t)).nextPlanAt).toBe(NOW.getTime() + SYNC_LIMITS.blockedRecheckMs);
    vi.advanceTimersByTime(HOUR);
    await planAndDrain(t);
    expect(await runs(t)).toHaveLength(1);
  });
});

describe("retention", () => {
  it("keeps a bounded run history per account", async () => {
    const t = newBackend();
    const adAccountId = await setup(t);
    await planAndDrain(t);
    const [first] = await runs(t);
    await t.run(async (ctx) => {
      const { _id: _i, _creationTime: _c, ...copy } = (await ctx.db.get(first!._id))!;
      for (let i = 0; i < 55; i++) {
        await ctx.db.insert("syncRuns", {
          ...copy,
          idempotencyKey: `old-${i}`,
          createdAt: copy.createdAt - (i + 1) * 1000,
        });
      }
    });
    vi.advanceTimersByTime(20 * MIN);
    const result = await t.mutation(internal.sync.admin.requestSync, { adAccountId });
    expect(result.status).toBe("started");
    // 56 old runs + 1 new, minus at most runsDeletedPerCreate (oldest first).
    expect(await runs(t)).toHaveLength(57 - SYNC_LIMITS.runsDeletedPerCreate);
  });
});
