/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { UserIdentity } from "convex/server";
import { expect, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { mockAuthorizationCode } from "./providers/mock/oauth";
import {
  FAKE_IG_APP_ID,
  FAKE_IG_APP_SECRET,
  type FakeInstagram,
} from "./providers/instagram/fakeInstagram.fixtures";
import { mockInstagramCode } from "./providers/social/mock";
import { subjectOf } from "./sync/subject";
import {
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  FAKE_CONFIG_ID,
  type FakeGraph,
} from "./providers/meta/fakeGraph.fixtures";
import {
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  type FakeGoogleAds,
} from "./providers/google/fakeGoogleAds.fixtures";
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
// Phase 2 data-model seeds (direct inserts that bypass convex/sync/upsert.ts on purpose;
// test-only, exempt from the canonical-insert lint rule)
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

// ---------------------------------------------------------------------------
// Phase 4 connection-flow helpers (mock "instant consent" OAuth)
// ---------------------------------------------------------------------------

export const RETURN_URL = "https://app.example.test/settings/connections";

/** Registers an app with an OAuth return-URL allowlist. */
export async function registerAppWithReturnUrls(
  t: Backend,
  issuer: string,
  slug: string,
  urls: string[] = ["https://app.example.test/settings/"],
) {
  await registerApp(t, issuer, slug);
  await t.mutation(internal.admin.integrationApps.setAllowedReturnUrls, { issuer, urls });
}

/** Path + query of an absolute callback URL, for t.fetch. */
export function callbackPath(url: string): string {
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

export async function followCallback(t: Backend, url: string): Promise<Response> {
  return await t.fetch(callbackPath(url), { method: "GET", redirect: "manual" });
}

/** Parses the redirect produced by the callback. */
export function redirectParams(response: Response): URLSearchParams {
  const location = response.headers.get("location");
  if (!location) throw new Error(`expected a redirect, got ${response.status}`);
  return new URL(location).searchParams;
}

// ---------------------------------------------------------------------------
// Phase 5 sync helpers (mock providers end to end)
// ---------------------------------------------------------------------------

/** Registers the app, provisions the org (as admin) and returns the backend. */
export async function setupSyncOrg(t: Backend, identityInput: IdentityInput = {}) {
  const issuer = identityInput.issuer ?? ISSUER_ERP;
  const existing = await t.run((ctx) =>
    ctx.db
      .query("integrationApps")
      .withIndex("by_issuer", (q) => q.eq("issuer", issuer))
      .unique(),
  );
  if (existing === null) {
    await registerAppWithReturnUrls(t, issuer, `app-${Math.abs(hashCode(issuer))}`);
  }
  await as(t, identityInput).mutation(api.v1.orgs.ensure, {});
}

/**
 * Connects a mock platform identity through the REAL connect flow (beginConnect
 * -> /oauth/callback -> encrypted credential). `user` selects the mock user and
 * optional scenario, e.g. "1", "1--rate_limited", "1--default--v1".
 */
export async function connectMock(
  t: Backend,
  provider: "meta" | "google_ads",
  user = "1",
  identityInput: IdentityInput = {},
): Promise<string> {
  const { authorizeUrl } = await as(t, identityInput).action(api.v1.connections.beginConnect, {
    provider,
    returnUrl: RETURN_URL,
  });
  const url = new URL(authorizeUrl);
  url.searchParams.set(
    "code",
    mockAuthorizationCode(provider, url.searchParams.get("code_challenge") ?? undefined, user),
  );
  const params = redirectParams(await followCallback(t, url.toString()));
  expect(params.get("status"), params.get("error") ?? "").toBe("connected");
  return params.get("connection")!;
}

export async function linkMock(
  t: Backend,
  connectionId: string,
  externalIds: string[],
  identityInput: IdentityInput = {},
) {
  return await as(t, identityInput).mutation(api.v1.connections.linkAdAccounts, {
    connectionId,
    externalIds,
  });
}

/**
 * The ad account of a sync row (syncAccounts / syncRuns / syncTasks). Throws — failing the
 * test — unless the row names exactly one subject and it is an ad account (Phase 10 subject
 * invariant), so ad-only assertions never need a non-null assertion.
 */
export function adSubjectOf(row: {
  adAccountId?: Id<"adAccounts">;
  socialAccountId?: Id<"socialAccounts">;
}): Id<"adAccounts"> {
  const subject = subjectOf(row);
  if (subject.kind !== "ad") throw new Error("Expected an ad-account sync subject");
  return subject.adAccountId;
}

/** Runs every scheduled function (workers, finalize steps, retries) to completion. */
export async function drainScheduler(t: Backend) {
  await t.finishAllScheduledFunctions(vi.runAllTimers, 20_000);
}

/** One planner tick followed by all the work it scheduled. */
export async function planAndDrain(t: Backend) {
  const result = await t.mutation(internal.sync.planner.tick, {});
  await drainScheduler(t);
  return result;
}

// ---------------------------------------------------------------------------
// Phase 8 helpers: the real Meta provider in live mode against the fake Graph
// ---------------------------------------------------------------------------

/** PROVIDER_MODE=live with test-only Meta app values, and `fetch` served by the fake Graph. */
export function stubLiveMeta(graph: FakeGraph, env: Record<string, string> = {}) {
  vi.stubEnv("PROVIDER_MODE", "live");
  vi.stubEnv("META_APP_ID", FAKE_APP_ID);
  vi.stubEnv("META_APP_SECRET", FAKE_APP_SECRET);
  vi.stubEnv("META_LOGIN_CONFIG_ID", FAKE_CONFIG_ID);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubGlobal("fetch", graph.fetch);
}

/**
 * Connects a Meta identity through the REAL connect flow (beginConnect -> fake
 * Facebook consent -> /oauth/callback -> Meta OAuthSpec against the fake Graph).
 * Returns the callback's redirect parameters.
 */
export async function connectMetaFake(
  t: Backend,
  graph: FakeGraph,
  user: string,
  identityInput: IdentityInput = {},
): Promise<URLSearchParams> {
  const { authorizeUrl } = await as(t, identityInput).action(api.v1.connections.beginConnect, {
    provider: "meta",
    returnUrl: RETURN_URL,
  });
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  const code = graph.issueCode(user);
  return redirectParams(
    await t.fetch(
      `/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
      { method: "GET", redirect: "manual" },
    ),
  );
}

// ---------------------------------------------------------------------------
// Phase 9 helpers: the real Google Ads provider in live mode against the fake API
// ---------------------------------------------------------------------------

/** PROVIDER_MODE=live with test-only Meta + Google values; `fetch` served by the fake Google API. */
export function stubLiveGoogle(fake: FakeGoogleAds, env: Record<string, string> = {}) {
  vi.stubEnv("PROVIDER_MODE", "live");
  vi.stubEnv("META_APP_ID", FAKE_APP_ID);
  vi.stubEnv("META_APP_SECRET", FAKE_APP_SECRET);
  vi.stubEnv("META_LOGIN_CONFIG_ID", FAKE_CONFIG_ID);
  vi.stubEnv("GOOGLE_CLIENT_ID", FAKE_GOOGLE_CLIENT_ID);
  vi.stubEnv("GOOGLE_CLIENT_SECRET", FAKE_GOOGLE_CLIENT_SECRET);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubGlobal("fetch", fake.fetch);
}

/**
 * Connects a Google identity through the REAL connect flow (beginConnect -> fake Google
 * consent bound to the PKCE challenge and redirect URI -> /oauth/callback -> Google OAuthSpec
 * against the fake API). Returns the callback's redirect parameters.
 */
export async function connectGoogleFake(
  t: Backend,
  fake: FakeGoogleAds,
  user: string,
  identityInput: IdentityInput = {},
): Promise<URLSearchParams> {
  const { authorizeUrl } = await as(t, identityInput).action(api.v1.connections.beginConnect, {
    provider: "google_ads",
    returnUrl: RETURN_URL,
  });
  const params = new URL(authorizeUrl).searchParams;
  const code = fake.issueCode(
    user,
    params.get("code_challenge")!,
    params.get("redirect_uri") ?? undefined,
  );
  return redirectParams(
    await t.fetch(
      `/oauth/callback?state=${encodeURIComponent(params.get("state")!)}&code=${encodeURIComponent(code)}`,
      { method: "GET", redirect: "manual" },
    ),
  );
}

// ---------------------------------------------------------------------------
// Phase 10 helpers: Instagram (organic social) connect flows
// ---------------------------------------------------------------------------

/** PROVIDER_MODE=live with test-only Instagram app values; `fetch` served by the fake API. */
export function stubLiveInstagram(fake: FakeInstagram, env: Record<string, string> = {}) {
  vi.stubEnv("PROVIDER_MODE", "live");
  vi.stubEnv("INSTAGRAM_APP_ID", FAKE_IG_APP_ID);
  vi.stubEnv("INSTAGRAM_APP_SECRET", FAKE_IG_APP_SECRET);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  vi.stubGlobal("fetch", fake.fetch);
}

/**
 * Connects an Instagram professional account through the REAL connect flow (beginConnect ->
 * fake Instagram consent -> /oauth/callback -> Instagram OAuthSpec + SDK-free discovery
 * against the fake API). Returns the callback's redirect parameters.
 */
export async function connectInstagramFake(
  t: Backend,
  fake: FakeInstagram,
  user = "business",
  identityInput: IdentityInput = {},
  extra: { reconnectConnectionId?: string } = {},
): Promise<URLSearchParams> {
  const { authorizeUrl } = await as(t, identityInput).action(api.v1.connections.beginConnect, {
    provider: "instagram",
    returnUrl: RETURN_URL,
    ...extra,
  });
  const state = new URL(authorizeUrl).searchParams.get("state")!;
  return redirectParams(
    await t.fetch(
      `/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(fake.issueCode(user))}`,
      { method: "GET", redirect: "manual" },
    ),
  );
}

/** Mock mode: connects a mock Instagram user ("1", "creator", "personal", "revoked", ...). */
export async function connectMockInstagram(
  t: Backend,
  user = "1",
  identityInput: IdentityInput = {},
): Promise<URLSearchParams> {
  const { authorizeUrl } = await as(t, identityInput).action(api.v1.connections.beginConnect, {
    provider: "instagram",
    returnUrl: RETURN_URL,
  });
  const url = new URL(authorizeUrl);
  url.searchParams.set("code", mockInstagramCode(user));
  return redirectParams(await followCallback(t, url.toString()));
}

export async function linkSocial(
  t: Backend,
  connectionId: string,
  externalIds: string[],
  identityInput: IdentityInput = {},
) {
  return await as(t, identityInput).mutation(api.v1.connections.linkSocialAccounts, {
    connectionId,
    externalIds,
  });
}
