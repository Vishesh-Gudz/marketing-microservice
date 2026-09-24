import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import type { AdPlatform } from "../domain/types";
import type { Tenant } from "../lib/tenancy";
import { MappingError } from "../providers/errors";
import { createMockAdsProvider, mockCredential } from "../providers/mock";
import { collectAll } from "../providers/pagination";
import type {
  EntityRequest,
  MetricsRequest,
  PageRequest,
  ProviderContext,
  ProviderMetricRow,
} from "../providers/types";
import { ISSUER_CRM, ISSUER_ERP, newBackend, seedOrg, type Backend } from "../test.helpers";
import {
  mapActionRows,
  mapAd,
  mapAdAccount,
  mapAdGroup,
  mapCampaign,
  mapCreative,
  mapMetricRows,
} from "./ads";
import { resolverFromMaps, type ResolverMaps } from "./resolver";
import { accountScopeFromDoc, orgScopeFromTenant, type AccountScope } from "./scope";

const NOW = 1_790_000_000_000;
const ctx = { credential: mockCredential(), attempt: 1 };
const MARCH = { from: "2026-03-01", to: "2026-03-07" };

function tenantFor(orgId: Id<"organizations">): Tenant {
  return {
    orgId,
    appId: "app" as Id<"integrationApps">,
    issuer: "",
    externalOrgId: "",
    subject: "s",
    role: "admin",
  };
}

const all = <T>(
  fetch: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>,
) => collectAll(fetch).then((r) => r.items);

/**
 * The full Phase 3 boundary against the REAL Phase 2 schema:
 * mock provider -> provider records -> mapping -> convex-test inserts.
 */
async function ingest(
  t: Backend,
  orgId: Id<"organizations">,
  platform: AdPlatform,
  accountExternalId: string,
) {
  const provider = createMockAdsProvider({ platform });
  const accountRecord = (await provider.listAccounts(ctx, {})).items.find(
    (a) => a.externalId === accountExternalId,
  )!;
  const adAccountId = await t.run((c) =>
    c.db.insert(
      "adAccounts",
      mapAdAccount(accountRecord, orgScopeFromTenant(tenantFor(orgId)), NOW),
    ),
  );
  const accountDoc = (await t.run((c) => c.db.get(adAccountId)))!;
  const scope = accountScopeFromDoc(accountDoc);

  const req = (cursor?: string): EntityRequest => ({
    accountExternalId,
    ...(cursor ? { cursor } : {}),
  });
  const maps = {
    campaigns: new Map<string, Id<"campaigns">>(),
    adGroups: new Map<string, { adGroupId: Id<"adGroups">; campaignId: Id<"campaigns"> }>(),
    ads: new Map<
      string,
      { adId: Id<"ads">; campaignId: Id<"campaigns">; adGroupId?: Id<"adGroups"> }
    >(),
    creatives: new Map<string, Id<"creatives">>(),
  } satisfies Required<ResolverMaps>;

  for (const record of await all((c) => provider.listCampaigns(ctx, req(c)))) {
    maps.campaigns.set(
      record.externalId,
      await t.run((c) => c.db.insert("campaigns", mapCampaign(record, scope, NOW))),
    );
  }
  for (const record of await all((c) => provider.listAdGroups(ctx, req(c)))) {
    const row = mapAdGroup(record, scope, resolverFromMaps(maps), NOW);
    const id = await t.run((c) => c.db.insert("adGroups", row));
    maps.adGroups.set(record.externalId, { adGroupId: id, campaignId: row.campaignId });
  }
  for (const record of await all((c) => provider.listCreatives(ctx, req(c)))) {
    maps.creatives.set(
      record.externalId,
      await t.run((c) => c.db.insert("creatives", mapCreative(record, scope, NOW))),
    );
  }
  for (const record of await all((c) => provider.listAds(ctx, req(c)))) {
    const row = mapAd(record, scope, resolverFromMaps(maps), NOW);
    const id = await t.run((c) => c.db.insert("ads", row));
    maps.ads.set(record.externalId, {
      adId: id,
      campaignId: row.campaignId,
      ...(row.adGroupId ? { adGroupId: row.adGroupId } : {}),
    });
  }

  const resolver = resolverFromMaps(maps);
  let metricRows = 0;
  let actionRows = 0;
  for (const level of provider.capabilities.metricLevels) {
    const mreq = (cursor?: string): MetricsRequest => ({
      accountExternalId,
      level,
      breakdown: "placement",
      ...MARCH,
      ...(cursor ? { cursor } : {}),
    });
    const metrics = mapMetricRows(
      await all((c) => provider.fetchDailyMetrics(ctx, mreq(c))),
      scope,
      resolver,
      NOW,
    );
    expect(metrics.unresolved, `${platform} ${level} metrics`).toEqual([]);
    for (const row of metrics.rows) await t.run((c) => c.db.insert("metricsDaily", row));
    metricRows += metrics.rows.length;

    const actions = mapActionRows(
      await all((c) => provider.fetchActionMetrics(ctx, mreq(c))),
      scope,
      resolver,
      NOW,
    );
    expect(actions.unresolved, `${platform} ${level} actions`).toEqual([]);
    for (const row of actions.rows) await t.run((c) => c.db.insert("actionMetricsDaily", row));
    actionRows += actions.rows.length;
  }
  return { scope, adAccountId, maps, metricRows, actionRows, provider };
}

describe("provider records -> canonical rows -> real schema", () => {
  it.each([
    ["meta", "1001"],
    ["google_ads", "1112223333"],
  ] as const)("%s: every mapped row inserts into the Phase 2 schema", async (platform, account) => {
    const t = newBackend();
    const orgId = await seedOrg(t);
    const { adAccountId, metricRows, actionRows } = await ingest(t, orgId, platform, account);
    expect(metricRows).toBeGreaterThan(0);
    expect(actionRows).toBeGreaterThan(0);

    await t.run(async (c) => {
      const campaigns = await c.db
        .query("campaigns")
        .withIndex("by_org_account_external", (q) =>
          q.eq("orgId", orgId).eq("adAccountId", adAccountId),
        )
        .collect();
      expect(campaigns.length).toBeGreaterThan(0);
      for (const campaign of campaigns) {
        expect(campaign).toMatchObject({
          orgId,
          adAccountId,
          platform,
          createdAt: NOW,
          updatedAt: NOW,
          lastSeenAt: NOW,
        });
      }
      const metrics = await c.db
        .query("metricsDaily")
        .withIndex("by_org_account_level_placement_date", (q) =>
          q.eq("orgId", orgId).eq("adAccountId", adAccountId),
        )
        .collect();
      expect(metrics).toHaveLength(metricRows);
      for (const m of metrics) {
        expect(typeof m.spendMicros).toBe("bigint");
        expect(m.syncedAt).toBe(NOW);
        if (m.level === "ad") expect(m.adId).toBe(m.entityId);
        if (m.level === "campaign") expect(m.campaignId).toBe(m.entityId);
      }
    });
  });

  it("denormalizes parents onto ad-level metric rows", async () => {
    const t = newBackend();
    const orgId = await seedOrg(t);
    const { maps } = await ingest(t, orgId, "meta", "1001");
    const ad = maps.ads.get("120210000000301")!;
    await t.run(async (c) => {
      const rows = await c.db
        .query("metricsDaily")
        .withIndex("by_org_entity_placement_date", (q) =>
          q.eq("orgId", orgId).eq("entityId", ad.adId),
        )
        .collect();
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows)
        expect(r).toMatchObject({
          level: "ad",
          adId: ad.adId,
          adGroupId: ad.adGroupId,
          campaignId: ad.campaignId,
        });
    });
  });
});

describe("scope enforcement", () => {
  async function scopes() {
    const t = newBackend();
    const orgId = await seedOrg(t);
    const meta = await ingest(t, orgId, "meta", "1001");
    const google = await ingest(t, orgId, "google_ads", "1112223333");
    return { t, orgId, meta, google };
  }

  async function mappingError(fn: () => unknown): Promise<MappingError> {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(MappingError);
      return error as MappingError;
    }
    throw new Error("expected a MappingError");
  }

  it("rejects platform, account and currency mismatches", async () => {
    const { meta, google } = await scopes();
    const metaCampaign = (await meta.provider.listCampaigns(ctx, { accountExternalId: "1001" }))
      .items[0]!;

    expect((await mappingError(() => mapCampaign(metaCampaign, google.scope, NOW))).reason).toBe(
      "platform_mismatch",
    );

    const otherAccount = (await meta.provider.listCampaigns(ctx, { accountExternalId: "1002" }))
      .items[0]!;
    expect((await mappingError(() => mapCampaign(otherAccount, meta.scope, NOW))).reason).toBe(
      "account_mismatch",
    );

    const row = (
      await meta.provider.fetchDailyMetrics(ctx, {
        accountExternalId: "1001",
        level: "account",
        breakdown: "none",
        ...MARCH,
      })
    ).items[0]!;
    expect(
      (
        await mappingError(() =>
          mapMetricRows([{ ...row, currency: "EUR" }], meta.scope, resolverFromMaps({}), NOW),
        )
      ).reason,
    ).toBe("currency_mismatch");
  });

  it("rejects invalid records, including smuggled tenant ids", async () => {
    const { meta } = await scopes();
    const campaign = (await meta.provider.listCampaigns(ctx, { accountExternalId: "1001" }))
      .items[0]!;
    const smuggled = { ...campaign, orgId: "someone-else" } as unknown as typeof campaign;
    expect((await mappingError(() => mapCampaign(smuggled, meta.scope, NOW))).reason).toBe(
      "invalid_record",
    );
  });

  it("surfaces unresolved entities instead of dropping them", async () => {
    const { meta } = await scopes();
    const records = await all((c) =>
      meta.provider.fetchDailyMetrics(ctx, {
        accountExternalId: "1001",
        level: "ad",
        breakdown: "none",
        ...MARCH,
        ...(c ? { cursor: c } : {}),
      }),
    );
    const batch = mapMetricRows(records, meta.scope, resolverFromMaps({}), NOW);
    expect(batch.rows).toEqual([]);
    expect(batch.unresolved).toEqual(records);

    const partial = mapMetricRows(
      records,
      meta.scope,
      resolverFromMaps({ ads: new Map([...meta.maps.ads].slice(0, 1)) }),
      NOW,
    );
    expect(partial.rows.length + partial.unresolved.length).toBe(records.length);
    expect(partial.rows.length).toBeGreaterThan(0);
    expect(partial.unresolved.length).toBeGreaterThan(0);

    const group = (await meta.provider.listAdGroups(ctx, { accountExternalId: "1001" })).items[0]!;
    expect(
      (await mappingError(() => mapAdGroup(group, meta.scope, resolverFromMaps({}), NOW))).reason,
    ).toBe("unresolved_entity");
  });

  it("rejects an ad whose ad group belongs to another campaign", async () => {
    const { meta } = await scopes();
    const ad = (await meta.provider.listAds(ctx, { accountExternalId: "1001" })).items[0]!;
    const wrongParent = new Map(meta.maps.adGroups);
    const group = wrongParent.get(ad.adGroupExternalId!)!;
    const otherCampaign = [...meta.maps.campaigns.values()].find((id) => id !== group.campaignId)!;
    wrongParent.set(ad.adGroupExternalId!, { ...group, campaignId: otherCampaign });
    const resolver = resolverFromMaps({ ...meta.maps, adGroups: wrongParent });
    expect((await mappingError(() => mapAd(ad, meta.scope, resolver, NOW))).reason).toBe(
      "invalid_record",
    );
  });
});

describe("tenant boundary", () => {
  it("maps identical provider data into each tenant's own rows only", async () => {
    const t = newBackend();
    const orgA = await seedOrg(t, ISSUER_ERP, "42");
    const orgB = await seedOrg(t, ISSUER_CRM, "42");
    const a = await ingest(t, orgA, "meta", "1001");
    const b = await ingest(t, orgB, "meta", "1001");
    expect(a.adAccountId).not.toBe(b.adAccountId);
    await t.run(async (c) => {
      for (const [orgId, scope] of [
        [orgA, a.scope],
        [orgB, b.scope],
      ] as const) {
        const rows = await c.db
          .query("metricsDaily")
          .withIndex("by_org_account_level_placement_date", (q) => q.eq("orgId", orgId))
          .collect();
        expect(rows.length).toBe(a.metricRows);
        expect(rows.every((r) => r.orgId === orgId && r.adAccountId === scope.adAccountId)).toBe(
          true,
        );
      }
    });
  });

  it("derives scopes only from the tenant or a stored account, and freezes them", async () => {
    const t = newBackend();
    const orgId = await seedOrg(t);
    const { scope, adAccountId } = await ingest(t, orgId, "google_ads", "1112223333");
    const doc = (await t.run((c) => c.db.get(adAccountId))) as Doc<"adAccounts">;
    expect(scope).toEqual({
      orgId: doc.orgId,
      adAccountId: doc._id,
      platform: doc.platform,
      externalId: doc.externalId,
      currency: doc.currency,
      timezone: doc.timezone,
    });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(Object.isFrozen(orgScopeFromTenant(tenantFor(orgId)))).toBe(true);
  });

  it("type-level: provider inputs carry no tenant ids and scopes cannot be forged", () => {
    type Equals<A, B> =
      (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
    type HasOrg<T> = "orgId" extends keyof T ? true : false;
    const assert = <T extends true>(value: T) => value;

    assert<Equals<HasOrg<ProviderContext>, false>>(true);
    assert<Equals<HasOrg<PageRequest>, false>>(true);
    assert<Equals<HasOrg<EntityRequest>, false>>(true);
    assert<Equals<HasOrg<MetricsRequest>, false>>(true);
    assert<Equals<HasOrg<ProviderMetricRow>, false>>(true);

    const orgId = "org" as Id<"organizations">;
    // @ts-expect-error: scopes are branded; object literals cannot stand in for them.
    const forged: AccountScope = {
      orgId,
      adAccountId: "a" as Id<"adAccounts">,
      platform: "meta",
      externalId: "1",
      currency: "USD",
      timezone: "UTC",
    };
    // @ts-expect-error: requests do not accept an orgId.
    const request: EntityRequest = { accountExternalId: "1001", orgId };
    // @ts-expect-error: the provider context does not accept an orgId.
    const context: ProviderContext = { credential: null, attempt: 1, orgId };
    expect([forged, request, context]).toHaveLength(3);
  });
});
