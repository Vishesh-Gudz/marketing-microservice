import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { addDays } from "../lib/dates";
import { isMarketingError } from "../lib/errors";
import { mockFollowers, mockMedia } from "../providers/social/mock/data";
import { mockInstagramAccountId } from "../providers/social/mock";
import {
  as,
  connectMockInstagram,
  expectMarketingError,
  ISSUER_CRM,
  linkSocial,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
  type IdentityInput,
} from "../test.helpers";
import * as organicAnalytics from "./organicAnalytics";
import * as socialAccounts from "./socialAccounts";
import * as socialPosts from "./socialPosts";

// Phase 10 Stage B (B2): the public organic API over the canonical social tables, fed by REAL
// B1 syncs of the deterministic mock Instagram provider (the same tables and functions real
// Instagram data will use). Nothing here is real-account evidence.

vi.setConfig({ testTimeout: 180_000 });
const NOW = new Date("2026-09-28T12:00:00Z");
const TODAY = "2026-09-28";
const DAY_MS = 86_400_000;
const CRM: IdentityInput = { issuer: ISSUER_CRM };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

/** Days since the epoch (the mock's day index: %7 == 3 empty day, %7 == 5 zero day). */
const dayIndex = (day: string) => Date.parse(`${day}T00:00:00Z`) / DAY_MS;
function dayWhere(residue: number, from = "2026-09-01"): string {
  let day = from;
  while (dayIndex(day) % 7 !== residue) day = addDays(day, 1);
  return day;
}
const EMPTY_DAY = dayWhere(3);
const ZERO_DAY = dayWhere(5);

/** Connects, links and syncs (initial run) the given mock Instagram users. */
async function socialOrg(t: Backend, users: string[] = ["1"], who: IdentityInput = {}) {
  await setupSyncOrg(t, who);
  const ids: Record<string, string> = {};
  for (const user of users) {
    const connectionId = (await connectMockInstagram(t, user, who)).get("connection")!;
    const [account] = await linkSocial(t, connectionId, [mockInstagramAccountId(user)], who);
    ids[user] = account!.id;
  }
  await planAndDrain(t);
  return ids;
}

async function days(t: Backend, accountId: string) {
  return (await t.run((ctx) => ctx.db.query("socialAccountMetricsDaily").collect())).filter(
    (row) => row.socialAccountId === accountId,
  );
}

function sum(
  rows: Doc<"socialAccountMetricsDaily">[],
  pick: (row: Doc<"socialAccountMetricsDaily">) => number | undefined,
) {
  return rows.reduce((total, row) => total + (pick(row) ?? 0), 0);
}

const inRange = (rows: Doc<"socialAccountMetricsDaily">[], from: string, to: string) =>
  rows.filter((row) => row.date >= from && row.date <= to);

const reasonOf = (
  metrics: { unavailableMetrics: { metric: string; reason: string }[] },
  metric: string,
) => metrics.unavailableMetrics.find((u) => u.metric === metric)?.reason;

// ---------------------------------------------------------------------------
// A. Accounts
// ---------------------------------------------------------------------------

describe("v1/socialAccounts", () => {
  it("empty org: an empty first page", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    expect(
      await as(t).query(api.v1.socialAccounts.list, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).toMatchObject({ page: [], isDone: true });
  });

  it("list and get return the exact DTO with follower count, sync time and coverage", async () => {
    const t = newBackend();
    const { "1": id } = await socialOrg(t);
    const { page, isDone } = await as(t).query(api.v1.socialAccounts.list, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(isDone).toBe(true);
    const connection = (await t.run((ctx) => ctx.db.query("connections").first()))!;
    const expected = {
      id,
      platform: "instagram",
      externalId: mockInstagramAccountId("1"),
      username: "mock_1",
      name: "Mock 1",
      accountType: "business",
      status: "active",
      linked: true,
      connectionId: connection._id,
      linkedAt: NOW.toISOString(),
      followersCount: mockFollowers("1"),
      lastSyncedAt: NOW.toISOString(),
      coverage: { from: "2026-08-30", through: TODAY },
    };
    expect(page).toEqual([expected]);
    expect(await as(t).query(api.v1.socialAccounts.get, { socialAccountId: id! })).toEqual(
      expected,
    );
  });

  it("pages deterministically (1-100 per page, platform then external id)", async () => {
    const t = newBackend();
    await socialOrg(t, ["1", "2", "3"]);
    const first = await as(t).query(api.v1.socialAccounts.list, {
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(first.page).toHaveLength(2);
    expect(first.isDone).toBe(false);
    const second = await as(t).query(api.v1.socialAccounts.list, {
      paginationOpts: { numItems: 2, cursor: first.continueCursor },
    });
    const all = [...first.page, ...second.page].map((a) => a.externalId);
    expect(all).toEqual(["1", "2", "3"].map(mockInstagramAccountId).sort());
    // Page size is clamped to 1..100.
    const clamped = await as(t).query(api.v1.socialAccounts.list, {
      paginationOpts: { numItems: 0, cursor: null },
    });
    expect(clamped.page).toHaveLength(1);
  });

  it("an unknown, malformed or foreign id is NOT_FOUND; orgs never see each other's accounts", async () => {
    const t = newBackend();
    const { "1": erpId } = await socialOrg(t);
    const { "1": crmId } = await socialOrg(t, ["1"], CRM);
    expect(crmId).not.toBe(erpId);
    await expectMarketingError(
      as(t, CRM).query(api.v1.socialAccounts.get, { socialAccountId: erpId! }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t).query(api.v1.socialAccounts.get, { socialAccountId: "nope" }),
      "NOT_FOUND",
    );
    const crmList = await as(t, CRM).query(api.v1.socialAccounts.list, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(crmList.page.map((a) => a.id)).toEqual([crmId]);
  });
});

// ---------------------------------------------------------------------------
// B. Posts
// ---------------------------------------------------------------------------

describe("v1/socialPosts", () => {
  async function allPosts(
    t: Backend,
    socialAccountId: string,
    extra: Record<string, unknown> = {},
  ) {
    const posts = [];
    let cursor: string | null = null;
    for (;;) {
      const page: Awaited<ReturnType<typeof listPage>> = await listPage(
        t,
        socialAccountId,
        cursor,
        extra,
      );
      posts.push(...page.page);
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    return posts;
  }
  function listPage(
    t: Backend,
    socialAccountId: string,
    cursor: string | null,
    extra: Record<string, unknown>,
  ) {
    return as(t).query(api.v1.socialPosts.list, {
      socialAccountId,
      paginationOpts: { numItems: 7, cursor },
      ...extra,
    });
  }

  it("lists only organic posts, newest first, with caption, permalink and latest lifetime snapshot", async () => {
    const t = newBackend();
    const { "1": accountId } = await socialOrg(t);
    const media = mockMedia("1", TODAY).filter(
      (m) => m.mediaProductType !== "AD" && m.mediaProductType !== "STORY",
    );
    const posts = await allPosts(t, accountId!);
    expect(posts.map((p) => p.externalId)).toEqual(media.map((m) => m.id)); // newest first
    expect(new Set(posts.map((p) => p.type))).toEqual(
      new Set(["image", "video", "reel", "carousel"]),
    );
    for (const post of posts) {
      expect(post.caption).toMatch(/^Mock /);
      expect(post.caption!.length).toBeLessThanOrEqual(2_200);
      expect(post.permalink).toBe(`https://www.instagram.com/p/mock${post.externalId}/`);
      expect(post.socialAccountId).toBe(accountId);
      const inWindow = post.publishedAt >= "2026-07-01";
      if (inWindow) {
        expect(post.latest?.capturedDate).toBe(TODAY);
        expect(post.latest?.metrics.unavailableMetrics).toContainEqual({
          metric: "videoViews",
          reason: "deprecated_metric",
        });
      } else {
        expect(post.latest).toBeUndefined();
        expect(post.dataState).toBe("unknown");
      }
    }
    // A post with explicit zeros and an unreported metric: zeros kept, views explained.
    const zero = posts.find((p) => p.latest?.metrics.shares === 0)!;
    expect(zero.latest!.metrics).toMatchObject({ comments: 0, saves: 0, shares: 0 });
    expect(reasonOf(zero.latest!.metrics, "views")).toBe("not_reported");
    expect(zero.dataState).toBe("partial");
    // A complete snapshot: engagementRate = totalInteractions / reach of that snapshot.
    const full = posts.find((p) => p.latest?.dataState === "reported")!;
    const m = full.latest!.metrics;
    expect(full.latest!.kpis.engagementRate).toBeCloseTo(m.totalInteractions! / m.reach!, 6);
  });

  it("ascending order and org-timezone publish-day filters", async () => {
    const t = newBackend();
    const { "1": accountId } = await socialOrg(t);
    const newest = await allPosts(t, accountId!);
    const oldest = await allPosts(t, accountId!, { sort: { by: "publishedAt", dir: "asc" } });
    expect(oldest.map((p) => p.id)).toEqual([...newest].reverse().map((p) => p.id));

    // Mock posts are published at 12:00 UTC. In Pacific/Kiritimati (UTC+14) that is the NEXT
    // local day, so the org-timezone filter moves them by one day.
    const post = newest[3]!;
    const utcDay = post.publishedAt.slice(0, 10);
    const utc = await allPosts(t, accountId!, { publishedFrom: utcDay, publishedTo: utcDay });
    expect(utc.map((p) => p.id)).toEqual([post.id]);
    await as(t, { role: "admin" }).mutation(api.v1.orgs.updateSettings, {
      timezone: "Pacific/Kiritimati",
    });
    const sameDay = await allPosts(t, accountId!, { publishedFrom: utcDay, publishedTo: utcDay });
    expect(sameDay.map((p) => p.id)).not.toContain(post.id);
    const nextDay = addDays(utcDay, 1);
    const local = await allPosts(t, accountId!, { publishedFrom: nextDay, publishedTo: nextDay });
    expect(local.map((p) => p.id)).toEqual([post.id]);
  });

  it("rejects invalid publish filters", async () => {
    const t = newBackend();
    const { "1": accountId } = await socialOrg(t);
    for (const extra of [
      { publishedFrom: "2026-02-30" },
      { publishedTo: "yesterday" },
      { publishedFrom: "2026-09-10", publishedTo: "2026-09-01" },
    ]) {
      await expectMarketingError(listPage(t, accountId!, null, extra), "INVALID_ARGUMENT");
    }
  });

  it("get returns lifetime captures only (no deltas); the latest capture wins", async () => {
    const t = newBackend();
    const { "1": accountId } = await socialOrg(t);
    const [post] = (await listPage(t, accountId!, null, {})).page.filter(
      (p) => p.latest?.dataState === "reported",
    );
    // Next day's lookback run captures a second lifetime snapshot.
    vi.setSystemTime(NOW.getTime() + DAY_MS + 3_600_000);
    await planAndDrain(t);
    const detail = await as(t).query(api.v1.socialPosts.get, { postId: post!.id });
    expect(detail.snapshots.map((s) => s.capturedDate)).toEqual([TODAY, "2026-09-29"]);
    expect(detail.latest!.capturedDate).toBe("2026-09-29");
    const [first, second] = detail.snapshots;
    expect(second!.metrics.likes!).toBeGreaterThanOrEqual(first!.metrics.likes!);
    expect(JSON.stringify(detail)).not.toMatch(/delta/i);
    const ranged = await as(t).query(api.v1.socialPosts.get, {
      postId: post!.id,
      range: { from: TODAY, to: TODAY },
    });
    expect(ranged.snapshots.map((s) => s.capturedDate)).toEqual([TODAY]);
    expect(ranged.snapshotRange).toEqual({ from: TODAY, to: TODAY });
    expect(ranged.latest!.capturedDate).toBe("2026-09-29");
  });

  it("another org's account or post is NOT_FOUND", async () => {
    const t = newBackend();
    const { "1": accountId } = await socialOrg(t);
    await socialOrg(t, ["1"], CRM);
    const [post] = (await listPage(t, accountId!, null, {})).page;
    await expectMarketingError(
      as(t, CRM).query(api.v1.socialPosts.list, {
        socialAccountId: accountId!,
        paginationOpts: { numItems: 5, cursor: null },
      }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t, CRM).query(api.v1.socialPosts.get, { postId: post!.id }),
      "NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// C. Overview
// ---------------------------------------------------------------------------

describe("v1/organicAnalytics:overview", () => {
  it("one account over synced UTC days: additive sums, followers snapshot, non-additive reach", async () => {
    const t = newBackend();
    const { "1": id } = await socialOrg(t);
    const rows = inRange(await days(t, id!), "2026-09-01", TODAY);
    const result = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: "2026-09-01", to: TODAY },
    });
    expect(result.timezone).toBe("UTC");
    expect(result.accountCount).toBe(1);
    const { totals } = result;
    expect(totals.dataState).toBe("reported");
    expect(totals.metrics.views).toBe(sum(rows, (r) => r.views));
    expect(totals.metrics.totalInteractions).toBe(sum(rows, (r) => r.totalInteractions));
    expect(totals.metrics.followerDelta).toBe(sum(rows, (r) => r.followerDelta));
    expect(totals.metrics.likes).toBe(sum(rows, (r) => r.extras?.likes));
    expect(totals.metrics.profileLinksTaps).toBe(sum(rows, (r) => r.extras?.profileLinksTaps));
    // Empty days (synced, nothing reported) make additive metrics partial, never zero-filled.
    expect(totals.metrics.partialMetrics).toContain("views");
    expect(totals.metrics.followers).toBe(mockFollowers("1"));
    expect(totals.metrics.followersCapturedAt).toBe(NOW.toISOString());
    expect(totals.metrics.reach).toBeUndefined();
    expect(reasonOf(totals.metrics, "reach")).toBe("non_additive");
    expect(reasonOf(totals.metrics, "accountsEngaged")).toBe("non_additive");
    expect(reasonOf(totals.metrics, "profileViews")).toBe("deprecated_metric");
    expect(reasonOf(totals.metrics, "websiteClicks")).toBe("deprecated_metric");
    expect(totals.kpis).toEqual({
      unavailableKpis: [{ kpi: "engagementRate", reason: "non_additive" }],
    });
    expect(result.coverage).toMatchObject({
      dataState: "reported",
      accounts: [
        { accountId: id, syncedDays: 28, unsyncedDays: 0, lastSyncedAt: NOW.toISOString() },
      ],
    });
  });

  it("one account, one UTC day: reach, accountsEngaged and engagementRate", async () => {
    const t = newBackend();
    const { "1": id } = await socialOrg(t);
    // A mock day that is neither empty (%7 == 3) nor all-zero (%7 == 5).
    let day = "2026-09-20";
    while ([3, 5].includes(dayIndex(day) % 7)) day = addDays(day, 1);
    const [row] = inRange(await days(t, id!), day, day);
    const { totals } = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: day, to: day },
    });
    expect(totals.metrics).toMatchObject({
      reach: row!.reach,
      accountsEngaged: row!.accountsEngaged,
    });
    expect(totals.kpis.engagementRate).toBeCloseTo(row!.totalInteractions! / row!.reach!, 6);
  });

  it("a synced empty day is reported with not_reported metrics; a zero day keeps its zeros", async () => {
    const t = newBackend();
    await socialOrg(t);
    const empty = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: EMPTY_DAY, to: EMPTY_DAY },
    });
    expect(empty.totals.dataState).toBe("reported");
    for (const metric of ["views", "reach", "totalInteractions", "likes", "followerDelta"]) {
      expect(reasonOf(empty.totals.metrics, metric)).toBe("not_reported");
    }
    expect(empty.totals.kpis.unavailableKpis).toEqual([
      { kpi: "engagementRate", reason: "numerator_unavailable" },
    ]);
    const zero = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: ZERO_DAY, to: ZERO_DAY },
    });
    expect(zero.totals.metrics).toMatchObject({ totalInteractions: 0, likes: 0, replies: 0 });
    expect(zero.totals.kpis.engagementRate).toBe(0);
  });

  it("zero reach on one day is zero_denominator", async () => {
    const t = newBackend();
    const { "1": id } = await socialOrg(t);
    const [row] = inRange(await days(t, id!), "2026-09-21", "2026-09-21");
    await t.run((ctx) => ctx.db.patch(row!._id, { reach: 0, totalInteractions: 3 }));
    const { totals } = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: "2026-09-21", to: "2026-09-21" },
    });
    expect(totals.metrics.reach).toBe(0);
    expect(totals.kpis.unavailableKpis).toEqual([
      { kpi: "engagementRate", reason: "zero_denominator" },
    ]);
  });

  it("partly synced ranges are partial; never-synced ranges are unknown", async () => {
    const t = newBackend();
    await socialOrg(t);
    const partly = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: "2026-08-20", to: TODAY },
    });
    expect(partly.totals.dataState).toBe("partial");
    expect(partly.coverage.accounts[0]).toMatchObject({ syncedDays: 30, unsyncedDays: 10 });
    const never = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: "2025-01-01", to: "2025-01-31" },
    });
    expect(never.totals.dataState).toBe("unknown");
    expect(never.totals.metrics.views).toBeUndefined();
    expect(reasonOf(never.totals.metrics, "views")).toBe("not_reported");
    expect(reasonOf(never.totals.metrics, "followers")).toBe("not_reported");
  });

  it("multiple accounts: sums, latest followers per account, below-threshold follower change", async () => {
    const t = newBackend();
    const ids = await socialOrg(t, ["1", "small"]);
    const both = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: "2026-09-01", to: TODAY },
    });
    expect(both.accountCount).toBe(2);
    expect(both.totals.metrics.followers).toBe(mockFollowers("1") + mockFollowers("small"));
    const rows = [
      ...inRange(await days(t, ids["1"]!), "2026-09-01", TODAY),
      ...inRange(await days(t, ids.small!), "2026-09-01", TODAY),
    ];
    expect(both.totals.metrics.views).toBe(sum(rows, (r) => r.views));
    expect(both.totals.metrics.partialMetrics).toContain("followerDelta"); // "small" never reports it
    const today = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: TODAY, to: TODAY },
    });
    expect(reasonOf(today.totals.metrics, "reach")).toBe("non_additive"); // two account-days
    const small = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: TODAY, to: TODAY },
      socialAccountIds: [ids.small!],
    });
    expect(small.totals.metrics.followers).toBe(mockFollowers("small"));
    expect(reasonOf(small.totals.metrics, "followerDelta")).toBe("below_follower_threshold");
  });

  it("compares with the previous period (additive metrics only)", async () => {
    const t = newBackend();
    const { "1": id } = await socialOrg(t);
    const rows = await days(t, id!);
    const result = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: "2026-09-15", to: TODAY },
      compare: "previous_period",
    });
    expect(result.comparison!.range).toEqual({ from: "2026-09-01", to: "2026-09-14" });
    const current = sum(inRange(rows, "2026-09-15", TODAY), (r) => r.views);
    const previous = sum(inRange(rows, "2026-09-01", "2026-09-14"), (r) => r.views);
    expect(result.comparison!.deltas.views).toMatchObject({ absolute: current - previous });
    expect(result.comparison!.deltas).not.toHaveProperty("followers");
    expect(result.comparison!.deltas).not.toHaveProperty("reach");
    const unsynced = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: "2026-09-15", to: TODAY },
      compare: { from: "2025-01-01", to: "2025-01-14" },
    });
    expect(unsynced.comparison!.deltas.views).toMatchObject({ reason: "previous_unavailable" });
  });

  it("validates ranges and account ids", async () => {
    const t = newBackend();
    const { "1": id } = await socialOrg(t);
    await socialOrg(t, ["1"], CRM);
    for (const range of [
      { from: "2026-09-10", to: "2026-09-01" },
      { from: "2026-13-01", to: "2026-13-02" },
      { from: "2025-01-01", to: "2026-09-28" },
    ]) {
      await expectMarketingError(
        as(t).query(api.v1.organicAnalytics.overview, { range }),
        "INVALID_ARGUMENT",
      );
    }
    const range = { from: "2026-09-01", to: TODAY };
    await expectMarketingError(
      as(t).query(api.v1.organicAnalytics.overview, { range, socialAccountIds: [] }),
      "INVALID_ARGUMENT",
    );
    await expectMarketingError(
      as(t, CRM).query(api.v1.organicAnalytics.overview, { range, socialAccountIds: [id!] }),
      "NOT_FOUND",
    );
  });
});

// ---------------------------------------------------------------------------
// D. Account series
// ---------------------------------------------------------------------------

describe("v1/organicAnalytics:accountSeries", () => {
  it("daily UTC points over an inclusive range: reach per day, empty days not reported", async () => {
    const t = newBackend();
    const { "1": id } = await socialOrg(t);
    const rows = await days(t, id!);
    const result = await as(t).query(api.v1.organicAnalytics.accountSeries, {
      socialAccountId: id!,
      range: { from: "2026-09-20", to: TODAY },
    });
    expect(result).toMatchObject({
      timezone: "UTC",
      granularity: "day",
      dataState: "reported",
      accountId: id,
    });
    expect(result.points.map((p) => p.bucket)).toEqual(
      Array.from({ length: 9 }, (_, i) => addDays("2026-09-20", i)),
    );
    for (const point of result.points) {
      const row = rows.find((r) => r.date === point.bucket)!;
      expect(point.from).toBe(point.bucket);
      if (point.bucket === EMPTY_DAY) {
        expect(point.dataState).toBe("reported");
        expect(reasonOf(point.metrics, "reach")).toBe("not_reported");
      } else {
        expect(point.metrics.reach).toBe(row.reach);
        expect(point.metrics.views).toBe(row.views);
      }
    }
    // Followers exist only where they were captured (today): no fabricated history.
    expect(result.points.at(-1)!.metrics.followers).toBe(mockFollowers("1"));
    expect(result.points[0]!.metrics.followers).toBeUndefined();
  });

  it("missing days are unknown; single-day ranges are inclusive", async () => {
    const t = newBackend();
    const { "1": id } = await socialOrg(t);
    const result = await as(t).query(api.v1.organicAnalytics.accountSeries, {
      socialAccountId: id!,
      range: { from: "2026-08-25", to: "2026-09-02" },
    });
    expect(result.dataState).toBe("partial");
    expect(result.points.map((p) => [p.bucket, p.dataState])).toEqual(
      Array.from({ length: 9 }, (_, i) => {
        const day = addDays("2026-08-25", i);
        return [day, day < "2026-08-30" ? "unknown" : "reported"];
      }),
    );
    const single = await as(t).query(api.v1.organicAnalytics.accountSeries, {
      socialAccountId: id!,
      range: { from: TODAY, to: TODAY },
    });
    expect(single.points).toHaveLength(1);
  });

  it("week and month buckets: additive sums, reach non-additive", async () => {
    const t = newBackend();
    const { "1": id } = await socialOrg(t);
    const rows = await days(t, id!);
    const weeks = await as(t).query(api.v1.organicAnalytics.accountSeries, {
      socialAccountId: id!,
      range: { from: "2026-09-01", to: TODAY },
      granularity: "week",
    });
    expect(weeks.points[0]).toMatchObject({
      bucket: "2026-08-31",
      from: "2026-09-01",
      partial: true,
    });
    for (const point of weeks.points) {
      expect(point.metrics.views).toBe(sum(inRange(rows, point.from, point.to), (r) => r.views));
      if (point.from === point.to) continue; // a bucket clipped to ONE UTC day is a single day
      expect(reasonOf(point.metrics, "reach")).toBe("non_additive");
      expect(point.kpis.unavailableKpis).toEqual([
        { kpi: "engagementRate", reason: "non_additive" },
      ]);
    }
    // 2026-09-28 is a Monday: the last week bucket is that one day, so reach exists there.
    const last = weeks.points.at(-1)!;
    expect([last.from, last.to]).toEqual([TODAY, TODAY]);
    expect(last.metrics.reach).toBe(rows.find((r) => r.date === TODAY)!.reach);
    const months = await as(t).query(api.v1.organicAnalytics.accountSeries, {
      socialAccountId: id!,
      range: { from: "2026-08-30", to: TODAY },
      granularity: "month",
    });
    expect(months.points.map((p) => p.bucket)).toEqual(["2026-08", "2026-09"]);
  });

  it("with several accounts, a series covers only its own account", async () => {
    const t = newBackend();
    const ids = await socialOrg(t, ["1", "2"]);
    const rows = await days(t, ids["1"]!);
    const result = await as(t).query(api.v1.organicAnalytics.accountSeries, {
      socialAccountId: ids["1"]!,
      range: { from: "2026-09-01", to: TODAY },
      granularity: "month",
    });
    expect(result.points[0]!.metrics.views).toBe(
      sum(inRange(rows, "2026-09-01", TODAY), (r) => r.views),
    );
  });
});

// ---------------------------------------------------------------------------
// E. Security, F. Budget, G. Contract
// ---------------------------------------------------------------------------

describe("security", () => {
  it("cross-org ids are NOT_FOUND on every organic endpoint", async () => {
    const t = newBackend();
    const { "1": id } = await socialOrg(t);
    await socialOrg(t, ["1"], CRM);
    const range = { from: "2026-09-01", to: TODAY };
    await expectMarketingError(
      as(t, CRM).query(api.v1.organicAnalytics.accountSeries, { socialAccountId: id!, range }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t, CRM).query(api.v1.socialAccounts.get, { socialAccountId: id! }),
      "NOT_FOUND",
    );
  });

  it("an orgId argument is rejected; unauthenticated calls fail", async () => {
    const t = newBackend();
    await socialOrg(t);
    const orgId = (await t.run((ctx) => ctx.db.query("organizations").first()))!._id;
    await expect(
      as(t).query(api.v1.organicAnalytics.overview, {
        range: { from: TODAY, to: TODAY },
        orgId,
      } as never),
    ).rejects.toThrow();
    await expectMarketingError(
      t.query(api.v1.socialAccounts.list, { paginationOpts: { numItems: 5, cursor: null } }),
      "UNAUTHENTICATED",
    );
  });

  it("responses carry no credential, token or URL other than permalinks", async () => {
    const t = newBackend();
    const { "1": id } = await socialOrg(t);
    const responses = JSON.stringify([
      await as(t).query(api.v1.socialAccounts.list, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
      await as(t).query(api.v1.socialPosts.list, {
        socialAccountId: id!,
        paginationOpts: { numItems: 100, cursor: null },
      }),
      await as(t).query(api.v1.organicAnalytics.overview, {
        range: { from: "2026-09-01", to: TODAY },
      }),
    ]);
    expect(responses).not.toMatch(/mock-ig-token|accessToken|credential|cipher|secret/i);
    for (const url of responses.match(/https?:\/\/[^"]+/g) ?? []) {
      expect(url).toMatch(/^https:\/\/www\.instagram\.com\/p\//);
    }
  });
});

describe("read budget (maxSocialRows = 8,000)", () => {
  it("fails with too_many_rows instead of truncating; stays within budget otherwise", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const orgId = (await t.run((ctx) => ctx.db.query("organizations").first()))!._id;
    const to = TODAY;
    const from = addDays(to, -399); // 400 UTC days
    const accountIds: Id<"socialAccounts">[] = [];
    for (let a = 0; a < 21; a++) {
      accountIds.push(
        await t.run(async (ctx) => {
          const socialAccountId = await ctx.db.insert("socialAccounts", {
            orgId,
            platform: "instagram",
            externalId: `1784140000${String(a).padStart(7, "0")}`,
            name: `seed ${a}`,
            accountType: "business",
            status: "active",
            createdAt: 0,
            updatedAt: 0,
          });
          for (let d = 0; d < 400; d++) {
            await ctx.db.insert("socialAccountMetricsDaily", {
              orgId,
              socialAccountId,
              platform: "instagram",
              date: addDays(from, d),
              views: 1,
              insightsSyncedAt: 1,
              syncedAt: 1,
            });
          }
          return socialAccountId;
        }),
      );
    }
    let caught: unknown;
    try {
      await as(t).query(api.v1.organicAnalytics.overview, { range: { from, to } });
    } catch (error) {
      caught = error;
    }
    expect(isMarketingError(caught)).toBe(true);
    expect((caught as { data: unknown }).data).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "too_many_rows", maxRows: 8_000, budget: "social_rows" },
    });
    // 19 accounts x 400 days (+ accounts and sync states) fit.
    const fits = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from, to },
      socialAccountIds: accountIds.slice(0, 19),
    });
    expect(fits.totals.metrics.views).toBe(19 * 400);
  });
});

describe("contract", () => {
  type Exported = { exportArgs: () => string; exportReturns: () => string };
  const fns = {
    "socialAccounts:list": socialAccounts.list,
    "socialAccounts:get": socialAccounts.get,
    "socialPosts:list": socialPosts.list,
    "socialPosts:get": socialPosts.get,
    "organicAnalytics:overview": organicAnalytics.overview,
    "organicAnalytics:accountSeries": organicAnalytics.accountSeries,
  } as unknown as Record<string, Exported>;

  function fieldNames(node: unknown, out: string[] = []): string[] {
    if (Array.isArray(node)) node.forEach((n) => fieldNames(n, out));
    else if (typeof node === "object" && node !== null) {
      const rec = node as Record<string, unknown>;
      if (rec.type === "object" && typeof rec.value === "object" && rec.value !== null) {
        out.push(...Object.keys(rec.value));
      }
      Object.values(rec).forEach((n) => fieldNames(n, out));
    }
    return out;
  }

  it.each(Object.entries(fns))("%s exposes no forbidden fields", (_name, fn) => {
    const names = fieldNames(JSON.parse(fn.exportReturns()));
    for (const forbidden of [
      "_id",
      "_creationTime",
      "orgId",
      "profilePictureUrl",
      "mediaUrl",
      "thumbnailUrl",
      "biography",
      "website",
      "credential",
      "accessToken",
      "profileViews",
      "websiteClicks",
      "videoViews",
      "impressions",
      "spend",
      "clicks",
      "profileVisits",
      "follows",
      "reposts",
      "totalLikes",
      "totalComments",
      "totalViews",
    ]) {
      expect(names, forbidden).not.toContain(forbidden);
    }
    expect(names.filter((n) => /url/i.test(n) && n !== "permalink")).toEqual([]);
  });

  it("post DTOs carry lifetime snapshots only (no delta fields)", () => {
    for (const name of ["socialPosts:list", "socialPosts:get"]) {
      const names = fieldNames(JSON.parse(fns[name]!.exportReturns()));
      expect(names.filter((n) => /delta/i.test(n))).toEqual([]);
    }
  });
});
