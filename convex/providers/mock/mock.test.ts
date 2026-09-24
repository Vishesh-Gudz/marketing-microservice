import { describe, expect, it } from "vitest";
import { AD_METRICS, type AdMetricKey } from "../../domain/metrics";
import type { AdPlatform, EntityLevel } from "../../domain/types";
import { sumMicros } from "../../lib/money";
import { expectProviderError } from "../contract.suite";
import { isProviderError } from "../errors";
import { collectAll } from "../pagination";
import type { AdsProvider, MetricsRequest, ProviderContext, ProviderMetricRow } from "../types";
import {
  createMockAdsProvider,
  mockCredential,
  RATE_LIMIT_RETRY_AFTER_MS,
  REVOKED_MOCK_TOKEN,
  type MockCredential,
  type MockScenario,
} from ".";

const ctx = (attempt = 1, token?: string): ProviderContext<MockCredential> => ({
  credential: mockCredential(token),
  attempt,
});

const provider = (platform: AdPlatform, scenario?: MockScenario) =>
  createMockAdsProvider({ platform, ...(scenario ? { scenario } : {}) });

async function allMetrics(p: AdsProvider<MockCredential>, request: MetricsRequest) {
  return (
    await collectAll((cursor) =>
      p.fetchDailyMetrics(ctx(), { ...request, ...(cursor ? { cursor } : {}) }),
    )
  ).items;
}

const MARCH = { from: "2026-03-01", to: "2026-03-31" } as const;

describe("Meta-like normalization", () => {
  const meta = provider("meta");

  it("normalizes accounts (act_ prefix, status, business parent)", async () => {
    const { items } = await meta.listAccounts(ctx(), {});
    expect(items.map((a) => a.externalId)).toEqual(["1001", "1002", "1003"]);
    expect(items[0]).toMatchObject({
      currency: "USD",
      timezone: "America/New_York",
      parentExternalId: "5550001",
    });
    expect(items[2]).toMatchObject({ status: "disabled", rawStatus: "2" });
  });

  it("normalizes campaigns: minor-unit budgets, CBO/ABO, account-local dates, statuses", async () => {
    const { items } = await meta.listCampaigns(ctx(), { accountExternalId: "1001" });
    const [cbo, abo, archived] = items;
    expect(cbo).toMatchObject({
      budgetType: "daily",
      budgetMicros: 150_000_000n,
      budgetLevel: "campaign",
      objective: "sales",
      status: "active",
      deliveryStatus: "delivering",
      startDate: "2026-01-01",
      channelType: "social",
    });
    expect(cbo).not.toHaveProperty("endDate");
    expect(abo).toMatchObject({
      budgetType: "none",
      budgetLevel: "ad_group",
      status: "paused",
      endDate: "2026-06-30",
    });
    expect(abo).not.toHaveProperty("budgetMicros");
    expect(archived).toMatchObject({
      budgetType: "lifetime",
      budgetMicros: 5_000_000_000n,
      status: "archived",
      deliveryStatus: "ended",
    });
  });

  it("normalizes ad sets, ads and creatives", async () => {
    const groups = (await meta.listAdGroups(ctx(), { accountExternalId: "1001" })).items;
    expect(groups.find((g) => g.externalId === "120210000000201")?.attributionSetting).toBe(
      "7d_click_1d_view",
    );
    expect(groups.find((g) => g.externalId === "120210000000202")?.attributionSetting).toBe(
      "1d_click",
    );
    expect(groups.find((g) => g.externalId === "120210000000203")).toMatchObject({
      budgetMicros: 40_000_000n,
      kind: "ad_set",
    });

    const ads = (await meta.listAds(ctx(), { accountExternalId: "1001" })).items;
    const deleted = ads.find((a) => a.externalId === "120210000000304")!;
    expect(deleted).toMatchObject({ status: "removed", deliveryStatus: "ended" });
    expect(deleted).not.toHaveProperty("creativeExternalId");
    expect(ads.find((a) => a.externalId === "120210000000303")?.format).toBe("carousel");
    // Creative 402 is reused by two ads (Meta creatives are reusable objects).
    expect(ads.filter((a) => a.creativeExternalId === "120210000000402")).toHaveLength(2);

    const creatives = (await meta.listCreatives(ctx(), { accountExternalId: "1001" })).items;
    expect(creatives.find((c) => c.externalId === "120210000000401")).toMatchObject({
      format: "video",
      instagramMediaExternalId: "17900000000000401",
    });
  });
});

describe("Google-like normalization", () => {
  const google = provider("google_ads");

  it("normalizes dashed customer ids, managers and closed accounts", async () => {
    const { items } = await google.listAccounts(ctx(), {});
    expect(items.map((a) => a.externalId)).toEqual([
      "1112223333",
      "4445556666",
      "7778889999",
      "9990001111",
    ]);
    expect(items[0]).toMatchObject({ parentExternalId: "9990001111", isManager: false });
    expect(items.find((a) => a.externalId === "9990001111")?.isManager).toBe(true);
    expect(items.find((a) => a.externalId === "7778889999")?.status).toBe("closed");
  });

  it("normalizes campaigns: native micros, no-end sentinel, channels, shared budgets", async () => {
    const [brand, pmax, removed] = (
      await google.listCampaigns(ctx(), { accountExternalId: "1112223333" })
    ).items;
    expect(brand).toMatchObject({
      budgetMicros: 80_000_000n,
      channelType: "search",
      objective: "unknown",
      startDate: "2026-01-01",
    });
    expect(brand).not.toHaveProperty("endDate");
    expect(pmax).toMatchObject({ channelType: "performance_max", isSharedBudget: true });
    expect(removed).toMatchObject({
      status: "removed",
      deliveryStatus: "ended",
      endDate: "2025-12-31",
    });

    const jp = (await google.listCampaigns(ctx(), { accountExternalId: "4445556666" })).items[0];
    expect(jp?.budgetMicros).toBe(10_000_000_000n);
  });

  it("models Performance Max as an asset group without ads, and composite ad ids", async () => {
    const groups = (await google.listAdGroups(ctx(), { accountExternalId: "1112223333" })).items;
    expect(groups.find((g) => g.externalId === "23000000001")?.kind).toBe("asset_group");
    const ads = (await google.listAds(ctx(), { accountExternalId: "1112223333" })).items;
    expect(ads.every((a) => a.adGroupExternalId !== "23000000001")).toBe(true);
    expect(ads[0]).toMatchObject({
      externalId: "22000000001~24000000001",
      creativeExternalId: "22000000001~24000000001",
      format: "responsive_search",
    });
  });

  it("rejects metric requests for manager accounts", async () => {
    await expectProviderError(
      google.fetchDailyMetrics(ctx(), {
        accountExternalId: "9990001111",
        level: "account",
        breakdown: "none",
        ...MARCH,
      }),
      "invalid_request",
    );
  });
});

describe("missing-data semantics", () => {
  it("omits zero-delivery days instead of writing zeros", async () => {
    const rows = await allMetrics(provider("meta"), {
      accountExternalId: "1001",
      level: "ad",
      breakdown: "none",
      ...MARCH,
    });
    const days = rows.filter((r) => r.entityExternalId === "120210000000301").map((r) => r.date);
    expect(days.length).toBeGreaterThan(20);
    expect(days.length).toBeLessThan(31);
  });

  it("keeps unreported metrics absent (Meta conversions, Google reach)", async () => {
    const metaRows = await allMetrics(provider("meta"), {
      accountExternalId: "1001",
      level: "ad",
      breakdown: "none",
      ...MARCH,
    });
    const salesAd = metaRows.filter((r) => r.entityExternalId === "120210000000302");
    expect(salesAd.some((r) => r.conversions === undefined)).toBe(true);
    expect(salesAd.some((r) => r.conversions !== undefined)).toBe(true);
    for (const r of salesAd.filter((row) => row.conversions === undefined))
      expect(r).not.toHaveProperty("conversions");

    const googleRows = await allMetrics(provider("google_ads"), {
      accountExternalId: "1112223333",
      level: "ad",
      breakdown: "placement",
      ...MARCH,
    });
    expect(googleRows.length).toBeGreaterThan(0);
    for (const r of googleRows) {
      expect(r).not.toHaveProperty("reach");
      expect(r).not.toHaveProperty("linkClicks");
      // Google always reports conversions, including zero: a reported value, never undefined.
      expect(typeof r.conversions).toBe("number");
    }
  });

  it("reports Meta reach only on 'all' rows and never above impressions", async () => {
    const rows = await allMetrics(provider("meta"), {
      accountExternalId: "1001",
      level: "campaign",
      breakdown: "placement",
      ...MARCH,
    });
    for (const r of rows) {
      if (r.placement === "all") {
        expect(r.reach).toBeDefined();
        expect(r.reach!).toBeLessThanOrEqual(r.impressions!);
      } else {
        expect(r).not.toHaveProperty("reach");
      }
    }
  });
});

describe("additive totals", () => {
  const ADDITIVE = (Object.keys(AD_METRICS) as AdMetricKey[]).filter((k) => AD_METRICS[k].additive);

  function checkPlacementTotals(rows: ProviderMetricRow[]) {
    const groups = new Map<string, ProviderMetricRow[]>();
    for (const r of rows) {
      const key = `${r.entityExternalId}|${r.date}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    expect(groups.size).toBeGreaterThan(0);
    for (const [key, group] of groups) {
      const all = group.find((r) => r.placement === "all")!;
      const parts = group.filter((r) => r.placement !== "all");
      expect(parts.length, key).toBeGreaterThan(0);
      for (const metric of ADDITIVE) {
        const values = parts.map((p) => p[metric]);
        if (AD_METRICS[metric].kind === "money") {
          expect(all[metric], `${key} ${metric}`).toBe(sumMicros(values as (bigint | undefined)[]));
        } else if (values.every((v) => v === undefined)) {
          expect(all, `${key} ${metric}`).not.toHaveProperty(metric);
        } else {
          const sum = (values as (number | undefined)[]).reduce<number>((s, v) => s + (v ?? 0), 0);
          expect(all[metric] as number, `${key} ${metric}`).toBeCloseTo(sum, 6);
        }
      }
    }
  }

  it.each([
    ["meta", "1001"],
    ["google_ads", "1112223333"],
  ] as const)("%s: the 'all' row equals the sum of placement rows", async (platform, account) => {
    for (const level of ["account", "campaign", "ad"] as EntityLevel[]) {
      checkPlacementTotals(
        await allMetrics(provider(platform), {
          accountExternalId: account,
          level,
          breakdown: "placement",
          ...MARCH,
        }),
      );
    }
  });

  it("keeps levels consistent: account spend = sum of campaign spend per day", async () => {
    const p = provider("meta");
    const request = { accountExternalId: "1001", breakdown: "none" as const, ...MARCH };
    const accountRows = await allMetrics(p, { ...request, level: "account" });
    const campaignRows = await allMetrics(p, { ...request, level: "campaign" });
    for (const row of accountRows) {
      const sameDay = campaignRows.filter((c) => c.date === row.date).map((c) => c.spendMicros);
      expect(row.spendMicros, row.date).toBe(sumMicros(sameDay));
    }
  });

  it("keeps high-denomination currency sums exact beyond 2^53 micros", async () => {
    const rows = await allMetrics(provider("meta"), {
      accountExternalId: "1002",
      level: "account",
      breakdown: "none",
      from: "2026-02-01",
      to: "2026-05-01",
    });
    const total = sumMicros(rows.map((r) => r.spendMicros))!;
    expect(rows.every((r) => r.currency === "IDR")).toBe(true);
    expect(total > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});

describe("capabilities match emitted data", () => {
  it.each([
    ["meta", "1001"],
    ["google_ads", "1112223333"],
  ] as const)("%s emits exactly its declared metric columns", async (platform, account) => {
    const p = provider(platform);
    const emitted = new Set<string>();
    for (const level of p.capabilities.metricLevels) {
      for (const row of await allMetrics(p, {
        accountExternalId: account,
        level,
        breakdown: "placement",
        ...MARCH,
      })) {
        for (const key of Object.keys(row)) if (key in AD_METRICS) emitted.add(key);
      }
    }
    expect([...emitted].sort()).toEqual([...p.capabilities.reportedMetrics].sort());
  });

  it("emits the declared attribution windows", async () => {
    const p = provider("meta");
    const rows = (
      await collectAll((cursor) =>
        p.fetchActionMetrics(ctx(), {
          accountExternalId: "1001",
          level: "campaign",
          breakdown: "none",
          ...MARCH,
          ...(cursor ? { cursor } : {}),
        }),
      )
    ).items;
    expect(new Set(rows.map((r) => r.attributionWindow))).toEqual(
      new Set(p.capabilities.attributionWindows),
    );
    expect(rows.some((r) => r.isPrimary === false)).toBe(true);
  });
});

describe("scenarios", () => {
  const request = {
    accountExternalId: "1001",
    level: "campaign" as const,
    breakdown: "placement" as const,
    ...MARCH,
    pageSize: 2,
  };

  it("empty: every list and metric request returns nothing", async () => {
    const p = provider("meta", "empty");
    expect((await p.listAccounts(ctx(), {})).items).toEqual([]);
    expect((await p.listCampaigns(ctx(), { accountExternalId: "1001" })).items).toEqual([]);
    expect((await p.fetchDailyMetrics(ctx(), request)).items).toEqual([]);
  });

  it("rate_limited: later pages fail on attempt 1 with retryAfterMs, succeed on attempt 2", async () => {
    const p = provider("meta", "rate_limited");
    const first = await p.fetchDailyMetrics(ctx(1), request);
    const next = { ...request, cursor: first.nextCursor! };
    let caught: unknown;
    try {
      await p.fetchDailyMetrics(ctx(1), next);
    } catch (error) {
      caught = error;
    }
    expect(isProviderError(caught) && caught).toMatchObject({
      kind: "rate_limited",
      retryable: true,
      retryAfterMs: RATE_LIMIT_RETRY_AFTER_MS,
    });
    const retried = await p.fetchDailyMetrics(ctx(2), next);
    expect(retried).toEqual(await provider("meta").fetchDailyMetrics(ctx(1), next));
  });

  it("transient: the first page fails on attempt 1 and succeeds on attempt 2", async () => {
    const p = provider("google_ads", "transient");
    await expectProviderError(
      p.listCampaigns(ctx(1), { accountExternalId: "1112223333" }),
      "transient",
    );
    await expect(
      p.listCampaigns(ctx(2), { accountExternalId: "1112223333" }),
    ).resolves.toBeDefined();
  });

  it("auth_revoked and revoked tokens fail with non-retryable auth errors", async () => {
    await expectProviderError(provider("meta", "auth_revoked").listAccounts(ctx(), {}), "auth");
    await expectProviderError(
      provider("meta").listAccounts(ctx(1, REVOKED_MOCK_TOKEN), {}),
      "auth",
    );
    await expectProviderError(
      provider("meta").listAccounts({ credential: { kind: "oauth" } as never, attempt: 1 }, {}),
      "auth",
    );
  });

  it("permission_denied: only the denied account fails", async () => {
    const p = provider("meta", "permission_denied");
    await expectProviderError(p.listCampaigns(ctx(), { accountExternalId: "1002" }), "permission");
    await expect(p.listCampaigns(ctx(), { accountExternalId: "1001" })).resolves.toBeDefined();
  });

  it("malformed: a bad raw record becomes a non-retryable data error", async () => {
    await expectProviderError(
      provider("meta", "malformed").listCampaigns(ctx(), { accountExternalId: "1001" }),
      "data",
    );
    await expectProviderError(
      provider("google_ads", "malformed").listAdGroups(ctx(), {
        accountExternalId: "1112223333",
        pageSize: 200,
      }),
      "data",
    );
  });

  it("slow_pages: forces one item per page", async () => {
    const p = provider("meta", "slow_pages");
    const page = await p.listCampaigns(ctx(), { accountExternalId: "1001", pageSize: 50 });
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
  });

  it("rejects non-positive attempts", async () => {
    await expectProviderError(
      provider("meta").listAccounts({ credential: mockCredential(), attempt: 0 }, {}),
      "invalid_request",
    );
  });
});
