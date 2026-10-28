import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { mockInstagramAccountId } from "../providers/social/mock";
import { mockYouTubeChannelId } from "../providers/social/mock/youtubeData";
import {
  createFakeYouTube,
  FAKE_CHANNEL_ID,
  FAKE_YT_TOKEN_MARKER,
  fakeVideos,
  type FakeYouTube,
} from "../providers/youtube/fakeYouTube.fixtures";
import {
  as,
  connectMockInstagram,
  connectMockYouTube,
  connectYouTubeFake,
  drainScheduler,
  expectMarketingError,
  ISSUER_CRM,
  linkSocial,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  stubLiveYouTube,
  type Backend,
  type IdentityInput,
} from "../test.helpers";

// ADR 0016, Checkpoint 6: the complete YouTube workflow as ONE journey per mode, through the
// public v1 API and the real backend functions (in-process Convex), never a real Google
// account. Each step is covered in depth by its own suite (youtubeFlow, youtube.e2e,
// youtubeRetention, v1/youtubeAnalytics); this file proves they work together, in order.

vi.setConfig({ testTimeout: 180_000 });
const NOW = new Date("2026-10-20T12:00:00Z");
const SYNCED = { from: "2026-09-18", to: "2026-10-17" };
const CRM: IdentityInput = { issuer: ISSUER_CRM };
const PAGE = { numItems: 100, cursor: null };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function channelRows(t: Backend, id: string) {
  return await t.run(async (ctx) => {
    const of = <T extends { socialAccountId: Id<"socialAccounts"> }>(rows: T[]) =>
      rows.filter((row) => row.socialAccountId === id).length;
    return {
      account: (await ctx.db.query("socialAccounts").collect()).filter((a) => a._id === id).length,
      posts: of(await ctx.db.query("socialPosts").collect()),
      snapshots: of(await ctx.db.query("socialPostMetricSnapshots").collect()),
      days: of(await ctx.db.query("socialAccountMetricsDaily").collect()),
    };
  });
}

const GONE = { account: 0, posts: 0, snapshots: 0, days: 0 };

/** Makes every sync state due now (a lookback too), like the planner cadence would later. */
async function dueNow(t: Backend) {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("syncAccounts").collect()) {
      await ctx.db.patch(row._id, { nextPlanAt: 0, nextLookbackAt: 0 });
    }
  });
}

describe("YouTube journey, mock mode (PROVIDER_MODE unset)", () => {
  it("connect, link, sync, read, view data, disconnect, delete; Instagram and another org untouched", async () => {
    const t = newBackend();
    await setupSyncOrg(t);

    // 1-2. Connect through the OAuth flow (mock consent -> callback -> claim), discover, link.
    const youtube = await connectMockYouTube(t, "1");
    expect(youtube.get("status")).toBe("connected");
    const connectionId = youtube.get("connection")!;
    const discovered = await as(t).query(api.v1.connections.listDiscoveredSocialAccounts, {
      connectionId,
    });
    expect(discovered.map((d) => [d.platform, d.externalId, d.linked])).toEqual([
      ["youtube", mockYouTubeChannelId("1"), false],
    ]);
    const [channel] = await linkSocial(t, connectionId, [mockYouTubeChannelId("1")]);
    const channelId = channel!.id;

    // Instagram in the same org, and the same YouTube channel connected by another org.
    const ig = (await connectMockInstagram(t, "1")).get("connection")!;
    const [instagram] = await linkSocial(t, ig, [mockInstagramAccountId("1")]);
    await setupSyncOrg(t, CRM);
    const other = (await connectMockYouTube(t, "1", CRM)).get("connection")!;
    const [otherChannel] = await linkSocial(t, other, [mockYouTubeChannelId("1")], CRM);

    // 3. Sync metadata, daily analytics and video statistics.
    await planAndDrain(t);
    const synced = await channelRows(t, channelId);
    expect(synced.account).toBe(1);
    expect(synced.posts).toBeGreaterThan(0);
    expect(synced.snapshots).toBeGreaterThan(0);
    expect(synced.days).toBeGreaterThan(0);
    const account = await as(t).query(api.v1.socialAccounts.get, { socialAccountId: channelId });
    expect(account).toMatchObject({ platform: "youtube", accountType: "channel", linked: true });
    expect(account.coverage).toEqual({ from: SYNCED.from, through: SYNCED.to });

    // 4-5. Tenant-scoped v1 reads (what /social renders).
    const days = await as(t).query(api.v1.youtubeAnalytics.channelDays, {
      socialAccountId: channelId,
      range: SYNCED,
    });
    expect(days).toMatchObject({
      timezone: "America/Los_Angeles",
      dataState: "reported",
      analyticsAccess: "granted",
    });
    expect(days.days).toHaveLength(30);
    const videos = await as(t).query(api.v1.youtubeAnalytics.videos, {
      socialAccountId: channelId,
      paginationOpts: PAGE,
    });
    expect(videos.page.some((v) => v.latest?.metrics.views !== undefined)).toBe(true);
    // Cross-tenant: the other org can read neither this channel nor a video of it.
    await expectMarketingError(
      as(t, CRM).query(api.v1.youtubeAnalytics.channelDays, {
        socialAccountId: channelId,
        range: SYNCED,
      }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t, CRM).query(api.v1.youtubeAnalytics.video, { videoId: videos.page[0]!.id }),
      "NOT_FOUND",
    );
    const instagramBefore = await channelRows(t, instagram!.id);
    const otherBefore = await channelRows(t, otherChannel!.id);

    // 7. Disconnect: revoked, and every stored row of the channel deleted.
    await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    await drainScheduler(t);
    expect(await channelRows(t, channelId)).toEqual(GONE);
    expect((await as(t).query(api.v1.connections.get, { connectionId })).status).toBe("revoked");
    // 9 (part). The other org's channel and the Instagram account are untouched by it.
    expect(await channelRows(t, otherChannel!.id)).toEqual(otherBefore);
    expect(await channelRows(t, instagram!.id)).toEqual(instagramBefore);
    await expectMarketingError(
      as(t).query(api.v1.youtubeAnalytics.channelDays, {
        socialAccountId: channelId,
        range: SYNCED,
      }),
      "NOT_FOUND",
    );

    // 8. Retry safety: a repeated disconnect, purge, sweep or planner tick changes nothing.
    await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    const orgId = (await t.run((ctx) => ctx.db.get(instagram!.id as Id<"socialAccounts">)))!.orgId;
    expect(
      (
        await t.mutation(internal.connections.youtubeRetention.purgeYouTubeAccount, {
          orgId,
          socialAccountId: channelId as Id<"socialAccounts">,
        })
      ).status,
    ).toBe("skipped");
    expect(
      (await t.mutation(internal.connections.youtubeRetention.sweepYouTubeRetention, {})).resumed,
    ).toBe(0);
    await planAndDrain(t);
    expect(await channelRows(t, channelId)).toEqual(GONE);

    // 9. Instagram and the other org keep syncing normally afterwards.
    expect((await channelRows(t, otherChannel!.id)).account).toBe(1);
    expect((await channelRows(t, instagram!.id)).account).toBe(1);
    const igOverview = await as(t).query(api.v1.organicAnalytics.overview, {
      range: { from: "2026-09-21", to: "2026-10-17" },
    });
    expect(igOverview.accountCount).toBe(1);
    expect(igOverview.totals.metrics.views).toBeGreaterThan(0);
  });
});

describe("YouTube journey, real provider code against the fake Google API", () => {
  let fake: FakeYouTube;
  beforeEach(() => {
    fake = createFakeYouTube({
      channels: {
        brand: {
          channelId: FAKE_CHANNEL_ID,
          title: "Fake Brand",
          customUrl: "@fakebrand",
          subscriberCount: "12300",
          videos: fakeVideos(3, "2026-10-19T10:00:00Z").map((video, i) => ({
            ...video,
            statistics: { viewCount: String(1000 * (i + 1)), commentCount: String(i) },
          })),
          days: { "2026-10-17": { views: 140 }, "2026-10-16": { views: 120 } },
        },
      },
    });
    stubLiveYouTube(fake);
  });

  it("OAuth, sync, revocation at Google, reconnect, resumed sync, disconnect with Google revoke", async () => {
    const t = newBackend();
    await setupSyncOrg(t);

    // 1-3. OAuth (PKCE consent at the fake Google, callback, claim), link, first sync.
    const params = await connectYouTubeFake(t, fake, "brand");
    expect(params.get("status")).toBe("connected");
    const connectionId = params.get("connection")!;
    const [channel] = await linkSocial(t, connectionId, [FAKE_CHANNEL_ID]);
    const channelId = channel!.id;
    await planAndDrain(t);
    const read = () =>
      as(t).query(api.v1.youtubeAnalytics.channelDays, {
        socialAccountId: channelId,
        range: { from: "2026-10-16", to: "2026-10-17" },
      });
    const first = await read();
    expect(first.analyticsAccess).toBe("granted");
    expect(first.days.map((d) => [d.date, d.status, d.metrics.views])).toEqual([
      ["2026-10-16", "reported", 120],
      ["2026-10-17", "reported", 140],
    ]);

    // 6. The user revokes access in their Google account: the next sync gets invalid_grant.
    fake.revoke("brand");
    await dueNow(t);
    vi.setSystemTime(NOW.getTime() + 2 * 60 * 60_000);
    await planAndDrain(t);
    expect((await as(t).query(api.v1.connections.get, { connectionId })).status).toBe(
      "needs_reauth",
    );
    expect((await read()).analyticsAccess).toBe("reauth_required");
    // The stored data stays readable while reconnecting (no deletion on a failed sync).
    expect((await read()).days[1]!.metrics.views).toBe(140);

    // Reconnect the same channel: active again, and the next sync succeeds.
    const again = await connectYouTubeFake(
      t,
      fake,
      "brand",
      {},
      { reconnectConnectionId: connectionId },
    );
    expect(again.get("status")).toBe("connected");
    expect((await as(t).query(api.v1.connections.get, { connectionId })).status).toBe("active");
    await dueNow(t);
    vi.setSystemTime(NOW.getTime() + 3 * 60 * 60_000);
    await planAndDrain(t);
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs.sort((a, b) => a.createdAt - b.createdAt).at(-1)).toMatchObject({
      status: "succeeded",
    });
    expect((await read()).analyticsAccess).toBe("granted");

    // 7. Disconnect: Google revocation request sent, data deleted, credential gone.
    fake.requests.length = 0;
    await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    await drainScheduler(t);
    expect(fake.requests.filter((r) => r.path === "/revoke")).toHaveLength(1);
    expect(fake.revokedUsers).toContain("brand");
    expect(await channelRows(t, channelId)).toEqual(GONE);
    const leftovers = await t.run(async (ctx) => ({
      credentials: await ctx.db.query("credentials").collect(),
      audit: await ctx.db.query("auditLog").collect(),
    }));
    expect(leftovers.credentials).toEqual([]);
    expect(leftovers.audit.map((e) => e.action)).toEqual(
      expect.arrayContaining(["socialAccount.purge_started", "socialAccount.purged"]),
    );
    expect(JSON.stringify(leftovers)).not.toContain(FAKE_YT_TOKEN_MARKER);
  });
});
