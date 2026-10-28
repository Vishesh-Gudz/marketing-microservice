import type { SocialAccount } from "@/lib/analytics/organic-types";
import type {
  YouTubeChannelDays,
  YouTubeDay,
  YouTubeVideo,
  YouTubeVideoStatistics,
} from "@/lib/analytics/youtube-types";

// DTO-shaped YouTube test data for dashboard component tests (ADR 0016, Checkpoint 5).
// TEST-ONLY: typed from the public v1 return types, never used by the app.

export const CHANNEL_ID = "acct_yt_1";
export const CHANNEL_ID_2 = "acct_yt_2";
export const YT_CONNECTION_ID = "conn_yt_1";

export function youtubeChannel(overrides: Partial<SocialAccount> = {}): SocialAccount {
  return {
    id: CHANNEL_ID,
    platform: "youtube",
    externalId: "UCfakeChannel0000000000a",
    username: "fakebrand",
    name: "Fake Brand",
    accountType: "channel",
    status: "active",
    linked: true,
    connectionId: YT_CONNECTION_ID,
    linkedAt: "2026-10-01T00:00:00.000Z",
    followersCount: 12_300,
    lastSyncedAt: "2026-10-20T12:00:00.000Z",
    coverage: { from: "2026-09-18", through: "2026-10-17" },
    ...overrides,
  };
}

export function youtubeDay(date: string, overrides: Partial<YouTubeDay> = {}): YouTubeDay {
  return {
    date,
    status: "reported",
    metrics: {
      views: 1_200,
      likes: 0,
      comments: 4,
      shares: 2,
      estimatedMinutesWatched: 3_456,
      averageViewDuration: 83,
      subscribersGained: 5,
      subscribersLost: 1,
    },
    unavailableMetrics: [],
    ...overrides,
  };
}

export function channelDays(overrides: Partial<YouTubeChannelDays> = {}): YouTubeChannelDays {
  return {
    timezone: "America/Los_Angeles",
    accountId: CHANNEL_ID,
    range: { from: "2026-10-15", to: "2026-10-17" },
    dataState: "reported",
    reportingDelayDays: 3,
    analyticsAccess: "granted",
    coverage: {
      syncedDays: 3,
      unsyncedDays: 0,
      covered: { from: "2026-09-18", through: "2026-10-17" },
      lastSyncedAt: "2026-10-20T12:00:00.000Z",
    },
    days: [youtubeDay("2026-10-15"), youtubeDay("2026-10-16"), youtubeDay("2026-10-17")],
    ...overrides,
  };
}

export function videoStatistics(
  overrides: Partial<YouTubeVideoStatistics> = {},
): YouTubeVideoStatistics {
  return {
    capturedDate: "2026-10-20",
    capturedAt: "2026-10-20T12:00:00.000Z",
    dataState: "reported",
    metrics: { views: 9_876, likes: 321, comments: 12 },
    unavailableMetrics: [],
    ...overrides,
  };
}

export function youtubeVideo(overrides: Partial<YouTubeVideo> = {}): YouTubeVideo {
  return {
    id: "post_yt_1",
    socialAccountId: CHANNEL_ID,
    videoId: "vid00000000",
    title: "Launch video",
    permalink: "https://www.youtube.com/watch?v=vid00000000",
    publishedAt: "2026-10-19T10:00:00.000Z",
    dataState: "reported",
    latest: videoStatistics(),
    ...overrides,
  };
}
