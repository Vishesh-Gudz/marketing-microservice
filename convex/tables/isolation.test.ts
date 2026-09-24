import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { getOwned, type Tenant, type TenantTable } from "../lib/tenancy";
import {
  expectMarketingError,
  ISSUER_CRM,
  ISSUER_ERP,
  newBackend,
  seedAdHierarchy,
  seedOrg,
} from "../test.helpers";

function tenantFor(orgId: Id<"organizations">): Tenant {
  return {
    orgId,
    appId: "unused" as Id<"integrationApps">,
    issuer: "",
    externalOrgId: "",
    subject: "test",
    role: "admin",
  };
}

async function twoTenantsWithIdenticalExternalIds() {
  const t = newBackend();
  const orgA = await seedOrg(t, ISSUER_ERP, "42");
  const orgB = await seedOrg(t, ISSUER_CRM, "42");
  // Same Meta account / campaign / ad ids under both tenants.
  const a = await seedAdHierarchy(t, orgA);
  const b = await seedAdHierarchy(t, orgB);
  return { t, orgA, orgB, a, b };
}

describe("tenant isolation of the canonical data model", () => {
  it("keeps identical external ids from two tenants as separate rows", async () => {
    const { t, orgA, orgB, a, b } = await twoTenantsWithIdenticalExternalIds();
    expect(a.adAccountId).not.toBe(b.adAccountId);
    expect(a.campaignId).not.toBe(b.campaignId);

    await t.run(async (ctx) => {
      for (const [orgId, expected] of [
        [orgA, a.adAccountId],
        [orgB, b.adAccountId],
      ] as const) {
        const accounts = await ctx.db
          .query("adAccounts")
          .withIndex("by_org_platform_external", (q) =>
            q.eq("orgId", orgId).eq("platform", "meta").eq("externalId", "1234567890"),
          )
          .collect();
        expect(accounts.map((row) => row._id)).toEqual([expected]);
      }
    });
  });

  it("scopes every org-first index to its tenant", async () => {
    const { t, orgA, a } = await twoTenantsWithIdenticalExternalIds();
    await t.run(async (ctx) => {
      const campaigns = await ctx.db
        .query("campaigns")
        .withIndex("by_org_account_external", (q) => q.eq("orgId", orgA))
        .collect();
      expect(campaigns.map((c) => c._id)).toEqual([a.campaignId]);

      const accountRows = await ctx.db
        .query("metricsDaily")
        .withIndex("by_org_level_placement_date", (q) =>
          q.eq("orgId", orgA).eq("level", "account").eq("placement", "all"),
        )
        .collect();
      expect(accountRows).toHaveLength(2);
      expect(accountRows.every((row) => row.orgId === orgA)).toBe(true);

      const posts = await ctx.db
        .query("socialPosts")
        .withIndex("by_org_platform_external", (q) =>
          q.eq("orgId", orgA).eq("platform", "instagram").eq("externalId", "17900000000000001"),
        )
        .collect();
      expect(posts.map((p) => p._id)).toEqual([a.postId]);
    });
  });

  it("getOwned returns NOT_FOUND for every table across tenants", async () => {
    const { t, orgA, orgB, a } = await twoTenantsWithIdenticalExternalIds();
    const owned: [TenantTable, string][] = [
      ["adAccounts", a.adAccountId],
      ["campaigns", a.campaignId],
      ["adGroups", a.adGroupId],
      ["ads", a.adId],
      ["creatives", a.creativeId],
      ["metricsDaily", a.metricIds[0]!],
      ["actionMetricsDaily", a.actionId],
      ["socialAccounts", a.socialAccountId],
      ["socialPosts", a.postId],
      ["socialPostMetricSnapshots", a.snapshotId],
      ["socialAccountMetricsDaily", a.accountMetricsId],
    ];

    for (const [table, id] of owned) {
      await t.run(async (ctx) => {
        const doc = await getOwned({ db: ctx.db, tenant: tenantFor(orgA) }, table, id);
        expect(doc._id).toBe(id);
      });
      await expectMarketingError(
        t.run((ctx) => getOwned({ db: ctx.db, tenant: tenantFor(orgB) }, table, id)),
        "NOT_FOUND",
      );
    }
  });

  it("keeps Meta and Google ids apart within one tenant", async () => {
    const t = newBackend();
    const orgId = await seedOrg(t);
    const meta = await seedAdHierarchy(t, orgId, { platform: "meta", campaignExternalId: "111" });
    const google = await seedAdHierarchy(t, orgId, {
      platform: "google_ads",
      campaignExternalId: "111",
    });
    expect(meta.adAccountId).not.toBe(google.adAccountId);
    expect(meta.campaignId).not.toBe(google.campaignId);

    await t.run(async (ctx) => {
      for (const [adAccountId, expected] of [
        [meta.adAccountId, meta.campaignId],
        [google.adAccountId, google.campaignId],
      ] as const) {
        const rows = await ctx.db
          .query("campaigns")
          .withIndex("by_org_account_external", (q) =>
            q.eq("orgId", orgId).eq("adAccountId", adAccountId).eq("externalId", "111"),
          )
          .collect();
        expect(rows.map((r) => r._id)).toEqual([expected]);
      }
    });
  });

  it("resolves metric upsert keys to exactly one row", async () => {
    const { t, orgA, a } = await twoTenantsWithIdenticalExternalIds();
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("metricsDaily")
        .withIndex("by_org_entity_placement_date", (q) =>
          q
            .eq("orgId", orgA)
            .eq("entityId", a.campaignId)
            .eq("placement", "instagram")
            .eq("date", "2026-09-01"),
        )
        .unique();
      expect(row?.spendMicros).toBe(5_000_000n);

      const range = await ctx.db
        .query("metricsDaily")
        .withIndex("by_org_entity_placement_date", (q) =>
          q
            .eq("orgId", orgA)
            .eq("entityId", a.adAccountId)
            .eq("placement", "all")
            .gte("date", "2026-09-01")
            .lte("date", "2026-09-30"),
        )
        .collect();
      expect(range.map((r) => r.date)).toEqual(["2026-09-01", "2026-09-02"]);
    });
  });
});

describe("schema validation on write", () => {
  it("round-trips int64 money exactly, beyond 2^53", async () => {
    const t = newBackend();
    const orgId = await seedOrg(t);
    const { adAccountId } = await seedAdHierarchy(t, orgId, { currency: "IDR" });
    const huge = 12_000_000_000_123_457n;
    await t.run(async (ctx) => {
      const id = await ctx.db.insert("metricsDaily", {
        orgId,
        platform: "meta",
        adAccountId,
        level: "account",
        entityId: adAccountId,
        date: "2026-09-03",
        placement: "all",
        currency: "IDR",
        spendMicros: huge,
        syncedAt: Date.now(),
      });
      expect((await ctx.db.get(id))?.spendMicros).toBe(huge);
    });
  });

  it("rejects documents that violate the schema", async () => {
    const t = newBackend();
    const orgId = await seedOrg(t);
    const ids = await seedAdHierarchy(t, orgId);
    const now = Date.now();
    const metricBase = {
      orgId,
      platform: "meta" as const,
      adAccountId: ids.adAccountId,
      level: "campaign" as const,
      entityId: ids.campaignId,
      date: "2026-09-05",
      placement: "all" as const,
      currency: "USD",
      syncedAt: now,
    };

    const invalid: [
      string,
      (ctx: Parameters<Parameters<typeof t.run>[0]>[0]) => Promise<unknown>,
    ][] = [
      [
        "unknown campaign status",
        (ctx) => ctx.db.patch(ids.campaignId, { status: "running" as never }),
      ],
      [
        "float money",
        (ctx) => ctx.db.insert("metricsDaily", { ...metricBase, spendMicros: 1.5 as never }),
      ],
      [
        "unknown placement",
        (ctx) => ctx.db.insert("metricsDaily", { ...metricBase, placement: "tiktok" as never }),
      ],
      [
        "metric entity from a non-ad table",
        (ctx) => ctx.db.insert("metricsDaily", { ...metricBase, entityId: ids.postId as never }),
      ],
      [
        "missing orgId",
        (ctx) => {
          const { orgId: _omit, ...rest } = metricBase;
          return ctx.db.insert("metricsDaily", rest as never);
        },
      ],
      [
        "unknown ad platform",
        (ctx) => ctx.db.patch(ids.adAccountId, { platform: "tiktok" as never }),
      ],
      ["unknown social post type", (ctx) => ctx.db.patch(ids.postId, { type: "tweet" as never })],
    ];

    for (const [label, write] of invalid) {
      await expect(t.run(write), label).rejects.toThrow();
    }
  });
});
