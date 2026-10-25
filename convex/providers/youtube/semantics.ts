import type { SocialAccountMetricKey, SocialPostMetricKey } from "../../domain/metrics";
import type { SocialPostType } from "../../domain/types";

/**
 * YouTube organic semantics (ADR 0016): THE table of what the YouTube provider reads and how
 * every value lands in the canonical social tables. Tags:
 *   [doc]              documented by Google (docs/providers/youtube.md)
 *   [PROVISIONAL YRn]  not verified against a real YouTube channel (YR list, same doc)
 *   [Y-Dn]             approved decisions of the Checkpoint 0 plan
 * No value here was observed on a real channel. The client allowlist (client.ts) is checked
 * independently: everything requested here must also pass it (semantics.test.ts).
 *
 * Policy (YouTube API Services Developer Policies III.E.4.h, Checkpoint 3 review): ONLY values
 * YouTube reports are stored, under their own meaning; nothing here is calculated (no net
 * subscriber change, no ratio, no average of ours, no estimate). How stored values may be
 * aggregated or compared is an open compliance question for Checkpoint 4 (ADR 0016).
 */

// ---------------------------------------------------------------------------
// Channel (sync preflight)
// ---------------------------------------------------------------------------

/** [Y-D2] Every YouTube account is a channel. */
export const CHANNEL_ACCOUNT_TYPE = "channel";

/**
 * [doc] `snippet.customUrl` is the channel's custom URL; current channels show their handle
 * there ("@name"). Only a value with the leading "@" is kept, without it, as the username.
 * Handles are 3–30 letters, digits, underscores, hyphens or periods (any script).
 * [PROVISIONAL YR5] customUrl carries the handle; legacy custom URLs are not handles.
 */
export const HANDLE_PREFIX = "@";
export const HANDLE = /^[\p{L}\p{N}_.-]{3,30}$/u;

/**
 * [doc] `statistics.subscriberCount` is rounded down to three significant figures, and is
 * not shown when `hiddenSubscriberCount` is true: then followersCount stays ABSENT.
 */
export const SUBSCRIBER_COUNT_ROUNDED = true;

/** [Y-D9] Channel thumbnails, banners, descriptions and keywords are never read or stored. */

// ---------------------------------------------------------------------------
// Videos (posts)
// ---------------------------------------------------------------------------

/** [doc][Y-D9] The Data API has no field that identifies a Short: every upload is a video. */
export const VIDEO_POST_TYPE: SocialPostType = "video";

/**
 * [doc] `snippet.liveBroadcastContent`: "none" (a regular video) and "live" (live now) are
 * published uploads; "upcoming" (a scheduled live stream or premiere) is not published yet and
 * is excluded (not stored, not counted). Any other value is unresolved.
 */
export const PUBLISHED_BROADCAST_CONTENT: ReadonlySet<string> = new Set(["none", "live"]);
export const EXCLUDED_BROADCAST_CONTENT: ReadonlySet<string> = new Set(["upcoming"]);

/**
 * [Y-D9] Public, unlisted and private uploads are all ingested (the owner's own data); the
 * privacy status is neither requested nor stored. [doc] the uploads playlist of an owner
 * "may also contain private videos"; [PROVISIONAL YR6] unlisted ones too.
 */
export const PRIVACY_STATUS_STORED = false;

/**
 * [doc] Titles have at most 100 characters; the title is stored as the caption (code points,
 * never a split surrogate pair). Descriptions, tags and thumbnails are never stored.
 */
export const TITLE_MAX_CHARS = 100;

/**
 * [Y-D9] The permalink is built from the video id; it is the only URL ever stored, in exactly
 * this form.
 */
const PERMALINK = /^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/;

export function youtubePermalink(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function isAllowedYouTubePermalink(value: unknown): value is string {
  return typeof value === "string" && PERMALINK.test(value);
}

// ---------------------------------------------------------------------------
// Request shape
// ---------------------------------------------------------------------------

/**
 * Listing: the channel's uploads playlist (`contentDetails.relatedPlaylists.uploads`, read by
 * the first page) through `playlistItems.list` (50 per page [doc]; newest first
 * [PROVISIONAL YR7], which the incremental listing's early stop relies on), then
 * `videos.list` for those ids (one request): 3 requests on the first page (channel, items,
 * videos), 2 on every later page, plus 1 token request per provider call.
 */
export const LISTING_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------
// Video lifetime statistics (fetchPostMetrics, Checkpoint 3)
// ---------------------------------------------------------------------------

/**
 * [doc] `videos.list` part `statistics`: lifetime counts as of now (uint64 strings). A count the
 * owner hides or disables (likes, comments) is simply absent and stays ABSENT, never 0.
 * `favoriteCount` (deprecated, always 0) and `dislikeCount` are never read.
 */
export const VIDEO_STATISTICS_COLUMNS = {
  viewCount: "views",
  likeCount: "likes",
  commentCount: "comments",
} as const satisfies Record<string, SocialPostMetricKey>;

/** The canonical post metric columns the YouTube provider fills (capabilities). */
export const YOUTUBE_POST_METRICS: readonly SocialPostMetricKey[] =
  Object.values(VIDEO_STATISTICS_COLUMNS);

/** [Y-D8] Uploads published within this many UTC days get a daily lifetime snapshot. */
export const POST_SNAPSHOT_WINDOW_DAYS = 90;

// ---------------------------------------------------------------------------
// Channel daily report (fetchAccountMetrics, Checkpoint 3)
// ---------------------------------------------------------------------------

/**
 * [doc] One `reports.query` per window: `ids=channel==MINE` (the channel of the consent; the
 * provider has already checked it is the requested one), `dimensions=day`, these core
 * metrics, which the channel "Time-based" report accepts together. Each value lands under its
 * OWN YouTube name: `views` in the canonical column, the rest in `extras`.
 * - `averageViewDuration` is YouTube's own per-day value (seconds); it is not additive and is
 *   never recomputed by us.
 * - Never requested: `dislikes`, `engagedViews`, `averageViewPercentage` (a ratio),
 *   `videosAddedToPlaylists`, revenue, demographics, traffic sources.
 * - Never stored: `followerDelta` (gained minus lost would be our calculation), reach,
 *   accounts engaged, total interactions.
 * [PROVISIONAL YR13] whether YouTube returns rows for days without activity.
 */
export const REPORT_IDS = "channel==MINE";
export const REPORT_DIMENSION = "day";

type ReportTarget = { column: SocialAccountMetricKey } | { extra: string };

export const ACCOUNT_REPORT_TARGETS = {
  views: { column: "views" },
  likes: { extra: "likes" },
  comments: { extra: "comments" },
  shares: { extra: "shares" },
  estimatedMinutesWatched: { extra: "estimatedMinutesWatched" },
  averageViewDuration: { extra: "averageViewDuration" },
  subscribersGained: { extra: "subscribersGained" },
  subscribersLost: { extra: "subscribersLost" },
} as const satisfies Record<string, ReportTarget>;

/** The exact `metrics` parameter (the allowlist accepts only this string). */
export const ACCOUNT_REPORT_METRICS = Object.keys(ACCOUNT_REPORT_TARGETS).join(",");

/** The canonical account metric columns the YouTube provider fills (capabilities). */
export const YOUTUBE_ACCOUNT_METRICS: readonly SocialAccountMetricKey[] = ["views"];

/**
 * [doc] "Data processing typically introduces a latency of 48 to 72 hours", and `endDate` is
 * cut back to the last fully processed day: account-metric windows end 3 days before today
 * (accountMetricsDelayDays), so lagging days stay unknown rather than "not reported".
 */
export const ACCOUNT_METRICS_DELAY_DAYS = 3;

/**
 * [doc] Analytics days are Pacific Time days ("12:00AM Pacific time (UTC-7 or UTC-8)"; DST days
 * have 23 or 25 hours). The provider passes the requested date keys through unchanged and stores
 * YouTube's day under the same key: a day is never converted to or from an instant.
 */
export const REPORT_DAY_BASIS = "America/Los_Angeles";
