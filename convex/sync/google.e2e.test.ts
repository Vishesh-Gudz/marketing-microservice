import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { numberToMicros } from "../lib/money";
import { GOOGLE_CAPABILITIES } from "../providers/google/capabilities";
import {
  adsError,
  createFakeGoogleAds,
  FAKE_GOOGLE_CLIENT_SECRET,
  FAKE_GOOGLE_RANGE,
  fakeGoogleDataset,
  type FakeGoogleAds,
  type FakeGoogleDataset,
} from "../providers/google/fakeGoogleAds.fixtures";
import schema from "../schema";
import { checkRecordsInScope } from "./guards";
import { allowedPlacements, buildRunPlan } from "./plan";
import {
  as,
  connectGoogleFake,
  drainScheduler,
  ISSUER_CRM,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  stubLiveGoogle,
  type Backend,
} from "../test.helpers";

// Phase 9 Stage B, end to end on convex-test with PROVIDER_MODE=live:
//   fake Google Ads API (documented shapes, synthetic data) → real Google provider +
//   GOOGLE_MAPPING → Phase 5 sync → canonical tables → Phase 6 v1 analytics.
// No schema, sync, analytics or public API change is involved. Not real-account evidence.

vi.setConfig({ testTimeout: 180_000 });
/** New York 10:00 on 2026-03-08: the initial window (30 days) covers the fake delivery. */
const NOW = new Date("2026-03-08T15:00:00Z");
const ACCOUNT = "2220000001";

let fake: FakeGoogleAds;
let data: FakeGoogleDataset;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  data = fakeGoogleDataset();
  fake = createFakeGoogleAds({ dataset: data });
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
  return { metrics: db.metrics.map(plain).sort(), actions: db.actions.map(plain).sort() };
}

/** Connects the fake Google user u1, links 222-000-0001 and runs the initial sync. */
async function syncGoogle(t: Backend, identity = {}) {
  stubLiveGoogle(fake);
  await setupSyncOrg(t, identity);
  const connectionId = (await connectGoogleFake(t, fake, "u1", identity)).get("connection")!;
  const [account] = await linkMock(t, connectionId, [ACCOUNT], identity);
  const logStart = fake.log.length;
  await planAndDrain(t);
  return { connectionId, adAccountId: account!.id as Id<"adAccounts">, logStart };
}

const facts = () => data.facts;
const sum = <T>(list: T[], pick: (item: T) => number) => list.reduce((t, x) => t + pick(x), 0);
/** Google's Conversions in the fake: every action except signups outside the Search campaign's custom goal. */
const counted = () =>
  facts().flatMap((f) =>
    (f.conversions ?? []).filter(
      (c) => c.actionId !== "900000002" || f.campaignId === "10000000001",
    ),
  );
const resource = (id: string) => `customers/${ACCOUNT}/conversionActions/${id}`;

describe("Google Ads end to end (fake API → provider → sync → canonical tables)", () => {
  it("syncs structure, daily metrics, placements and conversion actions", async () => {
    const t = newBackend();
    const { logStart } = await syncGoogle(t);
    const db = await snapshot(t);

    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]).toMatchObject({
      kind: "initial",
      status: "succeeded",
      providerId: "google-ads-api/v25",
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

    // Structure, including the REMOVED campaign / ad group / ad (their delivery resolves).
    expect(
      db.campaigns
        .map((c) => [c.externalId, c.status, c.channelType, c.budgetType, c.isSharedBudget])
        .sort(),
    ).toEqual([
      ["10000000001", "active", "search", "daily", false],
      ["10000000002", "active", "performance_max", "daily", true],
      ["10000000003", "removed", "search", "lifetime", false],
      ["10000000004", "paused", "display", "daily", true],
    ]);
    const shared = db.campaigns.filter((c) => c.attributes?.campaignBudgetId === "5000002");
    expect(shared.map((c) => c.externalId).sort()).toEqual(["10000000002", "10000000004"]);
    expect(db.campaigns.every((c) => c.removedAt === undefined)).toBe(true);
    expect(db.adGroups.map((g) => [g.externalId, g.kind]).sort()).toEqual([
      ["20000000001", "ad_group"],
      ["20000000002", "ad_group"],
      ["20000000003", "ad_group"],
      ["30000000001", "asset_group"],
    ]);
    expect(db.ads).toHaveLength(4);
    expect(db.creatives).toHaveLength(4);
    expect(db.ads.every((a) => a.creativeId !== undefined && a.adGroupId !== undefined)).toBe(true);

    // Account "all" rows: the delivered days, exact micros, documented conversion columns.
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
    const spend = (rows: typeof accountAll) => rows.reduce((t2, r) => t2 + r.spendMicros!, 0n);
    expect(spend(accountAll)).toBe(BigInt(sum(facts(), (f) => f.costMicros)));
    const conversions = facts().flatMap((f) => f.conversions ?? []);
    expect(sum(accountAll, (r) => r.allConversions!)).toBe(sum(conversions, (c) => c.count));
    expect(sum(accountAll, (r) => r.conversions!)).toBe(sum(counted(), (c) => c.count));
    expect(accountAll.every((r) => r.currency === "USD" && r.reach === undefined)).toBe(true);

    // Placement rows: Google's own networks only; raw values kept; "other" accumulated.
    const placements = db.metrics.filter((r) => r.placement !== "all");
    expect(new Set(placements.map((r) => r.placement))).toEqual(
      new Set(["google_search", "search_partners", "cross_network", "other"]),
    );
    expect(placements.every((r) => r.rawPlacement !== undefined)).toBe(true);
    const otherDay1 = placements.filter(
      (r) => r.placement === "other" && r.date === "2026-03-01" && r.level === "account",
    );
    expect(otherDay1).toHaveLength(1);
    expect(otherDay1[0]!.rawPlacement).toBe("GOOGLE_OWNED_CHANNELS,GOOGLE_TV");

    // Performance Max asset group: "all" rows only — never a synthetic placement.
    const assetGroup = db.adGroups.find((g) => g.kind === "asset_group")!;
    const assetRows = db.metrics.filter((r) => r.entityId === assetGroup._id);
    expect(assetRows).toHaveLength(7);
    expect(assetRows.every((r) => r.placement === "all")).toBe(true);
    expect(db.metrics.some((r) => r.level === "ad_group" && r.placement === "cross_network")).toBe(
      false,
    );

    // Level totals: campaign and ad group "all" rows add up to the account; the ad level
    // excludes Performance Max delivery (asset groups have no ads).
    for (const level of ["campaign", "ad_group"] as const) {
      const rows = db.metrics.filter((r) => r.level === level && r.placement === "all");
      expect(spend(rows), level).toBe(spend(accountAll));
    }
    const adAll = db.metrics.filter((r) => r.level === "ad" && r.placement === "all");
    const pmaxSpend = BigInt(
      sum(
        facts().filter((f) => f.assetGroupId !== undefined),
        (f) => f.costMicros,
      ),
    );
    expect(spend(adAll)).toBe(spend(accountAll) - pmaxSpend);

    // Reported zero stays zero.
    const adIds = new Map(db.ads.map((a) => [a._id as string, a.externalId]));
    const zero = db.metrics.filter(
      (r) =>
        r.level === "ad" &&
        adIds.get(r.entityId) === "20000000001~40000000002" &&
        r.placement === "search_partners",
    );
    expect(zero).toHaveLength(7);
    expect(zero.every((r) => r.clicks === 0 && r.spendMicros === 0n && r.conversions === 0)).toBe(
      true,
    );

    // Action rows: one per conversion action (resource-name identity), the "action_setting"
    // window bucket, interaction date.
    expect(new Set(db.actions.map((r) => r.attributionWindow))).toEqual(
      new Set(["action_setting"]),
    );
    expect(db.actions.every((r) => r.attributionBasis === "impression_or_click_date")).toBe(true);
    expect(db.actions.every((r) => r.placement === "all")).toBe(true);
    const primary = new Map(db.actions.map((r) => [r.rawActionType, r.isPrimary]));
    expect(Object.fromEntries(primary)).toEqual({
      [resource("900000001")]: true,
      [resource("900000002")]: false,
      [resource("900000003")]: undefined,
      [resource("900000004")]: true,
    });
    expect(
      db.actions.every((r) => r.rawActionType === resource(r.conversionActionExternalId!)),
    ).toBe(true);
    const accountActions = db.actions.filter((r) => r.level === "account");
    expect(sum(accountActions, (r) => r.count)).toBe(sum(conversions, (c) => c.count));
    const purchaseValue = accountActions
      .filter((r) => r.conversionActionExternalId === "900000001")
      .reduce((t2, r) => t2 + r.valueMicros!, 0n);
    expect(purchaseValue).toBe(
      numberToMicros(
        sum(
          conversions.filter((c) => c.actionId === "900000001"),
          (c) => c.value ?? 0,
        ),
      ),
    );
    // Ad-group level includes the Performance Max asset group's conversions.
    expect(db.actions.some((r) => r.level === "ad_group" && r.entityId === assetGroup._id)).toBe(
      true,
    );

    // Transport: read-only searches routed through the manager; nothing secret in any URL.
    const searches = fake.log.slice(logStart).filter((e) => e.kind === "search");
    expect(searches.every((e) => e.method === "POST" && e.loginCustomerId === "1110000001")).toBe(
      true,
    );
    expect(fake.log.every((e) => !e.secretInUrl && e.kind !== "other")).toBe(true);
    // A complete sync without any developer token (sunset 2026-09-09): none is ever sent.
    expect(fake.log.every((e) => !e.developerTokenHeader)).toBe(true);
  });

  it("serves the synced data through the v1 analytics the dashboard uses", async () => {
    const t = newBackend();
    const { adAccountId } = await syncGoogle(t);
    const conversions = facts().flatMap((f) => f.conversions ?? []);

    const overview = await as(t).query(api.v1.analytics.overview, { range: FAKE_GOOGLE_RANGE });
    expect(overview.accountCount).toBe(1);
    expect(overview.totals.dataState).toBe("reported");
    expect(overview.totals.metrics.spend?.native).toEqual([
      { currency: "USD", micros: String(sum(facts(), (f) => f.costMicros)) },
    ]);
    expect(overview.totals.metrics.impressions).toBe(sum(facts(), (f) => f.impressions));
    expect(overview.totals.metrics.clicks).toBe(sum(facts(), (f) => f.clicks));
    expect(overview.totals.metrics.allConversions).toBe(sum(conversions, (c) => c.count));
    expect(overview.totals.metrics.conversions).toBe(sum(counted(), (c) => c.count));
    expect(overview.totals.metrics.conversions).toBeLessThan(
      overview.totals.metrics.allConversions!,
    );
    expect(overview.totals.metrics.reach).toBeUndefined();

    const campaigns = await as(t).query(api.v1.analytics.performance, {
      level: "campaign",
      range: FAKE_GOOGLE_RANGE,
      parent: { accountId: adAccountId },
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(campaigns.page.map((r) => r.entity.externalId).sort()).toEqual([
      "10000000001",
      "10000000002",
      "10000000003",
      "10000000004",
    ]);
    expect(campaigns.page.find((r) => r.entity.externalId === "10000000003")!.entity).toMatchObject(
      { status: "removed", platform: "google_ads" },
    );

    const byPlacement = await as(t).query(api.v1.analytics.breakdown, {
      by: "placement",
      range: FAKE_GOOGLE_RANGE,
    });
    const withData = (groups: typeof byPlacement.groups) =>
      groups.filter((g) => g.metrics.impressions !== undefined).map((g) => g.key);
    expect(new Set(withData(byPlacement.groups))).toEqual(
      new Set(["google_search", "search_partners", "cross_network", "other"]),
    );
    // At the ad-group level the asset group has no placement rows: the loss is visible
    // (placement totals < "all" totals), never filled with a synthetic cross_network row.
    const adGroupPlacements = await as(t).query(api.v1.analytics.breakdown, {
      by: "placement",
      level: "ad_group",
      range: FAKE_GOOGLE_RANGE,
    });
    expect(withData(adGroupPlacements.groups)).not.toContain("cross_network");
    expect(new Set(withData(adGroupPlacements.groups))).toEqual(
      new Set(["google_search", "search_partners"]),
    );

    const actions = await as(t).query(api.v1.analytics.actions, {
      range: FAKE_GOOGLE_RANGE,
      filters: { accountIds: [adAccountId] },
    });
    expect(new Set(actions.groups.map((g) => g.attributionWindow))).toEqual(
      new Set(["action_setting"]),
    );
    // One group per conversion action (identity = resource name), whatever its display name.
    expect(actions.groups.map((g) => g.rawActionType).sort()).toEqual(
      ["900000001", "900000002", "900000003", "900000004"].map(resource),
    );
    expect(new Set(actions.groups.map((g) => g.actionType))).toEqual(
      new Set(["purchase", "complete_registration", "other", "lead"]),
    );
    const primaryOnly = await as(t).query(api.v1.analytics.actions, {
      range: FAKE_GOOGLE_RANGE,
      filters: { accountIds: [adAccountId], primaryOnly: true },
    });
    expect(new Set(primaryOnly.groups.map((g) => g.actionType))).toEqual(
      new Set(["purchase", "lead"]),
    );
  });

  it("re-syncing the same window is idempotent (rows replaced, never duplicated)", async () => {
    const t = newBackend();
    const { adAccountId } = await syncGoogle(t);
    const before = await canonicalRows(t);
    vi.advanceTimersByTime(20 * 60_000);
    const result = await t.mutation(internal.sync.admin.requestSync, {
      adAccountId,
      kind: "manual",
      from: "2026-02-07",
      to: "2026-03-08",
    });
    expect(result.status).toBe("started");
    await drainScheduler(t);
    const db = await snapshot(t);
    const manual = db.runs.find((r) => r.kind === "manual")!;
    expect(manual.status).toBe("succeeded");
    expect(manual.counts.inserted).toBe(0);
    expect(manual.counts.pruned).toBe(0);
    expect(await canonicalRows(t)).toEqual(before);
    expect(db.campaigns).toHaveLength(4);
  });

  it("page boundaries never change stored rows (slicing, Google pages, carry)", async () => {
    const reference = newBackend();
    await syncGoogle(reference);
    const expected = await canonicalRows(reference);

    // Google returns 3-row pages: listings, metrics, the "other" carry and the lookup... the
    // lookup must fit one Google page, so this dataset keeps 4 conversion actions on a 5-row page.
    data = fakeGoogleDataset();
    fake = createFakeGoogleAds({ dataset: data, pageSize: 5 });
    const t = newBackend();
    await syncGoogle(t);
    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("succeeded");
    expect(db.tasks.some((task) => task.pages > 5)).toBe(true);
    expect(await canonicalRows(t)).toEqual(expected);
  });

  it("conversion-action identity across syncs: rename, same-name action, rerun", async () => {
    const t = newBackend();
    const { adAccountId } = await syncGoogle(t);
    const before = await canonicalRows(t);

    // 1. Same id, renamed at Google: a re-sync keeps the same logical rows (nothing new,
    //    nothing pruned) — the display name is not part of the identity.
    data.conversionActions[ACCOUNT]!.find((a) => a.id === "900000001")!.name = "Online sales";
    vi.advanceTimersByTime(20 * 60_000);
    await t.mutation(internal.sync.admin.requestSync, {
      adAccountId,
      kind: "manual",
      from: "2026-02-07",
      to: "2026-03-08",
    });
    await drainScheduler(t);
    let db = await snapshot(t);
    const renamedRun = db.runs.find((r) => r.kind === "manual")!;
    expect(renamedRun.status).toBe("succeeded");
    expect(renamedRun.counts).toMatchObject({ inserted: 0, pruned: 0 });
    expect(await canonicalRows(t)).toEqual(before);

    // 2. A second action with the SAME display name but another id: its own rows, no collision.
    data.conversionActions[ACCOUNT]!.push({
      id: "900000005",
      name: "Online sales",
      status: "ENABLED",
      category: "PURCHASE",
      primaryForGoal: false,
    });
    data.facts
      .filter((f) => f.adId === "40000000001" && f.network === "SEARCH")
      .forEach((f) => f.conversions!.push({ actionId: "900000005", count: 0.5 }));
    vi.advanceTimersByTime(20 * 60_000);
    await t.mutation(internal.sync.admin.requestSync, {
      adAccountId,
      kind: "manual",
      from: "2026-02-07",
      to: "2026-03-08",
    });
    await drainScheduler(t);
    db = await snapshot(t);
    expect(db.runs.filter((r) => r.kind === "manual").every((r) => r.status === "succeeded")).toBe(
      true,
    );
    const second = db.actions.filter((r) => r.conversionActionExternalId === "900000005");
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((r) => r.rawActionType === resource("900000005") && !r.isPrimary)).toBe(
      true,
    );
    const first = db.actions.filter(
      (r) => r.conversionActionExternalId === "900000001" && r.level === "account",
    );
    expect(sum(first, (r) => r.count)).toBe(
      sum(
        facts().flatMap((f) => (f.conversions ?? []).filter((c) => c.actionId === "900000001")),
        (c) => c.count,
      ),
    );

    // 3. Rerunning the same data changes nothing.
    const settled = await canonicalRows(t);
    vi.advanceTimersByTime(20 * 60_000);
    await t.mutation(internal.sync.admin.requestSync, {
      adAccountId,
      kind: "manual",
      from: "2026-02-07",
      to: "2026-03-08",
    });
    await drainScheduler(t);
    const last = (await snapshot(t)).runs.filter((r) => r.kind === "manual").at(-1)!;
    expect(last.counts).toMatchObject({ inserted: 0, pruned: 0 });
    expect(await canonicalRows(t)).toEqual(settled);
  });

  it("restated-away delivery is pruned; removed structure is marked removed", async () => {
    const t = newBackend();
    const { adAccountId } = await syncGoogle(t);
    // Google no longer reports 2026-03-07 and the Display campaign / its ad group and ad.
    data.facts.splice(0, data.facts.length, ...data.facts.filter((f) => f.date !== "2026-03-07"));
    data.campaigns[ACCOUNT] = data.campaigns[ACCOUNT]!.filter((c) => c.id !== "10000000004");
    data.adGroups[ACCOUNT] = data.adGroups[ACCOUNT]!.filter((g) => g.id !== "20000000003");
    data.ads[ACCOUNT] = data.ads[ACCOUNT]!.filter((a) => a.id !== "40000000004");
    vi.advanceTimersByTime(20 * 60_000);
    await t.mutation(internal.sync.admin.requestSync, {
      adAccountId,
      kind: "manual",
      from: "2026-03-01",
      to: "2026-03-08",
    });
    await drainScheduler(t);
    const db = await snapshot(t);
    const manual = db.runs.find((r) => r.kind === "manual")!;
    expect(manual.status).toBe("succeeded");
    expect(manual.counts.pruned).toBeGreaterThan(0);
    expect(db.metrics.some((r) => r.date === "2026-03-07")).toBe(false);
    expect(db.actions.some((r) => r.date === "2026-03-07")).toBe(false);
    const display = db.campaigns.find((c) => c.externalId === "10000000004")!;
    expect(display.removedAt).toBeDefined();
    expect(display.status).toBe("paused"); // provider-owned status is untouched
    expect(db.adGroups.find((g) => g.externalId === "20000000003")!.removedAt).toBeDefined();
    expect(db.ads.find((a) => a.externalId === "20000000003~40000000004")!.removedAt).toBeDefined();
  });
});

describe("Google failure handling during sync", () => {
  it("a failing metric task leaves the run partial and never advances coverage", async () => {
    fake.inject({
      match: (e) =>
        e.kind === "search" &&
        /FROM ad_group_ad/.test(e.query ?? "") &&
        /metrics\./.test(e.query ?? ""),
      times: 1_000,
      response: adsError(400, "INVALID_ARGUMENT", "queryError", "UNRECOGNIZED_FIELD"),
    });
    const t = newBackend();
    await syncGoogle(t);
    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("partial");
    const failed = db.tasks.filter((task) => task.status === "failed");
    expect(failed.length).toBeGreaterThan(0);
    expect(failed.every((task) => task.level === "ad")).toBe(true);
    expect(failed[0]!.lastError).toMatchObject({
      kind: "invalid_request",
      code: "UNRECOGNIZED_FIELD",
    });
    // Both windows had a failed task: coverage does not advance.
    expect(db.states[0]!.coveredThrough).toBeUndefined();
    // Everything else was stored.
    expect(db.metrics.some((r) => r.level === "campaign")).toBe(true);
    expect(db.metrics.some((r) => r.level === "ad")).toBe(false);
    expect(db.connections[0]!.status).toBe("active");
  });

  it("a quota error is retried after Google's RetryInfo delay and the run completes", async () => {
    fake.inject({
      match: (e) =>
        e.kind === "search" &&
        /FROM campaign /.test(e.query ?? "") &&
        !/metrics\./.test(e.query ?? ""),
      response: adsError(429, "RESOURCE_EXHAUSTED", "quotaError", "RESOURCE_EXHAUSTED", "90s"),
    });
    const t = newBackend();
    await syncGoogle(t);
    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("succeeded");
    const throttled = db.tasks.filter((task) => task.totalAttempts > task.pages);
    expect(throttled).toHaveLength(1);
    expect(throttled[0]!.operation).toBe("listCampaigns");
    expect(db.states[0]!.throttledUntil).toBeGreaterThanOrEqual(NOW.getTime() + 90_000);
  });

  it("an expired Google page token restarts the task once from page 1", async () => {
    data = fakeGoogleDataset();
    fake = createFakeGoogleAds({ dataset: data, pageSize: 5 });
    const t = newBackend();
    stubLiveGoogle(fake);
    await setupSyncOrg(t);
    const connectionId = (await connectGoogleFake(t, fake, "u1")).get("connection")!;
    await linkMock(t, connectionId, [ACCOUNT]);
    fake.inject({
      match: (e) => e.kind === "search" && e.pageToken === true,
      response: adsError(400, "INVALID_ARGUMENT", "requestError", "EXPIRED_PAGE_TOKEN"),
    });
    await planAndDrain(t);
    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("succeeded");
    expect(db.tasks.filter((task) => task.restartedFromScratch)).toHaveLength(1);
  });

  it("a transient 5xx is retried by the sync (no retries inside the client)", async () => {
    fake.inject({
      match: (e) => e.kind === "search" && /FROM customer /.test(e.query ?? ""),
      response: adsError(503, "UNAVAILABLE", "internalError", "TRANSIENT_ERROR"),
    });
    const t = newBackend();
    await syncGoogle(t);
    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("succeeded");
    expect(db.tasks.filter((task) => task.totalAttempts > task.pages)).toHaveLength(1);
  });
});

describe("Google quota measurement (initial sync of the fake dataset)", () => {
  it("records Google Ads searches per task kind and token mints separately", async () => {
    const t = newBackend();
    stubLiveGoogle(fake);
    await setupSyncOrg(t);
    const connectionId = (await connectGoogleFake(t, fake, "u1")).get("connection")!;
    await linkMock(t, connectionId, [ACCOUNT]);
    const before = fake.log.length;
    await planAndDrain(t);
    const db = await snapshot(t);
    const sync = fake.log.slice(before);
    const shape = (query: string) => {
      const from = /FROM (\w+)/.exec(query)![1];
      if (from === "customer_client") return "route";
      if (from === "conversion_action") return "lookup";
      if (!/metrics\./.test(query)) return from === "customer" ? "getAccount" : `list:${from}`;
      return `${/conversion_action/.test(query) ? "actions" : "daily"}:${from}${/ad_network_type/.test(query) ? ":network" : ""}`;
    };
    const perShape: Record<string, number> = {};
    for (const entry of sync.filter((e) => e.kind === "search")) {
      const key = shape(entry.query!);
      perShape[key] = (perShape[key] ?? 0) + 1;
    }
    // One search per provider page of each task; route + lookup on the first page only.
    const tasks = db.tasks.length;
    const providerPages = db.tasks.reduce((t2, task) => t2 + task.pages, 0);
    expect(tasks).toBe(21);
    expect(perShape.route).toBe(tasks);
    expect(perShape.lookup).toBe(8); // 2 windows × 4 levels of action tasks
    expect(perShape.getAccount).toBeUndefined(); // a managed account is described by its route row
    expect(sync.filter((e) => e.kind === "accessible")).toHaveLength(tasks);
    const flushPages = providerPages - sync.filter((e) => e.kind === "token_refresh").length;
    expect(flushPages).toBeGreaterThanOrEqual(0);
    expect(sync.filter((e) => e.kind === "token_refresh")).toHaveLength(providerPages - flushPages);
    // The quota table of the Stage B report (fake dataset; not real-account evidence).
    expect(perShape).toEqual({
      route: 21,
      lookup: 8,
      "list:campaign": 1,
      "list:ad_group": 1,
      "list:asset_group": 1,
      "list:ad_group_ad": 2,
      "daily:customer": 2,
      "daily:customer:network": 2,
      "daily:campaign": 2,
      "daily:campaign:network": 2,
      "daily:ad_group": 2,
      "daily:asset_group": 2,
      "daily:ad_group:network": 2,
      "daily:ad_group_ad": 2,
      "daily:ad_group_ad:network": 2,
      "actions:customer": 2,
      "actions:campaign": 2,
      "actions:ad_group": 2,
      "actions:asset_group": 2,
      "actions:ad_group_ad": 2,
    });
    expect({
      providerPages,
      flushPages,
      searches: sync.filter((e) => e.kind === "search").length,
    }).toEqual({ providerPages: 36, flushPages: 2, searches: 62 });
  });
});

describe("tenant isolation and secrets", () => {
  it("keeps tenants apart: another org sees none of the Google data", async () => {
    const t = newBackend();
    await syncGoogle(t);
    await setupSyncOrg(t, { issuer: ISSUER_CRM });
    const other = await as(t, { issuer: ISSUER_CRM }).query(api.v1.analytics.overview, {
      range: FAKE_GOOGLE_RANGE,
    });
    expect(other.accountCount).toBe(0);
    expect(other.totals.metrics.spend).toBeUndefined();
  });

  it("two orgs syncing the same Google account keep independent canonical rows", async () => {
    const t = newBackend();
    await syncGoogle(t);
    const crm = { issuer: ISSUER_CRM };
    await syncGoogle(t, crm);
    const db = await snapshot(t);
    expect(db.accounts).toHaveLength(2);
    expect(new Set(db.accounts.map((a) => a.orgId)).size).toBe(2);
    const perOrg = (orgId: string) => db.metrics.filter((r) => r.orgId === orgId).length;
    expect(perOrg(db.accounts[0]!.orgId)).toBe(perOrg(db.accounts[1]!.orgId));
    const crmOverview = await as(t, crm).query(api.v1.analytics.overview, {
      range: FAKE_GOOGLE_RANGE,
    });
    expect(crmOverview.accountCount).toBe(1);
  });

  it("stores no token, secret, request id or Google URL anywhere", async () => {
    const t = newBackend();
    await syncGoogle(t);
    const all = await t.run(async (ctx) => {
      const out: Record<string, unknown[]> = {};
      for (const table of Object.keys(schema.tables) as (keyof typeof schema.tables)[]) {
        out[table] = await ctx.db.query(table).collect();
      }
      return out;
    });
    const text = JSON.stringify(all, (_k, value) => {
      if (typeof value === "bigint") return value.toString();
      if (value instanceof ArrayBuffer) return "<bytes>";
      return value;
    });
    for (const marker of [
      "test-refresh-",
      "test-access-",
      "test-gcode-",
      FAKE_GOOGLE_CLIENT_SECRET,
      "googleads.googleapis.com",
      "oauth2.googleapis.com",
      "fakeRequestId",
      "Fake Google Ads error",
      "campaignBudgets/",
    ]) {
      expect(text, marker).not.toContain(marker);
    }
  });
});

describe("capabilities drive planning (no sync change)", () => {
  const state = { structureStale: false, backfillHorizon: "2025-03-01" };

  it("plans every declared level for daily and action metrics; actions without a breakdown", () => {
    const plan = buildRunPlan({
      kind: "initial",
      state,
      capabilities: GOOGLE_CAPABILITIES,
      timezone: "America/New_York",
      now: NOW.getTime(),
    });
    expect(plan.tasks).toHaveLength(21);
    const daily = plan.tasks.filter((task) => task.operation === "fetchDailyMetrics");
    const actions = plan.tasks.filter((task) => task.operation === "fetchActionMetrics");
    expect(daily.every((task) => task.breakdown === "placement")).toBe(true);
    expect(actions.every((task) => task.breakdown === "none")).toBe(true);
    expect(new Set(daily.map((task) => task.level))).toEqual(
      new Set(["account", "campaign", "ad_group", "ad"]),
    );
  });

  it("an unsupported capability plans no task", () => {
    const plan = buildRunPlan({
      kind: "initial",
      state,
      capabilities: { ...GOOGLE_CAPABILITIES, actionMetrics: false, placementBreakdown: false },
      timezone: "America/New_York",
      now: NOW.getTime(),
    });
    expect(plan.tasks.some((task) => task.operation === "fetchActionMetrics")).toBe(false);
    expect(plan.tasks.every((task) => task.breakdown !== "placement")).toBe(true);
  });

  it("the guards reject any placement Google does not declare", () => {
    expect(allowedPlacements("placement", GOOGLE_CAPABILITIES)).not.toContain("facebook");
    const row = {
      platform: "google_ads",
      accountExternalId: ACCOUNT,
      level: "account",
      entityExternalId: ACCOUNT,
      date: "2026-03-02",
      placement: "facebook",
      currency: "USD",
    };
    const scope = {
      operation: "fetchDailyMetrics" as const,
      platform: "google_ads",
      accountExternalId: ACCOUNT,
      currency: "USD",
      level: "account",
      from: "2026-03-01",
      to: "2026-03-07",
      breakdown: "placement" as const,
      capabilities: GOOGLE_CAPABILITIES,
    };
    expect(checkRecordsInScope("metricRow", [row], scope)).toBe("out_of_scope");
    expect(
      checkRecordsInScope("metricRow", [{ ...row, placement: "gmail" }], scope),
    ).toBeUndefined();
  });
});
