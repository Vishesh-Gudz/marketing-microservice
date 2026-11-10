import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { eachDay } from "../lib/dates";
import { mockInstagramAccountId } from "../providers/social/mock";
import { mockYouTubeChannelId } from "../providers/social/mock/youtubeData";
import {
  createFakeYouTube,
  FAKE_CHANNEL_ID,
  FAKE_YT_READONLY_SCOPE,
  FAKE_YT_TOKEN_MARKER,
  fakeVideos,
  type FakeChannel,
  type FakeYouTube,
} from "../providers/youtube/fakeYouTube.fixtures";
import {
  as,
  connectMockInstagram,
  connectMockYouTube,
  connectYouTubeFake,
  linkSocial,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  stubLiveYouTube,
  type Backend,
} from "../test.helpers";

// ADR 0016, Checkpoint 3: YouTube analytics through the EXISTING engine (planner -> run -> tasks
// in seq order -> "use node" social worker -> provider -> commitSocialPage), against the fake
// Google API (documented behavior only) and in mock mode. Only values YouTube reports are
// stored; windows end 3 days before today (reporting delay); retries are idempotent; and the
// organic analytics does not aggregate YouTube yet (policy review before Checkpoint 4).

vi.setConfig({ testTimeout: 180_000 });
const NOW = new Date("2026-10-20T12:00:00Z");

const DAY_VALUES = (n: number) => ({
  views: 100 + n,
  likes: n,
  comments: 2,
  shares: 0,
  estimatedMinutesWatched: 300 + n,
  averageViewDuration: 80,
  subscribersGained: 4,
  subscribersLost: 1,
});

/** Days with a row: every day from 2026-08-01 to 2026-10-19 except every 5th one. */
function reportedDays(): Record<string, ReturnType<typeof DAY_VALUES>> {
  return Object.fromEntries(
    eachDay("2026-08-01", "2026-10-19")
      .map((day, i) => [day, i] as const)
      .filter(([, i]) => i % 5 !== 0)
      .map(([day, i]) => [day, DAY_VALUES(i)]),
  );
}

function brand(overrides: Partial<FakeChannel> = {}): FakeChannel {
  return {
    channelId: FAKE_CHANNEL_ID,
    title: "Fake Brand",
    customUrl: "@fakebrand",
    subscriberCount: "12300",
    videos: fakeVideos(3, "2026-10-19T10:00:00Z").map((video, i) => ({
      ...video,
      statistics: {
        viewCount: String(1000 * (i + 1)),
        ...(i === 1 ? {} : { likeCount: String(10 * i) }), // the 2nd hides its likes
        commentCount: String(i),
      },
    })),
    days: reportedDays(),
    ...overrides,
  };
}

let fake: FakeYouTube;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = createFakeYouTube({
    channels: { brand: brand(), noAnalytics: brand({ grantedScope: FAKE_YT_READONLY_SCOPE }) },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function state(t: Backend) {
  return await t.run(async (ctx) => ({
    accounts: await ctx.db.query("syncAccounts").collect(),
    runs: await ctx.db.query("syncRuns").collect(),
    tasks: await ctx.db.query("syncTasks").collect(),
    socialAccounts: await ctx.db.query("socialAccounts").collect(),
    posts: await ctx.db.query("socialPosts").collect(),
    snapshots: await ctx.db.query("socialPostMetricSnapshots").collect(),
    daily: await ctx.db.query("socialAccountMetricsDaily").collect(),
    analytics: await ctx.db.query("youtubeVideoAnalytics").collect(),
  }));
}

async function linkedYouTube(t: Backend, user = "brand") {
  await setupSyncOrg(t);
  const params = await connectYouTubeFake(t, fake, user);
  expect(params.get("status"), params.get("error") ?? "").toBe("connected");
  const [account] = await linkSocial(t, params.get("connection")!, [FAKE_CHANNEL_ID]);
  return account!.id as Id<"socialAccounts">;
}

const count = (path: string) => fake.requests.filter((r) => r.path === path).length;

describe("YouTube sync (live, fake API)", () => {
  it("plans delayed windows and stores channel, uploads, snapshots and days as reported", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const socialAccountId = await linkedYouTube(t);
    fake.requests.length = 0;

    expect((await planAndDrain(t)).started).toBe(1);
    const db = await state(t);
    expect(db.runs[0]).toMatchObject({
      socialAccountId,
      kind: "initial",
      status: "succeeded",
      platform: "youtube",
      providerId: "youtube-data-api/v3",
      // The 30 days ending 3 days before today (2026-10-20): YouTube reports late.
      window: { from: "2026-09-18", to: "2026-10-17" },
    });
    const tasks = db.tasks.sort((a, b) => a.seq - b.seq);
    expect(tasks.map((task) => [task.operation, task.status, task.from, task.to])).toEqual([
      ["getSocialAccount", "succeeded", undefined, undefined],
      ["listSocialPosts", "succeeded", undefined, undefined],
      ["fetchPostMetrics", "succeeded", "2026-07-23", "2026-10-20"],
      ["fetchAccountMetrics", "succeeded", "2026-10-01", "2026-10-17"],
      ["fetchAccountMetrics", "succeeded", "2026-09-18", "2026-09-30"],
      // Checkpoint 8: last28, then lifetime from the oldest upload's Pacific Time day.
      ["fetchVideoAnalytics", "succeeded", "2026-09-20", "2026-10-17"],
      ["fetchVideoAnalytics", "succeeded", "2026-10-17", "2026-10-17"],
    ]);

    // Snapshots: lifetime counts as reported; the hidden like count stays absent.
    expect(db.snapshots).toHaveLength(3);
    const byPost = new Map(db.posts.map((p) => [p._id, p.externalId]));
    const snaps = new Map(db.snapshots.map((s) => [byPost.get(s.postId), s]));
    expect(snaps.get("vid00000000")).toMatchObject({
      capturedDate: "2026-10-20",
      views: 1000,
      likes: 0,
      comments: 0,
    });
    expect(snaps.get("vid00000001")!.likes).toBeUndefined();

    // Days: exactly one insights row per requested day, nothing after 2026-10-17; a day
    // without a report row is synced but empty (never 0); no derived value anywhere.
    const insights = db.daily.filter((d) => d.insightsSyncedAt !== undefined);
    expect(insights.map((d) => d.date).sort()).toEqual(eachDay("2026-09-18", "2026-10-17"));
    const byDate = new Map(db.daily.map((d) => [d.date, d]));
    const reported = reportedDays();
    for (const day of insights) {
      expect(day.followerDelta).toBeUndefined();
      expect(day.reach).toBeUndefined();
      expect(day.totalInteractions).toBeUndefined();
      const values = reported[day.date];
      if (values === undefined) {
        expect([day.views, day.extras]).toEqual([undefined, undefined]);
      } else {
        expect(day.views).toBe(values.views);
        expect(day.extras).toEqual({
          likes: values.likes,
          comments: values.comments,
          shares: values.shares,
          estimatedMinutesWatched: values.estimatedMinutesWatched,
          averageViewDuration: values.averageViewDuration,
          subscribersGained: values.subscribersGained,
          subscribersLost: values.subscribersLost,
        });
      }
    }
    // Today's row holds only the subscriber capture of the preflight.
    expect(byDate.get("2026-10-20")).toMatchObject({ followers: 12_300 });
    expect(byDate.get("2026-10-20")!.insightsSyncedAt).toBeUndefined();

    expect(db.accounts[0]).toMatchObject({
      state: "idle",
      coveredFrom: "2026-09-18",
      coveredThrough: "2026-10-17",
    });
    // Requests: preflight 2, listing 4, snapshots 4, two day reports and two video reports
    // (Checkpoint 8) 2 each.
    expect(count("/v2/reports")).toBe(4);
    expect(fake.requests).toHaveLength(2 + 4 + 4 + 4 + 4);
    expect(JSON.stringify(db)).not.toContain(FAKE_YT_TOKEN_MARKER);
  });

  it("rerunning the same windows rewrites identical rows (idempotent)", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await linkedYouTube(t);
    await planAndDrain(t);
    const values = async () => {
      const db = await state(t);
      const strip = <T extends Record<string, unknown>>(rows: T[], drop: string[]) =>
        rows
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).filter(([k]) => !["_id", "_creationTime", ...drop].includes(k)),
            ),
          )
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return {
        posts: strip(db.posts, ["lastSeenAt", "updatedAt"]),
        snapshots: strip(db.snapshots, ["capturedAt"]),
        daily: strip(db.daily, ["syncedAt", "insightsSyncedAt", "followersCapturedAt"]),
        analytics: strip(db.analytics, ["syncedAt"]),
      };
    };
    const first = await values();
    // Same UTC day, next planner slot: force a lookback (re-lists, re-snapshots, re-reads days).
    const row = (await state(t)).accounts[0]!;
    await t.run((ctx) => ctx.db.patch(row._id, { nextLookbackAt: 0, nextPlanAt: 0 }));
    vi.setSystemTime(NOW.getTime() + 20 * 60_000);
    await planAndDrain(t);
    const runs = (await state(t)).runs.sort((a, b) => a.createdAt - b.createdAt);
    expect(runs.at(-1)).toMatchObject({
      kind: "lookback",
      status: "succeeded",
      window: { from: "2026-10-11", to: "2026-10-17" }, // 7 days, delayed by 3
    });
    expect(await values()).toEqual(first);
  });

  it("retries a failed report (outage, then quota) and writes each day once", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await linkedYouTube(t);
    fake.requests.length = 0;
    fake.failNext("reports", {
      status: 503,
      body: { error: { code: 503, errors: [{ reason: "backendError" }] } },
    });
    fake.failNext("reports", {
      status: 403,
      body: { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } },
    });
    await planAndDrain(t);
    const db = await state(t);
    expect(db.runs[0]).toMatchObject({ status: "succeeded" });
    // 2 day windows + 2 retried attempts + 2 per-video windows (Checkpoint 8)
    expect(count("/v2/reports")).toBe(6);
    const insights = db.daily.filter((d) => d.insightsSyncedAt !== undefined);
    expect(insights).toHaveLength(30);
    expect(new Set(insights.map((d) => d.date)).size).toBe(30);
  });

  it("a channel without the analytics grant syncs everything but the day reports (Q13)", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectYouTubeFake(t, fake, "noAnalytics");
    const connectionId = params.get("connection")!;
    const dto = await as(t).query(api.v1.connections.get, { connectionId });
    expect(dto.missingScopes).toEqual(["https://www.googleapis.com/auth/yt-analytics.readonly"]);
    const [account] = await linkSocial(t, connectionId, [FAKE_CHANNEL_ID]);
    fake.requests.length = 0;
    await planAndDrain(t);
    const db = await state(t);
    expect(db.runs[0]).toMatchObject({ kind: "initial", status: "succeeded" });
    expect(db.runs[0]!.error).toBeUndefined();
    expect(
      db.tasks.sort((a, b) => a.seq - b.seq).map((task) => [task.operation, task.status]),
    ).toEqual([
      ["getSocialAccount", "succeeded"],
      ["listSocialPosts", "succeeded"],
      ["fetchPostMetrics", "succeeded"],
    ]);
    // Channel, videos and video statistics are synced; no report was requested.
    expect(db.socialAccounts[0]).toMatchObject({ name: "Fake Brand", followersCount: 12_300 });
    expect(db.posts).toHaveLength(3);
    expect(db.snapshots).toHaveLength(3);
    expect(count("/v2/reports")).toBe(0);
    // No day is fabricated: no insights row, no coverage; v1 says why the days are unknown.
    expect(db.daily.filter((d) => d.insightsSyncedAt !== undefined)).toEqual([]);
    expect(db.accounts[0]).toMatchObject({ state: "idle", consecutiveFailures: 0 });
    expect(db.accounts[0]!.lastError).toBeUndefined();
    expect(db.accounts[0]!.coveredThrough).toBeUndefined();
    const days = await as(t).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: account!.id,
      range: { from: "2026-10-15", to: "2026-10-17" },
    });
    expect(days).toMatchObject({ analyticsAccess: "scope_missing", dataState: "unknown" });
    expect(
      days.days.every((day) => day.status === "unknown" && Object.keys(day.metrics).length === 0),
    ).toBe(true);
    // The missing scope is not an authorization failure.
    expect((await as(t).query(api.v1.connections.get, { connectionId })).status).toBe("active");

    // The next daily lookback keeps updating the video statistics (a new capture day).
    vi.setSystemTime(NOW.getTime() + 25 * 60 * 60_000);
    await planAndDrain(t);
    const later = await state(t);
    expect(later.runs.sort((a, b) => a.createdAt - b.createdAt).at(-1)).toMatchObject({
      kind: "lookback",
      status: "succeeded",
    });
    expect(later.snapshots).toHaveLength(6);
    expect(new Set(later.snapshots.map((s) => s.capturedDate))).toEqual(
      new Set(["2026-10-20", "2026-10-21"]),
    );
    expect(count("/v2/reports")).toBe(0);
  });

  it("a missing analytics grant alone never ages out the videos or the channel (Q13)", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const socialAccountId = await linkedYouTube(t, "noAnalytics");
    await planAndDrain(t);
    // 26 days later: the daily lookback lists the uploads again before the sweep looks.
    const aged = NOW.getTime() - 26 * 24 * 60 * 60_000;
    await t.run(async (ctx) => {
      for (const post of await ctx.db.query("socialPosts").collect()) {
        await ctx.db.patch(post._id, { lastSeenAt: aged });
      }
      await ctx.db.patch(socialAccountId, { lastSeenAt: aged });
      for (const row of await ctx.db.query("syncAccounts").collect()) {
        await ctx.db.patch(row._id, { nextPlanAt: 0, nextLookbackAt: 0 });
      }
    });
    vi.setSystemTime(NOW.getTime() + 60 * 60_000);
    await planAndDrain(t);
    expect(
      (await t.mutation(internal.connections.youtubeRetention.sweepYouTubeRetention, {}))
        .videosDeleted,
    ).toBe(0);
    expect(
      (await t.mutation(internal.connections.youtubeRetention.planYouTubeAuthorizationChecks, {}))
        .checks,
    ).toBe(0);
    const db = await state(t);
    expect(db.posts).toHaveLength(3);
    expect(db.socialAccounts).toHaveLength(1);
    expect(db.posts.every((post) => (post.lastSeenAt ?? 0) > aged)).toBe(true);
  });

  it("a channel blocked by the old behavior unblocks on its next run (audited)", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await linkedYouTube(t, "noAnalytics");
    await planAndDrain(t);
    // As Checkpoints 3-6 left it: blocked on analytics_scope_missing, re-checked daily.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("syncAccounts").collect()) {
        await ctx.db.patch(row._id, {
          state: "blocked",
          lastError: {
            kind: "permission",
            code: "analytics_scope_missing",
            message: "No access to this ad account",
            at: NOW.getTime(),
          },
          nextPlanAt: 0,
          nextLookbackAt: 0,
        });
      }
    });
    vi.setSystemTime(NOW.getTime() + 24 * 60 * 60_000);
    await planAndDrain(t);
    const db = await state(t);
    expect(db.runs.sort((a, b) => a.createdAt - b.createdAt).at(-1)).toMatchObject({
      status: "succeeded",
    });
    expect(db.accounts[0]).toMatchObject({ state: "idle" });
    expect(db.accounts[0]!.lastError).toBeUndefined();
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.map((entry) => entry.action)).toContain("sync.account_unblocked");
  });

  it("without the analytics grant, a revocation at Google still means needs_reauth; reconnecting with it syncs the days", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = (await connectYouTubeFake(t, fake, "noAnalytics")).get("connection")!;
    const [account] = await linkSocial(t, connectionId, [FAKE_CHANNEL_ID]);
    await planAndDrain(t);

    // A genuine authorization failure keeps its existing path.
    fake.revoke("noAnalytics");
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("syncAccounts").collect()) {
        await ctx.db.patch(row._id, { nextPlanAt: 0, nextIncrementalAt: 0 });
      }
    });
    vi.setSystemTime(NOW.getTime() + 60 * 60_000);
    await planAndDrain(t);
    expect((await as(t).query(api.v1.connections.get, { connectionId })).status).toBe(
      "needs_reauth",
    );
    const failed = (await state(t)).runs.sort((a, b) => a.createdAt - b.createdAt).at(-1);
    expect(failed).toMatchObject({
      status: "failed",
      error: { kind: "auth", code: "invalid_grant" },
    });

    // Reconnect the same channel, this time with YouTube Analytics: the full sync resumes.
    const again = await connectYouTubeFake(
      t,
      fake,
      "brand",
      {},
      { reconnectConnectionId: connectionId },
    );
    expect(again.get("status")).toBe("connected");
    const reconnected = await as(t).query(api.v1.connections.get, { connectionId });
    expect(reconnected).toMatchObject({ status: "active", missingScopes: [] });
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("syncAccounts").collect()) {
        await ctx.db.patch(row._id, { nextPlanAt: 0, nextLookbackAt: 0 });
      }
    });
    vi.setSystemTime(NOW.getTime() + 2 * 60 * 60_000);
    fake.requests.length = 0;
    await planAndDrain(t);
    const latest = (await state(t)).runs.sort((a, b) => a.createdAt - b.createdAt).at(-1)!;
    expect(latest).toMatchObject({ kind: "lookback", status: "succeeded" });
    expect(count("/v2/reports")).toBe(3); // the day report and the two per-video windows
    const days = await as(t).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: account!.id,
      range: { from: "2026-10-11", to: "2026-10-17" },
    });
    expect(days).toMatchObject({ analyticsAccess: "granted", dataState: "reported" });
  });

  it("another org's channel with the grant keeps its day reports; each org follows its own scopes", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const without = await linkedYouTube(t, "noAnalytics");
    const orgB = { org: "43" };
    await setupSyncOrg(t, orgB);
    const params = await connectYouTubeFake(t, fake, "brand", orgB);
    const [withGrant] = await linkSocial(t, params.get("connection")!, [FAKE_CHANNEL_ID], orgB);
    await planAndDrain(t);
    const db = await state(t);
    const insightsOf = (id: string) =>
      db.daily.filter((d) => d.socialAccountId === id && d.insightsSyncedAt !== undefined).length;
    expect(insightsOf(without)).toBe(0);
    expect(insightsOf(withGrant!.id)).toBe(30);
    expect(db.runs.every((run) => run.status === "succeeded")).toBe(true);
  });

  it("keeps Pacific Time day keys across the November DST change", async () => {
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    fake = createFakeYouTube({
      channels: {
        brand: brand({
          days: {
            "2026-10-31": DAY_VALUES(1),
            "2026-11-01": DAY_VALUES(2),
            "2026-11-02": DAY_VALUES(3),
          },
        }),
      },
    });
    stubLiveYouTube(fake);
    const t = newBackend();
    await linkedYouTube(t);
    await planAndDrain(t);
    const db = await state(t);
    const insights = db.daily.filter((d) => d.insightsSyncedAt !== undefined);
    // Window ends 2026-11-02 (3 days before 2026-11-05); 2026-11-01 (25 h) is one row.
    expect(
      insights
        .map((d) => d.date)
        .sort()
        .at(-1),
    ).toBe("2026-11-02");
    expect(insights.filter((d) => d.date === "2026-11-01")).toHaveLength(1);
    expect(insights.find((d) => d.date === "2026-11-01")!.views).toBe(DAY_VALUES(2).views);
    expect(insights.find((d) => d.date === "2026-10-31")!.views).toBe(DAY_VALUES(1).views);
  });
});

describe("per-video analytics windows (Checkpoint 8, live, fake API)", () => {
  const VIDEO_VALUES = (views: number) => ({
    views,
    estimatedMinutesWatched: views * 3,
    averageViewDuration: 120,
    averageViewPercentage: 37.5,
    likes: Math.floor(views / 10),
    comments: 2,
    shares: 1,
    subscribersGained: 3,
    subscribersLost: 1,
  });
  const byWindow = <T extends { window: string }>(rows: T[], window: string) =>
    rows.filter((row) => row.window === window);

  it("writes last28 and lifetime, then a lookback replaces each window completely", async () => {
    // The lifetime window starts on 2026-10-17 (the oldest upload's Pacific Time day), so
    // both windows are keyed by their own start day.
    const channel = brand({
      videoReports: {
        "2026-09-20": {
          vid00000000: VIDEO_VALUES(500),
          vid00000001: VIDEO_VALUES(300),
          vidNotStore: VIDEO_VALUES(900), // not a stored upload: dropped, never a post
        },
        "2026-10-17": {
          vid00000000: VIDEO_VALUES(800),
          vid00000001: VIDEO_VALUES(600),
          vid00000002: { ...VIDEO_VALUES(10), averageViewPercentage: null },
        },
      },
    });
    fake = createFakeYouTube({ channels: { brand: channel } });
    stubLiveYouTube(fake);
    const t = newBackend();
    const socialAccountId = await linkedYouTube(t);
    await planAndDrain(t);

    let db = await state(t);
    expect(db.runs[0]).toMatchObject({ status: "succeeded" }); // the unknown video is no error
    expect(db.runs[0]!.counts.unresolved).toBe(0);
    expect(db.posts.map((post) => post.externalId).sort()).toEqual([
      "vid00000000",
      "vid00000001",
      "vid00000002",
    ]);
    const postOf = new Map(db.posts.map((post) => [post._id, post.externalId]));
    const view = (window: string) =>
      byWindow(db.analytics, window)
        .map((row) => [postOf.get(row.postId), row.views, row.from, row.to])
        .sort();
    expect(view("last28")).toEqual([
      ["vid00000000", 500, "2026-09-20", "2026-10-17"],
      ["vid00000001", 300, "2026-09-20", "2026-10-17"],
    ]);
    expect(view("lifetime")).toEqual([
      ["vid00000000", 800, "2026-10-17", "2026-10-17"],
      ["vid00000001", 600, "2026-10-17", "2026-10-17"],
      ["vid00000002", 10, "2026-10-17", "2026-10-17"],
    ]);
    const first = db.analytics.find(
      (row) => row.window === "last28" && postOf.get(row.postId) === "vid00000000",
    )!;
    expect(first).toMatchObject({
      socialAccountId,
      ...VIDEO_VALUES(500),
      syncedAt: NOW.getTime(),
    });
    expect(first.orgId).toBe(db.socialAccounts[0]!.orgId);
    // A value YouTube left out stays absent (never 0).
    const partial = db.analytics.find((row) => postOf.get(row.postId) === "vid00000002")!;
    expect(partial).not.toHaveProperty("averageViewPercentage");
    expect(db.accounts[0]!.videoAnalyticsWindows).toEqual({
      last28: { from: "2026-09-20", to: "2026-10-17", syncedAt: NOW.getTime(), videos: 2 },
      lifetime: { from: "2026-10-17", to: "2026-10-17", syncedAt: NOW.getTime(), videos: 3 },
    });

    // The next day's lookback (Pacific Time 2026-10-21: both windows end on 2026-10-18).
    // vid00000001 fell out of the recent top list; vid00000002 entered it.
    channel.videoReports = {
      "2026-09-21": { vid00000000: VIDEO_VALUES(510), vid00000002: VIDEO_VALUES(20) },
      "2026-10-17": { vid00000000: VIDEO_VALUES(820), vid00000001: VIDEO_VALUES(610) },
    };
    const later = NOW.getTime() + 25 * 60 * 60_000;
    vi.setSystemTime(later);
    fake.requests.length = 0;
    await planAndDrain(t);
    db = await state(t);
    const lookback = db.runs.sort((a, b) => a.createdAt - b.createdAt).at(-1)!;
    expect(lookback).toMatchObject({ kind: "lookback", status: "succeeded" });
    expect(view("last28")).toEqual([
      ["vid00000000", 510, "2026-09-21", "2026-10-18"],
      ["vid00000002", 20, "2026-09-21", "2026-10-18"],
    ]);
    expect(view("lifetime")).toEqual([
      ["vid00000000", 820, "2026-10-17", "2026-10-18"],
      ["vid00000001", 610, "2026-10-17", "2026-10-18"],
    ]);
    // A video still listed keeps its row (replaced in place); every row carries the new sync.
    expect(db.analytics.some((row) => row._id === first._id)).toBe(true);
    expect(db.analytics.every((row) => row.syncedAt === later)).toBe(true);
    expect(db.accounts[0]!.videoAnalyticsWindows).toEqual({
      last28: { from: "2026-09-21", to: "2026-10-18", syncedAt: later, videos: 2 },
      lifetime: { from: "2026-10-17", to: "2026-10-18", syncedAt: later, videos: 2 },
    });
    const reports = fake.requests.filter((r) => r.path === "/v2/reports");
    expect(reports.map((r) => new URL(r.url).searchParams.get("dimensions"))).toEqual([
      "day",
      "video",
      "video",
    ]);
    expect(JSON.stringify(db)).not.toContain(FAKE_YT_TOKEN_MARKER);
  });

  it("an empty window report empties the window but keeps it synced", async () => {
    const channel = brand({ videoReports: { "*": { vid00000000: VIDEO_VALUES(5) } } });
    fake = createFakeYouTube({ channels: { brand: channel } });
    stubLiveYouTube(fake);
    const t = newBackend();
    await linkedYouTube(t);
    await planAndDrain(t);
    expect((await state(t)).analytics).toHaveLength(2);

    channel.videoReports = {};
    vi.setSystemTime(NOW.getTime() + 25 * 60 * 60_000);
    await planAndDrain(t);
    const db = await state(t);
    expect(db.analytics).toEqual([]);
    expect(db.accounts[0]!.videoAnalyticsWindows).toMatchObject({
      last28: { videos: 0 },
      lifetime: { videos: 0 },
    });
  });

  it("skips both windows for a channel without videos: no video report, nothing synced", async () => {
    fake = createFakeYouTube({ channels: { brand: brand({ videos: [] }) } });
    stubLiveYouTube(fake);
    const t = newBackend();
    await linkedYouTube(t);
    fake.requests.length = 0;
    await planAndDrain(t);
    const db = await state(t);
    expect(db.runs[0]).toMatchObject({ status: "succeeded", tasksSkipped: 2 });
    expect(db.runs[0]!.error).toBeUndefined();
    expect(
      db.tasks
        .filter((task) => task.operation === "fetchVideoAnalytics")
        .map((task) => [task.videoWindow, task.status, task.from]),
    ).toEqual([
      ["last28", "skipped", "2026-09-20"],
      ["lifetime", "skipped", undefined],
    ]);
    expect(count("/v2/reports")).toBe(2); // the two day reports only
    expect(db.analytics).toEqual([]);
    expect(db.accounts[0]!.videoAnalyticsWindows).toBeUndefined();
  });

  it("a channel without the analytics grant plans no window; incremental runs never fetch one", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await linkedYouTube(t, "noAnalytics");
    await planAndDrain(t);
    let db = await state(t);
    expect(db.tasks.some((task) => task.operation === "fetchVideoAnalytics")).toBe(false);

    const withGrant = newBackend();
    await linkedYouTube(withGrant);
    await planAndDrain(withGrant);
    // An hour later the incremental run lists and reads days, never the video windows.
    vi.setSystemTime(NOW.getTime() + 61 * 60_000);
    fake.requests.length = 0;
    await planAndDrain(withGrant);
    db = await state(withGrant);
    const incremental = db.runs.sort((a, b) => a.createdAt - b.createdAt).at(-1)!;
    expect(incremental.kind).toBe("incremental");
    expect(
      db.tasks
        .filter((task) => task.runId === incremental._id)
        .some((task) => task.operation === "fetchVideoAnalytics"),
    ).toBe(false);
    expect(
      fake.requests.filter((r) => new URL(r.url).searchParams.get("dimensions") === "video"),
    ).toEqual([]);
  });

  it("a failed video report fails only its task; the stored windows stay as they were", async () => {
    const channel = brand({ videoReports: { "*": { vid00000000: VIDEO_VALUES(5) } } });
    fake = createFakeYouTube({ channels: { brand: channel } });
    stubLiveYouTube(fake);
    const t = newBackend();
    await linkedYouTube(t);
    await planAndDrain(t);
    const before = (await state(t)).analytics;
    expect(before).toHaveLength(2);

    // The next lookback: the day report succeeds, then both video reports answer garbage.
    vi.setSystemTime(NOW.getTime() + 25 * 60 * 60_000);
    const garbage = { status: 200, body: { columnHeaders: [{ name: "views" }] } };
    const realFetch = fake.fetch;
    let reports = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input.toString());
      if (url.pathname === "/v2/reports" && url.searchParams.get("dimensions") === "video") {
        reports++;
        return new Response(JSON.stringify(garbage.body), { status: garbage.status });
      }
      return await realFetch(input, init);
    });
    await planAndDrain(t);
    const db = await state(t);
    const lookback = db.runs.sort((a, b) => a.createdAt - b.createdAt).at(-1)!;
    expect(lookback).toMatchObject({
      kind: "lookback",
      status: "partial",
      tasksFailed: 2,
      error: { kind: "data", code: "report_unexpected" },
    });
    expect(reports).toBe(2); // a data error is never retried
    expect(db.analytics.map((row) => row._id).sort()).toEqual(before.map((row) => row._id).sort());
    expect(db.accounts[0]).toMatchObject({ state: "idle" });
  });
});

describe("organic analytics does not aggregate YouTube yet (mock mode)", () => {
  async function both(t: Backend) {
    await setupSyncOrg(t);
    const ig = (await connectMockInstagram(t, "1")).get("connection")!;
    const [instagram] = await linkSocial(t, ig, [mockInstagramAccountId("1")]);
    const yt = (await connectMockYouTube(t, "1")).get("connection")!;
    const [youtube] = await linkSocial(t, yt, [mockYouTubeChannelId("1")]);
    await planAndDrain(t);
    return { instagram: instagram!.id, youtube: youtube!.id };
  }
  const range = { from: "2026-09-21", to: "2026-10-17" };

  it("stores YouTube days in mock mode, but org-wide totals are Instagram's alone", async () => {
    const t = newBackend();
    const ids = await both(t);
    const stored = await t.run((ctx) => ctx.db.query("socialAccountMetricsDaily").collect());
    expect(stored.some((d) => d.platform === "youtube" && d.views !== undefined)).toBe(true);

    const orgWide = await as(t).query(api.v1.organicAnalytics.overview, { range });
    const instagramOnly = await as(t).query(api.v1.organicAnalytics.overview, {
      range,
      socialAccountIds: [ids.instagram],
    });
    expect(orgWide.accountCount).toBe(1);
    expect(orgWide.totals).toEqual(instagramOnly.totals);
  });

  it("a YouTube account is unsupported: no summed, compared or charted YouTube value", async () => {
    const t = newBackend();
    const ids = await both(t);
    const youtube = await as(t).query(api.v1.organicAnalytics.overview, {
      range,
      compare: "previous_period",
      socialAccountIds: [ids.youtube],
    });
    expect(youtube.totals.dataState).toBe("unsupported");
    const valueKeys = Object.keys(youtube.totals.metrics).filter(
      (key) => !["unavailableMetrics", "partialMetrics"].includes(key),
    );
    expect(valueKeys).toEqual([]);
    for (const delta of Object.values(youtube.comparison!.deltas)) expect(delta).toBeUndefined();

    const series = await as(t).query(api.v1.organicAnalytics.accountSeries, {
      socialAccountId: ids.youtube,
      range,
    });
    expect(series.dataState).toBe("unsupported");
    for (const point of series.points) {
      expect(point.metrics.views).toBeUndefined();
      expect(point.metrics.likes).toBeUndefined();
    }
  });
});
