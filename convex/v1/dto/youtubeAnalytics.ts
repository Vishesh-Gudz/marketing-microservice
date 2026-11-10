import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import {
  YOUTUBE_DAY_METRICS,
  YOUTUBE_DAY_TIMEZONE,
  YOUTUBE_TOTAL_METRICS,
  YOUTUBE_TOTAL_REASONS,
  YOUTUBE_VIDEO_METRICS,
} from "../../analytics/organic/metrics";
import {
  youtubeVideoStatistics,
  type YouTubeAnalyticsAccess,
  type YouTubeDay,
  type YouTubeRangeTotals,
  type YouTubeVideoAnalyticsView,
  type YouTubeVideoWindowView,
} from "../../analytics/organic/youtube";
import { literalUnion } from "../../domain/validators";
import { toIso } from "../../lib/dto";
import { organicDateRangeDto } from "./organicAnalytics";
import { organicDataStateDto } from "./socialPost";

/**
 * YouTube analytics DTOs (ADR 0016, Checkpoints 4 and 8). Values are exactly what YouTube
 * reported, under YouTube's own names, for ONE channel. The only derived values are the
 * approved Checkpoint 8 range totals of that one channel (`channelDays.totals`); no
 * comparison, score or ranking is computed, per-video ratios are never aggregated, and nothing
 * is combined with another channel or platform. Unavailable values are omitted (never null,
 * never 0) and explained. No credential, token, scope string or connection internal is ever
 * included.
 */

const optionalNumber = v.optional(v.number());

export const youtubeDayMetricsDto = v.object({
  views: optionalNumber,
  likes: optionalNumber,
  comments: optionalNumber,
  shares: optionalNumber,
  estimatedMinutesWatched: optionalNumber,
  /** YouTube's own per-day average (seconds); never recomputed. */
  averageViewDuration: optionalNumber,
  subscribersGained: optionalNumber,
  subscribersLost: optionalNumber,
});

export const youtubeDayDto = v.object({
  /** A Pacific Time day (YYYY-MM-DD). */
  date: v.string(),
  /**
   * reported: values below; not_reported: synced, YouTube reported nothing for the day;
   * unknown: not synced (yet).
   */
  status: v.union(v.literal("reported"), v.literal("not_reported"), v.literal("unknown")),
  metrics: youtubeDayMetricsDto,
  /** Metrics a reported day lacks. */
  unavailableMetrics: v.array(
    v.object({ metric: literalUnion(YOUTUBE_DAY_METRICS), reason: v.literal("not_reported") }),
  ),
});

export const youtubeAnalyticsAccessValidator = v.union(
  v.literal("granted"),
  v.literal("scope_missing"),
  v.literal("reauth_required"),
  v.literal("not_linked"),
  v.literal("unknown"),
);

/**
 * Checkpoint 8: ONE channel's totals over the range's reported days (computed by us, approved):
 * counts summed over the days that report them; subscribersNet = subscribersGained -
 * subscribersLost over the days reporting both; averageViewDuration = estimatedMinutesWatched x
 * 60 / views over the days reporting both (whole seconds).
 */
export const youtubeRangeTotalsDto = v.object({
  /** Days of the range with status "reported": the only days the totals cover. */
  reportedDays: v.number(),
  metrics: v.object({
    views: optionalNumber,
    estimatedMinutesWatched: optionalNumber,
    likes: optionalNumber,
    comments: optionalNumber,
    shares: optionalNumber,
    subscribersGained: optionalNumber,
    subscribersLost: optionalNumber,
    /** May be negative. */
    subscribersNet: optionalNumber,
    /** Seconds per view (whole seconds). */
    averageViewDuration: optionalNumber,
  }),
  /**
   * Totals the range does not have: not_reported (no reported day carries the value(s));
   * zero_views (averageViewDuration only: the views of those days add up to 0).
   */
  unavailableMetrics: v.array(
    v.object({
      metric: literalUnion(YOUTUBE_TOTAL_METRICS),
      reason: literalUnion(YOUTUBE_TOTAL_REASONS),
    }),
  ),
});
export type YouTubeRangeTotalsDto = Infer<typeof youtubeRangeTotalsDto>;

export const youtubeChannelDaysDto = v.object({
  /** YouTube Analytics days are Pacific Time days (not UTC like the Instagram metrics). */
  timezone: v.literal(YOUTUBE_DAY_TIMEZONE),
  accountId: v.string(),
  range: organicDateRangeDto,
  /** reported: every day of the range synced; partial: some; unknown: none. */
  dataState: organicDataStateDto,
  /** YouTube needs about this many days before a day's values exist; newer days stay unknown. */
  reportingDelayDays: v.number(),
  /** Checkpoint 8: the range totals of this channel's reported days. */
  totals: youtubeRangeTotalsDto,
  /**
   * Checkpoint 8: the channel's current subscriber count (YouTube rounds it to three significant
   * figures) and when the sync captured it; absent when the channel hides it or it was never
   * captured. Not a day value.
   */
  subscribers: v.optional(v.object({ count: v.number(), capturedAt: v.string() })),
  /**
   * granted; scope_missing (yt-analytics.readonly was not granted: no day values until the
   * channel is reconnected with it); reauth_required; not_linked (history only); unknown.
   */
  analyticsAccess: youtubeAnalyticsAccessValidator,
  coverage: v.object({
    /** Days of the range synced (reported or not reported), and the others. */
    syncedDays: v.number(),
    unsyncedDays: v.number(),
    /** Pacific Time days the sync has completely covered for this channel. */
    covered: v.optional(v.object({ from: v.string(), through: v.string() })),
    lastSyncedAt: v.optional(v.string()),
  }),
  /** One entry per day of the range, oldest first. */
  days: v.array(youtubeDayDto),
});
export type YouTubeChannelDaysDto = Infer<typeof youtubeChannelDaysDto>;

export const youtubeVideoStatisticsDto = v.object({
  /** OUR capture day (UTC), not a YouTube Analytics day. */
  capturedDate: v.string(),
  capturedAt: v.string(),
  /** reported: every statistic returned; partial: some hidden or disabled by the owner. */
  dataState: organicDataStateDto,
  /** Lifetime counts as of the capture (`videos.list` statistics). */
  metrics: v.object({ views: optionalNumber, likes: optionalNumber, comments: optionalNumber }),
  unavailableMetrics: v.array(
    v.object({ metric: literalUnion(YOUTUBE_VIDEO_METRICS), reason: v.literal("not_reported") }),
  ),
});
export type YouTubeVideoStatisticsDto = Infer<typeof youtubeVideoStatisticsDto>;

/** Checkpoint 8: one video's values in one window of YouTube's per-video report. */
export const youtubeVideoWindowDto = v.object({
  /**
   * reported: YouTube listed the video among the window's top 200 by views (metrics below);
   * not_in_top: the window was synced for the channel but the video is not in its top 200 (no
   * metrics; never 0).
   */
  status: v.union(v.literal("reported"), v.literal("not_in_top")),
  /** Inclusive Pacific Time days of the window. */
  from: v.string(),
  to: v.string(),
  syncedAt: v.string(),
  metrics: v.object({
    views: optionalNumber,
    estimatedMinutesWatched: optionalNumber,
    /** YouTube's own value for this video and window (seconds). */
    averageViewDuration: optionalNumber,
    /** YouTube's own value for this video and window (percent; may exceed 100 on rewatches). */
    averageViewPercentage: optionalNumber,
    likes: optionalNumber,
    comments: optionalNumber,
    shares: optionalNumber,
    subscribersGained: optionalNumber,
    subscribersLost: optionalNumber,
  }),
});
export type YouTubeVideoWindowDto = Infer<typeof youtubeVideoWindowDto>;

/**
 * Checkpoint 8: the video's windows. last28 = the 28 Pacific Time days ending at the reporting
 * delay; lifetime = from the channel's oldest stored upload to the same day. A window is
 * absent when it was never synced for the channel or the video is newer than its last day.
 */
export const youtubeVideoAnalyticsDto = v.object({
  last28: v.optional(youtubeVideoWindowDto),
  lifetime: v.optional(youtubeVideoWindowDto),
});
export type YouTubeVideoAnalyticsDto = Infer<typeof youtubeVideoAnalyticsDto>;

const youtubeVideoFields = {
  id: v.string(),
  socialAccountId: v.string(),
  /** The YouTube video id. */
  videoId: v.string(),
  /** At most 100 characters. */
  title: v.optional(v.string()),
  /** The validated https://www.youtube.com/watch?v=<id> link: the only URL. */
  permalink: v.optional(v.string()),
  publishedAt: v.string(),
  /** No longer listed by YouTube (bounded removal); YouTube does not tell us why. */
  removedAt: v.optional(v.string()),
  /** The latest capture's data state; unknown when never captured. */
  dataState: organicDataStateDto,
  latest: v.optional(youtubeVideoStatisticsDto),
  /** Checkpoint 8: per-video analytics windows (YouTube Analytics, Pacific Time days). */
  analytics: youtubeVideoAnalyticsDto,
};

export const youtubeVideoDto = v.object(youtubeVideoFields);
export type YouTubeVideoDto = Infer<typeof youtubeVideoDto>;

export const youtubeVideoDetailDto = v.object({
  ...youtubeVideoFields,
  /** Capture days (UTC) of `captures` when a range was requested. */
  captureRange: v.optional(organicDateRangeDto),
  /** Lifetime captures, oldest first (never differenced into per-day values). */
  captures: v.array(youtubeVideoStatisticsDto),
});
export type YouTubeVideoDetailDto = Infer<typeof youtubeVideoDetailDto>;

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

export function toYouTubeRangeTotalsDto(totals: YouTubeRangeTotals): YouTubeRangeTotalsDto {
  return {
    reportedDays: totals.reportedDays,
    metrics: totals.values,
    unavailableMetrics: totals.unavailableMetrics,
  };
}

export function toYouTubeChannelDaysDto(result: {
  account: Doc<"socialAccounts">;
  range: { from: string; to: string };
  dataState: YouTubeChannelDaysDto["dataState"];
  reportingDelayDays: number;
  totals: YouTubeRangeTotals;
  subscribers?: { count: number; capturedAt: number };
  analyticsAccess: YouTubeAnalyticsAccess;
  coverage: {
    syncedDays: number;
    unsyncedDays: number;
    covered?: { from: string; through: string };
    lastSyncedAt?: number;
  };
  days: YouTubeDay[];
}): YouTubeChannelDaysDto {
  const { lastSyncedAt, ...coverage } = result.coverage;
  return {
    timezone: YOUTUBE_DAY_TIMEZONE,
    accountId: result.account._id,
    range: result.range,
    dataState: result.dataState,
    reportingDelayDays: result.reportingDelayDays,
    totals: toYouTubeRangeTotalsDto(result.totals),
    ...(result.subscribers !== undefined
      ? {
          subscribers: {
            count: result.subscribers.count,
            capturedAt: toIso(result.subscribers.capturedAt),
          },
        }
      : {}),
    analyticsAccess: result.analyticsAccess,
    coverage: {
      ...coverage,
      ...(lastSyncedAt !== undefined ? { lastSyncedAt: toIso(lastSyncedAt) } : {}),
    },
    days: result.days.map((day) => ({
      date: day.date,
      status: day.status,
      metrics: day.values,
      unavailableMetrics: day.unavailableMetrics,
    })),
  };
}

export function toYouTubeVideoStatisticsDto(
  snapshot: Doc<"socialPostMetricSnapshots">,
): YouTubeVideoStatisticsDto {
  const statistics = youtubeVideoStatistics(snapshot);
  return {
    capturedDate: snapshot.capturedDate,
    capturedAt: toIso(snapshot.capturedAt),
    dataState: statistics.dataState,
    metrics: statistics.values,
    unavailableMetrics: statistics.unavailableMetrics,
  };
}

function toYouTubeVideoWindowDto(window: YouTubeVideoWindowView): YouTubeVideoWindowDto {
  return {
    status: window.status,
    from: window.from,
    to: window.to,
    syncedAt: toIso(window.syncedAt),
    metrics: window.values,
  };
}

export function toYouTubeVideoAnalyticsDto(
  analytics: YouTubeVideoAnalyticsView,
): YouTubeVideoAnalyticsDto {
  return {
    ...(analytics.last28 !== undefined
      ? { last28: toYouTubeVideoWindowDto(analytics.last28) }
      : {}),
    ...(analytics.lifetime !== undefined
      ? { lifetime: toYouTubeVideoWindowDto(analytics.lifetime) }
      : {}),
  };
}

export function toYouTubeVideoDto(view: {
  post: Doc<"socialPosts">;
  latest: Doc<"socialPostMetricSnapshots"> | null;
  analytics: YouTubeVideoAnalyticsView;
}): YouTubeVideoDto {
  const { post } = view;
  const latest = view.latest === null ? undefined : toYouTubeVideoStatisticsDto(view.latest);
  return {
    id: post._id,
    socialAccountId: post.socialAccountId,
    videoId: post.externalId,
    ...(post.caption !== undefined ? { title: post.caption } : {}),
    ...(post.permalink !== undefined ? { permalink: post.permalink } : {}),
    publishedAt: toIso(post.publishedAt),
    ...(post.removedAt !== undefined ? { removedAt: toIso(post.removedAt) } : {}),
    dataState: latest?.dataState ?? "unknown",
    ...(latest !== undefined ? { latest } : {}),
    analytics: toYouTubeVideoAnalyticsDto(view.analytics),
  };
}

export function toYouTubeVideoDetailDto(view: {
  post: Doc<"socialPosts">;
  latest: Doc<"socialPostMetricSnapshots"> | null;
  snapshots: Doc<"socialPostMetricSnapshots">[];
  analytics: YouTubeVideoAnalyticsView;
  range?: { from: string; to: string };
}): YouTubeVideoDetailDto {
  return {
    ...toYouTubeVideoDto(view),
    ...(view.range !== undefined ? { captureRange: view.range } : {}),
    captures: view.snapshots.map(toYouTubeVideoStatisticsDto),
  };
}
