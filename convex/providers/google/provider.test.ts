import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntityLevel } from "../../domain/types";
import { numberToMicros } from "../../lib/money";
import type {
  ProviderActionRow,
  ProviderAdAccount,
  ProviderContext,
  ProviderMetricRow,
  ProviderPage,
} from "../types";
import { createGoogleAdsProvider, GOOGLE_CAPABILITIES, type GoogleCredential } from ".";
import {
  adsError,
  createFakeGoogleAds,
  FAKE_DEVELOPER_TOKEN,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  FAKE_GOOGLE_RANGE,
  fakeGoogleCredential,
  fakeGoogleDataset,
  installFakeGoogleAds,
  type FakeGoogleAds,
  type FakeGoogleDataset,
} from "./fakeGoogleAds.fixtures";
import { GOOGLE_MAPPING } from "./mapping";

// Phase 9: the Google provider with its PRODUCTION mapping — config and credential checks,
// per-call access tokens, discovery, routing, getAccount (Stage A) and the Stage B structure,
// metric and conversion-action mappings against the fake Google Ads API.

afterEach(() => {
  vi.unstubAllGlobals();
});

const OPTIONS = {
  clientId: FAKE_GOOGLE_CLIENT_ID,
  clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
  developerToken: FAKE_DEVELOPER_TOKEN,
};
const provider = (overrides: Record<string, string | undefined> = {}) =>
  createGoogleAdsProvider({ ...OPTIONS, ...overrides });

function setup(options: Parameters<typeof createFakeGoogleAds>[0] = {}, user = "u1") {
  const fake = installFakeGoogleAds(createFakeGoogleAds(options));
  const ctx: ProviderContext<GoogleCredential> = {
    credential: fakeGoogleCredential(fake.grantRefreshToken(user)),
    attempt: 1,
  };
  return { fake, ctx };
}

async function listAll(
  p: ReturnType<typeof provider>,
  ctx: ProviderContext<GoogleCredential>,
  pageSize?: number,
) {
  const items: ProviderAdAccount[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await p.listAccounts(ctx, {
      ...(cursor !== undefined ? { cursor } : {}),
      ...(pageSize !== undefined ? { pageSize } : {}),
    });
    items.push(...page.items);
    cursor = page.nextCursor;
    pages += 1;
    expect(pages).toBeLessThan(100);
  } while (cursor !== undefined);
  return { items, pages };
}

const LEAK =
  /test-(access|refresh)|test-google-client-secret|test-developer-token|Fake|fakeRequestId|https?:/;

function expectNoLeak(fake: FakeGoogleAds, error: unknown) {
  expect(`${(error as Error).message} ${JSON.stringify(error)}`).not.toMatch(LEAK);
  expect(fake.log.every((e) => !e.secretInUrl)).toBe(true);
}

const DISCOVERED = [
  {
    externalId: "1110000001",
    name: "Fake Manager",
    currency: "USD",
    timezone: "America/New_York",
    status: "active",
    isManager: true,
  },
  {
    externalId: "2220000001",
    name: "Fake Shop USD",
    currency: "USD",
    parentExternalId: "1110000001",
  },
  {
    externalId: "2220000002",
    name: "Fake Shop JPY",
    currency: "JPY",
    parentExternalId: "1110000001",
    attributes: { testAccount: "true" },
  },
  { externalId: "3330000001", isManager: true, parentExternalId: "1110000001" },
  // Two levels down: parentExternalId is the ROUTING manager (G-D3), not the sub-manager.
  { externalId: "4440000001", currency: "EUR", isManager: false, parentExternalId: "1110000001" },
  {
    externalId: "6660000001",
    status: "closed",
    rawStatus: "CANCELED",
    parentExternalId: "1110000001",
  },
  // Directly accessible (listed once, without a parent); empty name → formatted id.
  { externalId: "7770000001", name: "777-000-0001", currency: "GBP", isManager: false },
];

describe("configuration and credential (no network)", () => {
  it.each([
    ["no developer token", { developerToken: undefined }],
    ["a malformed developer token", { developerToken: "bad token!" }],
    ["no client id", { clientId: undefined }],
    ["a malformed client id", { clientId: "123.apps.example.com" }],
    ["no client secret", { clientSecret: undefined }],
    ["an invalid version override", { version: "25" }],
  ])("%s → unknown google_config_invalid", async (_label, overrides) => {
    const { fake, ctx } = setup();
    const p = provider(overrides);
    for (const call of [
      () => p.listAccounts(ctx, {}),
      () => p.getAccount(ctx, { accountExternalId: "2220000001" }),
    ]) {
      await expect(call()).rejects.toMatchObject({
        kind: "unknown",
        providerCode: "google_config_invalid",
        retryable: false,
      });
    }
    expect(fake.log).toHaveLength(0);
  });

  it("rejects a non-Google credential and a credential of another OAuth client (auth)", async () => {
    const { fake } = setup();
    const p = provider();
    await expect(
      p.listAccounts({ credential: { kind: "meta", accessToken: "x" } as never, attempt: 1 }, {}),
    ).rejects.toMatchObject({ kind: "auth", providerCode: "credential_invalid" });
    await expect(
      p.listAccounts(
        {
          credential: fakeGoogleCredential(
            "test-refresh-u1",
            "999-other.apps.googleusercontent.com",
          ),
          attempt: 1,
        },
        {},
      ),
    ).rejects.toMatchObject({ kind: "auth", providerCode: "client_id_mismatch" });
    expect(fake.log).toHaveLength(0);
  });

  it("a revoked refresh token is auth / invalid_grant (reauth), with no Ads call", async () => {
    const { fake, ctx } = setup();
    fake.revoke("u1");
    let caught: unknown;
    try {
      await provider().getAccount(ctx, { accountExternalId: "2220000001" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ kind: "auth", providerCode: "invalid_grant", retryable: false });
    expect(fake.counts()).toMatchObject({ token_refresh: 1, accessible: 0, search: 0 });
    expectNoLeak(fake, caught);
  });

  it("rejects a malformed customer id before any network call", async () => {
    const { fake, ctx } = setup();
    await expect(
      provider().getAccount(ctx, { accountExternalId: "123-456-7890" }),
    ).rejects.toMatchObject({ kind: "invalid_request", providerCode: "customer_id" });
    expect(fake.log).toHaveLength(0);
  });
});

describe("access tokens and transport", () => {
  it("mints a fresh access token per provider call; it never appears in a URL", async () => {
    const { fake, ctx } = setup();
    const p = provider();
    await p.listAccounts(ctx, {});
    await p.getAccount(ctx, { accountExternalId: "2220000001" });
    await p.getAccount(ctx, { accountExternalId: "7770000001" });
    expect(fake.counts().token_refresh).toBe(3);
    expect(fake.counts().token_exchange).toBe(0);
    for (const entry of fake.log) {
      expect(entry.secretInUrl).toBe(false);
      if (entry.kind === "token_refresh") {
        expect(entry.formFields.sort()).toEqual(
          ["client_id", "client_secret", "grant_type", "refresh_token"].sort(),
        );
        expect(entry).toMatchObject({ hasBearer: false, developerToken: false });
      } else {
        expect(entry).toMatchObject({
          method: expect.any(String),
          hasBearer: true,
          developerToken: true,
        });
      }
    }
    // Read-only transport: only the allowlisted endpoints were called.
    expect(new Set(fake.log.map((e) => `${e.method} ${e.host}`))).toEqual(
      new Set([
        "POST oauth2.googleapis.com",
        "GET googleads.googleapis.com",
        "POST googleads.googleapis.com",
      ]),
    );
    expect(fake.log.some((e) => e.kind === "other" || /mutate|searchStream/.test(e.path))).toBe(
      false,
    );
  });

  it("uses the pinned version by default and a validated override", async () => {
    expect(provider().providerId).toBe("google-ads-api/v25");
    const { fake, ctx } = setup();
    const p = provider({ version: "v26" });
    expect(p.providerId).toBe("google-ads-api/v26");
    await p.getAccount(ctx, { accountExternalId: "7770000001" });
    expect(
      fake.log.filter((e) => e.host === "googleads.googleapis.com").map((e) => e.path),
    ).toEqual([
      "/v26/customers:listAccessibleCustomers",
      "/v26/customers/7770000001/googleAds:search",
    ]);
  });
});

describe("discovery (listAccounts)", () => {
  it("lists managers, the flattened hierarchy and direct customers, each once", async () => {
    const { fake, ctx } = setup();
    const page = await provider().listAccounts(ctx, {});
    expect(page.nextCursor).toBeUndefined();
    expect(page.items.map((a) => a.externalId)).toEqual(DISCOVERED.map((a) => a.externalId));
    page.items.forEach((item, i) => expect(item).toMatchObject(DISCOVERED[i]!));
    expect(page.items.find((a) => a.externalId === "1110000001")).not.toHaveProperty(
      "parentExternalId",
    );
    expect(page.items.find((a) => a.externalId === "7770000001")).not.toHaveProperty(
      "parentExternalId",
    );
    // Hidden clients are never listed.
    expect(page.items.some((a) => a.externalId === "5550000001")).toBe(false);
    // Cost: 1 token + 1 listAccessibleCustomers + 3 searches (manager, hierarchy, direct 777).
    expect(fake.counts()).toMatchObject({ token_refresh: 1, accessible: 1, search: 3 });
    const searches = fake.log.filter((e) => e.kind === "search");
    expect(searches.map((e) => [e.customerId, e.loginCustomerId])).toEqual([
      ["1110000001", undefined],
      ["1110000001", "1110000001"],
      ["7770000001", undefined],
    ]);
    expect(searches[1]!.query).toMatch(
      /FROM customer_client WHERE customer_client\.level > 0 ORDER BY customer_client\.id ASC$/,
    );
  });

  it.each([
    ["provider pages of 2", 2, undefined],
    ["provider pages of 1 and Google pages of 2", 1, 2],
    ["provider pages of 3 and Google pages of 1", 3, 1],
  ])("pages deterministically with %s", async (_label, pageSize, googlePage) => {
    const { ctx } = setup(googlePage !== undefined ? { pageSize: googlePage } : {});
    const p = provider();
    const { items, pages } = await listAll(p, ctx, pageSize);
    expect(items.map((a) => a.externalId)).toEqual(DISCOVERED.map((a) => a.externalId));
    expect(pages).toBeGreaterThanOrEqual(Math.ceil(DISCOVERED.length / pageSize));
    const again = await listAll(p, ctx, pageSize);
    expect(again.items).toEqual(items);
  });

  it("rejects a cursor from another request or a tampered cursor", async () => {
    const { fake, ctx } = setup();
    const p = provider();
    const first = await p.listAccounts(ctx, { pageSize: 2 });
    const other = { credential: fakeGoogleCredential(fake.grantRefreshToken("u2")), attempt: 1 };
    await expect(p.listAccounts(other, { cursor: first.nextCursor! })).rejects.toMatchObject({
      kind: "invalid_request",
      providerCode: "cursor_invalid",
    });
    await expect(
      p.listAccounts(ctx, { cursor: `${first.nextCursor!.slice(0, -4)}AAAA` }),
    ).rejects.toMatchObject({ kind: "invalid_request" });
  });

  it("skips customers it cannot read and managers whose hierarchy is denied", async () => {
    const { fake, ctx } = setup();
    fake.inject({
      match: (e) => e.kind === "search" && e.loginCustomerId === "1110000001",
      response: adsError(403, "PERMISSION_DENIED", "authorizationError", "USER_PERMISSION_DENIED"),
    });
    const page = await provider().listAccounts(ctx, {});
    expect(page.items.map((a) => a.externalId)).toEqual(["1110000001", "7770000001"]);
  });

  it.each([
    [
      "a quota error",
      adsError(429, "RESOURCE_EXHAUSTED", "quotaError", "RESOURCE_EXHAUSTED", "12s"),
      { kind: "rate_limited", providerCode: "RESOURCE_EXHAUSTED", retryAfterMs: 12_000 },
    ],
    [
      "an internal error",
      adsError(500, "INTERNAL", "internalError", "INTERNAL_ERROR"),
      { kind: "transient", providerCode: "INTERNAL_ERROR", retryable: true },
    ],
    [
      "a developer token without access",
      adsError(403, "PERMISSION_DENIED", "authorizationError", "DEVELOPER_TOKEN_NOT_APPROVED"),
      { kind: "unknown", providerCode: "DEVELOPER_TOKEN_NOT_APPROVED", retryable: false },
    ],
  ])("surfaces %s instead of skipping", async (_label, response, expected) => {
    const { fake, ctx } = setup();
    fake.inject({ match: (e) => e.kind === "search", response });
    let caught: unknown;
    try {
      await provider().listAccounts(ctx, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject(expected);
    expectNoLeak(fake, caught);
  });

  it("a test developer token cannot read production accounts → configuration error", async () => {
    const { ctx } = setup({ developerTokenLevel: "test" });
    await expect(provider().listAccounts(ctx, {})).rejects.toMatchObject({
      kind: "unknown",
      providerCode: "DEVELOPER_TOKEN_NOT_APPROVED",
    });
  });

  it("an account without customers lists nothing", async () => {
    const { fake, ctx } = setup({}, "noads");
    // noads fails listAccessibleCustomers with NOT_ADS_USER (auth).
    await expect(provider().listAccounts(ctx, {})).rejects.toMatchObject({
      kind: "auth",
      providerCode: "NOT_ADS_USER",
    });
    expect(fake.counts().search).toBe(0);
  });

  it("fails closed beyond the hierarchy size limit", async () => {
    const children = Array.from({ length: 10_000 }, (_, i) => ({ id: String(8_000_000_000 + i) }));
    const base = fakeGoogleDataset();
    const dataset: FakeGoogleDataset = {
      ...base,
      customers: [
        {
          id: "1110000001",
          descriptiveName: "Huge Manager",
          currencyCode: "USD",
          timeZone: "UTC",
          manager: true,
          status: "ENABLED",
          children,
        },
        ...children.map((c) => ({
          id: c.id,
          currencyCode: "USD",
          timeZone: "UTC",
          status: "ENABLED",
        })),
      ],
    };
    const { ctx } = setup({
      dataset,
      users: { u1: { sub: "1", accessible: ["1110000001"] } },
    });
    const p = provider();
    let cursor: string | undefined;
    let listed = 0;
    let caught: unknown;
    try {
      for (let i = 0; i < 25; i++) {
        const page = await p.listAccounts(ctx, cursor !== undefined ? { cursor } : {});
        listed += page.items.length;
        cursor = page.nextCursor;
        if (cursor === undefined) break;
      }
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ kind: "unknown", providerCode: "google_hierarchy_limit" });
    expect(listed).toBe(10_000);
  }, 60_000);
});

describe("getAccount and routing", () => {
  it("returns exactly the discovered record for every account", async () => {
    const { ctx } = setup();
    const p = provider();
    const { items } = await listAll(p, ctx);
    for (const item of items) {
      expect(await p.getAccount(ctx, { accountExternalId: item.externalId })).toEqual(item);
    }
  });

  it("routes a managed account through its manager (login-customer-id)", async () => {
    const { fake, ctx } = setup();
    await provider().getAccount(ctx, { accountExternalId: "4440000001" });
    expect(fake.log.filter((e) => e.kind === "search")).toEqual([
      expect.objectContaining({ customerId: "1110000001", loginCustomerId: "1110000001" }),
    ]);
    fake.log.length = 0;
    await provider().getAccount(ctx, { accountExternalId: "7770000001" });
    expect(fake.log.filter((e) => e.kind === "search")).toEqual([
      expect.not.objectContaining({ loginCustomerId: expect.anything() }),
    ]);
  });

  it.each([
    ["an unknown customer", "9999999999"],
    ["a hidden client", "5550000001"],
  ])("%s → not_found", async (_label, id) => {
    const { ctx } = setup();
    await expect(provider().getAccount(ctx, { accountExternalId: id })).rejects.toMatchObject({
      kind: "not_found",
      providerCode: "no_route",
    });
  });

  it("another user cannot reach the manager's clients", async () => {
    const { ctx } = setup({}, "u2");
    await expect(
      provider().getAccount(ctx, { accountExternalId: "2220000001" }),
    ).rejects.toMatchObject({ kind: "not_found" });
    expect(await provider().getAccount(ctx, { accountExternalId: "7770000001" })).toMatchObject({
      externalId: "7770000001",
    });
  });
});

describe("structure (production mapping)", () => {
  const listAll = async <T>(call: (cursor?: string) => Promise<ProviderPage<T>>) => {
    const items: T[] = [];
    let cursor: string | undefined;
    do {
      const page = await call(cursor);
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  };
  const req = (cursor?: string) => ({
    accountExternalId: "2220000001",
    ...(cursor !== undefined ? { cursor } : {}),
  });

  it("maps campaigns: status, serving status, channel, budgets (daily / custom period / shared), dates", async () => {
    const { ctx } = setup();
    const campaigns = await listAll((c) => provider().listCampaigns(ctx, req(c)));
    const base = { platform: "google_ads", accountExternalId: "2220000001" };
    expect(campaigns).toEqual([
      {
        ...base,
        externalId: "10000000001",
        name: "Search US",
        status: "active",
        rawStatus: "ENABLED",
        deliveryStatus: "delivering",
        objective: "unknown",
        channelType: "search",
        budgetType: "daily",
        budgetMicros: 50_000_000n,
        isSharedBudget: false,
        budgetLevel: "campaign",
        bidStrategy: "MAXIMIZE_CONVERSIONS",
        startDate: "2026-01-15",
        attributes: {
          advertisingChannelType: "SEARCH",
          campaignBudgetId: "5000001",
          budgetPeriod: "DAILY",
        },
      },
      {
        ...base,
        externalId: "10000000002",
        name: "Performance Max",
        status: "active",
        rawStatus: "ENABLED",
        deliveryStatus: "delivering",
        objective: "unknown",
        channelType: "performance_max",
        budgetType: "daily",
        budgetMicros: 120_000_000n,
        isSharedBudget: true,
        budgetLevel: "campaign",
        bidStrategy: "MAXIMIZE_CONVERSION_VALUE",
        startDate: "2026-02-01",
        endDate: "2026-12-31",
        attributes: {
          advertisingChannelType: "PERFORMANCE_MAX",
          campaignBudgetId: "5000002",
          budgetPeriod: "DAILY",
        },
      },
      {
        ...base,
        externalId: "10000000003",
        name: "Removed campaign",
        status: "removed",
        rawStatus: "REMOVED",
        deliveryStatus: "ended",
        objective: "unknown",
        channelType: "search",
        budgetType: "lifetime",
        budgetMicros: 300_000_000n,
        isSharedBudget: false,
        budgetLevel: "campaign",
        bidStrategy: "MANUAL_CPC",
        startDate: "2026-01-01",
        endDate: "2026-03-02",
        attributes: {
          advertisingChannelType: "SEARCH",
          campaignBudgetId: "5000003",
          budgetPeriod: "CUSTOM_PERIOD",
        },
      },
      {
        ...base,
        externalId: "10000000004",
        name: "Display remarketing",
        status: "paused",
        rawStatus: "PAUSED",
        objective: "unknown",
        channelType: "display",
        budgetType: "daily",
        budgetMicros: 120_000_000n,
        isSharedBudget: true,
        budgetLevel: "campaign",
        startDate: "2026-02-15",
        attributes: {
          advertisingChannelType: "DISPLAY",
          campaignBudgetId: "5000002",
          budgetPeriod: "DAILY",
        },
      },
    ]);
  });

  it("maps ad groups and Performance Max asset groups (two stages)", async () => {
    const { ctx } = setup();
    const groups = await listAll((c) => provider().listAdGroups(ctx, req(c)));
    expect(
      groups.map((g) => [g.externalId, g.kind, g.status, g.campaignExternalId, g.name]),
    ).toEqual([
      ["20000000001", "ad_group", "active", "10000000001", "Brand"],
      ["20000000002", "ad_group", "removed", "10000000003", "Old"],
      ["20000000003", "ad_group", "paused", "10000000004", "Retargeting"],
      ["30000000001", "asset_group", "active", "10000000002", "All products"],
    ]);
    expect(groups[0]).toMatchObject({
      rawStatus: "ENABLED",
      attributes: { adGroupType: "SEARCH_STANDARD" },
    });
    expect(groups[3]).not.toHaveProperty("attributes");
    expect(groups.every((g) => g.budgetType === undefined && g.deliveryStatus === undefined)).toBe(
      true,
    );
  });

  it("maps ads and their one-per-ad creatives (same external id)", async () => {
    const { ctx } = setup();
    const ads = await listAll((c) => provider().listAds(ctx, req(c)));
    const creatives = await listAll((c) => provider().listCreatives(ctx, req(c)));
    expect(ads.map((a) => [a.externalId, a.adGroupExternalId, a.status, a.format, a.name])).toEqual(
      [
        ["20000000001~40000000001", "20000000001", "active", "responsive_search", "Ad 40000000001"],
        ["20000000001~40000000002", "20000000001", "paused", "responsive_search", "Ad 40000000002"],
        ["20000000002~40000000003", "20000000002", "removed", "text", "Ad 40000000003"],
        [
          "20000000003~40000000004",
          "20000000003",
          "paused",
          "responsive_display",
          "Remarketing banner",
        ],
      ],
    );
    expect(ads.every((a) => a.creativeExternalId === a.externalId)).toBe(true);
    expect(creatives.map((c) => c.externalId)).toEqual(ads.map((a) => a.externalId));
    expect(creatives).toEqual([
      {
        platform: "google_ads",
        accountExternalId: "2220000001",
        externalId: "20000000001~40000000001",
        format: "responsive_search",
        headlines: ["Fake Shop", "Free delivery"],
        descriptions: ["Everything for the fake home."],
        linkUrl: "https://shop.example.test/",
        attributes: { adType: "RESPONSIVE_SEARCH_AD" },
      },
      {
        platform: "google_ads",
        accountExternalId: "2220000001",
        externalId: "20000000001~40000000002",
        format: "responsive_search",
        headlines: ["Fake Shop sale"],
        attributes: { adType: "RESPONSIVE_SEARCH_AD" },
      },
      {
        platform: "google_ads",
        accountExternalId: "2220000001",
        externalId: "20000000002~40000000003",
        format: "text",
        linkUrl: "https://shop.example.test/old",
        attributes: { adType: "EXPANDED_TEXT_AD" },
      },
      {
        platform: "google_ads",
        accountExternalId: "2220000001",
        externalId: "20000000003~40000000004",
        format: "responsive_display",
        headlines: ["Come back"],
        descriptions: ["Your cart is waiting."],
        callToAction: "Shop now",
        linkUrl: "https://shop.example.test/back",
        attributes: { adType: "RESPONSIVE_DISPLAY_AD" },
      },
    ]);
  });

  it("an unclassifiable budget period fails the listing closed (data)", async () => {
    const data = fakeGoogleDataset();
    data.campaigns["2220000001"]![0]!.budget!.period = "UNKNOWN";
    const { ctx } = setup({ dataset: data });
    await expect(provider().listCampaigns(ctx, req())).rejects.toMatchObject({
      kind: "data",
      providerCode: "normalize",
    });
  });
});

describe("daily metrics (production mapping)", () => {
  const request = (level: EntityLevel, breakdown: "none" | "placement") => ({
    accountExternalId: "2220000001",
    level,
    breakdown,
    ...FAKE_GOOGLE_RANGE,
  });
  const rowsOf = async (
    ctx: ProviderContext<GoogleCredential>,
    level: EntityLevel,
    breakdown: "none" | "placement",
  ) => {
    const items: ProviderMetricRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider().fetchDailyMetrics(ctx, {
        ...request(level, breakdown),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  };

  it("account 'all' rows: exact micros, reported counts, documented conversion columns", async () => {
    const { ctx } = setup();
    const data = fakeGoogleDataset();
    const rows = await rowsOf(ctx, "account", "none");
    expect(rows.map((r) => r.date)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
    ]);
    // Google's Conversions (fake): primary actions (and a missing flag, the documented default)
    // plus the signups the Search campaign's custom goal uses; PMax signups are not counted.
    const counted = (f: { campaignId: string }, c: { actionId: string }) =>
      c.actionId !== "900000002" || f.campaignId === "10000000001";
    for (const row of rows) {
      const facts = data.facts.filter((f) => f.date === row.date);
      const conversions = facts.flatMap((f) => f.conversions ?? []);
      const primary = facts.flatMap((f) => (f.conversions ?? []).filter((c) => counted(f, c)));
      expect(row).toEqual({
        platform: "google_ads",
        accountExternalId: "2220000001",
        level: "account",
        entityExternalId: "2220000001",
        date: row.date,
        placement: "all",
        currency: "USD",
        spendMicros: BigInt(facts.reduce((t, f) => t + f.costMicros, 0)),
        impressions: facts.reduce((t, f) => t + f.impressions, 0),
        clicks: facts.reduce((t, f) => t + f.clicks, 0),
        conversions: primary.reduce((t, c) => t + c.count, 0),
        conversionValueMicros: numberToMicros(primary.reduce((t, c) => t + (c.value ?? 0), 0)),
        allConversions: conversions.reduce((t, c) => t + c.count, 0),
      });
      expect(typeof row.spendMicros).toBe("bigint");
      expect(row).not.toHaveProperty("reach");
      expect(row).not.toHaveProperty("linkClicks");
    }
  });

  it("placement rows: documented networks only; unmapped values accumulate as 'other'", async () => {
    const { ctx } = setup();
    const rows = await rowsOf(ctx, "account", "placement");
    const placements = new Set(rows.map((r) => r.placement));
    expect(placements).toEqual(
      new Set(["all", "google_search", "search_partners", "cross_network", "other"]),
    );
    for (const row of rows.filter((r) => r.placement !== "all")) {
      expect(row.rawPlacement).toBeDefined();
    }
    expect(
      rows.filter((r) => r.placement === "all").every((r) => r.rawPlacement === undefined),
    ).toBe(true);
    expect(rows.find((r) => r.placement === "cross_network")!.rawPlacement).toBe("MIXED");
  });

  it("asset groups: 'all' rows only — no synthetic placement, never a network query", async () => {
    const { fake, ctx } = setup();
    const rows = await rowsOf(ctx, "ad_group", "placement");
    const assetRows = rows.filter((r) => r.entityExternalId === "30000000001");
    expect(assetRows).toHaveLength(7);
    expect(assetRows.every((r) => r.placement === "all")).toBe(true);
    expect(rows.some((r) => r.placement === "cross_network")).toBe(false);
    // Ad groups do get Google's own network rows.
    expect(
      rows.some((r) => r.entityExternalId === "20000000001" && r.placement === "google_search"),
    ).toBe(true);
    const assetQueries = fake.log.filter((e) => /FROM asset_group/.test(e.query ?? ""));
    expect(assetQueries.length).toBeGreaterThan(0);
    expect(assetQueries.some((e) => /ad_network_type/.test(e.query!))).toBe(false);
  });

  it("a reported zero stays 0; an unreported metric stays absent (never 0)", async () => {
    const { ctx } = setup({
      omitMetrics: ({ from, row }) =>
        from === "campaign" &&
        (row.campaign as { id: string }).id === "10000000003" &&
        (row.segments as { date: string }).date === "2026-03-02" &&
        (row.segments as { adNetworkType?: string }).adNetworkType === undefined
          ? ["clicks", "conversionsValue"]
          : [],
    });
    const adRows = await rowsOf(ctx, "ad", "placement");
    const zero = adRows.filter(
      (r) => r.entityExternalId === "20000000001~40000000002" && r.placement === "search_partners",
    );
    expect(zero).toHaveLength(7);
    for (const row of zero) {
      expect(row.clicks).toBe(0);
      expect(row.spendMicros).toBe(0n);
      expect(row.conversions).toBe(0);
    }
    const campaignRows = await rowsOf(ctx, "campaign", "none");
    const missing = campaignRows.find(
      (r) => r.entityExternalId === "10000000003" && r.date === "2026-03-02",
    )!;
    expect(missing).not.toHaveProperty("clicks");
    expect(missing).not.toHaveProperty("conversionValueMicros");
    expect(missing.impressions).toBeGreaterThan(0);
    const other = campaignRows.find(
      (r) => r.entityExternalId === "10000000003" && r.date === "2026-03-01",
    )!;
    expect(other.clicks).toBeGreaterThan(0);
  });
});

describe("action metrics (production mapping)", () => {
  const request = (level: EntityLevel, breakdown: "none" | "placement" = "none") => ({
    accountExternalId: "2220000001",
    level,
    breakdown,
    ...FAKE_GOOGLE_RANGE,
  });
  const actionsOf = async (
    ctx: ProviderContext<GoogleCredential>,
    level: EntityLevel,
    breakdown: "none" | "placement" = "none",
    pageSize?: number,
  ) => {
    const items: ProviderActionRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider().fetchActionMetrics(ctx, {
        ...request(level, breakdown),
        ...(pageSize !== undefined ? { pageSize } : {}),
        ...(cursor !== undefined ? { cursor } : {}),
      });
      items.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return items;
  };
  const resource = (id: string) => `customers/2220000001/conversionActions/${id}`;

  it("one row per conversion action: resource-name identity, all_conversions, primary_for_goal", async () => {
    const { ctx } = setup();
    const rows = await actionsOf(ctx, "campaign");
    const kinds = new Map(
      rows.map((r) => [
        r.rawActionType,
        [r.conversionActionExternalId, r.actionType, r.isPrimary ?? "absent"],
      ]),
    );
    expect(Object.fromEntries(kinds)).toEqual({
      [resource("900000001")]: ["900000001", "purchase", true],
      [resource("900000002")]: ["900000002", "complete_registration", false],
      [resource("900000003")]: ["900000003", "other", "absent"],
      [resource("900000004")]: ["900000004", "lead", true],
    });
    expect(rows.every((r) => r.attributionWindow === "action_setting")).toBe(true);
    expect(rows.every((r) => r.attributionBasis === "impression_or_click_date")).toBe(true);
    expect(rows.every((r) => r.placement === "all" && r.currency === "USD")).toBe(true);
    const signup = rows.find(
      (r) => r.conversionActionExternalId === "900000002" && r.entityExternalId === "10000000001",
    )!;
    expect(signup.count).toBe(0.25);
    expect(signup.valueMicros).toBe(0n);
    const purchase = rows.find(
      (r) => r.conversionActionExternalId === "900000001" && r.entityExternalId === "10000000002",
    )!;
    expect(purchase).toMatchObject({ count: 2, valueMicros: 80_250_000n });
  });

  it("action counts add up to all_conversions and are never forced to the wide conversions", async () => {
    const { ctx } = setup();
    const actions = await actionsOf(ctx, "campaign");
    const wide = (await provider().fetchDailyMetrics(ctx, request("campaign"))).items;
    for (const row of wide) {
      const same = actions.filter(
        (a) => a.date === row.date && a.entityExternalId === row.entityExternalId,
      );
      // Documented relationship: all_conversions per action adds up to all_conversions.
      expect(same.reduce((t, a) => t + a.count, 0)).toBe(row.allConversions);
    }
    // The wide `conversions` is Google's own column. For the Search campaign it includes the
    // SECONDARY signups (custom conversion goal) and the store visits (flag not reported):
    // it is stored as reported, never replaced by the isPrimary sum.
    const search = wide.find(
      (r) => r.entityExternalId === "10000000001" && r.date === "2026-03-01",
    )!;
    const searchActions = actions.filter(
      (a) => a.entityExternalId === "10000000001" && a.date === "2026-03-01",
    );
    const primarySum = searchActions
      .filter((a) => a.isPrimary === true)
      .reduce((t, a) => t + a.count, 0);
    expect(search.conversions).not.toBe(primarySum);
    expect(search.conversions).toBe(searchActions.reduce((t, a) => t + a.count, 0));
    // Performance Max: its signups are secondary and not in a custom goal → only in all.
    const pmax = wide.find((r) => r.entityExternalId === "10000000002" && r.date === "2026-03-01")!;
    expect(pmax.allConversions! - pmax.conversions!).toBe(0.5);
  });

  it("ad-group level includes Performance Max asset groups; placement stage maps networks", async () => {
    const { fake, ctx } = setup();
    const rows = await actionsOf(ctx, "ad_group", "placement");
    expect(rows.some((r) => r.entityExternalId === "30000000001" && r.placement === "all")).toBe(
      true,
    );
    expect(rows.some((r) => r.entityExternalId === "30000000001" && r.placement !== "all")).toBe(
      false,
    );
    expect(new Set(rows.map((r) => r.placement))).toEqual(new Set(["all", "google_search"]));
    // Conversion segments are only ever combined with conversion metrics.
    for (const entry of fake.log.filter((e) => /conversion_action/.test(e.query ?? ""))) {
      expect(entry.query).not.toMatch(/metrics\.(impressions|clicks|cost_micros)/);
    }
  });

  describe("conversion-action identity (regressions)", () => {
    it("same action id, renamed: identical rows (no new logical action)", async () => {
      const { ctx } = setup();
      const before = await actionsOf(ctx, "campaign");
      const data = fakeGoogleDataset();
      data.conversionActions["2220000001"]!.find((a) => a.id === "900000001")!.name =
        "Online purchase (renamed)";
      const renamed = setup({ dataset: data });
      expect(await actionsOf(renamed.ctx, "campaign")).toEqual(before);
    });

    it("different action ids with the same name: distinct rows, never merged or rejected", async () => {
      const data = fakeGoogleDataset();
      data.conversionActions["2220000001"]!.push({
        id: "900000005",
        name: "Purchase", // same display name as 900000001
        status: "ENABLED",
        category: "PURCHASE",
        primaryForGoal: false,
      });
      data.facts
        .filter((f) => f.adId === "40000000001" && f.network === "SEARCH")
        .forEach((f) => f.conversions!.push({ actionId: "900000005", count: 0.75, value: 5 }));
      const { ctx } = setup({ dataset: data });
      const rows = await actionsOf(ctx, "campaign", "none", 2);
      const perDay = rows.filter(
        (r) => r.entityExternalId === "10000000001" && r.date === "2026-03-01",
      );
      const byId = new Map(perDay.map((r) => [r.conversionActionExternalId, r]));
      // Two ads of the Search campaign: 1 + 0.5 purchases on the first day.
      expect(byId.get("900000001")).toMatchObject({ count: 1.5, isPrimary: true });
      expect(byId.get("900000005")).toMatchObject({
        rawActionType: resource("900000005"),
        count: 0.75,
        valueMicros: 5_000_000n,
        isPrimary: false,
      });
      const keys = rows.map(
        (r) =>
          `${r.entityExternalId}|${r.date}|${r.placement}|${r.rawActionType}|${r.attributionWindow}`,
      );
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("a removed action keeps its identity, history and flag", async () => {
      const { ctx } = setup();
      const rows = await actionsOf(ctx, "campaign");
      const lead = rows.filter((r) => r.conversionActionExternalId === "900000004");
      expect(lead.map((r) => r.date).sort()).toEqual(["2026-03-01", "2026-03-02"]);
      expect(lead.every((r) => r.rawActionType === resource("900000004") && r.isPrimary)).toBe(
        true,
      );
    });

    it("rerunning the same data yields the same rows", async () => {
      const { ctx } = setup();
      const first = await actionsOf(ctx, "ad_group", "placement");
      const second = await actionsOf(ctx, "ad_group", "placement");
      expect(second).toEqual(first);
    });

    it("a changed lookback setting never changes the window bucket or the rows", async () => {
      const { ctx } = setup();
      const before = await actionsOf(ctx, "campaign");
      const data = fakeGoogleDataset();
      const purchase = data.conversionActions["2220000001"]!.find((a) => a.id === "900000001")!;
      purchase.clickThroughLookbackWindowDays = 90;
      purchase.viewThroughLookbackWindowDays = 30;
      const changed = setup({ dataset: data });
      expect(await actionsOf(changed.ctx, "campaign")).toEqual(before);
      expect(changed.fake.log.some((e) => /lookback_window/.test(e.query ?? ""))).toBe(false);
    });
  });
});

describe("mapping seam and capabilities (Stage B)", () => {
  it("still validates metric requests first", async () => {
    const { fake, ctx } = setup();
    await expect(
      provider().fetchDailyMetrics(ctx, {
        accountExternalId: "2220000001",
        level: "campaign",
        breakdown: "none",
        from: "2026-01-01",
        to: "2026-03-01",
      }),
    ).rejects.toMatchObject({ kind: "invalid_request", providerCode: "range" });
    expect(fake.log).toHaveLength(0);
  });

  it("ships the production mapping and no test seam", () => {
    expect(Object.isFrozen(GOOGLE_MAPPING)).toBe(true);
    expect(Object.keys(GOOGLE_MAPPING).sort()).toEqual(
      ["actionMetrics", "adGroups", "ads", "campaigns", "creatives", "dailyMetrics"].sort(),
    );
    expect(Object.isFrozen(provider())).toBe(true);
    // @ts-expect-error — no fetch injection
    createGoogleAdsProvider({ ...OPTIONS, fetch: globalThis.fetch });
    // @ts-expect-error — no mapping injection
    createGoogleAdsProvider({ ...OPTIONS, mapping: {} });
  });

  it("declares exactly the Stage B capabilities", () => {
    expect(GOOGLE_CAPABILITIES).toEqual({
      entities: { campaigns: true, adGroups: true, ads: true, creatives: true },
      adGroupKinds: ["ad_group", "asset_group"],
      incrementalEntities: false,
      metricLevels: ["account", "campaign", "ad_group", "ad"],
      placementBreakdown: true,
      placements: [
        "all",
        "google_search",
        "search_partners",
        "google_display",
        "youtube",
        "gmail",
        "discover",
        "cross_network",
        "other",
      ],
      reportedMetrics: [
        "spendMicros",
        "impressions",
        "clicks",
        "conversions",
        "conversionValueMicros",
        "allConversions",
      ],
      actionMetrics: true,
      attributionWindows: ["action_setting"],
      maxMetricsRangeDays: 31,
      defaultPageSize: 500,
      maxPageSize: 500,
      restatementLookbackDays: 30,
    });
    expect(Object.isFrozen(GOOGLE_CAPABILITIES)).toBe(true);
    expect(provider().capabilities).toBe(GOOGLE_CAPABILITIES);
  });
});
