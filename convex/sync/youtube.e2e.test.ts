import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
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
    // Requests: preflight 2, listing 4, snapshots 4, two day reports 2 each.
    expect(count("/v2/reports")).toBe(2);
    expect(fake.requests).toHaveLength(2 + 4 + 4 + 4);
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
    expect(count("/v2/reports")).toBe(4); // 2 windows + 2 retried attempts
    const insights = db.daily.filter((d) => d.insightsSyncedAt !== undefined);
    expect(insights).toHaveLength(30);
    expect(new Set(insights.map((d) => d.date)).size).toBe(30);
  });

  it("a channel without the analytics grant is blocked before any report request", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectYouTubeFake(t, fake, "noAnalytics");
    const dto = await as(t).query(api.v1.connections.get, {
      connectionId: params.get("connection")!,
    });
    expect(dto.missingScopes).toEqual(["https://www.googleapis.com/auth/yt-analytics.readonly"]);
    await linkSocial(t, params.get("connection")!, [FAKE_CHANNEL_ID]);
    await planAndDrain(t);
    const db = await state(t);
    expect(db.runs[0]).toMatchObject({
      status: "failed",
      error: { kind: "permission", code: "analytics_scope_missing" },
    });
    expect(db.accounts[0]!.state).toBe("blocked");
    expect(count("/v2/reports")).toBe(0);
    expect(db.daily.filter((d) => d.insightsSyncedAt !== undefined)).toEqual([]);
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
