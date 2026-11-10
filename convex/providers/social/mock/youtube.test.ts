import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProviderError } from "../../errors";
import { isYouTubeChannelId, isYouTubePlaylistId, isYouTubeVideoId } from "../../youtube/config";
import type { ProviderContext } from "../../types";
import { createMockYouTubeSocialProvider } from "./youtube";
import {
  MOCK_YT_LISTING_DAYS,
  MOCK_YT_UPLOAD_EVERY_DAYS,
  mockYouTubeChannel,
  mockYouTubeChannelId,
  mockYouTubeUploadsId,
  mockYouTubeVideos,
} from "./youtubeData";

// ADR 0016 (Y-D12): the mock YouTube provider is deterministic, uses the REAL YouTube mapping
// and covers the edge cases (hidden subscribers, no uploads, an unresolved upload, revoked).

const NOW = new Date("2026-10-20T12:00:00Z");
const ctx = (user: string, token = `mock-yt-token-${user}`): ProviderContext => ({
  credential: { kind: "mock_youtube", token, user },
  attempt: 1,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function allPosts(user: string) {
  const provider = createMockYouTubeSocialProvider();
  const posts = [];
  let unresolved = 0;
  let cursor: string | undefined;
  do {
    const page = await provider.listPosts(ctx(user), {
      accountExternalId: mockYouTubeChannelId(user),
      ...(cursor ? { cursor } : {}),
    });
    posts.push(...page.items);
    unresolved += page.unresolved ?? 0;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return { posts, unresolved };
}

describe("mock YouTube data", () => {
  it("is deterministic and uses well-formed YouTube ids", () => {
    expect(mockYouTubeChannelId("1")).toBe(mockYouTubeChannelId("1"));
    expect(mockYouTubeChannelId("1")).not.toBe(mockYouTubeChannelId("2"));
    expect(isYouTubeChannelId(mockYouTubeChannelId("1"))).toBe(true);
    expect(isYouTubePlaylistId(mockYouTubeUploadsId("1"))).toBe(true);
    const videos = mockYouTubeVideos("1", "2026-10-20");
    expect(videos).toEqual(mockYouTubeVideos("1", "2026-10-20"));
    expect(videos).toHaveLength(MOCK_YT_LISTING_DAYS / MOCK_YT_UPLOAD_EVERY_DAYS);
    expect(videos.every((video) => isYouTubeVideoId(video.id))).toBe(true);
    expect(new Set(videos.map((video) => video.id)).size).toBe(videos.length);
    // A video keeps its id and snippet as days pass (anchored to the epoch); its lifetime
    // statistics grow.
    const later = mockYouTubeVideos("1", "2026-10-22").find((video) => video.id === videos[0]!.id);
    expect(later?.snippet).toEqual(videos[0]!.snippet);
    expect(Number(later?.statistics?.viewCount)).toBeGreaterThanOrEqual(
      Number(videos[0]!.statistics?.viewCount),
    );
  });
});

describe("mock YouTube provider", () => {
  it("serves the channel through the real mapping", async () => {
    const record = await createMockYouTubeSocialProvider().getAccount(ctx("1"), {
      accountExternalId: mockYouTubeChannelId("1"),
    });
    expect(record).toMatchObject({
      platform: "youtube",
      externalId: mockYouTubeChannelId("1"),
      username: "mock_1",
      name: "Mock 1 channel",
      accountType: "channel",
      status: "active",
    });
    expect(record.followersCount).toBe(Number(mockYouTubeChannel("1").statistics?.subscriberCount));
  });

  it("keeps a hidden subscriber count absent", async () => {
    const record = await createMockYouTubeSocialProvider().getAccount(ctx("hidden"), {
      accountExternalId: mockYouTubeChannelId("hidden"),
    });
    expect(record).not.toHaveProperty("followersCount");
  });

  it("lists every published upload once, newest first, and excludes upcoming premieres", async () => {
    const { posts, unresolved } = await allPosts("1");
    const videos = mockYouTubeVideos("1", "2026-10-20");
    const upcoming = videos.filter((v) => v.snippet?.liveBroadcastContent === "upcoming").length;
    expect(upcoming).toBeGreaterThan(0);
    expect(posts).toHaveLength(videos.length - upcoming);
    expect(unresolved).toBe(0);
    const times = posts.map((post) => post.publishedAt);
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(posts.some((post) => post.caption === undefined)).toBe(true);
  });

  it("covers a channel without uploads and an unresolved upload", async () => {
    expect(await allPosts("empty")).toEqual({ posts: [], unresolved: 0 });
    const edge = await allPosts("edge");
    expect(edge.unresolved).toBeGreaterThan(0);
  });

  it("fails closed like the live provider", async () => {
    const provider = createMockYouTubeSocialProvider();
    const revoked = await provider
      .getAccount(ctx("revoked", "revoked"), { accountExternalId: mockYouTubeChannelId("revoked") })
      .catch((e: unknown) => e);
    expect(isProviderError(revoked) && [revoked.kind, revoked.providerCode]).toEqual([
      "auth",
      "invalid_grant",
    ]);
    const foreign = await provider
      .getAccount(ctx("1"), { accountExternalId: mockYouTubeChannelId("2") })
      .catch((e: unknown) => e);
    expect(isProviderError(foreign) && foreign.kind).toBe("permission");
    const cursor = await provider
      .listPosts(ctx("1"), { accountExternalId: mockYouTubeChannelId("1"), cursor: "mockyt1.50.x" })
      .catch((e: unknown) => e);
    expect(isProviderError(cursor) && cursor.kind).toBe("invalid_request");
    const limited = await provider
      .fetchAccountMetrics(ctx("limited"), {
        accountExternalId: mockYouTubeChannelId("limited"),
        from: "2026-10-01",
        to: "2026-10-02",
      })
      .catch((e: unknown) => e);
    expect(isProviderError(limited) && [limited.kind, limited.providerCode]).toEqual([
      "permission",
      "analytics_scope_missing",
    ]);
  });

  it("snapshots in-window uploads through the real mapping; hidden counts stay absent", async () => {
    const provider = createMockYouTubeSocialProvider();
    const snapshots = [];
    let cursor: string | undefined;
    do {
      const page = await provider.fetchPostMetrics(ctx("1"), {
        accountExternalId: mockYouTubeChannelId("1"),
        publishedFrom: "2026-07-22",
        ...(cursor ? { cursor } : {}),
      });
      snapshots.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const window = mockYouTubeVideos("1", "2026-10-20").filter(
      (video) =>
        video.snippet?.liveBroadcastContent !== "upcoming" &&
        Date.parse(video.snippet!.publishedAt!) >= Date.parse("2026-07-22T00:00:00Z"),
    );
    expect(snapshots.map((s) => s.postExternalId)).toEqual(window.map((video) => video.id));
    expect(snapshots.every((s) => s.capturedDate === "2026-10-20")).toBe(true);
    expect(snapshots.some((s) => s.likes === undefined)).toBe(true);
    expect(snapshots.some((s) => s.comments === undefined)).toBe(true);
    expect(snapshots.some((s) => s.views === 0)).toBe(true); // published today: an explicit 0
  });

  it("serves day reports with days that report nothing and days of explicit zeros", async () => {
    const page = await createMockYouTubeSocialProvider().fetchAccountMetrics(ctx("1"), {
      accountExternalId: mockYouTubeChannelId("1"),
      from: "2026-09-17",
      to: "2026-10-17",
    });
    expect(page.items).toHaveLength(31);
    expect(page.items.some((day) => day.views === undefined && day.extras === undefined)).toBe(
      true,
    );
    expect(page.items.some((day) => day.views === 0)).toBe(true);
    expect(page.items.some((day) => (day.views ?? 0) > 0)).toBe(true);
    for (const day of page.items) expect(day).not.toHaveProperty("followerDelta");
    // Deterministic: the same window gives the same days.
    const again = await createMockYouTubeSocialProvider().fetchAccountMetrics(ctx("1"), {
      accountExternalId: mockYouTubeChannelId("1"),
      from: "2026-09-17",
      to: "2026-10-17",
    });
    expect(again).toEqual(page);
  });

  it("Checkpoint 8: serves deterministic per-video windows through the real mapping", async () => {
    const provider = createMockYouTubeSocialProvider();
    const channel = mockYouTubeChannelId("1");
    const window = (kind: "last28" | "lifetime", from: string) =>
      provider.fetchVideoAnalytics!(ctx("1"), {
        accountExternalId: channel,
        window: kind,
        from,
        to: "2026-10-17",
      });
    const last28 = await window("last28", "2026-09-20");
    const lifetime = await window("lifetime", "2026-04-01");
    expect(await window("last28", "2026-09-20")).toEqual(last28);
    expect(last28.nextCursor).toBeUndefined();
    expect(last28.items.length).toBeGreaterThan(0);
    // Older uploads keep getting views: every video of the window has a row in both, with more
    // lifetime views than recent ones when it was published before the recent window.
    const recentViews = new Map(last28.items.map((item) => [item.postExternalId, item.views!]));
    expect(lifetime.items.map((item) => item.postExternalId).sort()).toEqual(
      [...recentViews.keys()].sort(),
    );
    for (const item of lifetime.items) {
      expect(item.views!).toBeGreaterThanOrEqual(recentViews.get(item.postExternalId)!);
    }
    expect(lifetime.items.some((item) => item.views! > recentViews.get(item.postExternalId)!)).toBe(
      true,
    );
    for (const page of [last28, lifetime]) {
      expect(page.items.length).toBeLessThanOrEqual(200);
      // Most viewed first; every listed video is a published upload of the channel.
      const views = page.items.map((item) => item.views!);
      expect([...views].sort((a, b) => b - a)).toEqual(views);
    }
    const listed = new Set((await allPosts("1")).posts.map((post) => post.externalId));
    for (const item of lifetime.items) expect(listed.has(item.postExternalId)).toBe(true);
    expect(last28.items[0]).toMatchObject({
      platform: "youtube",
      accountExternalId: channel,
      window: "last28",
      from: "2026-09-20",
      to: "2026-10-17",
    });
    // Decimals for the average percentage, some above 100 (rewatches); integers elsewhere.
    expect(lifetime.items.some((item) => !Number.isInteger(item.averageViewPercentage))).toBe(true);
    expect(lifetime.items.some((item) => item.averageViewPercentage! > 100)).toBe(true);
    expect(lifetime.items.every((item) => Number.isInteger(item.estimatedMinutesWatched))).toBe(
      true,
    );
    // Videos newer than the window's last day have no row.
    const newest = (await allPosts("1")).posts[0]!;
    expect(last28.items.some((item) => item.postExternalId === newest.externalId)).toBe(false);
  });

  it("Checkpoint 8: no uploads, no rows; the limited user lacks the analytics grant", async () => {
    const provider = createMockYouTubeSocialProvider();
    const request = (user: string) => ({
      accountExternalId: mockYouTubeChannelId(user),
      window: "last28" as const,
      from: "2026-09-20",
      to: "2026-10-17",
    });
    expect((await provider.fetchVideoAnalytics!(ctx("empty"), request("empty"))).items).toEqual([]);
    const error = await provider.fetchVideoAnalytics!(ctx("limited"), request("limited")).catch(
      (e: unknown) => e,
    );
    expect(isProviderError(error) && [error.kind, error.providerCode]).toEqual([
      "permission",
      "analytics_scope_missing",
    ]);
  });
});
