import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  MetricsRequest,
  ProviderActionRow,
  ProviderContext,
  ProviderMetricRow,
  ProviderPage,
} from "../types";
import { createGoogleAdsProvider, type GoogleCredential } from ".";
import {
  createFakeGoogleAds,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  FAKE_GOOGLE_RANGE,
  fakeGoogleCredential,
  fakeGoogleDataset,
  installFakeGoogleAds,
  type FakeFact,
  type FakeGoogleDataset,
} from "./fakeGoogleAds.fixtures";

// Phase 9 (G-D16): provider-side slicing of fixed-size Google pages, its measured cost,
// staged cursors, the request lookup and the "other" carry — with the PRODUCTION mapping.

afterEach(() => {
  vi.unstubAllGlobals();
});

const CAMPAIGNS = 16;

/** 2220000001 keeps its 4 campaigns and gets 12 more; 7770000001 gets 16. */
function dataset(): FakeGoogleDataset {
  const base = fakeGoogleDataset();
  const many = (offset: number, count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: String(10_000_000_100 + offset + i),
      name: `Campaign ${i}`,
      status: "ENABLED",
    }));
  const own = base.campaigns["2220000001"]!;
  return {
    ...base,
    campaigns: {
      ...base.campaigns,
      "2220000001": [...own, ...many(0, CAMPAIGNS - own.length)],
      "7770000001": many(100, CAMPAIGNS),
    },
  };
}
const CAMPAIGN_IDS = [
  "10000000001",
  "10000000002",
  "10000000003",
  "10000000004",
  ...Array.from({ length: CAMPAIGNS - 4 }, (_, i) => String(10_000_000_100 + i)),
];

function setup(googlePageRows?: number, data: FakeGoogleDataset = dataset()) {
  const fake = installFakeGoogleAds(
    createFakeGoogleAds({ dataset: data, ...(googlePageRows ? { pageSize: googlePageRows } : {}) }),
  );
  const ctx: ProviderContext<GoogleCredential> = {
    credential: fakeGoogleCredential(fake.grantRefreshToken("u1")),
    attempt: 1,
  };
  const provider = createGoogleAdsProvider({
    clientId: FAKE_GOOGLE_CLIENT_ID,
    clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
  });
  return { fake, ctx, provider, data };
}

async function drain<T>(call: (cursor?: string) => Promise<ProviderPage<T>>) {
  const pages: T[][] = [];
  let cursor: string | undefined;
  do {
    const page = await call(cursor);
    pages.push(page.items);
    cursor = page.nextCursor;
    expect(pages.length).toBeLessThan(200);
  } while (cursor !== undefined);
  return { pages, items: pages.flat() };
}

/** Documented cost (docs/providers/google-ads.md): Σ over Google pages of ceil(rows / limit). */
function expectedSearches(rows: number, googlePage: number, limit: number): number {
  if (rows === 0) return 1;
  let total = 0;
  for (let start = 0; start < rows; start += googlePage) {
    total += Math.ceil(Math.min(googlePage, rows - start) / limit);
  }
  return total;
}

const FROM = (query: string | undefined) => /FROM (\w+)/.exec(query ?? "")?.[1];

describe("slicing cost (search calls vs token mints)", () => {
  it.each([
    // [provider page size, Google page rows, provider pages, searches]
    [5, undefined, 4, 4],
    [5, 6, 5, 5],
    [16, undefined, 1, 1],
    [500, 6, 3, 3],
    [1, undefined, 16, 16],
    [3, 4, 8, 8],
  ])(
    "pageSize %s with %s-row Google pages: %s provider pages, %s searches",
    async (pageSize, googlePage, pages, searches) => {
      expect(expectedSearches(CAMPAIGNS, googlePage ?? 10_000, pageSize)).toBe(searches);
      const { fake, ctx, provider } = setup(googlePage);
      const result = await drain((cursor) =>
        provider.listCampaigns(ctx, {
          accountExternalId: "2220000001",
          pageSize,
          ...(cursor !== undefined ? { cursor } : {}),
        }),
      );
      expect(result.pages).toHaveLength(pages);
      expect(result.pages.every((p) => p.length <= pageSize)).toBe(true);
      expect(result.items.map((c) => c.externalId)).toEqual(CAMPAIGN_IDS);
      // Search calls on the account: exactly the documented provider-page behavior.
      expect(fake.searchesFor("2220000001")).toBe(searches);
      // Routing (first page only): 1 listAccessibleCustomers + 1 customer_client search.
      expect(fake.counts().accessible).toBe(1);
      expect(fake.searchesFor("1110000001")).toBe(1);
      // Token mints are counted separately: one per provider call, none are Ads operations.
      expect(fake.counts()).toMatchObject({
        token_refresh: pages,
        token_exchange: 0,
        search: searches + 1,
      });
      // Every account search is routed through the manager; later pages reuse the route.
      for (const entry of fake.log.filter((e) => e.customerId === "2220000001")) {
        expect(entry.loginCustomerId).toBe("1110000001");
      }
    },
  );

  it("a directly accessible account costs no routing searches", async () => {
    const { fake, ctx, provider } = setup(6);
    const result = await drain((cursor) =>
      provider.listCampaigns(ctx, {
        accountExternalId: "7770000001",
        pageSize: 5,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    expect(result.items).toHaveLength(CAMPAIGNS);
    expect(fake.counts()).toMatchObject({ accessible: 1, search: 5, token_refresh: 5 });
    expect(fake.log.some((e) => e.loginCustomerId !== undefined)).toBe(false);
  });

  it("staged listings move to the next GAQL stage (ad groups, then asset groups)", async () => {
    const { fake, ctx, provider } = setup();
    const result = await drain((cursor) =>
      provider.listAdGroups(ctx, {
        accountExternalId: "2220000001",
        pageSize: 1,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    expect(result.items.map((g) => [g.externalId, g.kind])).toEqual([
      ["20000000001", "ad_group"],
      ["20000000002", "ad_group"],
      ["20000000003", "ad_group"],
      ["30000000001", "asset_group"],
    ]);
    expect(fake.searchesFor("2220000001")).toBe(4);
    expect(fake.log.filter((e) => e.customerId === "2220000001").map((e) => FROM(e.query))).toEqual(
      ["ad_group", "ad_group", "ad_group", "asset_group"],
    );
  });

  it("measures a 2,000-row ad-level window (quota table: calls per task)", async () => {
    // 100 ads × 20 days × 2 networks: 2,000 "all" rows and 4,000 network rows.
    const base = fakeGoogleDataset();
    const days = Array.from({ length: 20 }, (_, i) => `2026-03-${String(i + 1).padStart(2, "0")}`);
    const ads = Array.from({ length: 100 }, (_, i) => ({
      id: String(50_000_000_000 + i),
      status: "ENABLED",
      adGroupId: "20000000001",
      campaignId: "10000000001",
      type: "RESPONSIVE_SEARCH_AD",
    }));
    const facts: FakeFact[] = ads.flatMap((ad) =>
      days.flatMap((date) =>
        ["SEARCH", "SEARCH_PARTNERS"].map((network) => ({
          customerId: "2220000001",
          campaignId: ad.campaignId,
          adGroupId: ad.adGroupId,
          adId: ad.id,
          date,
          network,
          impressions: 10,
          clicks: 1,
          costMicros: 1_000,
        })),
      ),
    );
    const { fake, ctx, provider } = setup(undefined, {
      ...base,
      ads: { "2220000001": ads },
      facts,
    });
    const result = await drain((cursor) =>
      provider.fetchDailyMetrics(ctx, {
        accountExternalId: "2220000001",
        level: "ad",
        from: days[0]!,
        to: days[19]!,
        breakdown: "placement",
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    expect(result.items).toHaveLength(6_000);
    const allSearches = expectedSearches(2_000, 10_000, 500);
    const networkSearches = expectedSearches(4_000, 10_000, 500);
    expect([allSearches, networkSearches]).toEqual([4, 8]);
    expect(result.pages).toHaveLength(allSearches + networkSearches);
    expect(fake.searchesFor("2220000001")).toBe(allSearches + networkSearches);
    expect(fake.counts()).toMatchObject({
      token_refresh: allSearches + networkSearches,
      accessible: 1,
      search: allSearches + networkSearches + 1,
    });
  });
});

describe("cursor integrity", () => {
  it("replaying a cursor returns the same page", async () => {
    const { ctx, provider } = setup(6);
    const request = { accountExternalId: "2220000001", pageSize: 5 };
    const first = await provider.listCampaigns(ctx, request);
    const second = await provider.listCampaigns(ctx, { ...request, cursor: first.nextCursor! });
    const replay = await provider.listCampaigns(ctx, { ...request, cursor: first.nextCursor! });
    expect(replay).toEqual(second);
  });

  it("an expired Google page token → invalid_request (the sync restarts from page 1)", async () => {
    const { fake, ctx, provider } = setup(6);
    const request = { accountExternalId: "2220000001", pageSize: 5 };
    const p1 = await provider.listCampaigns(ctx, request);
    const p2 = await provider.listCampaigns(ctx, { ...request, cursor: p1.nextCursor! });
    fake.expirePageTokens();
    await expect(
      provider.listCampaigns(ctx, { ...request, cursor: p2.nextCursor! }),
    ).rejects.toMatchObject({
      kind: "invalid_request",
      providerCode: "EXPIRED_PAGE_TOKEN",
      retryable: false,
    });
  });

  it("an offset beyond a shrunken Google page → cursor_invalid", async () => {
    const { ctx, provider, data } = setup();
    const request = { accountExternalId: "2220000001", pageSize: 5 };
    const first = await provider.listCampaigns(ctx, request);
    data.campaigns["2220000001"]!.splice(3);
    await expect(
      provider.listCampaigns(ctx, { ...request, cursor: first.nextCursor! }),
    ).rejects.toMatchObject({ kind: "invalid_request", providerCode: "cursor_invalid" });
  });

  it.each([
    ["another account", (c: string) => ({ op: "listCampaigns", account: "7770000001", cursor: c })],
    ["another operation", (c: string) => ({ op: "listAds", account: "2220000001", cursor: c })],
  ])("a cursor is bound to its request: %s", async (_label, build) => {
    const { ctx, provider } = setup();
    const first = await provider.listCampaigns(ctx, {
      accountExternalId: "2220000001",
      pageSize: 5,
    });
    const { op, account, cursor } = build(first.nextCursor!);
    const call = op === "listAds" ? provider.listAds : provider.listCampaigns;
    await expect(call(ctx, { accountExternalId: account, cursor })).rejects.toMatchObject({
      kind: "invalid_request",
      providerCode: "cursor_invalid",
    });
  });
});

describe("carry across slices and Google pages (production network mapping)", () => {
  const REQUEST: MetricsRequest = {
    accountExternalId: "2220000001",
    level: "campaign",
    from: FAKE_GOOGLE_RANGE.from,
    to: FAKE_GOOGLE_RANGE.to,
    breakdown: "placement",
  };

  async function metrics(pageSize: number, googlePage?: number) {
    const env = setup(googlePage);
    const result = await drain((cursor) =>
      env.provider.fetchDailyMetrics(env.ctx, {
        ...REQUEST,
        pageSize,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    return { ...env, ...result };
  }

  it("accumulates unmapped networks of one key exactly once, independent of slicing", async () => {
    const whole = await metrics(500);
    const sliced = await metrics(3, 5);
    expect(sliced.items).toEqual(whole.items);

    const rows = whole.items as ProviderMetricRow[];
    const byPlacement = (p: string) => rows.filter((r) => r.placement === p);
    expect(byPlacement("all")).toHaveLength(16);
    expect(byPlacement("google_search")).toHaveLength(9);
    expect(byPlacement("search_partners")).toHaveLength(9);
    // Google's own MIXED value for the Performance Max campaign — never synthesized.
    expect(byPlacement("cross_network")).toHaveLength(7);
    const other = byPlacement("other");
    expect(other).toHaveLength(7);
    expect(other.every((r) => r.entityExternalId === "10000000002")).toBe(true);

    // Day 1: GOOGLE_TV and GOOGLE_OWNED_CHANNELS land in ONE "other" row, summed exactly.
    const facts = whole.data.facts.filter(
      (f) => f.campaignId === "10000000002" && f.date === "2026-03-01",
    );
    const unmapped = facts.filter(
      (f) => f.network === "GOOGLE_TV" || f.network === "GOOGLE_OWNED_CHANNELS",
    );
    const day1 = other.find((r) => r.date === "2026-03-01")!;
    expect(day1).toMatchObject({
      rawPlacement: "GOOGLE_OWNED_CHANNELS,GOOGLE_TV",
      impressions: unmapped.reduce((t, f) => t + f.impressions, 0),
      clicks: unmapped.reduce((t, f) => t + f.clicks, 0),
      spendMicros: BigInt(unmapped.reduce((t, f) => t + f.costMicros, 0)),
    });
    expect(
      other.filter((r) => r.date !== "2026-03-01").every((r) => r.rawPlacement === "GOOGLE_TV"),
    ).toBe(true);
    // Keys are unique per placement (no double emission across pages).
    const keys = rows.map((r) => `${r.entityExternalId}|${r.date}|${r.placement}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("flush pages cost no token mint and no search", async () => {
    const { fake, pages } = await metrics(3, 5);
    const allRows = 16; // (campaign, date) pairs with delivery
    const networkRows = 33; // 14 Search + 4 removed-campaign + 14 PMax + 1 owned channels
    const stage0 = expectedSearches(allRows, 5, 3);
    const stage1 = expectedSearches(networkRows, 5, 3);
    const flush = Math.ceil(7 / 3);
    expect([stage0, stage1, flush]).toEqual([7, 13, 3]);
    expect(pages).toHaveLength(stage0 + stage1 + flush);
    expect(fake.searchesFor("2220000001")).toBe(stage0 + stage1);
    expect(fake.counts().token_refresh).toBe(stage0 + stage1);
    expect(pages.slice(stage0 + stage1).map((p) => p.length)).toEqual([3, 3, 1]);
  });
});

describe("request lookup (conversion actions)", () => {
  const REQUEST: MetricsRequest = {
    accountExternalId: "2220000001",
    level: "campaign",
    from: FAKE_GOOGLE_RANGE.from,
    to: FAKE_GOOGLE_RANGE.to,
    breakdown: "none",
  };

  it("is read once per request, travels in the cursor and survives slicing", async () => {
    const whole = setup();
    const reference = await drain((cursor) =>
      whole.provider.fetchActionMetrics(whole.ctx, {
        ...REQUEST,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    const sliced = setup(4);
    const paged = await drain((cursor) =>
      sliced.provider.fetchActionMetrics(sliced.ctx, {
        ...REQUEST,
        pageSize: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    expect(paged.items).toEqual(reference.items);
    expect(paged.pages.length).toBeGreaterThan(5);
    for (const env of [whole, sliced]) {
      const lookups = env.fake.log.filter((e) => FROM(e.query) === "conversion_action");
      expect(lookups).toHaveLength(1);
      expect(lookups[0]!.loginCustomerId).toBe("1110000001");
    }
    const rows = reference.items as ProviderActionRow[];
    expect(new Set(rows.map((r) => r.isPrimary))).toEqual(new Set([true, false, undefined]));
  });

  it("reads every Google page of the lookup (pagination) on the first provider call only", async () => {
    const data = dataset();
    // 3-row Google pages: the 7 conversion actions (4 real + 3 without delivery) take 3 pages.
    data.conversionActions["2220000001"]!.push(
      ...Array.from({ length: 3 }, (_, i) => ({
        id: String(800_000_000 + i),
        name: `Unused ${i}`,
        status: "ENABLED",
        category: "PURCHASE",
        primaryForGoal: i % 2 === 0,
      })),
    );
    const paged = setup(3, data);
    const rows = await drain((cursor) =>
      paged.provider.fetchActionMetrics(paged.ctx, {
        ...REQUEST,
        pageSize: 2,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    const lookups = paged.fake.log.filter((e) => FROM(e.query) === "conversion_action");
    expect(lookups).toHaveLength(3);
    expect(lookups.map((e) => e.pageToken)).toEqual([false, true, true]);
    // Same rows as with one Google page (flags of every page were applied).
    const reference = setup(undefined, dataset());
    const expected = await drain((cursor) =>
      reference.provider.fetchActionMetrics(reference.ctx, {
        ...REQUEST,
        ...(cursor !== undefined ? { cursor } : {}),
      }),
    );
    expect(rows.items).toEqual(expected.items);
    expect(
      (rows.items as ProviderActionRow[]).find((r) => r.conversionActionExternalId === "900000004")!
        .isPrimary,
    ).toBe(true);
  });

  it("a lookup beyond 10,000 conversion actions fails closed", async () => {
    const data = dataset();
    data.conversionActions["2220000001"] = Array.from({ length: 10_001 }, (_, i) => ({
      id: String(800_000_000 + i),
      name: `Action ${i}`,
      status: "ENABLED",
      category: "PURCHASE",
      primaryForGoal: true,
    }));
    const { provider, ctx } = setup(undefined, data);
    await expect(provider.fetchActionMetrics(ctx, REQUEST)).rejects.toMatchObject({
      kind: "data",
      providerCode: "lookup_limit",
    });
  }, 60_000);

  it("daily-metric cursors never carry a lookup; action cursors always do", async () => {
    const { provider, ctx } = setup(10);
    const daily = await provider.fetchDailyMetrics(ctx, { ...REQUEST, pageSize: 1 });
    const actions = await provider.fetchActionMetrics(ctx, { ...REQUEST, pageSize: 1 });
    const decode = (cursor: string) =>
      JSON.parse(atob(cursor.slice(3).replace(/-/g, "+").replace(/_/g, "/"))) as Record<
        string,
        unknown
      >;
    expect(decode(daily.nextCursor!)).not.toHaveProperty("l");
    expect(decode(actions.nextCursor!)).toHaveProperty("l", {
      y: ["900000001", "900000004"],
      n: ["900000002"],
    });
  });
});
