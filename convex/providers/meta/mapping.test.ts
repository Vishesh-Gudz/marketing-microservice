import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetaAdsProvider } from ".";
import { expectProviderError } from "../contract.suite";
import { collectAll } from "../pagination";
import type { MetricsRequest, ProviderActionRow, ProviderMetricRow, ProviderPage } from "../types";
import type { MetaCredential } from "./credential";
import {
  createFakeGraph,
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  FAKE_RANGE,
  fakeMetaDataset,
  graphError,
  installFakeGraph,
  type FakeCell,
  type FakeGraph,
} from "./fakeGraph.fixtures";
import {
  attributionLabel,
  normalizeCampaign,
  normalizeInsightActions,
  normalizeInsightRow,
} from "./normalize";
import type { RawCampaign, RawInsight } from "./schemas";

// Phase 8 Stage B: the PROVISIONAL Meta semantics (semantics.ts, docs/providers/meta.md
// "Real-account validation required"), pinned against the fake Graph. These tests prove the
// implementation does what the documented assumptions say — not that Meta behaves that way.

const credential: MetaCredential = {
  kind: "meta",
  v: 1,
  accessToken: "test-long-u1",
  tokenType: "user",
  appId: FAKE_APP_ID,
  issuedAt: 1,
};
const ctx = (attempt = 1) => ({ credential, attempt });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(graph: FakeGraph = createFakeGraph()) {
  installFakeGraph(graph);
  return {
    graph,
    provider: createMetaAdsProvider({ appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET }),
  };
}

const request = (
  level: MetricsRequest["level"],
  breakdown: MetricsRequest["breakdown"] = "none",
): MetricsRequest => ({ accountExternalId: "1001", level, breakdown, ...FAKE_RANGE });

async function all<T>(fetch: (cursor?: string) => Promise<ProviderPage<T>>) {
  return (await collectAll((cursor) => fetch(cursor))).items;
}

const cells = (): FakeCell[] => fakeMetaDataset().cells["1001"]!;
const sum = (list: FakeCell[], pick: (c: FakeCell) => number) =>
  list.reduce((total, c) => total + pick(c), 0);

describe("structure (campaigns, ad sets, ads, creatives)", () => {
  it("lists campaigns including ARCHIVED and DELETED ones, with statuses, objectives and budgets", async () => {
    const { graph, provider } = setup();
    const campaigns = await all((cursor) =>
      provider.listCampaigns(ctx(), { accountExternalId: "1001", ...(cursor ? { cursor } : {}) }),
    );
    expect(campaigns).toEqual([
      expect.objectContaining({
        externalId: "2001",
        status: "active",
        rawStatus: "ACTIVE",
        deliveryStatus: "delivering",
        objective: "sales",
        rawObjective: "OUTCOME_SALES",
        channelType: "social",
        budgetType: "daily",
        budgetMicros: 150_000_000n, // 15000 cents = USD 150
        budgetLevel: "campaign", // CBO
        bidStrategy: "LOWEST_COST_WITHOUT_CAP",
        startDate: "2026-02-15",
        platformCreatedAt: Date.parse("2026-02-10T14:00:00Z"),
        attributes: { effectiveStatus: "ACTIVE" },
      }),
      expect.objectContaining({
        externalId: "2002",
        status: "paused",
        deliveryStatus: "not_delivering",
        objective: "leads",
        budgetType: "none",
        budgetLevel: "ad_group", // ABO
        startDate: "2026-02-20",
        endDate: "2026-04-30",
      }),
      expect.objectContaining({
        externalId: "2003",
        status: "archived",
        deliveryStatus: "ended",
        objective: "awareness",
        rawObjective: "REACH",
        budgetType: "lifetime",
        budgetMicros: 500_000_000n,
        endDate: "2026-03-31",
      }),
      expect.objectContaining({
        externalId: "2004",
        status: "removed",
        deliveryStatus: "ended",
        objective: "traffic",
        rawObjective: "LINK_CLICKS",
      }),
    ]);
    expect(campaigns[1]).not.toHaveProperty("budgetMicros");
    // The account's currency/time zone are read first; the listing asks for every status.
    const [lookup, listing] = graph.log.slice(-2);
    expect(lookup).toMatchObject({
      path: "act_1001",
      params: { fields: "currency,timezone_name" },
    });
    expect(JSON.parse(listing!.params.effective_status!)).toEqual(
      expect.arrayContaining(["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"]),
    );
  });

  it("maps ad sets (ABO budgets, attribution setting) and ads (creative link, format)", async () => {
    const { provider } = setup();
    const adSets = await all((cursor) =>
      provider.listAdGroups(ctx(), { accountExternalId: "1001", ...(cursor ? { cursor } : {}) }),
    );
    expect(adSets.map((g) => [g.externalId, g.campaignExternalId, g.kind])).toEqual([
      ["3001", "2001", "ad_set"],
      ["3002", "2002", "ad_set"],
      ["3003", "2003", "ad_set"],
      ["3004", "2004", "ad_set"],
    ]);
    expect(adSets[0]).toMatchObject({
      status: "active",
      attributionSetting: "7d_click_1d_view",
      optimizationGoal: "OFFSITE_CONVERSIONS",
    });
    expect(adSets[0]).not.toHaveProperty("budgetMicros");
    expect(adSets[1]).toMatchObject({
      status: "active",
      deliveryStatus: "not_delivering", // CAMPAIGN_PAUSED
      budgetType: "daily",
      budgetMicros: 50_000_000n,
      attributionSetting: "1d_click",
    });
    expect(adSets[3]).toMatchObject({ status: "removed", deliveryStatus: "ended" });

    const ads = await all((cursor) =>
      provider.listAds(ctx(), { accountExternalId: "1001", ...(cursor ? { cursor } : {}) }),
    );
    expect(
      ads.map((a) => [a.externalId, a.adGroupExternalId, a.creativeExternalId, a.format]),
    ).toEqual([
      ["4001", "3001", "5001", "image"],
      ["4002", "3001", "5002", "video"],
      ["4003", "3002", "5003", "other"], // SHARE: link ad, carousel not guessed
      ["4004", "3003", "5001", "image"],
      ["4005", "3004", undefined, undefined],
    ]);
    expect(ads[4]).toMatchObject({ status: "removed", deliveryStatus: "ended" });
  });

  it("maps creatives; unknown object types stay 'other' with the raw type kept", async () => {
    const { provider } = setup();
    const creatives = await all((cursor) =>
      provider.listCreatives(ctx(), { accountExternalId: "1001", ...(cursor ? { cursor } : {}) }),
    );
    expect(creatives[0]).toEqual({
      platform: "meta",
      accountExternalId: "1001",
      externalId: "5001",
      format: "image",
      title: "Spring sale",
      body: "Up to 30% off",
      callToAction: "SHOP_NOW",
      linkUrl: "https://shop.example.test/spring",
      thumbnailUrl: "https://cdn.example.test/t/5001.jpg",
      imageUrl: "https://cdn.example.test/i/5001.jpg",
      instagramMediaExternalId: "17900000000000001",
      facebookPostExternalId: "7770002_9990001",
      attributes: { objectType: "PHOTO" },
    });
    expect(creatives[1]).toMatchObject({ format: "video", videoExternalId: "6660001" });
    expect(creatives[2]).toMatchObject({ format: "other", attributes: { objectType: "SHARE" } });
  });
});

describe("budgets, currencies and time zones (R10)", () => {
  const raw = (budget: string): RawCampaign => ({
    id: "1",
    name: "c",
    status: "ACTIVE",
    daily_budget: budget,
    start_time: "2026-02-28T23:30:00-0800",
  });

  it.each([
    ["USD", "15000", 150_000_000n],
    ["EUR", "999", 9_990_000n],
    ["JPY", "5000", 5_000_000_000n],
    ["KRW", "10000", 10_000_000_000n],
  ])("%s budget %s → %s micros", (currency, budget, micros) => {
    const campaign = normalizeCampaign(raw(budget), "1001", { currency, timezone: "UTC" });
    expect(campaign).toMatchObject({ budgetType: "daily", budgetMicros: micros });
    expect(campaign.attributes?.rawDailyBudget).toBeUndefined();
  });

  it.each(["IDR", "TWD", "HUF", "COP", "CRC", "KWD"])(
    "%s: offset not safely known → no budgetMicros, raw integer kept",
    (currency) => {
      const campaign = normalizeCampaign(raw("250000"), "1001", { currency, timezone: "UTC" });
      expect(campaign).toMatchObject({ budgetType: "daily", budgetLevel: "campaign" });
      expect(campaign).not.toHaveProperty("budgetMicros");
      expect(campaign.attributes).toMatchObject({ rawDailyBudget: "250000" });
    },
  );

  it('"0" is no budget (ABO), never a zero budget', () => {
    const campaign = normalizeCampaign(raw("0"), "1001", { currency: "USD", timezone: "UTC" });
    expect(campaign).toMatchObject({ budgetType: "none", budgetLevel: "ad_group" });
    expect(campaign).not.toHaveProperty("budgetMicros");
  });

  it("dates are the ad account's calendar day of the Meta instant", () => {
    const tokyo = normalizeCampaign(raw("100"), "1001", {
      currency: "USD",
      timezone: "Asia/Tokyo",
    });
    expect(tokyo.startDate).toBe("2026-03-01"); // 23:30 PST = 16:30 next day in Tokyo
    const la = normalizeCampaign(raw("100"), "1001", {
      currency: "USD",
      timezone: "America/Los_Angeles",
    });
    expect(la.startDate).toBe("2026-02-28");
  });

  it("labels attribution settings click, view, engaged-view", () => {
    expect(
      attributionLabel([
        { event_type: "VIEW_THROUGH", window_days: 1 },
        { event_type: "CLICK_THROUGH", window_days: 7 },
        { event_type: "ENGAGED_VIDEO_VIEW", window_days: 1 },
      ]),
    ).toBe("7d_click_1d_view_1d_ev");
    expect(attributionLabel([])).toBeUndefined();
  });
});

describe("daily insights (R11–R15)", () => {
  it("requests account-local days with the unified attribution setting and impression-time reporting", async () => {
    const { graph, provider } = setup();
    await all((cursor) =>
      provider.fetchDailyMetrics(ctx(), { ...request("campaign"), ...(cursor ? { cursor } : {}) }),
    );
    const call = graph.log.find((e) => e.path === "act_1001/insights")!;
    expect(call.params).toMatchObject({
      level: "campaign",
      time_increment: "1",
      use_unified_attribution_setting: "true",
      action_report_time: "impression",
    });
    expect(JSON.parse(call.params.time_range!)).toEqual({
      since: "2026-03-01",
      until: "2026-03-07",
    });
    expect(call.params.fields!.split(",")).toEqual(
      expect.arrayContaining([
        "spend",
        "impressions",
        "clicks",
        "reach",
        "actions",
        "action_values",
      ]),
    );
    expect(JSON.parse(call.params.filtering!)).toEqual([
      {
        field: "campaign.effective_status",
        operator: "IN",
        value: ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"],
      },
    ]);
    expect(call.params).not.toHaveProperty("breakdowns");
  });

  it("account totals equal the delivery; conversions = omni_purchase + lead, never double counted", async () => {
    const { provider } = setup();
    const rows = await all((cursor) =>
      provider.fetchDailyMetrics(ctx(), { ...request("account"), ...(cursor ? { cursor } : {}) }),
    );
    expect(rows).toHaveLength(7);
    expect(rows.every((r) => r.placement === "all" && r.currency === "USD")).toBe(true);
    const all7 = cells();
    const spendMicros = rows.reduce((total, r) => total + r.spendMicros!, 0n);
    expect(spendMicros).toBe(BigInt(sum(all7, (c) => c.spendCents)) * 10_000n);
    expect(rows.reduce((t, r) => t + r.impressions!, 0)).toBe(sum(all7, (c) => c.impressions));
    const purchases = sum(all7, (c) => c.actions.omni_purchase?.value ?? 0);
    const leads = sum(all7, (c) => c.actions.lead?.value ?? 0);
    expect(rows.reduce((t, r) => t + (r.conversions ?? 0), 0)).toBe(purchases + leads);
    expect(rows.reduce((t, r) => t + (r.conversionValueMicros ?? 0n), 0n)).toBe(
      BigInt(sum(all7, (c) => c.values.omni_purchase?.value ?? 0)) * 10_000n,
    );
    expect(rows.every((r) => typeof r.reach === "number")).toBe(true);
  });

  it("includes ARCHIVED and DELETED entities: campaign rows sum to the account rows", async () => {
    const { provider } = setup();
    const byCampaign = await all((cursor) =>
      provider.fetchDailyMetrics(ctx(), { ...request("campaign"), ...(cursor ? { cursor } : {}) }),
    );
    expect(new Set(byCampaign.map((r) => r.entityExternalId))).toEqual(
      new Set(["2001", "2002", "2003", "2004"]),
    );
    const byAccount = await all((cursor) =>
      provider.fetchDailyMetrics(ctx(), { ...request("account"), ...(cursor ? { cursor } : {}) }),
    );
    const spend = (rows: ProviderMetricRow[]) => rows.reduce((t, r) => t + r.spendMicros!, 0n);
    expect(spend(byCampaign)).toBe(spend(byAccount));
  });

  it("missing stays missing, reported zero stays zero (R11)", async () => {
    const { provider } = setup();
    const rows = await all((cursor) =>
      provider.fetchDailyMetrics(ctx(), {
        ...request("ad", "placement"),
        ...(cursor ? { cursor } : {}),
      }),
    );
    const zeroClicks = rows.find(
      (r) =>
        r.entityExternalId === "4002" && r.date === "2026-03-04" && r.placement === "instagram",
    )!;
    expect(zeroClicks.clicks).toBe(0); // Meta reported "0"
    expect(zeroClicks).not.toHaveProperty("linkClicks"); // omitted by Meta: unknown, not 0
    // The video ad reported no purchase/lead action: conversions are absent, not 0.
    const video = rows.filter((r) => r.entityExternalId === "4002");
    expect(video.every((r) => !("conversions" in r) && !("conversionValueMicros" in r))).toBe(true);
    expect(video.some((r) => typeof r.videoPlays === "number")).toBe(true);
    expect(video.some((r) => typeof r.videoCompletions === "number")).toBe(true);
    expect(video.some((r) => typeof r.videoViews === "number")).toBe(true);
    // Engagement comes from the actions array; an unreported action type stays absent.
    expect(rows.some((r) => typeof r.reactions === "number")).toBe(true);
    expect(rows.some((r) => !("comments" in r))).toBe(true);
    // No delivery → no row (4003 stopped delivering after 2026-03-04).
    expect(rows.some((r) => r.entityExternalId === "4003" && r.date > "2026-03-04")).toBe(false);
  });

  it("placement breakdown: 'all' rows (with reach) first, then publisher_platform rows (no reach)", async () => {
    const { graph, provider } = setup();
    const rows = await all((cursor) =>
      provider.fetchDailyMetrics(ctx(), {
        ...request("campaign", "placement"),
        ...(cursor ? { cursor } : {}),
      }),
    );
    const firstBreakdown = rows.findIndex((r) => r.placement !== "all");
    expect(rows.slice(0, firstBreakdown).every((r) => r.placement === "all")).toBe(true);
    expect(rows.slice(firstBreakdown).every((r) => r.placement !== "all")).toBe(true);
    expect(new Set(rows.map((r) => r.placement))).toEqual(
      new Set(["all", "facebook", "instagram", "audience_network", "threads", "other"]),
    );
    const breakdownRows = rows.slice(firstBreakdown);
    expect(breakdownRows.every((r) => !("reach" in r) && r.rawPlacement !== undefined)).toBe(true);
    expect(rows.find((r) => r.placement === "other")!.rawPlacement).toBe("oculus,unknown");
    // Stage 1 asks for the breakdown and never for reach.
    const stage1 = graph.log.find((e) => e.params.breakdowns === "publisher_platform")!;
    expect(stage1.params.fields!.split(",")).not.toContain("reach");
    // Breakdown rows sum to the 'all' rows (additive metrics).
    const spend = (list: ProviderMetricRow[]) => list.reduce((t, r) => t + r.spendMicros!, 0n);
    expect(spend(breakdownRows)).toBe(spend(rows.slice(0, firstBreakdown)));
  });

  it("stage paging is invariant to the page size", async () => {
    const { provider } = setup();
    const small = await all((cursor) =>
      provider.fetchDailyMetrics(ctx(), {
        ...request("ad", "placement"),
        pageSize: 3,
        ...(cursor ? { cursor } : {}),
      }),
    );
    const large = await all((cursor) =>
      provider.fetchDailyMetrics(ctx(), {
        ...request("ad", "placement"),
        ...(cursor ? { cursor } : {}),
      }),
    );
    expect(small).toEqual(large);
  });

  it("omits reach for windows older than the reach cutoff (R12)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2027-06-01T12:00:00Z"));
    const { graph, provider } = setup();
    const rows = await all((cursor) =>
      provider.fetchDailyMetrics(ctx(), { ...request("account"), ...(cursor ? { cursor } : {}) }),
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => !("reach" in r))).toBe(true);
    const call = graph.log.find((e) => e.path === "act_1001/insights")!;
    expect(call.params.fields!.split(",")).not.toContain("reach");
  });

  it("shrinks the page from the 3rd attempt of a page, never below 50 (D23)", async () => {
    const limits: string[] = [];
    const { graph, provider } = setup();
    for (const attempt of [1, 2, 3, 4, 6]) {
      await provider.fetchDailyMetrics(ctx(attempt), request("account"));
      limits.push(graph.log.at(-1)!.params.limit!);
    }
    expect(limits).toEqual(["500", "500", "250", "125", "50"]);
    await provider.fetchDailyMetrics(ctx(5), { ...request("account"), pageSize: 10 });
    expect(graph.log.at(-1)!.params.limit).toBe("10");
  });

  it("a throttled insights page is rate_limited with the header-derived delay", async () => {
    const graph = createFakeGraph();
    graph.inject({
      match: (e) => e.path === "act_1001/insights",
      response: {
        ...graphError(80_000),
        headers: {
          "x-business-use-case-usage": JSON.stringify({
            "1001": [{ type: "ads_insights", estimated_time_to_regain_access: 5 }],
          }),
        },
      },
    });
    const { provider } = setup(graph);
    await expect(provider.fetchDailyMetrics(ctx(), request("account"))).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 300_000,
      retryable: true,
    });
  });

  it.each([
    ["a multi-day row", { date_stop: "2026-03-02" }],
    ["a row of another account", { account_id: "9999" }],
    ["a non-numeric count", { impressions: "12a" }],
    ["a negative spend", { spend: "-1.00" }],
    ["a non-ISO currency", { account_currency: "US Dollar" }],
  ])("rejects %s as a non-retryable data error", async (_label, patch) => {
    const graph = createFakeGraph();
    graph.inject({
      match: (e) => e.path === "act_1001/insights",
      response: {
        status: 200,
        body: {
          data: [
            {
              date_start: "2026-03-01",
              date_stop: "2026-03-01",
              account_id: "1001",
              account_currency: "USD",
              spend: "1.00",
              impressions: "10",
              ...patch,
            },
          ],
        },
      },
    });
    const { provider } = setup(graph);
    await expectProviderError(provider.fetchDailyMetrics(ctx(), request("account")), "data");
  });
});

describe("action metrics (R14, R16)", () => {
  it("requests fixed attribution windows with impression-time reporting (no unified setting)", async () => {
    const { graph, provider } = setup();
    await all((cursor) =>
      provider.fetchActionMetrics(ctx(), { ...request("ad"), ...(cursor ? { cursor } : {}) }),
    );
    const call = graph.log.find((e) => e.path === "act_1001/insights")!;
    expect(JSON.parse(call.params.action_attribution_windows!)).toEqual([
      "1d_click",
      "7d_click",
      "1d_view",
    ]);
    expect(call.params.action_report_time).toBe("impression");
    expect(call.params).not.toHaveProperty("use_unified_attribution_setting");
  });

  it("keeps conversion action types only, one row per reported window", async () => {
    const { provider } = setup();
    const rows = await all((cursor) =>
      provider.fetchActionMetrics(ctx(), { ...request("ad"), ...(cursor ? { cursor } : {}) }),
    );
    expect(new Set(rows.map((r) => r.rawActionType))).toEqual(
      new Set(["omni_purchase", "omni_add_to_cart", "lead", "offsite_conversion.custom.8880001"]),
    );
    expect(new Set(rows.map((r) => r.attributionWindow))).toEqual(
      new Set(["1d_click", "7d_click", "1d_view"]),
    );
    for (const row of rows) {
      expect(row.attributionBasis).toBe("impression_or_click_date");
      expect(row.placement).toBe("all");
    }
    const purchase = rows.filter((r) => r.rawActionType === "omni_purchase");
    expect(purchase.every((r) => r.actionType === "purchase" && r.isPrimary === true)).toBe(true);
    expect(purchase.every((r) => r.valueMicros !== undefined)).toBe(true);
    const custom = rows.filter((r) => r.actionType === "custom");
    expect(custom.every((r) => r.conversionActionExternalId === "8880001" && !r.isPrimary)).toBe(
      true,
    );
    expect(
      rows.filter((r) => r.rawActionType === "omni_add_to_cart").every((r) => !r.isPrimary),
    ).toBe(true);
    // Window rows are exactly the per-window counts (the combined `value` is not stored).
    const all7 = cells();
    expect(
      purchase.filter((r) => r.attributionWindow === "7d_click").reduce((t, r) => t + r.count, 0),
    ).toBe(sum(all7, (c) => c.actions.omni_purchase?.["7d_click"] ?? 0));
    const keys = rows.map((r) =>
      [r.entityExternalId, r.date, r.placement, r.rawActionType, r.attributionWindow].join("|"),
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("supports the placement breakdown as a second stage", async () => {
    const { provider } = setup();
    const rows = await all((cursor) =>
      provider.fetchActionMetrics(ctx(), {
        ...request("campaign", "placement"),
        ...(cursor ? { cursor } : {}),
      }),
    );
    expect(rows.some((r) => r.placement === "all")).toBe(true);
    expect(rows.some((r) => r.placement === "facebook" && r.rawPlacement === "facebook")).toBe(
      true,
    );
  });
});

describe("page-local normalization details", () => {
  const base: RawInsight = {
    date_start: "2026-03-02",
    date_stop: "2026-03-02",
    account_id: "1001",
    account_currency: "USD",
    campaign_id: "2001",
  };
  const req = request("campaign", "placement");

  // Accumulation of "other" rows (across pages) is covered by carry.test.ts and
  // placementPaging.test.ts.

  it("ignores reach on breakdown rows and actions outside the conversion list", () => {
    const row = normalizeInsightRow(
      { ...base, publisher_platform: "facebook", reach: "7", impressions: "9" },
      req,
      1,
    );
    expect(row).not.toHaveProperty("reach");
    const actions: ProviderActionRow[] = normalizeInsightActions(
      {
        ...base,
        actions: [
          { action_type: "post_reaction", value: "3", "1d_click": "3" },
          { action_type: "offsite_conversion.fb_pixel_purchase", value: "2", "7d_click": "2" },
          { action_type: "offsite_conversion.custom.notanid", value: "1", "7d_click": "1" },
        ],
      },
      request("campaign"),
      0,
    );
    expect(actions).toEqual([]);
  });
});
