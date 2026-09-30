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

// Removed entities (Phase 2 lifecycle): rows the platform no longer returns get
// removedAt after a COMPLETE, successful, fully resolved full listing. Rows are
// never hard-deleted, status is provider-owned and untouched, metrics stay.

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

async function synced(t: Backend, platform: "meta" | "google_ads", externalId: string) {
  await setupSyncOrg(t);
  const connectionId = await connectMock(t, platform);
  const [account] = await linkMock(t, connectionId, [externalId]);
  await planAndDrain(t);
  return account!.id as Id<"adAccounts">;
}

/** Inserts `count` campaigns the platform does not know (as if deleted there). */
async function seedGhostCampaigns(t: Backend, adAccountId: Id<"adAccounts">, count: number) {
  return await t.run(async (ctx) => {
    const account = (await ctx.db.get(adAccountId))!;
    const ids = [];
    for (let i = 0; i < count; i++) {
      ids.push(
        await ctx.db.insert("campaigns", {
          orgId: account.orgId,
          adAccountId,
          platform: account.platform,
          externalId: String(900_000_000 + i),
          name: `Ghost ${i}`,
          status: "active",
          objective: "sales",
          budgetType: "none",
          budgetLevel: "campaign",
          lastSeenAt: NOW.getTime() - 10 * 24 * HOUR,
          createdAt: NOW.getTime() - 20 * 24 * HOUR,
          updatedAt: NOW.getTime() - 10 * 24 * HOUR,
        }),
      );
    }
    return ids;
  });
}

async function lookback(t: Backend, adAccountId: Id<"adAccounts">) {
  vi.advanceTimersByTime(20 * 60_000);
  const result = await t.mutation(internal.sync.admin.requestSync, {
    adAccountId,
    kind: "lookback",
  });
  expect(result.status).toBe("started");
  await drainScheduler(t);
  return await t.run(async (ctx) => (await ctx.db.query("syncRuns").order("desc").first())!);
}

describe("removal marking", () => {
  it("marks entities missing from a full listing as removed (status untouched, row kept)", async () => {
    const t = newBackend();
    const adAccountId = await synced(t, "google_ads", "4445556666");
    const [ghost] = await seedGhostCampaigns(t, adAccountId, 1);
    const run = await lookback(t, adAccountId);
    expect(run.status).toBe("succeeded");
    expect(run.counts.removed).toBe(1);
    const row = await t.run((ctx) => ctx.db.get(ghost!));
    expect(row).toMatchObject({ status: "active" });
    expect(row!.removedAt).toBeDefined();
    const live = await t.run((ctx) => ctx.db.query("campaigns").collect());
    expect(live.filter((c) => c.removedAt !== undefined)).toHaveLength(1);
  });

  it("a removed entity that reappears is un-removed", async () => {
    const t = newBackend();
    const adAccountId = await synced(t, "google_ads", "4445556666");
    const [campaign] = await t.run((ctx) => ctx.db.query("campaigns").collect());
    await t.run((ctx) => ctx.db.patch(campaign!._id, { removedAt: NOW.getTime() - HOUR }));
    const run = await lookback(t, adAccountId);
    expect(run.counts.reappeared).toBeGreaterThanOrEqual(1);
    expect((await t.run((ctx) => ctx.db.get(campaign!._id)))!.removedAt).toBeUndefined();
  });

  it("incremental listings never mark removals", async () => {
    const t = newBackend();
    const adAccountId = await synced(t, "meta", "1002");
    await seedGhostCampaigns(t, adAccountId, 1);
    vi.advanceTimersByTime(HOUR + 60_000);
    await t.run(async (ctx) => {
      const state = (await ctx.db.query("syncAccounts").first())!;
      await ctx.db.patch(state._id, { coveredFrom: state.backfillHorizon }); // no backfill noise
    });
    await planAndDrain(t);
    const run = await t.run(async (ctx) => (await ctx.db.query("syncRuns").order("desc").first())!);
    expect(run).toMatchObject({ kind: "incremental", structureMode: "incremental" });
    const ghosts = await t.run((ctx) =>
      ctx.db
        .query("campaigns")
        .filter((q) => q.neq(q.field("removedAt"), undefined))
        .collect(),
    );
    expect(ghosts).toHaveLength(0);
  });

  it("vetoes suspicious mass removals and flags the run", async () => {
    const t = newBackend();
    const adAccountId = await synced(t, "google_ads", "4445556666");
    await seedGhostCampaigns(t, adAccountId, 25);
    const run = await lookback(t, adAccountId);
    expect(run.status).toBe("partial");
    expect(run.error).toMatchObject({ kind: "suspicious_empty_listing" });
    const removed = await t.run((ctx) =>
      ctx.db
        .query("campaigns")
        .filter((q) => q.neq(q.field("removedAt"), undefined))
        .collect(),
    );
    expect(removed).toHaveLength(0);
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.some((a) => a.action === "sync.removal_skipped")).toBe(true);
  });
});
