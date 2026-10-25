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
    // A video keeps its id as days pass (anchored to the epoch).
    expect(mockYouTubeVideos("1", "2026-10-22")).toContainEqual(videos[0]);
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
    const metrics = await provider
      .fetchPostMetrics(ctx("1"), {
        accountExternalId: mockYouTubeChannelId("1"),
        publishedFrom: "2026-07-01",
      })
      .catch((e: unknown) => e);
    expect(isProviderError(metrics) && metrics.kind).toBe("unsupported");
  });
});
