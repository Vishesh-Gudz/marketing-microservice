import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  connectMock,
  drainScheduler,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";
import { emptyCounts } from "./upsert";

// D11 (Phase 6): a metric window whose tasks had unresolved or rejected records
// does NOT advance syncAccounts coverage. Inside coverage a missing row means
// "no delivery"; a skipped record would make that false.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-04-10T15:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const state = (t: Backend) => t.run(async (ctx) => (await ctx.db.query("syncAccounts").first())!);
const lastRun = (t: Backend) =>
  t.run(async (ctx) => (await ctx.db.query("syncRuns").order("desc").first())!);

async function linked(t: Backend) {
  await setupSyncOrg(t);
  const connectionId = await connectMock(t, "meta", "1");
  const [account] = await linkMock(t, connectionId, ["1001"]);
  return account!.id as Id<"adAccounts">;
}

describe("coverage only advances for fully resolved metric windows", () => {
  it("does not cover windows whose metric rows could not be resolved", async () => {
    const t = newBackend();
    await linked(t);
    // Campaign listing fails (malformed record) -> campaign/ad-group/ad metric rows are unresolved.
    await connectMock(t, "meta", "1--malformed");
    await planAndDrain(t);

    const run = await lastRun(t);
    expect(run.status).toBe("partial");
    expect(run.counts.unresolved).toBeGreaterThan(0);
    const row = await state(t);
    expect(row.coveredFrom).toBeUndefined();
    expect(row.coveredThrough).toBeUndefined();
    expect(row.structureStale).toBe(true);
  });

  it("covers the window after a later clean run", async () => {
    const t = newBackend();
    const adAccountId = await linked(t);
    await connectMock(t, "meta", "1--malformed");
    await planAndDrain(t);
    expect((await state(t)).coveredFrom).toBeUndefined();

    await connectMock(t, "meta", "1"); // healthy credential again
    vi.advanceTimersByTime(20 * 60_000);
    await t.mutation(internal.sync.admin.requestSync, { adAccountId, kind: "lookback" });
    await drainScheduler(t);
    const run = await lastRun(t);
    expect(run.status).toBe("succeeded");
    expect(await state(t)).toMatchObject({
      coveredFrom: run.window!.from,
      coveredThrough: run.window!.to,
    });
  });

  it("keeps existing coverage (never shrinks it) when a later window is unresolved", async () => {
    const t = newBackend();
    const adAccountId = await linked(t);
    await planAndDrain(t);
    const before = await state(t);
    expect(before.coveredFrom).toBe("2026-03-12");

    await connectMock(t, "meta", "1--malformed");
    vi.advanceTimersByTime(20 * 60_000);
    await t.mutation(internal.sync.admin.requestSync, { adAccountId, kind: "lookback" });
    await drainScheduler(t);
    expect((await lastRun(t)).status).toBe("partial");
    const after = await state(t);
    expect(after.coveredFrom).toBe(before.coveredFrom);
    expect(after.coveredThrough).toBe(before.coveredThrough);
  });

  it("treats rejected records like unresolved ones", async () => {
    const t = newBackend();
    await linked(t);
    await t.mutation(internal.sync.planner.tick, {});
    // Test-only: mark the newest window's metric tasks as having rejected a record.
    await t.run(async (ctx) => {
      const tasks = await ctx.db.query("syncTasks").collect();
      const metric = tasks.filter(
        (x) => x.operation === "fetchDailyMetrics" && x.from !== undefined,
      );
      const newest = metric.reduce((a, b) => (a.from! > b.from! ? a : b));
      for (const task of metric.filter((x) => x.from === newest.from)) {
        await ctx.db.patch(task._id, { counts: { ...emptyCounts(), rejected: 1 } });
      }
    });
    await drainScheduler(t);
    const run = await lastRun(t);
    expect(run.window).toEqual({ from: "2026-03-12", to: "2026-04-10" });
    // The newest chunk (April) is not covered; the older chunk (March) alone is not
    // adjacent to anything newer, so it becomes the coverage.
    expect(await state(t)).toMatchObject({
      coveredFrom: "2026-03-12",
      coveredThrough: "2026-03-31",
    });
  });
});
