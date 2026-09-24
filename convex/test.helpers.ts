/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { UserIdentity } from "convex/server";
import { expect } from "vitest";
import { internal } from "./_generated/api";
import { isMarketingError, type MarketingErrorCode } from "./lib/errors";
import type { Role } from "./lib/validation";
import schema from "./schema";
import { modules } from "./test.setup";

// Test-only helpers (two dots in the filename => never deployed by Convex).
// convex-test's `withIdentity` stands in for a JWT that Convex has already
// verified; real signature/iss/aud/exp verification is covered by tests/live.

export const ISSUER_ERP = "https://erp.example.test";
export const ISSUER_CRM = "https://crm.example.test";

export function newBackend() {
  return convexTest(schema, modules);
}

export type Backend = ReturnType<typeof newBackend>;

export async function registerApp(
  t: Backend,
  issuer: string,
  slug: string,
  status: "active" | "disabled" = "active",
) {
  await t.mutation(internal.admin.integrationApps.register, { issuer, slug, name: slug });
  if (status === "disabled") {
    await t.mutation(internal.admin.integrationApps.setStatus, { issuer, status });
  }
}

export type IdentityInput = {
  issuer?: string;
  sub?: string;
  org?: string | null;
  role?: Role | string | null;
  orgName?: string;
};

/** Builds the identity Convex would derive from a verified JWT. */
export function identity({
  issuer = ISSUER_ERP,
  sub = "user_1",
  org = "42",
  role = "admin",
  orgName,
}: IdentityInput = {}): Partial<UserIdentity> {
  return {
    issuer,
    subject: sub,
    tokenIdentifier: `${issuer}|${sub}`,
    ...(org !== null ? { org_id: org } : {}),
    ...(role !== null ? { org_role: role } : {}),
    ...(orgName ? { org_name: orgName } : {}),
  };
}

export function as(t: Backend, input: IdentityInput = {}) {
  return t.withIdentity(identity(input));
}

export async function expectMarketingError(
  promise: Promise<unknown>,
  code: MarketingErrorCode,
): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught, `expected ${code} error`).toBeDefined();
  expect(isMarketingError(caught), `expected MarketingError, got: ${String(caught)}`).toBe(true);
  expect((caught as { data: { code: string } }).data.code).toBe(code);
}

// ---------------------------------------------------------------------------
// Phase 2 data-model seeds (direct inserts; the Phase 5 write path does not exist yet)
// ---------------------------------------------------------------------------

type SeedCtx = Parameters<Parameters<Backend["run"]>[0]>[0];

/** Inserts an integration app + organization directly and returns the org id. */
export async function seedOrg(t: Backend, issuer = ISSUER_ERP, externalOrgId = "42") {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const existingApp = await ctx.db
      .query("integrationApps")
      .withIndex("by_issuer", (q) => q.eq("issuer", issuer))
      .unique();
    const appId =
      existingApp?._id ??
      (await ctx.db.insert("integrationApps", {
        issuer,
        slug: `app-${Math.abs(hashCode(issuer))}`,
        name: issuer,
        status: "active",
        createdAt: now,
        updatedAt: now,
      }));
    return await ctx.db.insert("organizations", {
      issuer,
      externalOrgId,
      appId,
      displayName: externalOrgId,
      reportingCurrency: "USD",
      timezone: "UTC",
      createdAt: now,
      updatedAt: now,
    });
  });
}

function hashCode(value: string): number {
  let hash = 0;
  for (const char of value) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return hash;
}

export type SeedOptions = {
  platform?: "meta" | "google_ads";
  accountExternalId?: string;
  campaignExternalId?: string;
  currency?: string;
  timezone?: string;
};

/**
 * Seeds one full paid + organic tree for `orgId`: account > campaign > ad group
 * > ad (+ creative), metric rows (account/campaign/ad levels, "all" + "instagram"
 * placements), an action row, and a social account with post, snapshot and daily metrics.
 */
export async function seedAdHierarchy(
  t: Backend,
  orgId: Awaited<ReturnType<typeof seedOrg>>,
  options: SeedOptions = {},
) {
  const {
    platform = "meta",
    accountExternalId = "1234567890",
    campaignExternalId = "111",
    currency = "USD",
    timezone = "America/New_York",
  } = options;

  return await t.run(async (ctx: SeedCtx) => {
    const now = Date.now();
    const life = { createdAt: now, updatedAt: now, lastSeenAt: now };

    const adAccountId = await ctx.db.insert("adAccounts", {
      orgId,
      platform,
      externalId: accountExternalId,
      name: "Account",
      currency,
      timezone,
      status: "active",
      isManager: false,
      ...life,
    });
    const campaignId = await ctx.db.insert("campaigns", {
      orgId,
      adAccountId,
      platform,
      externalId: campaignExternalId,
      name: "Campaign",
      status: "active",
      objective: "sales",
      channelType: platform === "meta" ? "social" : "search",
      budgetType: "daily",
      budgetMicros: 50_000_000n,
      budgetLevel: "campaign",
      startDate: "2026-09-01",
      ...life,
    });
    const adGroupId = await ctx.db.insert("adGroups", {
      orgId,
      adAccountId,
      campaignId,
      platform,
      externalId: "222",
      name: "Ad group",
      kind: platform === "meta" ? "ad_set" : "ad_group",
      status: "active",
      ...life,
    });
    const creativeId = await ctx.db.insert("creatives", {
      orgId,
      adAccountId,
      platform,
      externalId: platform === "meta" ? "444" : "222~333",
      format: "image",
      ...(platform === "meta" ? { instagramMediaExternalId: "17900000000000001" } : {}),
      createdAt: now,
      updatedAt: now,
    });
    const adId = await ctx.db.insert("ads", {
      orgId,
      adAccountId,
      campaignId,
      adGroupId,
      platform,
      externalId: platform === "meta" ? "333" : "222~333",
      name: "Ad",
      status: "active",
      creativeId,
      format: "image",
      ...life,
    });

    const base = { orgId, platform, adAccountId, currency, syncedAt: now } as const;
    const metricIds = [];
    for (const date of ["2026-09-01", "2026-09-02"]) {
      metricIds.push(
        await ctx.db.insert("metricsDaily", {
          ...base,
          level: "account",
          entityId: adAccountId,
          date,
          placement: "all",
          spendMicros: 12_345_678n,
          impressions: 1000,
          reach: 800,
          clicks: 20,
        }),
        await ctx.db.insert("metricsDaily", {
          ...base,
          level: "campaign",
          entityId: campaignId,
          campaignId,
          date,
          placement: "instagram",
          spendMicros: 5_000_000n,
          impressions: 400,
        }),
        await ctx.db.insert("metricsDaily", {
          ...base,
          level: "ad",
          entityId: adId,
          campaignId,
          adGroupId,
          adId,
          date,
          placement: "all",
          spendMicros: 1_000_000n,
          conversions: 1.5,
          conversionValueMicros: 99_990_000n,
        }),
      );
    }
    const actionId = await ctx.db.insert("actionMetricsDaily", {
      ...base,
      level: "campaign",
      entityId: campaignId,
      campaignId,
      date: "2026-09-01",
      placement: "all",
      actionType: "purchase",
      rawActionType: "offsite_conversion.fb_pixel_purchase",
      attributionWindow: "7d_click_1d_view",
      attributionBasis: "impression_or_click_date",
      count: 3,
      valueMicros: 150_000_000n,
      isPrimary: true,
    });

    const socialAccountId = await ctx.db.insert("socialAccounts", {
      orgId,
      platform: "instagram",
      externalId: "17841400000000001",
      username: "brand",
      name: "Brand",
      accountType: "business",
      status: "active",
      ...life,
    });
    const postId = await ctx.db.insert("socialPosts", {
      orgId,
      socialAccountId,
      platform: "instagram",
      externalId: "17900000000000001",
      type: "reel",
      publishedAt: now,
      ...life,
    });
    const snapshotId = await ctx.db.insert("socialPostMetricSnapshots", {
      orgId,
      socialAccountId,
      postId,
      platform: "instagram",
      capturedDate: "2026-09-02",
      capturedAt: now,
      likes: 10,
      reach: 500,
    });
    const accountMetricsId = await ctx.db.insert("socialAccountMetricsDaily", {
      orgId,
      socialAccountId,
      platform: "instagram",
      date: "2026-09-01",
      followers: 1200,
      syncedAt: now,
    });

    return {
      adAccountId,
      campaignId,
      adGroupId,
      adId,
      creativeId,
      metricIds,
      actionId,
      socialAccountId,
      postId,
      snapshotId,
      accountMetricsId,
    };
  });
}
