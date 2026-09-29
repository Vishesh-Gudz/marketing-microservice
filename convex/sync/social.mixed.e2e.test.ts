import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Id } from "../_generated/dataModel";
import { mockInstagramAccountId } from "../providers/social/mock";
import {
  connectMock,
  connectMockInstagram,
  ISSUER_CRM,
  linkMock,
  linkSocial,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
  type IdentityInput,
} from "../test.helpers";

// Phase 10 Stage B mixed regression (mock mode): Meta Ads + Google Ads + Instagram organic in
// one org. The ad side must be byte-identical to an ad-only baseline (same rows, same runs,
// same coverage), organic rows never reference ad data (and vice versa), and a second org
// syncing the same Instagram account sees only its own rows.

vi.setConfig({ testTimeout: 300_000 });
const NOW = new Date("2026-09-28T12:00:00Z");
const TICKS = 2;

/** JSON with int64 metric values (bigint) spelled out. */
const json = (value: unknown) =>
  JSON.stringify(value, (_key, x: unknown) => (typeof x === "bigint" ? `${x}n` : x));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

const AD_TABLES = [
  "adAccounts",
  "campaigns",
  "adGroups",
  "ads",
  "creatives",
  "metricsDaily",
  "actionMetricsDaily",
] as const;
/** Organic tables keyed by a social account (socialAccounts itself is the account). */
const SOCIAL_CHILD_TABLES = [
  "socialPosts",
  "socialPostMetricSnapshots",
  "socialAccountMetricsDaily",
] as const;

async function setup(t: Backend, withInstagram: boolean, who: IdentityInput = {}) {
  await setupSyncOrg(t, who);
  const meta = await connectMock(t, "meta", "1", who);
  await linkMock(t, meta, ["1001"], who);
  const google = await connectMock(t, "google_ads", "1", who);
  await linkMock(t, google, ["4445556666"], who);
  if (withInstagram) {
    const ig = (await connectMockInstagram(t, "1", who)).get("connection")!;
    await linkSocial(t, ig, [mockInstagramAccountId("1")], who);
  }
}

async function sync(t: Backend, ticks = TICKS) {
  for (let i = 0; i < ticks; i++) await planAndDrain(t);
}

/**
 * Every ad-side row with Convex ids replaced by stable natural labels (ids differ between
 * backends; everything else must be identical). Run/task pointers are dropped.
 */
async function adSnapshot(t: Backend) {
  return await t.run(async (ctx) => {
    const labels = new Map<string, string>();
    for (const org of await ctx.db.query("organizations").collect())
      labels.set(org._id, `org:${org.externalOrgId}`);
    for (const connection of await ctx.db.query("connections").collect()) {
      labels.set(connection._id, `connection:${connection.provider}`);
    }
    for (const table of ["adAccounts", "campaigns", "adGroups", "ads", "creatives"] as const) {
      for (const row of await ctx.db.query(table).collect()) {
        labels.set(row._id, `${table}:${row.externalId}`);
      }
    }
    const clean = (row: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(row)
          .filter(
            ([key]) => !["_id", "_creationTime", "lastRunId", "activeRunId", "runId"].includes(key),
          )
          .map(([key, value]) => [
            key,
            typeof value === "string" ? (labels.get(value) ?? value) : value,
          ]),
      );
    const out: Record<string, unknown[]> = {};
    for (const table of AD_TABLES) {
      out[table] = (await ctx.db.query(table).collect())
        .map(clean)
        .sort((a, b) => json(a).localeCompare(json(b)));
    }
    const isAd = (row: { adAccountId?: string }) => row.adAccountId !== undefined;
    out.syncAccounts = (await ctx.db.query("syncAccounts").collect()).filter(isAd).map(clean);
    out.syncRuns = (await ctx.db.query("syncRuns").collect())
      .filter(isAd)
      .map(clean)
      .sort((a, b) => json(a).localeCompare(json(b)));
    out.syncTasks = (await ctx.db.query("syncTasks").collect())
      .filter(isAd)
      .map(clean)
      .sort((a, b) => json(a).localeCompare(json(b)));
    return out;
  });
}

describe("Meta + Google + Instagram mixed regression", () => {
  it("ad rows, runs and coverage are identical to an ad-only baseline", async () => {
    const baseline = newBackend();
    await setup(baseline, false);
    await sync(baseline);
    const mixed = newBackend();
    await setup(mixed, true);
    await sync(mixed);

    const expected = await adSnapshot(baseline);
    const actual = await adSnapshot(mixed);
    expect((expected.metricsDaily as unknown[]).length).toBeGreaterThan(0);
    expect((expected.syncRuns as unknown[]).length).toBeGreaterThan(2);
    expect(actual).toEqual(expected);

    // The mixed backend really synced organic data.
    const social = await mixed.run(async (ctx) => ({
      runs: (await ctx.db.query("syncRuns").collect()).filter(
        (r) => r.socialAccountId !== undefined,
      ),
      posts: await ctx.db.query("socialPosts").collect(),
      days: await ctx.db.query("socialAccountMetricsDaily").collect(),
    }));
    expect(social.runs.length).toBeGreaterThan(0);
    expect(social.runs.every((r) => r.status === "succeeded")).toBe(true);
    expect(social.posts.length).toBeGreaterThan(0);
    expect(social.days.length).toBeGreaterThan(0);
  });

  it("no cross-table writes between ad and organic data", async () => {
    const t = newBackend();
    await setup(t, true);
    await sync(t, 1);
    await t.run(async (ctx) => {
      const adAccounts = new Set(
        (await ctx.db.query("adAccounts").collect()).map((a) => a._id as string),
      );
      const socialAccounts = new Set(
        (await ctx.db.query("socialAccounts").collect()).map((a) => a._id as string),
      );
      expect(adAccounts.size).toBe(2);
      expect(socialAccounts.size).toBe(1);
      for (const table of [
        "metricsDaily",
        "actionMetricsDaily",
        "campaigns",
        "adGroups",
        "ads",
        "creatives",
      ] as const) {
        for (const row of await ctx.db.query(table).collect()) {
          expect(adAccounts.has(row.adAccountId)).toBe(true);
          expect(json(row)).not.toContain(mockInstagramAccountId("1"));
        }
      }
      for (const table of [
        "socialPosts",
        "socialPostMetricSnapshots",
        "socialAccountMetricsDaily",
      ] as const) {
        for (const row of await ctx.db.query(table).collect()) {
          expect(socialAccounts.has(row.socialAccountId)).toBe(true);
          expect(row).not.toHaveProperty("adAccountId");
        }
      }
      // Every sync row names exactly one subject of its own kind.
      for (const table of ["syncAccounts", "syncRuns", "syncTasks"] as const) {
        for (const row of await ctx.db.query(table).collect()) {
          const ad = row.adAccountId !== undefined;
          const social = row.socialAccountId !== undefined;
          expect(ad !== social).toBe(true);
          if (ad) expect(adAccounts.has(row.adAccountId!)).toBe(true);
          if (social) expect(socialAccounts.has(row.socialAccountId!)).toBe(true);
        }
      }
      const socialRuns = (await ctx.db.query("syncRuns").collect()).filter(
        (r) => r.socialAccountId,
      );
      expect(socialRuns.every((r) => r.platform === "instagram")).toBe(true);
      const adRuns = (await ctx.db.query("syncRuns").collect()).filter((r) => r.adAccountId);
      expect(adRuns.every((r) => r.platform === "meta" || r.platform === "google_ads")).toBe(true);
    });
  });

  it("two orgs syncing the same Instagram account never see each other's rows", async () => {
    const t = newBackend();
    await setup(t, true);
    await setup(t, true, { issuer: ISSUER_CRM });
    await sync(t, 1);
    await t.run(async (ctx) => {
      const orgs = await ctx.db.query("organizations").collect();
      expect(orgs).toHaveLength(2);
      const accounts = await ctx.db.query("socialAccounts").collect();
      expect(accounts).toHaveLength(2); // one independent row per org
      const orgOf = new Map(accounts.map((a) => [a._id as string, a.orgId]));
      for (const table of SOCIAL_CHILD_TABLES) {
        const rows = await ctx.db.query(table).collect();
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) {
          expect(row.orgId).toBe(orgOf.get(row.socialAccountId as Id<"socialAccounts">));
        }
      }
      const posts = await ctx.db.query("socialPosts").collect();
      for (const snapshot of await ctx.db.query("socialPostMetricSnapshots").collect()) {
        const post = posts.find((p) => p._id === snapshot.postId)!;
        expect(post.orgId).toBe(snapshot.orgId);
      }
      for (const table of ["syncRuns", "syncTasks", "syncAccounts"] as const) {
        for (const row of await ctx.db.query(table).collect()) {
          if (row.socialAccountId !== undefined) {
            expect(row.orgId).toBe(orgOf.get(row.socialAccountId));
          }
        }
      }
    });
  });
});
