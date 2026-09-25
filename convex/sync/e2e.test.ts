import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { EntityLevel } from "../domain/types";
import { collectAll } from "../providers/pagination";
import { createMockAdsProvider, mockCredential } from "../providers/mock";
import {
  connectMock,
  drainScheduler,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";
import { windowChunks } from "./plan";

// Complete syncs of the Meta-like and Google-like mocks into the REAL Phase 2
// schema, through the real connect flow, encrypted credential, planner,
// worker, guards, mapping and write path.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-04-10T15:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const LEVELS: EntityLevel[] = ["account", "campaign", "ad_group", "ad"];

async function tables(t: Backend) {
  return await t.run(async (ctx) => ({
    runs: await ctx.db.query("syncRuns").collect(),
    tasks: await ctx.db.query("syncTasks").collect(),
    campaigns: await ctx.db.query("campaigns").collect(),
    adGroups: await ctx.db.query("adGroups").collect(),
    ads: await ctx.db.query("ads").collect(),
    creatives: await ctx.db.query("creatives").collect(),
    metrics: await ctx.db.query("metricsDaily").collect(),
    actions: await ctx.db.query("actionMetricsDaily").collect(),
    syncAccounts: await ctx.db.query("syncAccounts").collect(),
    accounts: await ctx.db.query("adAccounts").collect(),
  }));
}

/** What the provider itself returns for the initial window (the expected canonical content). */
async function expectedFromProvider(
  platform: "meta" | "google_ads",
  accountExternalId: string,
  window: { from: string; to: string },
) {
  const provider = createMockAdsProvider({ platform });
  const ctx = { credential: mockCredential(), attempt: 1 };
  const all = <T>(
    fetch: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
  ) => collectAll(fetch, { maxPages: 1000 }).then((r) => r.items);
  const req = (cursor?: string) => ({ accountExternalId, ...(cursor ? { cursor } : {}) });
  const metricRows = [];
  const actionRows = [];
  for (const chunk of windowChunks(window, 31)) {
    for (const level of LEVELS) {
      metricRows.push(
        ...(await all((c) =>
          provider.fetchDailyMetrics(ctx, { ...req(c), level, ...chunk, breakdown: "placement" }),
        )),
      );
      actionRows.push(
        ...(await all((c) =>
          provider.fetchActionMetrics(ctx, { ...req(c), level, ...chunk, breakdown: "none" }),
        )),
      );
    }
  }
  return {
    campaigns: await all((c) => provider.listCampaigns(ctx, req(c))),
    adGroups: await all((c) => provider.listAdGroups(ctx, req(c))),
    creatives: await all((c) => provider.listCreatives(ctx, req(c))),
    ads: await all((c) => provider.listAds(ctx, req(c))),
    metricRows,
    actionRows,
  };
}

function strip<T extends Record<string, unknown>>(row: T) {
  const { _creationTime: _c, syncedAt: _s, updatedAt: _u, lastSeenAt: _l, ...rest } = row;
  return rest;
}

async function fullSync(t: Backend, platform: "meta" | "google_ads", externalId: string) {
  await setupSyncOrg(t);
  const connectionId = await connectMock(t, platform);
  const [account] = await linkMock(t, connectionId, [externalId]);
  await planAndDrain(t);
  return { connectionId, adAccountId: account!.id as Id<"adAccounts"> };
}

describe.each([
  { platform: "meta" as const, externalId: "1001", tz: "America/New_York" },
  { platform: "google_ads" as const, externalId: "1112223333", tz: "America/Los_Angeles" },
])("complete $platform sync", ({ platform, externalId }) => {
  it("fills the canonical tables exactly with the provider's data", async () => {
    const t = newBackend();
    await fullSync(t, platform, externalId);
    const db = await tables(t);

    expect(db.runs).toHaveLength(1);
    const [run] = db.runs;
    expect(run).toMatchObject({ kind: "initial", trigger: "link", status: "succeeded" });
    expect(run!.window).toEqual({ from: "2026-03-12", to: "2026-04-10" });
    expect(db.tasks.every((task) => task.status === "succeeded")).toBe(true);
    expect(run!.counts.unresolved + run!.counts.rejected).toBe(0);

    const expected = await expectedFromProvider(platform, externalId, run!.window!);
    expect(db.campaigns.map((c) => c.externalId).sort()).toEqual(
      expected.campaigns.map((c) => c.externalId).sort(),
    );
    expect(db.adGroups).toHaveLength(expected.adGroups.length);
    expect(db.creatives).toHaveLength(expected.creatives.length);
    expect(db.ads).toHaveLength(expected.ads.length);
    expect(db.metrics).toHaveLength(expected.metricRows.length);
    expect(db.actions).toHaveLength(expected.actionRows.length);
    expect(db.metrics.length).toBeGreaterThan(0);
    expect(db.actions.length).toBeGreaterThan(0);

    // Every account-level spend value is stored exactly (bigint micros).
    const stored = new Map(
      db.metrics
        .filter((m) => m.level === "account")
        .map((m) => [`${m.date}|${m.placement}`, m.spendMicros]),
    );
    for (const row of expected.metricRows.filter((r) => r.level === "account")) {
      expect(stored.get(`${row.date}|${row.placement}`)).toBe(row.spendMicros);
    }

    // No dangling references: every child points at a stored parent of the same org/account.
    const campaignIds = new Set(db.campaigns.map((c) => c._id));
    const groupIds = new Set(db.adGroups.map((g) => g._id));
    const creativeIds = new Set(db.creatives.map((c) => c._id));
    for (const g of db.adGroups) expect(campaignIds.has(g.campaignId)).toBe(true);
    for (const a of db.ads) {
      expect(campaignIds.has(a.campaignId)).toBe(true);
      if (a.adGroupId) expect(groupIds.has(a.adGroupId)).toBe(true);
      if (a.creativeId) expect(creativeIds.has(a.creativeId)).toBe(true);
    }

    const [state] = db.syncAccounts;
    expect(state).toMatchObject({
      state: "idle",
      coveredFrom: "2026-03-12",
      coveredThrough: "2026-04-10",
      structureStale: false,
      consecutiveFailures: 0,
    });
    expect(state!.activeRunId).toBeUndefined();
    expect(state!.initialDoneAt).toBeDefined();
  });

  it("is idempotent: re-syncing the same window leaves identical rows", async () => {
    const t = newBackend();
    const { adAccountId } = await fullSync(t, platform, externalId);
    const before = await tables(t);

    vi.advanceTimersByTime(20 * 60_000);
    const result = await t.mutation(internal.sync.admin.requestSync, {
      adAccountId,
      kind: "manual",
      from: "2026-03-12",
      to: "2026-04-10",
    });
    expect(result.status).toBe("started");
    await drainScheduler(t);
    const after = await tables(t);

    const run = after.runs.find((r) => r.kind === "manual")!;
    expect(run.status).toBe("succeeded");
    expect(run.counts.inserted).toBe(0);
    expect(run.counts.pruned).toBe(0);
    expect(run.counts.removed).toBe(0);
    for (const key of [
      "campaigns",
      "adGroups",
      "ads",
      "creatives",
      "metrics",
      "actions",
    ] as const) {
      const a = (before[key] as Record<string, unknown>[]).map(strip);
      const b = (after[key] as Record<string, unknown>[]).map(strip);
      expect(b, key).toEqual(a);
    }
  });
});
