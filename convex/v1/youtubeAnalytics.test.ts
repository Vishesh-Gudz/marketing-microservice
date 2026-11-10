import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  YOUTUBE_DAY_METRICS,
  YOUTUBE_DAY_TIMEZONE,
  YOUTUBE_VIDEO_ANALYTICS_METRICS,
  YOUTUBE_VIDEO_METRICS,
} from "../analytics/organic/metrics";
import { compareDateKeys, eachDay, toDateKey } from "../lib/dates";
import { isMarketingError } from "../lib/errors";
import { mockInstagramAccountId } from "../providers/social/mock";
import { mockYouTubeChannelId, mockYouTubeSubscribers } from "../providers/social/mock/youtubeData";
import {
  ACCOUNT_REPORT_TARGETS,
  REPORT_DAY_BASIS,
  VIDEO_REPORT_COLUMNS,
  YOUTUBE_POST_METRICS,
} from "../providers/youtube/semantics";
import {
  as,
  connectMockInstagram,
  connectMockYouTube,
  expectMarketingError,
  ISSUER_CRM,
  linkSocial,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
  type IdentityInput,
} from "../test.helpers";
import * as youtubeAnalytics from "./youtubeAnalytics";

// ADR 0016, Checkpoint 4: the YouTube v1 API over the rows the Checkpoint 3 sync stores, fed
// by REAL syncs of the deterministic mock YouTube provider (plus a few direct seeds for exact
// edge cases). One channel per request, values as reported, nothing summed, compared or
// combined. Nothing here is real-channel evidence.

vi.setConfig({ testTimeout: 180_000 });
const NOW = new Date("2026-10-20T12:00:00Z");
const CRM: IdentityInput = { issuer: ISSUER_CRM };
/** The initial run's channel days: the 30 days ending 3 days before today (ADR 0016). */
const SYNCED = { from: "2026-09-18", to: "2026-10-17" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Connects, links and syncs (initial run) the given mock YouTube users. */
async function youtubeOrg(t: Backend, users: string[] = ["1"], who: IdentityInput = {}) {
  await setupSyncOrg(t, who);
  const ids: Record<string, Id<"socialAccounts">> = {};
  const connections: Record<string, Id<"connections">> = {};
  for (const user of users) {
    const connectionId = (await connectMockYouTube(t, user, who)).get("connection")!;
    const [account] = await linkSocial(t, connectionId, [mockYouTubeChannelId(user)], who);
    ids[user] = account!.id as Id<"socialAccounts">;
    connections[user] = connectionId as Id<"connections">;
  }
  await planAndDrain(t);
  return { ids, connections };
}

async function rowsOf(t: Backend, socialAccountId: Id<"socialAccounts">) {
  return await t.run(async (ctx) => ({
    days: (await ctx.db.query("socialAccountMetricsDaily").collect()).filter(
      (row) => row.socialAccountId === socialAccountId,
    ),
    posts: (await ctx.db.query("socialPosts").collect()).filter(
      (row) => row.socialAccountId === socialAccountId,
    ),
    snapshots: (await ctx.db.query("socialPostMetricSnapshots").collect()).filter(
      (row) => row.socialAccountId === socialAccountId,
    ),
  }));
}

/** The day values exactly as stored (views column + extras), for comparison. */
function storedValues(row: Doc<"socialAccountMetricsDaily">) {
  return Object.fromEntries(
    YOUTUBE_DAY_METRICS.flatMap((metric) => {
      const value = metric === "views" ? row.views : row.extras?.[metric];
      return value === undefined ? [] : [[metric, value]];
    }),
  );
}

async function invalidReason(promise: Promise<unknown>): Promise<unknown> {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(isMarketingError(caught), String(caught)).toBe(true);
  const data = (caught as { data: { code: string; details?: { reason?: string } } }).data;
  expect(data.code).toBe("INVALID_ARGUMENT");
  return data.details?.reason;
}

const page = { numItems: 100, cursor: null };

describe("v1/youtubeAnalytics:channelDays", () => {
  it("one entry per Pacific Time day with the values as stored; no rate or comparison", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const stored = (await rowsOf(t, ids["1"]!)).days;

    const dto = await as(t).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: ids["1"]!,
      range: SYNCED,
    });

    expect(Object.keys(dto).sort()).toEqual(
      [
        "accountId",
        "analyticsAccess",
        "coverage",
        "dataState",
        "days",
        "range",
        "reportingDelayDays",
        "subscribers",
        "timezone",
        "totals",
      ].sort(),
    );
    expect(dto).toMatchObject({
      timezone: "America/Los_Angeles",
      accountId: ids["1"],
      range: SYNCED,
      dataState: "reported",
      reportingDelayDays: 3,
      analyticsAccess: "granted",
      coverage: {
        syncedDays: 30,
        unsyncedDays: 0,
        covered: { from: SYNCED.from, through: SYNCED.to },
        lastSyncedAt: NOW.toISOString(),
      },
    });
    expect(dto.days.map((day) => day.date)).toEqual(eachDay(SYNCED.from, SYNCED.to));
    const byDate = new Map(stored.map((row) => [row.date, row]));
    for (const day of dto.days) {
      const values = storedValues(byDate.get(day.date)!);
      expect(day.metrics).toEqual(values);
      expect(day.status).toBe(Object.keys(values).length === 0 ? "not_reported" : "reported");
    }
    // The mock skips some days (synced, nothing reported) and reports some as zeros.
    expect(dto.days.some((day) => day.status === "not_reported")).toBe(true);
    const zero = dto.days.find((day) => day.status === "reported" && day.metrics.views === 0);
    expect(zero?.metrics.likes).toBe(0); // a reported zero stays 0
    expect(dto.days.find((day) => day.status === "not_reported")!.metrics).toEqual({});
  });

  it("days not synced yet are unknown: partial and unknown ranges, no follower capture leaks in", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    // Today's row (a UTC capture day) holds only the subscriber capture of the preflight.
    const today = (await rowsOf(t, ids["1"]!)).days.find((row) => row.date === "2026-10-20");
    expect(today?.followers).toBeDefined();

    const partial = await as(t).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: ids["1"]!,
      range: { from: "2026-10-15", to: "2026-10-20" },
    });
    expect(partial.dataState).toBe("partial");
    expect(partial.coverage).toMatchObject({ syncedDays: 3, unsyncedDays: 3 });
    expect(partial.days.slice(3)).toEqual([
      { date: "2026-10-18", status: "unknown", metrics: {}, unavailableMetrics: [] },
      { date: "2026-10-19", status: "unknown", metrics: {}, unavailableMetrics: [] },
      { date: "2026-10-20", status: "unknown", metrics: {}, unavailableMetrics: [] },
    ]);

    const unknown = await as(t).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: ids["1"]!,
      range: { from: "2026-10-18", to: "2026-10-20" },
    });
    expect(unknown).toMatchObject({
      dataState: "unknown",
      coverage: { syncedDays: 0, unsyncedDays: 3 },
    });
  });

  it("a reported day lacking a metric names it; a DST day is one Pacific Time key", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const channel = ids["1"]!;
    const orgId = (await t.run((ctx) => ctx.db.get(channel)))!.orgId;
    // 2025-11-02: Pacific Time falls back (a 25-hour day), stored under one key.
    await t.run(async (ctx) => {
      await ctx.db.insert("socialAccountMetricsDaily", {
        orgId,
        socialAccountId: channel,
        platform: "youtube",
        date: "2025-11-02",
        views: 10,
        extras: { likes: 1, averageViewDuration: 42 },
        insightsSyncedAt: 1,
        syncedAt: 1,
      });
    });

    const dto = await as(t).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: channel,
      range: { from: "2025-11-01", to: "2025-11-03" },
    });

    expect(dto.days.map((day) => [day.date, day.status])).toEqual([
      ["2025-11-01", "unknown"],
      ["2025-11-02", "reported"],
      ["2025-11-03", "unknown"],
    ]);
    expect(dto.days[1]).toEqual({
      date: "2025-11-02",
      status: "reported",
      metrics: { views: 10, likes: 1, averageViewDuration: 42 },
      unavailableMetrics: [
        "comments",
        "shares",
        "estimatedMinutesWatched",
        "subscribersGained",
        "subscribersLost",
      ].map((metric) => ({ metric, reason: "not_reported" })),
    });
    expect(dto.dataState).toBe("partial");
  });

  it("without the analytics grant: scope_missing and no day values; videos are still listed", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t, ["limited"]);
    const channel = ids["limited"]!;

    const dto = await as(t).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: channel,
      range: SYNCED,
    });
    expect(dto).toMatchObject({ analyticsAccess: "scope_missing", dataState: "unknown" });
    expect(dto.days.every((day) => day.status === "unknown")).toBe(true);

    const videos = await as(t).query(api.v1.youtubeAnalytics.videos, {
      socialAccountId: channel,
      paginationOpts: page,
    });
    expect(videos.page.length).toBeGreaterThan(0);
    // Videos captured before the day reports failed (older uploads are never captured).
    expect(videos.page.some((video) => video.latest !== undefined)).toBe(true);
  });

  it("reports a connection needing re-authorization and a channel that is not linked", async () => {
    const t = newBackend();
    const { ids, connections } = await youtubeOrg(t);
    const channelDays = () =>
      as(t).query(api.v1.youtubeAnalytics.channelDays, {
        socialAccountId: ids["1"]!,
        range: SYNCED,
      });

    await t.run((ctx) => ctx.db.patch(connections["1"]!, { status: "needs_reauth" }));
    expect((await channelDays()).analyticsAccess).toBe("reauth_required");

    await t.run((ctx) => ctx.db.patch(ids["1"]!, { connectionId: undefined, linkedAt: undefined }));
    const unlinked = await channelDays();
    expect(unlinked.analyticsAccess).toBe("not_linked");
    expect(unlinked.dataState).toBe("reported"); // the stored history is still readable
  });

  it("validates the range (dates, order, at most 400 days)", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    for (const range of [
      { from: "2026-10-1", to: "2026-10-17" },
      { from: "2026-10-17", to: "2026-10-01" },
      { from: "2025-01-01", to: "2026-10-17" },
    ]) {
      await expectMarketingError(
        as(t).query(api.v1.youtubeAnalytics.channelDays, { socialAccountId: ids["1"]!, range }),
        "INVALID_ARGUMENT",
      );
    }
  });
});

describe("v1/youtubeAnalytics:videos and :video", () => {
  it("lists one channel's videos newest first with their latest lifetime statistics, page by page", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const stored = await rowsOf(t, ids["1"]!);
    const latest = new Map<string, Doc<"socialPostMetricSnapshots">>();
    for (const snapshot of stored.snapshots) {
      const current = latest.get(snapshot.postId);
      if (current === undefined || current.capturedDate < snapshot.capturedDate) {
        latest.set(snapshot.postId, snapshot);
      }
    }

    const all: Awaited<ReturnType<typeof listPage>>["page"] = [];
    let cursor: string | null = null;
    async function listPage(next: string | null) {
      return await as(t).query(api.v1.youtubeAnalytics.videos, {
        socialAccountId: ids["1"]!,
        paginationOpts: { numItems: 7, cursor: next },
      });
    }
    for (;;) {
      const result = await listPage(cursor);
      expect(result.page.length).toBeLessThanOrEqual(7);
      all.push(...result.page);
      if (result.isDone) break;
      cursor = result.continueCursor;
    }

    expect(all.map((video) => video.id).sort()).toEqual(stored.posts.map((p) => p._id).sort());
    const published = all.map((video) => Date.parse(video.publishedAt));
    expect([...published].sort((a, b) => b - a)).toEqual(published);
    for (const video of all) {
      const post = stored.posts.find((p) => p._id === video.id)!;
      expect(video).toMatchObject({
        socialAccountId: ids["1"],
        videoId: post.externalId,
        permalink: `https://www.youtube.com/watch?v=${post.externalId}`,
      });
      const snapshot = latest.get(video.id as Id<"socialPosts">);
      if (snapshot === undefined) {
        expect(video).toMatchObject({ dataState: "unknown" });
        expect(video.latest).toBeUndefined();
        continue;
      }
      expect(video.latest!.capturedDate).toBe(snapshot.capturedDate);
      expect(video.latest!.metrics).toEqual(
        Object.fromEntries(
          YOUTUBE_VIDEO_METRICS.filter((m) => snapshot[m] !== undefined).map((m) => [
            m,
            snapshot[m],
          ]),
        ),
      );
    }
    // A hidden like count and disabled comments stay absent and are named, never 0.
    const hidden = all.find((video) => video.latest?.metrics.likes === undefined && video.latest);
    expect(hidden!.latest).toMatchObject({
      dataState: "partial",
      unavailableMetrics: [{ metric: "likes", reason: "not_reported" }],
    });
    const noComments = all.find(
      (video) => video.latest?.metrics.comments === undefined && video.latest,
    );
    expect(noComments!.latest!.unavailableMetrics).toEqual([
      { metric: "comments", reason: "not_reported" },
    ]);
    // No Instagram-only metric, rate or KPI on a YouTube video.
    const keys = JSON.stringify(all);
    for (const field of ["reach", "saves", "totalInteractions", "engagementRate", "kpis"]) {
      expect(keys).not.toContain(`"${field}"`);
    }
  });

  it("filters by publish day in the org timezone, ascending on request", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const result = await as(t).query(api.v1.youtubeAnalytics.videos, {
      socialAccountId: ids["1"]!,
      publishedFrom: "2026-10-01",
      publishedTo: "2026-10-15",
      sort: { by: "publishedAt", dir: "asc" },
      paginationOpts: page,
    });
    expect(result.page.length).toBeGreaterThan(0);
    const days = result.page.map((video) => video.publishedAt.slice(0, 10));
    expect([...days].sort()).toEqual(days);
    for (const day of days) expect(day >= "2026-10-01" && day <= "2026-10-15").toBe(true);
    await expectMarketingError(
      as(t).query(api.v1.youtubeAnalytics.videos, {
        socialAccountId: ids["1"]!,
        publishedFrom: "2026-10-15",
        publishedTo: "2026-10-01",
        paginationOpts: page,
      }),
      "INVALID_ARGUMENT",
    );
  });

  it("one video: its lifetime captures oldest first, on UTC capture days, optionally by range", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const stored = await rowsOf(t, ids["1"]!);
    const snapshot = stored.snapshots[0]!;

    const detail = await as(t).query(api.v1.youtubeAnalytics.video, {
      videoId: snapshot.postId,
    });
    const captures = stored.snapshots.filter((s) => s.postId === snapshot.postId);
    expect(detail.captures.map((c) => c.capturedDate)).toEqual(
      captures.map((c) => c.capturedDate).sort(),
    );
    expect(detail.captures.at(-1)).toEqual(detail.latest);
    expect(detail).not.toHaveProperty("captureRange");

    const ranged = await as(t).query(api.v1.youtubeAnalytics.video, {
      videoId: snapshot.postId,
      range: { from: "2026-01-01", to: "2026-01-31" },
    });
    expect(ranged).toMatchObject({
      captureRange: { from: "2026-01-01", to: "2026-01-31" },
      captures: [],
    });
    expect(ranged.latest).toEqual(detail.latest); // the latest capture is always shown
  });
});

describe("Instagram ids, mixed selections and the organic aggregation", () => {
  async function mixedOrg(t: Backend) {
    const { ids } = await youtubeOrg(t, ["1", "2"]);
    const ig = (await connectMockInstagram(t, "1")).get("connection")!;
    const [instagram] = await linkSocial(t, ig, [mockInstagramAccountId("1")]);
    await planAndDrain(t);
    return { youtube: ids["1"]!, youtube2: ids["2"]!, instagram: instagram!.id };
  }

  it("a YouTube endpoint refuses an Instagram account or post (not_youtube)", async () => {
    const t = newBackend();
    const { instagram } = await mixedOrg(t);
    expect(
      await invalidReason(
        as(t).query(api.v1.youtubeAnalytics.channelDays, {
          socialAccountId: instagram,
          range: SYNCED,
        }),
      ),
    ).toBe("not_youtube");
    expect(
      await invalidReason(
        as(t).query(api.v1.youtubeAnalytics.videos, {
          socialAccountId: instagram,
          paginationOpts: page,
        }),
      ),
    ).toBe("not_youtube");
    const post = (await t.run((ctx) => ctx.db.query("socialPosts").collect())).find(
      (row) => row.platform === "instagram",
    )!;
    expect(
      await invalidReason(as(t).query(api.v1.youtubeAnalytics.video, { videoId: post._id })),
    ).toBe("not_youtube");
  });

  it("never combines: YouTube with Instagram or two channels is refused; Instagram is unchanged", async () => {
    const t = newBackend();
    const { youtube, youtube2, instagram } = await mixedOrg(t);
    const range = { from: "2026-09-21", to: "2026-10-17" };

    for (const socialAccountIds of [
      [instagram, youtube],
      [youtube, youtube2],
    ]) {
      expect(
        await invalidReason(
          as(t).query(api.v1.organicAnalytics.overview, { range, socialAccountIds }),
        ),
      ).toBe("platform_not_aggregated");
    }

    // One YouTube channel alone stays unsupported (no value), as in Checkpoint 3.
    const single = await as(t).query(api.v1.organicAnalytics.overview, {
      range,
      socialAccountIds: [youtube],
    });
    expect(single.totals.dataState).toBe("unsupported");
    expect(single.totals.metrics.views).toBeUndefined();

    // Instagram alone and org-wide (Instagram only) are identical.
    const instagramOnly = await as(t).query(api.v1.organicAnalytics.overview, {
      range,
      socialAccountIds: [instagram],
    });
    const orgWide = await as(t).query(api.v1.organicAnalytics.overview, { range });
    expect(orgWide.accountCount).toBe(1);
    expect(orgWide.totals).toEqual(instagramOnly.totals);
    expect(instagramOnly.totals.metrics.views).toBeGreaterThan(0);
  });
});

describe("Checkpoint 8: channel totals and subscribers", () => {
  /** The expected totals, recomputed from the DTO's own days (reported days only). */
  function expectedTotals(days: { status: string; metrics: Record<string, number | undefined> }[]) {
    const reported = days.filter((day) => day.status === "reported");
    const sum = (metric: string) => {
      const values = reported.flatMap((day) =>
        day.metrics[metric] === undefined ? [] : [day.metrics[metric]],
      );
      return values.length === 0 ? undefined : values.reduce((a, b) => a + b, 0);
    };
    return { reported, sum };
  }

  it("sums the reported days server-side; averageViewDuration = watch time x 60 / views", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const dto = await as(t).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: ids["1"]!,
      range: SYNCED,
    });
    const { reported, sum } = expectedTotals(dto.days);
    expect(reported.length).toBeGreaterThan(0);
    expect(reported.length).toBeLessThan(dto.days.length); // some days report nothing
    const views = sum("views")!;
    const minutes = sum("estimatedMinutesWatched")!;
    expect(dto.totals).toEqual({
      reportedDays: reported.length,
      metrics: {
        views,
        estimatedMinutesWatched: minutes,
        likes: sum("likes"),
        comments: sum("comments"),
        shares: sum("shares"),
        subscribersGained: sum("subscribersGained"),
        subscribersLost: sum("subscribersLost"),
        subscribersNet: sum("subscribersGained")! - sum("subscribersLost")!,
        averageViewDuration: Math.round((minutes * 60) / views),
      },
      unavailableMetrics: [],
    });
    // The current subscriber count of the preflight capture (YouTube's rounded value).
    expect(dto.subscribers).toEqual({
      count: mockYouTubeSubscribers("1"),
      capturedAt: NOW.toISOString(),
    });
  });

  it("averages only days reporting both values; zero views and no reported day are named", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const channel = ids["1"]!;
    const orgId = (await t.run((ctx) => ctx.db.get(channel)))!.orgId;
    const day = (date: string, views: number | undefined, extras: Record<string, number>) => ({
      orgId,
      socialAccountId: channel,
      platform: "youtube" as const,
      date,
      ...(views !== undefined ? { views } : {}),
      extras,
      insightsSyncedAt: 1,
      syncedAt: 1,
    });
    await t.run(async (ctx) => {
      // 2025-01-01: both watch values; 2025-01-02: views without watch time and a gain without
      // a loss (excluded from the average and the net change); 2025-01-03: synced, nothing.
      await ctx.db.insert(
        "socialAccountMetricsDaily",
        day("2025-01-01", 100, {
          estimatedMinutesWatched: 250,
          subscribersGained: 5,
          subscribersLost: 2,
        }),
      );
      await ctx.db.insert(
        "socialAccountMetricsDaily",
        day("2025-01-02", 900, { likes: 3, subscribersGained: 7 }),
      );
      await ctx.db.insert("socialAccountMetricsDaily", {
        orgId,
        socialAccountId: channel,
        platform: "youtube",
        date: "2025-01-03",
        insightsSyncedAt: 1,
        syncedAt: 1,
      });
      // 2025-02-01 / 02: reported, but zero views.
      await ctx.db.insert(
        "socialAccountMetricsDaily",
        day("2025-02-01", 0, { estimatedMinutesWatched: 0 }),
      );
      await ctx.db.insert("socialAccountMetricsDaily", day("2025-02-02", 0, { likes: 0 }));
    });
    const totals = async (from: string, to: string) =>
      (
        await as(t).query(api.v1.youtubeAnalytics.channelDays, {
          socialAccountId: channel,
          range: { from, to },
        })
      ).totals;

    expect(await totals("2025-01-01", "2025-01-04")).toEqual({
      reportedDays: 2,
      metrics: {
        views: 1000,
        estimatedMinutesWatched: 250,
        likes: 3,
        subscribersGained: 12,
        subscribersLost: 2,
        subscribersNet: 3, // only 2025-01-01 reports both
        averageViewDuration: 150, // 250 x 60 / 100: the 900 views without watch time are left out
      },
      unavailableMetrics: [
        { metric: "comments", reason: "not_reported" },
        { metric: "shares", reason: "not_reported" },
      ],
    });
    expect(await totals("2025-02-01", "2025-02-02")).toEqual({
      reportedDays: 2,
      metrics: { views: 0, estimatedMinutesWatched: 0, likes: 0 },
      unavailableMetrics: [
        { metric: "comments", reason: "not_reported" },
        { metric: "shares", reason: "not_reported" },
        { metric: "subscribersGained", reason: "not_reported" },
        { metric: "subscribersLost", reason: "not_reported" },
        { metric: "subscribersNet", reason: "not_reported" },
        { metric: "averageViewDuration", reason: "zero_views" },
      ],
    });
    // Nothing reported (synced-empty and unknown days only): no total at all, never 0.
    const empty = await totals("2025-01-03", "2025-01-10");
    expect(empty).toMatchObject({ reportedDays: 0, metrics: {} });
    expect(empty.unavailableMetrics.every((entry) => entry.reason === "not_reported")).toBe(true);
    expect(empty.unavailableMetrics).toHaveLength(9);
  });

  it("a hidden subscriber count stays absent; days and totals are unaffected", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t, ["hidden"]);
    const dto = await as(t).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: ids["hidden"]!,
      range: SYNCED,
    });
    expect(dto).not.toHaveProperty("subscribers");
    expect(dto.totals.reportedDays).toBeGreaterThan(0);
  });

  it("without the analytics grant: no totals (nothing reported) and no video window", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t, ["limited"]);
    const dto = await as(t).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: ids["limited"]!,
      range: SYNCED,
    });
    expect(dto.totals).toMatchObject({ reportedDays: 0, metrics: {} });
    expect(dto.subscribers?.count).toBe(mockYouTubeSubscribers("limited")); // the Data API value
    const videos = await as(t).query(api.v1.youtubeAnalytics.videos, {
      socialAccountId: ids["limited"]!,
      paginationOpts: page,
    });
    expect(videos.page.length).toBeGreaterThan(0);
    expect(videos.page.every((video) => Object.keys(video.analytics).length === 0)).toBe(true);
    const tasks = await t.run((ctx) => ctx.db.query("syncTasks").collect());
    expect(tasks.some((task) => task.operation === "fetchVideoAnalytics")).toBe(false);
  });
});

describe("Checkpoint 8: per-video analytics windows", () => {
  async function analyticsRows(t: Backend) {
    return await t.run((ctx) => ctx.db.query("youtubeVideoAnalytics").collect());
  }
  const LAST28 = { from: "2026-09-20", to: "2026-10-17" };

  it("each video carries its reported windows, exactly as stored", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const rows = await analyticsRows(t);
    const result = await as(t).query(api.v1.youtubeAnalytics.videos, {
      socialAccountId: ids["1"]!,
      paginationOpts: page,
    });
    expect(result.page.length).toBeGreaterThan(10);
    const lifetimeFrom = rows.find((row) => row.window === "lifetime")!.from;
    let reported = 0;
    for (const video of result.page) {
      const publishedDay = toDateKey(Date.parse(video.publishedAt), "America/Los_Angeles");
      const mine = rows.filter((row) => row.postId === video.id);
      if (compareDateKeys(publishedDay, LAST28.to) > 0) {
        // Uploaded after the windows' last day: no window at all.
        expect(mine).toEqual([]);
        expect(video.analytics).toEqual({});
        continue;
      }
      reported++;
      for (const window of ["last28", "lifetime"] as const) {
        const row = mine.find((candidate) => candidate.window === window)!;
        expect(video.analytics[window]).toEqual({
          status: "reported",
          from: window === "last28" ? LAST28.from : lifetimeFrom,
          to: LAST28.to,
          syncedAt: NOW.toISOString(),
          metrics: Object.fromEntries(
            YOUTUBE_VIDEO_ANALYTICS_METRICS.flatMap((metric) =>
              row[metric] === undefined ? [] : [[metric, row[metric]]],
            ),
          ),
        });
      }
    }
    expect(reported).toBeGreaterThan(0);
    // The detail endpoint returns the same windows.
    const sample = result.page.find((video) => video.analytics.last28 !== undefined)!;
    const detail = await as(t).query(api.v1.youtubeAnalytics.video, { videoId: sample.id });
    expect(detail.analytics).toEqual(sample.analytics);
    expect(detail.analytics.last28!.metrics.averageViewPercentage).toBeDefined();
  });

  it("a video without a row in a synced window is not_in_top (no values, never 0)", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const rows = await analyticsRows(t);
    // Simulate the window report without this video: it fell out of the top 200.
    const dropped = rows.find((row) => row.window === "last28")!;
    await t.run((ctx) => ctx.db.delete(dropped._id));

    const detail = await as(t).query(api.v1.youtubeAnalytics.video, { videoId: dropped.postId });
    expect(detail.analytics.last28).toEqual({
      status: "not_in_top",
      from: LAST28.from,
      to: LAST28.to,
      syncedAt: NOW.toISOString(),
      metrics: {},
    });
    expect(detail.analytics.lifetime?.status).toBe("reported");
    const listed = await as(t).query(api.v1.youtubeAnalytics.videos, {
      socialAccountId: ids["1"]!,
      paginationOpts: page,
    });
    expect(listed.page.find((video) => video.id === dropped.postId)!.analytics).toEqual(
      detail.analytics,
    );
  });

  it("a window never synced for the channel is absent, not not_in_top", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const video = (await analyticsRows(t)).find((row) => row.window === "lifetime")!.postId;
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("youtubeVideoAnalytics").collect()) {
        if (row.window === "lifetime") await ctx.db.delete(row._id);
      }
      for (const state of await ctx.db.query("syncAccounts").collect()) {
        await ctx.db.patch(state._id, {
          videoAnalyticsWindows: { last28: state.videoAnalyticsWindows!.last28! },
        });
      }
    });
    const detail = await as(t).query(api.v1.youtubeAnalytics.video, { videoId: video });
    expect(Object.keys(detail.analytics)).toEqual(["last28"]);
    expect(ids["1"]).toBeDefined();
  });

  it("never mixes organizations: the same channel in another org reads its own rows", async () => {
    const t = newBackend();
    const a = await youtubeOrg(t);
    const b = await youtubeOrg(t, ["1"], CRM);
    const rowsBefore = await analyticsRows(t);
    // Org A's stored values change; org B's answer does not.
    const bVideos = async () =>
      (
        await as(t, CRM).query(api.v1.youtubeAnalytics.videos, {
          socialAccountId: b.ids["1"]!,
          paginationOpts: page,
        })
      ).page.map((video) => video.analytics);
    const before = await bVideos();
    const orgA = (await t.run((ctx) => ctx.db.get(a.ids["1"]!)))!.orgId;
    await t.run(async (ctx) => {
      for (const row of rowsBefore.filter((r) => r.orgId === orgA)) {
        await ctx.db.patch(row._id, { views: 999_999_999 });
      }
    });
    expect(await bVideos()).toEqual(before);
    const views = before.flatMap((windows) => [
      windows.last28?.metrics.views,
      windows.lifetime?.metrics.views,
    ]);
    expect(views.some((value) => value !== undefined)).toBe(true);
    expect(views).not.toContain(999_999_999);
    // Another org's video id is NOT_FOUND (never its windows).
    const aVideo = rowsBefore.find((row) => row.orgId === orgA)!.postId;
    await expectMarketingError(
      as(t, CRM).query(api.v1.youtubeAnalytics.video, { videoId: aVideo }),
      "NOT_FOUND",
    );
  });
});

describe("security", () => {
  it("another org's channel or video is NOT_FOUND; malformed ids too", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    await youtubeOrg(t, ["1"], CRM);
    const video = (await rowsOf(t, ids["1"]!)).posts[0]!;
    for (const socialAccountId of [ids["1"]!, "not-an-id"]) {
      await expectMarketingError(
        as(t, CRM).query(api.v1.youtubeAnalytics.channelDays, { socialAccountId, range: SYNCED }),
        "NOT_FOUND",
      );
      await expectMarketingError(
        as(t, CRM).query(api.v1.youtubeAnalytics.videos, {
          socialAccountId,
          paginationOpts: page,
        }),
        "NOT_FOUND",
      );
    }
    for (const videoId of [video._id, "not-an-id"]) {
      await expectMarketingError(
        as(t, CRM).query(api.v1.youtubeAnalytics.video, { videoId }),
        "NOT_FOUND",
      );
    }
  });

  it("an orgId argument is rejected; unauthenticated and viewer-less calls fail", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const orgId = (await t.run((ctx) => ctx.db.query("organizations").first()))!._id;
    await expect(
      as(t).query(api.v1.youtubeAnalytics.channelDays, {
        socialAccountId: ids["1"]!,
        range: SYNCED,
        orgId,
      } as never),
    ).rejects.toThrow();
    await expectMarketingError(
      t.query(api.v1.youtubeAnalytics.channelDays, { socialAccountId: ids["1"]!, range: SYNCED }),
      "UNAUTHENTICATED",
    );
    // A viewer may read (orgQuery); the answer is the same.
    const viewer = await as(t, { role: "viewer" }).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: ids["1"]!,
      range: SYNCED,
    });
    expect(viewer.coverage.syncedDays).toBe(30);
  });

  it("responses carry no token, credential, scope or URL other than YouTube watch links", async () => {
    const t = newBackend();
    const { ids } = await youtubeOrg(t);
    const video = (await rowsOf(t, ids["1"]!)).posts[0]!;
    const responses = JSON.stringify([
      await as(t).query(api.v1.youtubeAnalytics.channelDays, {
        socialAccountId: ids["1"]!,
        range: SYNCED,
      }),
      await as(t).query(api.v1.youtubeAnalytics.videos, {
        socialAccountId: ids["1"]!,
        paginationOpts: page,
      }),
      await as(t).query(api.v1.youtubeAnalytics.video, { videoId: video._id }),
    ]);
    expect(responses).not.toMatch(/mock-yt-token|token|credential|cipher|secret|googleapis/i);
    for (const url of responses.match(/https?:\/\/[^"]+/g) ?? []) {
      expect(url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/);
    }
  });
});

describe("contract", () => {
  type Exported = { exportArgs: () => string; exportReturns: () => string };
  const fns = {
    "youtubeAnalytics:channelDays": youtubeAnalytics.channelDays,
    "youtubeAnalytics:videos": youtubeAnalytics.videos,
    "youtubeAnalytics:video": youtubeAnalytics.video,
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

  /**
   * ADR 0016 Checkpoint 8 (approved): the only derived or ratio fields are the one-channel range
   * totals of channelDays and YouTube's own per-video averageViewPercentage. Nothing else.
   */
  const APPROVED_DERIVED: Record<string, string[]> = {
    "youtubeAnalytics:channelDays": ["totals"],
    "youtubeAnalytics:videos": ["averageViewPercentage"],
    "youtubeAnalytics:video": ["averageViewPercentage"],
  };

  it.each(Object.entries(fns))(
    "%s exposes no derived, aggregate or forbidden field beyond the approved ones",
    (name, fn) => {
      const names = fieldNames(JSON.parse(fn.exportReturns()));
      for (const forbidden of [
        "_id",
        "_creationTime",
        "orgId",
        "connectionId",
        "grantedScopes",
        "credential",
        "accessToken",
        "followers",
        "reach",
        "saves",
        "totalInteractions",
        "engagementRate",
        "kpis",
        "comparison",
        "deltas",
        "postId",
      ]) {
        expect(names, forbidden).not.toContain(forbidden);
      }
      expect([
        ...new Set(names.filter((n) => /total|delta|percent|rate|score|rank|sum/i.test(n))),
      ]).toEqual(APPROVED_DERIVED[name]);
      expect(names.filter((n) => /url/i.test(n))).toEqual([]);
    },
  );

  it("the API's YouTube vocabulary matches what the provider stores", () => {
    expect([...YOUTUBE_DAY_METRICS]).toEqual(Object.keys(ACCOUNT_REPORT_TARGETS));
    expect([...YOUTUBE_VIDEO_METRICS]).toEqual([...YOUTUBE_POST_METRICS]);
    expect([...YOUTUBE_VIDEO_ANALYTICS_METRICS]).toEqual([...VIDEO_REPORT_COLUMNS]);
    expect(YOUTUBE_DAY_TIMEZONE).toBe(REPORT_DAY_BASIS);
  });
});
