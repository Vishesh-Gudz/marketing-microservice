import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  createFakeGraph,
  FAKE_APP_SECRET,
  FAKE_RANGE,
  fakeMetaDataset,
  fakeMetaDatasetWithConversions,
  graphError,
  type FakeCell,
  type FakeGraph,
} from "../providers/meta/fakeGraph.fixtures";
import {
  as,
  connectMetaFake,
  connectMock,
  drainScheduler,
  ISSUER_CRM,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  stubLiveMeta,
  type Backend,
} from "../test.helpers";

// Phase 8 Stage B, end to end on convex-test with PROVIDER_MODE=live:
//   fake Graph (Marketing-API-shaped, provisional semantics) → real Meta provider +
//   META_MAPPING → Phase 5 sync → metricsDaily / actionMetricsDaily → Phase 6 v1 analytics
//   (the DTOs the Phase 7 dashboard renders). No schema or public API change is involved.

vi.setConfig({ testTimeout: 180_000 });
/** New York 10:00 on 2026-03-08: the initial window (30 days) covers the fake delivery. */
const NOW = new Date("2026-03-08T15:00:00Z");

let graph: FakeGraph;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  graph = createFakeGraph();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function snapshot(t: Backend) {
  return await t.run(async (ctx) => ({
    runs: await ctx.db.query("syncRuns").collect(),
    tasks: await ctx.db.query("syncTasks").collect(),
    states: await ctx.db.query("syncAccounts").collect(),
    connections: await ctx.db.query("connections").collect(),
    accounts: await ctx.db.query("adAccounts").collect(),
    campaigns: await ctx.db.query("campaigns").collect(),
    adGroups: await ctx.db.query("adGroups").collect(),
    ads: await ctx.db.query("ads").collect(),
    creatives: await ctx.db.query("creatives").collect(),
    metrics: await ctx.db.query("metricsDaily").collect(),
    actions: await ctx.db.query("actionMetricsDaily").collect(),
    audit: await ctx.db.query("auditLog").collect(),
  }));
}

/** Metric and action rows keyed by external ids (comparable across backends). */
async function canonicalRows(t: Backend) {
  const db = await snapshot(t);
  const external = new Map<string, string>([
    ...db.accounts.map((a) => [a._id as string, a.externalId] as const),
    ...db.campaigns.map((c) => [c._id as string, c.externalId] as const),
    ...db.adGroups.map((g) => [g._id as string, g.externalId] as const),
    ...db.ads.map((a) => [a._id as string, a.externalId] as const),
  ]);
  const internalFields = new Set([
    "_id",
    "_creationTime",
    "orgId",
    "adAccountId",
    "entityId",
    "campaignId",
    "adGroupId",
    "adId",
    "syncedAt",
  ]);
  const plain = (row: Record<string, unknown>) =>
    JSON.stringify(
      {
        entity: external.get(row.entityId as string),
        ...Object.fromEntries(Object.entries(row).filter(([k]) => !internalFields.has(k))),
      },
      (_k, value) => (typeof value === "bigint" ? `${value}n` : value),
    );
  return {
    metrics: db.metrics.map(plain).sort(),
    actions: db.actions.map(plain).sort(),
  };
}

/** Connects the fake Meta user u1, links ad account 1001 and runs the initial sync. */
async function syncMeta(t: Backend) {
  stubLiveMeta(graph);
  await setupSyncOrg(t);
  const connectionId = (await connectMetaFake(t, graph, "u1")).get("connection")!;
  const [account] = await linkMock(t, connectionId, ["1001"]);
  await planAndDrain(t);
  return { connectionId, adAccountId: account!.id as Id<"adAccounts"> };
}

const cells = (): FakeCell[] => fakeMetaDataset().cells["1001"]!;

/** The public sync error of an ad account (v1/adAccounts:list, as the dashboard reads it). */
async function publicSyncError(t: Backend, externalId: string) {
  const accounts = await as(t).query(api.v1.adAccounts.list, {});
  return accounts.find((a) => a.externalId === externalId)?.sync?.lastError;
}
const sum = (list: FakeCell[], pick: (c: FakeCell) => number) =>
  list.reduce((total, c) => total + pick(c), 0);

describe("Meta Ads end to end (fake Graph → provider → sync → canonical tables → v1 analytics)", () => {
  it("syncs structure, daily metrics, placements and action metrics into the canonical tables", async () => {
    const t = newBackend();
    await syncMeta(t);
    const db = await snapshot(t);

    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]).toMatchObject({
      kind: "initial",
      status: "succeeded",
      providerId: "meta-marketing-api/v26.0",
    });
    expect(db.runs[0]!.counts).toMatchObject({ unresolved: 0, rejected: 0 });
    // getAccount + 4 listings + 2 month chunks × 4 levels × (daily + action) metrics.
    expect(db.tasks).toHaveLength(21);
    expect(db.tasks.every((task) => task.status === "succeeded")).toBe(true);
    expect(db.connections[0]!.status).toBe("active");
    expect(db.states[0]).toMatchObject({
      coveredFrom: "2026-02-07",
      coveredThrough: "2026-03-08",
      consecutiveFailures: 0,
    });

    // Structure, including ARCHIVED and DELETED objects (their delivery must resolve).
    expect(db.campaigns.map((c) => [c.externalId, c.status, c.budgetLevel]).sort()).toEqual([
      ["2001", "active", "campaign"],
      ["2002", "paused", "ad_group"],
      ["2003", "archived", "campaign"],
      ["2004", "removed", "ad_group"],
    ]);
    expect(db.adGroups).toHaveLength(4);
    expect(db.ads).toHaveLength(5);
    expect(db.creatives).toHaveLength(3);
    expect(db.ads.filter((a) => a.creativeId !== undefined)).toHaveLength(4);
    const cbo = db.campaigns.find((c) => c.externalId === "2001")!;
    expect(cbo).toMatchObject({ budgetType: "daily", budgetMicros: 150_000_000n });

    // Account "all" rows: exactly the delivered days, totals equal the Meta delivery.
    const accountAll = db.metrics.filter((r) => r.level === "account" && r.placement === "all");
    expect(accountAll.map((r) => r.date).sort()).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
    ]);
    const all7 = cells();
    expect(accountAll.reduce((t2, r) => t2 + r.spendMicros!, 0n)).toBe(
      BigInt(sum(all7, (c) => c.spendCents)) * 10_000n,
    );
    expect(accountAll.every((r) => typeof r.reach === "number" && r.currency === "USD")).toBe(true);
    // Placement rows carry the raw value and never reach.
    const placements = db.metrics.filter((r) => r.placement !== "all");
    expect(new Set(placements.map((r) => r.placement))).toEqual(
      new Set(["facebook", "instagram", "audience_network", "threads", "other"]),
    );
    expect(placements.every((r) => r.reach === undefined && r.rawPlacement !== undefined)).toBe(
      true,
    );
    // Rows of the archived and deleted campaigns resolved to their entities.
    const campaignIds = new Map(db.campaigns.map((c) => [c._id as string, c.externalId]));
    const campaignRows = db.metrics.filter((r) => r.level === "campaign" && r.placement === "all");
    expect(new Set(campaignRows.map((r) => campaignIds.get(r.entityId)))).toEqual(
      new Set(["2001", "2002", "2003", "2004"]),
    );
    for (const level of ["campaign", "ad_group", "ad"] as const) {
      const rows = db.metrics.filter((r) => r.level === level && r.placement === "all");
      expect(
        rows.reduce((t2, r) => t2 + r.spendMicros!, 0n),
        level,
      ).toBe(accountAll.reduce((t2, r) => t2 + r.spendMicros!, 0n));
    }

    // Action rows: conversion types only, fixed windows, impression-date basis.
    expect(db.actions.length).toBeGreaterThan(0);
    expect(new Set(db.actions.map((r) => r.attributionWindow))).toEqual(
      new Set(["1d_click", "7d_click", "1d_view"]),
    );
    expect(db.actions.every((r) => r.attributionBasis === "impression_or_click_date")).toBe(true);
    expect(db.actions.every((r) => r.placement === "all")).toBe(true);
    expect(db.actions.some((r) => r.rawActionType === "offsite_conversion.fb_pixel_purchase")).toBe(
      false,
    );
    const purchases = db.actions.filter(
      (r) =>
        r.level === "account" && r.actionType === "purchase" && r.attributionWindow === "7d_click",
    );
    expect(purchases.reduce((t2, r) => t2 + r.count, 0)).toBe(
      sum(all7, (c) => c.actions.omni_purchase?.["7d_click"] ?? 0),
    );
    expect(purchases.every((r) => r.isPrimary === true)).toBe(true);

    // Transport: GET-only reads with header tokens and appsecret_proof.
    const reads = graph.log.filter((e) => e.path !== "oauth/access_token");
    expect(reads.every((e) => e.method === "GET" && !e.secretInUrl)).toBe(true);
    expect(reads.filter((e) => e.auth === "user").every((e) => e.hasProof)).toBe(true);
  });

  it("serves the synced data through the v1 analytics the dashboard uses", async () => {
    const t = newBackend();
    const { adAccountId } = await syncMeta(t);
    const all7 = cells();
    const spendMicros = String(BigInt(sum(all7, (c) => c.spendCents)) * 10_000n);
    const conversions =
      sum(all7, (c) => c.actions.omni_purchase?.value ?? 0) +
      sum(all7, (c) => c.actions.lead?.value ?? 0);

    const overview = await as(t).query(api.v1.analytics.overview, { range: FAKE_RANGE });
    expect(overview.accountCount).toBe(1);
    expect(overview.totals.dataState).toBe("reported");
    expect(overview.totals.metrics.spend?.native).toEqual([
      { currency: "USD", micros: spendMicros },
    ]);
    expect(overview.totals.metrics.impressions).toBe(sum(all7, (c) => c.impressions));
    expect(overview.totals.metrics.conversions).toBe(conversions);
    expect(overview.totals.metrics.conversionValue?.native[0]).toEqual({
      currency: "USD",
      micros: String(BigInt(sum(all7, (c) => c.values.omni_purchase?.value ?? 0)) * 10_000n),
    });
    expect(overview.totals.metrics.partialMetrics).not.toContain("conversions");
    expect(typeof overview.totals.kpis.roas).toBe("number");

    const series = await as(t).query(api.v1.analytics.timeSeries, {
      range: FAKE_RANGE,
      granularity: "day",
      entity: { level: "account", id: adAccountId },
    });
    expect(series.points).toHaveLength(7);
    expect(series.points.every((p) => typeof p.metrics.reach === "number")).toBe(true);

    const campaigns = await as(t).query(api.v1.analytics.performance, {
      level: "campaign",
      range: FAKE_RANGE,
      parent: { accountId: adAccountId },
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(campaigns.page.map((r) => r.entity.externalId).sort()).toEqual([
      "2001",
      "2002",
      "2003",
      "2004",
    ]);
    const sales = campaigns.page.find((r) => r.entity.externalId === "2001")!;
    expect(sales.entity).toMatchObject({ status: "active", objective: "sales", platform: "meta" });

    const byPlacement = await as(t).query(api.v1.analytics.breakdown, {
      by: "placement",
      range: FAKE_RANGE,
    });
    expect(byPlacement.groups.map((g) => g.key)).toEqual(
      expect.arrayContaining(["facebook", "instagram", "audience_network", "threads", "other"]),
    );

    const actions = await as(t).query(api.v1.analytics.actions, {
      range: FAKE_RANGE,
      filters: { accountIds: [adAccountId] },
    });
    const purchase = actions.groups.filter((g) => g.actionType === "purchase");
    // Three attribution windows = three separate groups, never summed.
    expect(new Set(purchase.map((g) => g.attributionWindow))).toEqual(
      new Set(["1d_click", "7d_click", "1d_view"]),
    );
    expect(purchase.every((g) => g.isPrimary === true)).toBe(true);
    expect(purchase.every((g) => g.costPerAction?.native[0]?.currency === "USD")).toBe(true);
    const primaryOnly = await as(t).query(api.v1.analytics.actions, {
      range: FAKE_RANGE,
      filters: { accountIds: [adAccountId], primaryOnly: true },
    });
    expect(new Set(primaryOnly.groups.map((g) => g.actionType))).toEqual(
      new Set(["purchase", "lead"]),
    );
  });

  it("re-syncing the same window is idempotent (rows replaced, never duplicated)", async () => {
    const t = newBackend();
    const { adAccountId } = await syncMeta(t);
    const before = await snapshot(t);
    vi.advanceTimersByTime(20 * 60_000);
    const result = await t.mutation(internal.sync.admin.requestSync, {
      adAccountId,
      kind: "manual",
      from: "2026-02-07",
      to: "2026-03-08",
    });
    expect(result.status).toBe("started");
    await drainScheduler(t);
    const after = await snapshot(t);
    const manual = after.runs.find((r) => r.kind === "manual")!;
    expect(manual.status).toBe("succeeded");
    expect(manual.counts.inserted).toBe(0);
    expect(manual.counts.pruned).toBe(0);
    expect(after.metrics).toHaveLength(before.metrics.length);
    expect(after.actions).toHaveLength(before.actions.length);
    expect(after.campaigns).toHaveLength(before.campaigns.length);
  });

  it("a throttled insights page is retried after the Meta-reported delay and the run completes", async () => {
    graph.inject({
      match: (e) => e.path === "act_1001/insights",
      response: {
        ...graphError(80_000),
        headers: {
          "x-business-use-case-usage": JSON.stringify({
            "1001": [{ type: "ads_insights", estimated_time_to_regain_access: 2 }],
          }),
        },
      },
    });
    const t = newBackend();
    await syncMeta(t);
    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("succeeded");
    // Staged insights tasks take two pages; exactly one task needed one extra attempt.
    const throttled = db.tasks.filter((task) => task.totalAttempts > task.pages);
    expect(throttled).toHaveLength(1);
    expect(throttled[0]!.totalAttempts).toBe(throttled[0]!.pages + 1);
    expect(throttled[0]).toMatchObject({ status: "succeeded", rateLimitHits: 0 });
    expect(db.states[0]!.throttledUntil).toBeGreaterThanOrEqual(NOW.getTime() + 120_000);
  });

  it("keeps tenants apart: another org sees none of the Meta data", async () => {
    const t = newBackend();
    await syncMeta(t);
    await setupSyncOrg(t, { issuer: ISSUER_CRM });
    const other = await as(t, { issuer: ISSUER_CRM }).query(api.v1.analytics.overview, {
      range: FAKE_RANGE,
    });
    expect(other.accountCount).toBe(0);
    expect(other.totals.metrics.spend).toBeUndefined();
  });

  it("page boundaries never change stored rows: 'other' accumulates across pages (R9)", async () => {
    // Reference: Graph returns whole pages.
    const reference = newBackend();
    await syncMeta(reference);
    const expected = await canonicalRows(reference);

    // Graph returns at most 2 rows per page: "other" contributions land on different pages.
    graph = createFakeGraph({ pageCap: 2 });
    const t = newBackend();
    const { adAccountId } = await syncMeta(t);
    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("succeeded");
    expect(db.tasks.some((task) => task.pages > 5)).toBe(true);
    const stored = await canonicalRows(t);
    expect(stored.metrics).toEqual(expected.metrics);
    expect(stored.actions).toEqual(expected.actions);

    // The accumulated row: sums where every contribution reported, absent otherwise.
    const others = db.metrics.filter((r) => r.placement === "other");
    expect(others.map((r) => r.level).sort()).toEqual(["account", "ad", "ad_group", "campaign"]);
    for (const row of others) {
      expect(row).toMatchObject({
        date: "2026-03-02",
        rawPlacement: "oculus,unknown",
        spendMicros: 890_000n,
        impressions: 101,
        clicks: 0,
        engagements: 3,
      });
      expect(row.linkClicks).toBeUndefined();
      expect(row.reactions).toBeUndefined();
    }

    // Re-syncing the same window replaces rows with identical values: nothing doubles.
    vi.advanceTimersByTime(20 * 60_000);
    await t.mutation(internal.sync.admin.requestSync, {
      adAccountId,
      kind: "manual",
      from: "2026-02-07",
      to: "2026-03-08",
    });
    await drainScheduler(t);
    const manual = (await snapshot(t)).runs.find((r) => r.kind === "manual")!;
    expect(manual).toMatchObject({ status: "succeeded" });
    expect(manual.counts.inserted).toBe(0);
    expect(await canonicalRows(t)).toEqual(expected);
  });

  it("an account with many conversions syncs completely: no page exceeds the sync limit", async () => {
    // 10 extra custom conversions in 3 windows: every insights row becomes 30+ action
    // records, so a full Graph page of the busier levels normalizes to more than the sync
    // engine's 500-record page (before the fix: page_too_large, a partial run, no coverage).
    const dataset = () => fakeMetaDatasetWithConversions(10);
    graph = createFakeGraph({ dataset: dataset() });
    const t = newBackend();
    await syncMeta(t);
    const db = await snapshot(t);
    expect(
      db.tasks.filter((task) => task.status !== "succeeded").map((task) => task.lastError),
    ).toEqual([]);
    expect(db.runs[0]).toMatchObject({ kind: "initial", status: "succeeded" });
    expect(db.runs[0]!.counts).toMatchObject({ unresolved: 0, rejected: 0 });
    expect(db.states[0]).toMatchObject({
      coveredFrom: "2026-02-07",
      coveredThrough: "2026-03-08",
      consecutiveFailures: 0,
    });
    expect(db.actions.length).toBeGreaterThan(2_000);
    // The provider asked Graph for fewer rows instead of over-filling a page.
    const actionLimits = graph.log
      .filter((e) => e.path === "act_1001/insights" && e.params.action_attribution_windows)
      .map((e) => Number(e.params.limit));
    expect(Math.min(...actionLimits)).toBeLessThan(500);

    // Reference: Graph returns 2 rows per page, so no page ever needs to shrink.
    graph = createFakeGraph({ dataset: dataset(), pageCap: 2 });
    const reference = newBackend();
    await syncMeta(reference);
    expect((await snapshot(reference)).runs[0]!.status).toBe("succeeded");
    expect(await canonicalRows(t)).toEqual(await canonicalRows(reference));
  });

  it("stores no token, secret or Graph URL anywhere", async () => {
    const t = newBackend();
    await syncMeta(t);
    const db = await snapshot(t);
    const text = JSON.stringify(db, (_k, value) =>
      typeof value === "bigint" ? value.toString() : value,
    );
    for (const marker of ["test-long-", "test-short-", FAKE_APP_SECRET, "graph.facebook.com"]) {
      expect(text).not.toContain(marker);
    }
  });
});

describe("Meta failure handling during sync", () => {
  it("live mode moves leftover mock Google connections to needs_reauth (no synthetic data)", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "google_ads", "1");
    await linkMock(t, connectionId, ["1112223333"]);
    stubLiveMeta(graph);
    await planAndDrain(t);

    const db = await snapshot(t);
    expect(db.connections[0]!.status).toBe("needs_reauth");
    expect(db.runs[0]!.providerId).toBe("unavailable");
    expect(db.tasks.find((task) => task.operation === "getAccount")!.lastError).toMatchObject({
      kind: "auth",
      code: "provider_unavailable",
    });
    expect(db.campaigns).toHaveLength(0);
    expect(db.metrics).toHaveLength(0);
    expect(db.audit.filter((a) => a.action === "connection.needs_reauth")).toHaveLength(1);
    expect(graph.calls()).toBe(0);
  });

  it("a revoked Meta token (190) moves the connection to needs_reauth", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = (await connectMetaFake(t, graph, "u1")).get("connection")!;
    await linkMock(t, connectionId, ["1001"]);
    graph.inject({
      match: (e) => e.path === "act_1001",
      response: { status: 401, body: { error: { code: 190, error_subcode: 460 } } },
    });
    await planAndDrain(t);
    const db = await snapshot(t);
    expect(db.connections[0]!.status).toBe("needs_reauth");
    expect(db.runs[0]!.status).toBe("failed");
    expect(db.tasks.find((task) => task.operation === "getAccount")!.lastError).toMatchObject({
      kind: "auth",
      code: "190/460",
    });
    // Public: a fixed reason and the generic message; never the Graph code.
    const error = await publicSyncError(t, "1001");
    expect(error).toMatchObject({ kind: "auth", reason: "reauth_required" });
    expect(JSON.stringify(error)).not.toContain("190");
  });

  it("a throttled preflight (17) is retried after the header-derived delay and then succeeds", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = (await connectMetaFake(t, graph, "u1")).get("connection")!;
    await linkMock(t, connectionId, ["1001"]);
    graph.inject({
      match: (e) => e.path === "act_1001" && e.params.fields !== "currency,timezone_name",
      response: {
        status: 400,
        body: { error: { code: 17, error_subcode: 2_446_079 } },
        headers: {
          "x-ad-account-usage": JSON.stringify({ acc_id_util_pct: 100, reset_time_duration: 120 }),
        },
      },
    });
    await planAndDrain(t);
    const db = await snapshot(t);
    const preflight = db.tasks.find((task) => task.operation === "getAccount")!;
    expect(preflight.status).toBe("succeeded");
    expect(preflight.totalAttempts).toBe(2);
    expect(db.states[0]!.throttledUntil).toBeGreaterThanOrEqual(NOW.getTime() + 120_000);
    expect(db.connections[0]!.status).toBe("active");
  });

  it("an unknown or deleted ad account (100/33) blocks that account as not_found", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = (await connectMetaFake(t, graph, "u1")).get("connection")!;
    await linkMock(t, connectionId, ["1001"]);
    graph.inject({
      match: (e) => e.path === "act_1001",
      response: { status: 400, body: { error: { code: 100, error_subcode: 33 } } },
    });
    await planAndDrain(t);
    const db = await snapshot(t);
    expect(db.connections[0]!.status).toBe("active");
    expect(db.runs[0]!.status).toBe("failed");
    expect(db.states[0]).toMatchObject({
      state: "blocked",
      lastError: { kind: "not_found", code: "100/33" },
    });
    expect(db.tasks.find((task) => task.operation === "getAccount")!.totalAttempts).toBe(1);
    expect(await publicSyncError(t, "1001")).toMatchObject({ reason: "account_not_accessible" });
  });

  it("'too much data' (100/1487534) on an insights page is transient: retried, then completes", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = (await connectMetaFake(t, graph, "u1")).get("connection")!;
    await linkMock(t, connectionId, ["1001"]);
    graph.inject({
      match: (e) => e.path === "act_1001/insights",
      response: { status: 500, body: { error: { code: 100, error_subcode: 1_487_534 } } },
    });
    await planAndDrain(t);
    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("succeeded");
    const retried = db.tasks.filter((task) => task.totalAttempts > task.pages);
    expect(retried).toHaveLength(1);
    expect(retried[0]!.totalAttempts).toBe(retried[0]!.pages + 1);
    expect(retried[0]!.operation).toMatch(/Metrics$/);
    expect(db.connections[0]!.status).toBe("active");
  });

  it("an account-scoped permission error blocks only that account", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = (await connectMetaFake(t, graph, "u1")).get("connection")!;
    await linkMock(t, connectionId, ["1001", "1002"]);
    graph.inject({
      match: (e) => e.path === "act_1002",
      response: { status: 403, body: { error: { code: 10 } } },
    });
    await planAndDrain(t);
    const db = await snapshot(t);
    expect(db.connections[0]!.status).toBe("active");
    const blocked = db.states.filter((s) => s.state === "blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]!.lastError).toMatchObject({ kind: "permission" });
    expect(await publicSyncError(t, "1002")).toMatchObject({ reason: "permission_denied" });
    expect(await publicSyncError(t, "1001")).toBeUndefined();
  });
});
