import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  as,
  connectMock,
  expectMarketingError,
  ISSUER_CRM,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
  type IdentityInput,
} from "../test.helpers";

// v1 analytics over the canonical tables: seeded rows for exact expectations,
// real Phase 5 mock syncs for end-to-end behavior.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-04-10T15:00:00Z");
const APRIL = { from: "2026-04-01", to: "2026-04-10" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function orgOf(t: Backend, who: IdentityInput = {}) {
  await setupSyncOrg(t, who);
  return (await t.run(async (ctx) =>
    (await ctx.db.query("organizations").collect()).find(
      (o) => o.issuer === (who.issuer ?? "https://erp.example.test"),
    ),
  ))!._id;
}

type AccountSeed = {
  platform?: "meta" | "google_ads";
  externalId: string;
  currency?: string;
  timezone?: string;
  coveredFrom?: string;
  coveredThrough?: string;
};

async function seedAccount(t: Backend, orgId: Id<"organizations">, seed: AccountSeed) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const adAccountId = await ctx.db.insert("adAccounts", {
      orgId,
      platform: seed.platform ?? "meta",
      externalId: seed.externalId,
      name: `Account ${seed.externalId}`,
      currency: seed.currency ?? "USD",
      timezone: seed.timezone ?? "America/New_York",
      status: "active",
      isManager: false,
      createdAt: now,
      updatedAt: now,
    });
    if (seed.coveredFrom !== undefined) {
      await ctx.db.insert("syncAccounts", {
        orgId,
        adAccountId,
        state: "idle",
        structureStale: false,
        coveredFrom: seed.coveredFrom,
        coveredThrough: seed.coveredThrough ?? seed.coveredFrom,
        backfillHorizon: "2025-01-01",
        consecutiveFailures: 0,
        lastSuccessAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
    return adAccountId;
  });
}

type RowSeed = Partial<Doc<"metricsDaily">> & { date: string };

async function seedRows(
  t: Backend,
  orgId: Id<"organizations">,
  adAccountId: Id<"adAccounts">,
  rows: RowSeed[],
) {
  await t.run(async (ctx) => {
    const account = (await ctx.db.get(adAccountId))!;
    for (const row of rows) {
      await ctx.db.insert("metricsDaily", {
        orgId,
        platform: account.platform,
        adAccountId,
        level: "account",
        entityId: adAccountId,
        placement: "all",
        currency: account.currency,
        syncedAt: Date.now(),
        ...row,
      });
    }
  });
}

async function seedCampaign(
  t: Backend,
  orgId: Id<"organizations">,
  adAccountId: Id<"adAccounts">,
  externalId: string,
  name = `Campaign ${externalId}`,
) {
  return await t.run(async (ctx) => {
    const account = (await ctx.db.get(adAccountId))!;
    const now = Date.now();
    return await ctx.db.insert("campaigns", {
      orgId,
      adAccountId,
      platform: account.platform,
      externalId,
      name,
      status: "active",
      objective: "sales",
      budgetType: "daily",
      budgetMicros: 25_000_000n,
      budgetLevel: "campaign",
      createdAt: now,
      updatedAt: now,
    });
  });
}

const overview = (t: Backend, args: Record<string, unknown> = {}, who: IdentityInput = {}) =>
  as(t, { role: "viewer", ...who }).query(api.v1.analytics.overview, { range: APRIL, ...args });

describe("overview", () => {
  it("sums account-level rows exactly and computes KPIs", async () => {
    const t = newBackend();
    const orgId = await orgOf(t);
    const a = await seedAccount(t, orgId, {
      externalId: "1",
      coveredFrom: "2026-01-01",
      coveredThrough: "2026-04-10",
    });
    const b = await seedAccount(t, orgId, {
      externalId: "2",
      coveredFrom: "2026-01-01",
      coveredThrough: "2026-04-10",
    });
    await seedRows(t, orgId, a, [
      {
        date: "2026-04-01",
        spendMicros: 10_000_000n,
        impressions: 1_000,
        clicks: 10,
        conversions: 1.5,
        conversionValueMicros: 30_000_000n,
      },
      {
        date: "2026-04-02",
        spendMicros: 5_000_000n,
        impressions: 500,
        clicks: 5,
        conversions: 0,
        conversionValueMicros: 0n,
      },
    ]);
    await seedRows(t, orgId, b, [
      { date: "2026-04-05", spendMicros: 2n ** 60n, impressions: 2_500, clicks: 25 },
      { date: "2026-03-31", spendMicros: 99_000_000n, impressions: 1, clicks: 1 }, // outside range
    ]);

    const result = await overview(t);
    expect(result.accountCount).toBe(2);
    expect(result.totals.dataState).toBe("reported");
    expect(result.fx).toEqual({ reportingCurrency: "USD", status: "not_needed" });
    const total = (2n ** 60n + 15_000_000n).toString();
    expect(result.totals.metrics.spend).toEqual({
      native: [{ currency: "USD", micros: total }],
      reporting: { currency: "USD", micros: total },
    });
    expect(result.totals.metrics.impressions).toBe(4_000);
    expect(result.totals.metrics.clicks).toBe(40);
    expect(result.totals.metrics.conversions).toBe(1.5);
    expect(result.totals.metrics.partialMetrics).toEqual(["conversions", "conversionValue"]);
    expect(result.totals.kpis.ctr).toBe(0.01);
    // Paired sums: ROAS only over rows reporting both value and spend (account 1).
    expect(result.totals.kpis.roas).toBe(2);
    expect(result.totals.kpis.partialKpis).toContain("roas");
    expect(result.totals.kpis.cpc?.native[0]?.currency).toBe("USD");
    // Money KPIs are MoneyAmountsDto, ratio KPIs are numbers.
    expect(typeof result.totals.kpis.cpc?.native[0]?.micros).toBe("string");
    expect(typeof result.totals.kpis.ctr).toBe("number");
    expect(JSON.stringify(result)).not.toContain("null");
  });

  it("distinguishes no_delivery, unknown and partial coverage", async () => {
    const t = newBackend();
    const orgId = await orgOf(t);
    await seedAccount(t, orgId, {
      externalId: "1",
      coveredFrom: "2026-03-01",
      coveredThrough: "2026-04-10",
    });
    expect((await overview(t)).totals.dataState).toBe("no_delivery");
    expect((await overview(t)).totals.metrics).toEqual({
      unavailableMetrics: [],
      partialMetrics: [],
    });

    const u = newBackend();
    const uOrg = await orgOf(u);
    await seedAccount(u, uOrg, { externalId: "1" });
    expect((await overview(u)).totals.dataState).toBe("unknown");

    const p = newBackend();
    const pOrg = await orgOf(p);
    const acc = await seedAccount(p, pOrg, {
      externalId: "1",
      coveredFrom: "2026-04-05",
      coveredThrough: "2026-04-10",
    });
    await seedRows(p, pOrg, acc, [{ date: "2026-04-06", spendMicros: 1n }]);
    const partial = await overview(p);
    expect(partial.totals.dataState).toBe("partial");
    expect(partial.coverage.accounts[0]).toMatchObject({ daysUncovered: 4, supported: true });
  });

  it("keeps native money per currency and converts only with rates", async () => {
    const t = newBackend();
    const orgId = await orgOf(t);
    const usd = await seedAccount(t, orgId, {
      externalId: "1",
      coveredFrom: "2026-01-01",
      coveredThrough: "2026-04-10",
    });
    const eur = await seedAccount(t, orgId, {
      externalId: "2",
      currency: "EUR",
      coveredFrom: "2026-01-01",
      coveredThrough: "2026-04-10",
    });
    await seedRows(t, orgId, usd, [{ date: "2026-04-02", spendMicros: 10_000_000n, clicks: 10 }]);
    await seedRows(t, orgId, eur, [{ date: "2026-04-03", spendMicros: 8_000_000n, clicks: 10 }]);

    const missing = await overview(t);
    expect(missing.fx).toEqual({
      reportingCurrency: "USD",
      status: "missing",
      missing: [{ currency: "EUR", days: 1 }],
    });
    expect(missing.totals.metrics.spend).toEqual({
      native: [
        { currency: "EUR", micros: "8000000" },
        { currency: "USD", micros: "10000000" },
      ],
    });
    expect(missing.totals.kpis.cpc).toEqual({
      native: [
        { currency: "EUR", micros: "800000" },
        { currency: "USD", micros: "1000000" },
      ],
    });

    // A rate 2 days older than the metric day is used (<= 7 days fallback).
    await t.mutation(internal.admin.fxRates.upsert, {
      rates: [{ quote: "EUR", date: "2026-04-01", rate: "0.8" }],
    });
    const converted = await overview(t);
    expect(converted.fx.status).toBe("complete");
    expect(converted.totals.metrics.spend?.reporting).toEqual({
      currency: "USD",
      micros: "20000000",
    });
    expect(converted.totals.kpis.cpc?.reporting).toEqual({ currency: "USD", micros: "1000000" });
  });

  it("compares with the previous period", async () => {
    const t = newBackend();
    const orgId = await orgOf(t);
    const a = await seedAccount(t, orgId, {
      externalId: "1",
      coveredFrom: "2026-01-01",
      coveredThrough: "2026-04-10",
    });
    await seedRows(t, orgId, a, [
      { date: "2026-04-02", spendMicros: 30_000_000n, impressions: 300, clicks: 0 },
      { date: "2026-03-25", spendMicros: 20_000_000n, impressions: 200, clicks: 0 },
    ]);
    const result = await overview(t, { compare: "previous_period" });
    expect(result.comparison?.range).toEqual({ from: "2026-03-22", to: "2026-03-31" });
    expect(result.comparison?.deltas.spend).toEqual({
      absolute: {
        native: [{ currency: "USD", micros: "10000000" }],
        reporting: { currency: "USD", micros: "10000000" },
      },
      percent: 0.5,
    });
    expect(result.comparison?.deltas.impressions).toEqual({ absolute: 100, percent: 0.5 });
    expect(result.comparison?.deltas.clicks).toEqual({ absolute: 0, reason: "previous_zero" });
    // Not reported in the current period: no delta (the reason is in unavailableMetrics).
    expect(result.comparison?.deltas).not.toHaveProperty("conversions");
    expect(result.totals.metrics.unavailableMetrics).toContainEqual({
      metric: "conversions",
      reason: "not_reported",
    });

    const empty = await overview(t, { compare: { from: "2026-02-01", to: "2026-02-10" } });
    expect(empty.comparison?.previous.dataState).toBe("no_delivery");
    expect(empty.comparison?.deltas.spend).toEqual({ reason: "previous_unavailable" });
  });

  it("applies one DateKey range to each account's own local days", async () => {
    const t = newBackend();
    const orgId = await orgOf(t);
    const tokyo = await seedAccount(t, orgId, {
      externalId: "1",
      timezone: "Asia/Tokyo",
      coveredFrom: "2026-04-01",
      coveredThrough: "2026-04-11",
    });
    const la = await seedAccount(t, orgId, {
      externalId: "2",
      timezone: "America/Los_Angeles",
      coveredFrom: "2026-04-01",
      coveredThrough: "2026-04-10",
    });
    await seedRows(t, orgId, tokyo, [
      { date: "2026-04-10", impressions: 1 },
      { date: "2026-04-11", impressions: 100 }, // Tokyo's local "today"; outside the range
    ]);
    await seedRows(t, orgId, la, [{ date: "2026-04-10", impressions: 10 }]);
    const result = await overview(t, { range: { from: "2026-04-10", to: "2026-04-10" } });
    expect(result.totals.metrics.impressions).toBe(11);
  });
});

describe("clock independence (D5)", () => {
  it("never rejects a range for being after today; uncovered days are unknown", async () => {
    const t = newBackend();
    const orgId = await orgOf(t);
    const a = await seedAccount(t, orgId, {
      externalId: "1",
      coveredFrom: "2026-01-01",
      coveredThrough: "2026-04-10",
    });
    await seedRows(t, orgId, a, [{ date: "2026-04-09", impressions: 5 }]);
    const straddling = await overview(t, { range: { from: "2026-04-08", to: "2026-04-20" } });
    expect(straddling.totals.dataState).toBe("partial");
    expect(straddling.coverage.accounts[0]!.daysUncovered).toBe(10);
    const future = await overview(t, { range: { from: "2030-01-01", to: "2030-01-10" } });
    expect(future.totals.dataState).toBe("unknown");
  });

  it("returns the same result for the same range whatever the current time", async () => {
    const t = newBackend();
    const orgId = await orgOf(t);
    const a = await seedAccount(t, orgId, {
      externalId: "1",
      coveredFrom: "2026-01-01",
      coveredThrough: "2026-04-10",
    });
    await seedRows(t, orgId, a, [{ date: "2026-04-02", spendMicros: 3n, impressions: 9 }]);
    const before = await overview(t, { compare: "previous_period" });
    vi.setSystemTime(new Date("2027-12-31T23:00:00Z"));
    expect(await overview(t, { compare: "previous_period" })).toEqual(before);
  });
});

describe("public enums", () => {
  it("expose exactly the documented reason, state and status values", async () => {
    const fns = await import("./analytics");
    const literals = new Map<string, Set<string>>();
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (typeof node !== "object" || node === null) return;
      const rec = node as Record<string, unknown>;
      if (rec.type === "object" && typeof rec.value === "object" && rec.value !== null) {
        for (const [field, spec] of Object.entries(
          rec.value as Record<string, { fieldType: unknown }>,
        )) {
          const type = spec.fieldType as { type: string; value: unknown };
          if (type.type === "union" && Array.isArray(type.value)) {
            const values = (type.value as { type: string; value: string }[])
              .filter((m) => m.type === "literal")
              .map((m) => m.value);
            if (values.length > 0) {
              // FX status shares the name "status" with entity status: key it by its object.
              const key =
                field === "status" && "reportingCurrency" in (rec.value as object)
                  ? "fx.status"
                  : field;
              const set = literals.get(key) ?? new Set<string>();
              values.forEach((v) => set.add(v));
              literals.set(key, set);
            }
          }
        }
      }
      Object.values(rec).forEach(walk);
    };
    for (const fn of [fns.overview, fns.timeSeries, fns.performance, fns.breakdown, fns.actions]) {
      walk(JSON.parse((fn as unknown as { exportReturns: () => string }).exportReturns()));
    }
    const sorted = (field: string) => [...(literals.get(field) ?? [])].sort();
    expect(sorted("reason")).toEqual(
      [
        // unavailableMetrics
        "not_reported",
        "non_additive",
        "invalid_data",
        // unavailableKpis (and action KPIs)
        "numerator_unavailable",
        "denominator_unavailable",
        "zero_denominator",
        "mixed_currency",
        // deltas
        "previous_zero",
        "previous_unavailable",
      ].sort(),
    );
    expect(sorted("dataState")).toEqual(
      ["no_delivery", "partial", "reported", "unknown", "unsupported"].sort(),
    );
    expect(sorted("fx.status")).toEqual(["complete", "missing", "not_needed"]);
    expect(sorted("kpi")).toEqual(
      [
        "costPerAction",
        "costPerConversion",
        "conversionRate",
        "cpc",
        "cpm",
        "ctr",
        "roas",
        "valuePerSpend",
      ].sort(),
    );
  });
});

describe("validation and limits", () => {
  it("rejects invalid ranges with INVALID_ARGUMENT", async () => {
    const t = newBackend();
    await orgOf(t);
    for (const range of [
      { from: "2026-02-30", to: "2026-03-01" },
      { from: "2026-04-10", to: "2026-04-01" },
      { from: "2025-01-01", to: "2026-04-01" },
    ]) {
      await expectMarketingError(overview(t, { range }), "INVALID_ARGUMENT");
    }
    await expectMarketingError(
      overview(t, { filters: { accountIds: Array.from({ length: 51 }, (_, i) => String(i)) } }),
      "INVALID_ARGUMENT",
    );
  });

  it("requires auth and a provisioned org", async () => {
    const t = newBackend();
    await expectMarketingError(
      t.query(api.v1.analytics.overview, { range: APRIL }),
      "UNAUTHENTICATED",
    );
  });

  it("fails with too_many_rows instead of truncating", async () => {
    const t = newBackend();
    const orgId = await orgOf(t);
    const account = await seedAccount(t, orgId, {
      externalId: "1",
      coveredFrom: "2025-01-01",
      coveredThrough: "2026-04-10",
    });
    const campaigns: Id<"campaigns">[] = [];
    for (let i = 0; i < 21; i++)
      campaigns.push(await seedCampaign(t, orgId, account, String(100 + i)));
    await t.run(async (ctx) => {
      for (const campaignId of campaigns) {
        for (let d = 0; d < 400; d++) {
          const date = new Date(Date.UTC(2025, 2, 7 + d)).toISOString().slice(0, 10);
          await ctx.db.insert("metricsDaily", {
            orgId,
            platform: "meta",
            adAccountId: account,
            level: "campaign",
            entityId: campaignId,
            campaignId,
            placement: "all",
            currency: "USD",
            date,
            spendMicros: 1n,
            syncedAt: 0,
          });
        }
      }
    });
    let caught: unknown;
    try {
      await as(t).query(api.v1.analytics.performance, {
        level: "campaign",
        range: { from: "2025-03-07", to: "2026-04-10" },
        paginationOpts: { numItems: 10, cursor: null },
      });
    } catch (error) {
      caught = error;
    }
    expect(
      (caught as { data: { code: string; details: Record<string, unknown> } }).data,
    ).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "too_many_rows", maxRows: 8000 },
    });
    // Narrower range: within budget.
    const ok = await as(t).query(api.v1.analytics.performance, {
      level: "campaign",
      range: { from: "2026-03-01", to: "2026-04-10" },
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(ok.page).toHaveLength(10);
  });
});

describe("performance", () => {
  async function setup() {
    const t = newBackend();
    const orgId = await orgOf(t);
    const account = await seedAccount(t, orgId, {
      externalId: "1",
      coveredFrom: "2026-01-01",
      coveredThrough: "2026-04-10",
    });
    const ids: Id<"campaigns">[] = [];
    for (const [i, spend] of [5n, 30n, 10n, 20n].entries()) {
      const id = await seedCampaign(t, orgId, account, String(10 + i), `C${i}`);
      ids.push(id);
      await seedRows(t, orgId, account, [
        {
          date: "2026-04-03",
          level: "campaign",
          entityId: id,
          campaignId: id,
          spendMicros: spend * 1_000_000n,
          impressions: 100,
        },
      ]);
    }
    return { t, orgId, account, ids };
  }

  it("sorts by spend and paginates with a request-bound cursor", async () => {
    const { t } = await setup();
    const first = await as(t).query(api.v1.analytics.performance, {
      level: "campaign",
      range: APRIL,
      paginationOpts: { numItems: 3, cursor: null },
    });
    expect(first.page.map((r) => r.entity.name)).toEqual(["C1", "C3", "C2"]);
    expect(first.isDone).toBe(false);
    expect(first.page[0]!.entity).toMatchObject({
      level: "campaign",
      budget: { currency: "USD", micros: "25000000" },
      removed: false,
    });
    const second = await as(t).query(api.v1.analytics.performance, {
      level: "campaign",
      range: APRIL,
      paginationOpts: { numItems: 3, cursor: first.continueCursor },
    });
    expect(second.page.map((r) => r.entity.name)).toEqual(["C0"]);
    expect(second.isDone).toBe(true);
    await expectMarketingError(
      as(t).query(api.v1.analytics.performance, {
        level: "campaign",
        range: { from: "2026-04-02", to: "2026-04-10" },
        paginationOpts: { numItems: 3, cursor: first.continueCursor },
      }),
      "INVALID_ARGUMENT",
    );
    const byName = await as(t).query(api.v1.analytics.performance, {
      level: "campaign",
      range: APRIL,
      sort: { by: "name" },
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(byName.page.map((r) => r.entity.name)).toEqual(["C0", "C1", "C2", "C3"]);
  });

  it("lists every scoped entity; entities without rows get no_delivery / unknown", async () => {
    const { t, orgId, account } = await setup();
    const idle = await seedCampaign(t, orgId, account, "99", "Idle campaign");
    const page = await as(t).query(api.v1.analytics.performance, {
      level: "campaign",
      range: APRIL,
      compare: "previous_period",
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page).toHaveLength(5);
    const row = page.page.at(-1)!; // no spend -> sorted last
    expect(row.entity.id).toBe(idle);
    expect(row.dataState).toBe("no_delivery");
    expect(row.metrics).toEqual({ unavailableMetrics: [], partialMetrics: [] });
    expect(row.kpis).toEqual({ unavailableKpis: [], partialKpis: [] });
    expect(row.comparison?.previous.dataState).toBe("no_delivery");
    expect(row.comparison?.deltas).toEqual({});

    // Outside coverage the same entity is "unknown", not "no_delivery".
    const outside = await as(t).query(api.v1.analytics.performance, {
      level: "campaign",
      range: { from: "2025-06-01", to: "2025-06-30" },
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(outside.page.every((r) => r.dataState === "unknown")).toBe(true);
  });

  it("validates parent scopes", async () => {
    const { t, account } = await setup();
    await expectMarketingError(
      as(t).query(api.v1.analytics.performance, {
        level: "ad",
        range: APRIL,
        paginationOpts: { numItems: 10, cursor: null },
      }),
      "INVALID_ARGUMENT",
    );
    await expectMarketingError(
      as(t).query(api.v1.analytics.performance, {
        level: "ad_group",
        range: APRIL,
        parent: { accountId: account },
        paginationOpts: { numItems: 10, cursor: null },
      }),
      "INVALID_ARGUMENT",
    );
  });
});

describe("tenant isolation", () => {
  it("never mixes tenants, even with identical external ids", async () => {
    const t = newBackend();
    const erp = await orgOf(t);
    const crm = await orgOf(t, { issuer: ISSUER_CRM });
    const erpAccount = await seedAccount(t, erp, {
      externalId: "1",
      coveredFrom: "2026-01-01",
      coveredThrough: "2026-04-10",
    });
    const crmAccount = await seedAccount(t, crm, {
      externalId: "1",
      coveredFrom: "2026-01-01",
      coveredThrough: "2026-04-10",
    });
    await seedRows(t, erp, erpAccount, [{ date: "2026-04-02", impressions: 7 }]);
    await seedRows(t, crm, crmAccount, [{ date: "2026-04-02", impressions: 1_000 }]);

    expect((await overview(t)).totals.metrics.impressions).toBe(7);
    expect((await overview(t, {}, { issuer: ISSUER_CRM })).totals.metrics.impressions).toBe(1_000);
    await expectMarketingError(overview(t, { filters: { accountIds: [crmAccount] } }), "NOT_FOUND");
    await expectMarketingError(
      as(t).query(api.v1.analytics.timeSeries, {
        range: APRIL,
        granularity: "day",
        entity: { level: "account", id: crmAccount },
      }),
      "NOT_FOUND",
    );
  });
});

describe("end to end over Phase 5 mock syncs", () => {
  async function synced() {
    const t = newBackend();
    await setupSyncOrg(t);
    const meta = await connectMock(t, "meta");
    const [metaAccount] = await linkMock(t, meta, ["1001"]);
    const google = await connectMock(t, "google_ads");
    const [googleAccount] = await linkMock(t, google, ["4445556666"]);
    await planAndDrain(t);
    return { t, metaAccount: metaAccount!.id, googleAccount: googleAccount!.id };
  }

  it("matches the stored account-level rows and exposes every query", async () => {
    const { t, metaAccount, googleAccount } = await synced();
    const range = { from: "2026-03-15", to: "2026-04-09" };
    const rows = await t.run((ctx) =>
      ctx.db
        .query("metricsDaily")
        .filter((q) => q.and(q.eq(q.field("level"), "account"), q.eq(q.field("placement"), "all")))
        .collect(),
    );
    const inRange = rows.filter((r) => r.date >= range.from && r.date <= range.to);
    const expectedImpressions = inRange.reduce((sum, r) => sum + (r.impressions ?? 0), 0);

    const result = await as(t).query(api.v1.analytics.overview, {
      range,
      compare: "previous_period",
    });
    expect(result.totals.dataState).toBe("reported");
    expect(result.totals.metrics.impressions).toBe(expectedImpressions);
    // Meta USD + Google JPY without rates: native per currency, no reporting total.
    expect(result.totals.metrics.spend?.native.map((m) => m.currency)).toEqual(["JPY", "USD"]);
    expect(result.fx.status).toBe("missing");
    expect(result.totals.metrics.unavailableMetrics).toContainEqual({
      metric: "reach",
      reason: "non_additive",
    });

    const series = await as(t).query(api.v1.analytics.timeSeries, {
      range,
      granularity: "day",
      entity: { level: "account", id: metaAccount },
    });
    expect(series.points).toHaveLength(26);
    expect(series.points.some((p) => typeof p.metrics.reach === "number")).toBe(true);

    const weeks = await as(t).query(api.v1.analytics.timeSeries, { range, granularity: "week" });
    expect(weeks.points[0]).toMatchObject({ bucket: "2026-03-09", partial: true });

    const campaigns = await as(t).query(api.v1.analytics.performance, {
      level: "campaign",
      range,
      parent: { accountId: metaAccount },
      compare: "previous_period",
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(campaigns.page.length).toBeGreaterThan(0);
    expect(campaigns.page.every((r) => r.entity.accountId === metaAccount)).toBe(true);
    const campaignId = campaigns.page[0]!.entity.id;
    const adGroups = await as(t).query(api.v1.analytics.performance, {
      level: "ad_group",
      range,
      parent: { campaignId },
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(adGroups.page.every((r) => r.entity.campaignId === campaignId)).toBe(true);

    const placements = await as(t).query(api.v1.analytics.breakdown, { by: "placement", range });
    const keys = placements.groups.map((g) => g.key);
    expect(keys).not.toContain("all");
    expect(keys).toEqual(expect.arrayContaining(["facebook", "instagram", "google_search"]));
    const platforms = await as(t).query(api.v1.analytics.breakdown, { by: "platform", range });
    expect(platforms.groups.map((g) => g.key)).toEqual(["google_ads", "meta"]);
    const byAccount = await as(t).query(api.v1.analytics.breakdown, { by: "account", range });
    const sum = byAccount.groups.reduce((n, g) => n + (g.metrics.impressions ?? 0), 0);
    expect(sum).toBe(expectedImpressions);

    const actions = await as(t).query(api.v1.analytics.actions, {
      range,
      filters: { accountIds: [metaAccount] },
    });
    const purchase = actions.groups.filter((g) => g.actionType === "purchase");
    // Two attribution windows = two separate groups, never summed.
    expect(new Set(purchase.map((g) => g.attributionWindow))).toEqual(
      new Set(["7d_click_1d_view", "1d_click"]),
    );
    expect(purchase.every((g) => g.costPerAction?.native[0]?.currency === "USD")).toBe(true);
    const googleActions = await as(t).query(api.v1.analytics.actions, {
      range,
      entity: { level: "account", id: googleAccount },
      filters: { primaryOnly: true },
    });
    expect(googleActions.groups.every((g) => g.isPrimary === true)).toBe(true);
  });
});
