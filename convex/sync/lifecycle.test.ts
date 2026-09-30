import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  as,
  connectMock,
  drainScheduler,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";

// Concurrency and connection lifecycle: duplicate planners, parallel accounts,
// disconnect / unlink / relink / reconnect / re-auth while a run is in flight.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-04-10T15:00:00Z");
const HOUR = 60 * 60_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function db(t: Backend) {
  return await t.run(async (ctx) => ({
    runs: await ctx.db.query("syncRuns").collect(),
    states: await ctx.db.query("syncAccounts").collect(),
    campaigns: await ctx.db.query("campaigns").collect(),
    metrics: await ctx.db.query("metricsDaily").collect(),
    accounts: await ctx.db.query("adAccounts").collect(),
    credentials: await ctx.db.query("credentials").collect(),
  }));
}

async function linked(t: Backend, externalIds = ["4445556666"]) {
  await setupSyncOrg(t);
  const connectionId = await connectMock(t, "google_ads");
  const accounts = await linkMock(t, connectionId, externalIds);
  return { connectionId, accountIds: accounts.map((a) => a.id as Id<"adAccounts">) };
}

describe("duplicate work", () => {
  it("duplicate planner invocations create one run per account", async () => {
    const t = newBackend();
    await linked(t);
    await t.mutation(internal.sync.planner.tick, {});
    await t.mutation(internal.sync.planner.tick, {});
    vi.advanceTimersByTime(60_000);
    await t.mutation(internal.sync.planner.tick, {});
    expect((await db(t)).runs).toHaveLength(1);
    await drainScheduler(t);
    expect((await db(t)).runs[0]!.status).toBe("succeeded");
  });

  it("manual requests while a run is active are refused as busy", async () => {
    const t = newBackend();
    const { accountIds } = await linked(t);
    await t.mutation(internal.sync.planner.tick, {});
    const result = await t.mutation(internal.sync.admin.requestSync, {
      adAccountId: accountIds[0]!,
    });
    expect(result.status).toBe("busy");
    expect((await db(t)).runs).toHaveLength(1);
  });

  it("syncs several accounts in parallel, each with its own lease", async () => {
    const t = newBackend();
    const { accountIds } = await linked(t, ["4445556666", "1112223333"]);
    await t.mutation(internal.sync.planner.tick, {});
    const during = await db(t);
    expect(during.runs).toHaveLength(2);
    expect(new Set(during.states.map((s) => s.activeRunId)).size).toBe(2);
    await drainScheduler(t);
    const after = await db(t);
    expect(after.runs.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);
    for (const id of accountIds) {
      expect(after.campaigns.filter((c) => c.adAccountId === id).length).toBeGreaterThan(0);
    }
  });
});

describe("connection changes during a sync", () => {
  it("disconnect: the run is cancelled, nothing more is written, the account is parked", async () => {
    const t = newBackend();
    const { connectionId } = await linked(t);
    await t.mutation(internal.sync.planner.tick, {});
    await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    await drainScheduler(t);
    const after = await db(t);
    expect(after.runs[0]).toMatchObject({ status: "cancelled" });
    expect(["account_unlinked", "connection_inactive"]).toContain(after.runs[0]!.cancelReason);
    expect(after.campaigns).toHaveLength(0);
    expect(after.credentials).toHaveLength(0);
    await t.mutation(internal.sync.planner.tick, {});
    expect((await db(t)).states[0]).toMatchObject({ state: "parked" });
    expect((await db(t)).states[0]!.nextPlanAt).toBeUndefined();
  });

  it("unlink mid-run cancels; rows already written are kept; relink resumes", async () => {
    const t = newBackend();
    const { connectionId, accountIds } = await linked(t);
    await t.mutation(internal.sync.planner.tick, {});
    // Let the first steps run (getAccount + some structure).
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(1);
      await t.finishInProgressScheduledFunctions();
    }
    await as(t).mutation(api.v1.connections.unlinkAdAccount, { adAccountId: accountIds[0]! });
    await drainScheduler(t);
    const after = await db(t);
    expect(after.runs[0]).toMatchObject({ status: "cancelled", cancelReason: "account_unlinked" });
    expect(after.states[0]).toMatchObject({ state: "parked" });

    await linkMock(t, connectionId, ["4445556666"]);
    await planAndDrain(t);
    const resumed = await db(t);
    expect(resumed.runs.filter((r) => r.status === "succeeded")).toHaveLength(1);
  });

  it("relink to another connection: the old run is cancelled, data rows are reused (no duplicates)", async () => {
    const t = newBackend();
    const { accountIds } = await linked(t);
    await t.mutation(internal.sync.planner.tick, {});
    const second = await connectMock(t, "google_ads", "2");
    await linkMock(t, second, ["4445556666"]);
    await drainScheduler(t);
    let after = await db(t);
    expect(after.runs[0]).toMatchObject({ status: "cancelled", cancelReason: "account_relinked" });

    await planAndDrain(t);
    after = await db(t);
    const done = after.runs.find((r) => r.status === "succeeded")!;
    expect(done.connectionId).toBe(second);
    expect(after.accounts).toHaveLength(1);
    expect(after.accounts[0]!._id).toBe(accountIds[0]);

    // Same data as a single clean sync: no duplicated canonical rows.
    const clean = newBackend();
    await linked(clean);
    await planAndDrain(clean);
    const reference = await db(clean);
    expect(after.campaigns).toHaveLength(reference.campaigns.length);
    expect(after.metrics).toHaveLength(reference.metrics.length);
  });

  it("reconnect (same identity) mid-run: later pages use the new credential and the run completes", async () => {
    const t = newBackend();
    const { connectionId } = await linked(t);
    await t.mutation(internal.sync.planner.tick, {});
    vi.advanceTimersByTime(1);
    await t.finishInProgressScheduledFunctions();
    expect(await connectMock(t, "google_ads", "1")).toBe(connectionId);
    await drainScheduler(t);
    const after = await db(t);
    expect(after.runs[0]!.status).toBe("succeeded");
    const connection = await as(t).query(api.v1.connections.get, { connectionId });
    expect(connection.status).toBe("active");
  });

  it("needs_reauth mid-run cancels; after reconnect the planner resumes", async () => {
    const t = newBackend();
    const { connectionId } = await linked(t);
    await t.mutation(internal.sync.planner.tick, {});
    await t.mutation(internal.connections.lifecycle.markNeedsReauth, {
      connectionId: connectionId as Id<"connections">,
      reason: "test",
      actorSubject: "test",
    });
    await drainScheduler(t);
    expect((await db(t)).runs[0]).toMatchObject({
      status: "cancelled",
      cancelReason: "connection_inactive",
    });

    await connectMock(t, "google_ads", "1");
    vi.advanceTimersByTime(HOUR + 1);
    await planAndDrain(t);
    expect((await db(t)).runs.filter((r) => r.status === "succeeded")).toHaveLength(1);
  });

  it("an expired access token takes the auth path (needs_reauth, no provider call)", async () => {
    const t = newBackend();
    const { connectionId } = await linked(t);
    await t.run((ctx) =>
      ctx.db.patch(connectionId as Id<"connections">, { tokenExpiresAt: NOW.getTime() - 1 }),
    );
    await planAndDrain(t);
    const after = await db(t);
    expect(after.runs[0]).toMatchObject({ status: "failed", error: { kind: "auth" } });
    expect((await as(t).query(api.v1.connections.get, { connectionId })).status).toBe(
      "needs_reauth",
    );
    expect(after.campaigns).toHaveLength(0);
  });
});
