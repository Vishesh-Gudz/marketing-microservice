/**
 * Organic analytics vocabulary (Phase 10 Stage B): metric names, reasons, states. Separate from
 * the ad analytics vocabulary (convex/analytics/aggregate.ts, coverage.ts), which is untouched.
 *
 * Account metrics (socialAccountMetricsDaily, UTC days):
 *   followers           snapshot (profile column group): latest capture, never summed over days
 *   followerDelta, views, totalInteractions, and the extras likes / comments / shares / saves /
 *   replies / profileLinksTaps: additive over days and accounts
 *   reach, accountsEngaged: non-additive (unique accounts): only for ONE account on ONE day
 * Post metrics (socialPostMetricSnapshots): lifetime values of one capture; never differenced.
 */

export const ORGANIC_ACCOUNT_METRICS = [
  "followers",
  "followerDelta",
  "reach",
  "views",
  "accountsEngaged",
  "totalInteractions",
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "profileLinksTaps",
] as const;
export type OrganicAccountMetric = (typeof ORGANIC_ACCOUNT_METRICS)[number];

/** Summed across accounts and days (only over rows that report them). */
export const ADDITIVE_ACCOUNT_METRICS = [
  "followerDelta",
  "views",
  "totalInteractions",
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "profileLinksTaps",
] as const satisfies readonly OrganicAccountMetric[];

/** Unique-account counts: available only for exactly one account and one UTC day (R13). */
export const NON_ADDITIVE_ACCOUNT_METRICS = [
  "reach",
  "accountsEngaged",
] as const satisfies readonly OrganicAccountMetric[];

/** Stored under `extras` (Instagram account insights without a canonical column). */
export const EXTRA_ACCOUNT_METRICS = [
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "profileLinksTaps",
] as const satisfies readonly OrganicAccountMetric[];

/** Canonical columns Instagram removed (F19): always unavailable, never rendered. */
export const DEPRECATED_ACCOUNT_METRICS = ["profileViews", "websiteClicks"] as const;

export const ORGANIC_POST_METRICS = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saves",
  "totalInteractions",
] as const;
export type OrganicPostMetric = (typeof ORGANIC_POST_METRICS)[number];
export const DEPRECATED_POST_METRICS = ["videoViews"] as const;

/** Every account metric name an unavailable entry may carry (incl. deprecated ones). */
export const ORGANIC_ACCOUNT_METRIC_NAMES = [
  ...ORGANIC_ACCOUNT_METRICS,
  ...DEPRECATED_ACCOUNT_METRICS,
] as const;
export type OrganicAccountMetricName = (typeof ORGANIC_ACCOUNT_METRIC_NAMES)[number];

export const ORGANIC_POST_METRIC_NAMES = [
  ...ORGANIC_POST_METRICS,
  ...DEPRECATED_POST_METRICS,
] as const;
export type OrganicPostMetricName = (typeof ORGANIC_POST_METRIC_NAMES)[number];

/**
 * Metric-level unavailable reasons (F13), in precedence order (R7): the first that applies
 * wins. `unsupported` is NOT a metric reason: it is the capability-level data state.
 */
export const ORGANIC_METRIC_REASONS = [
  "deprecated_metric",
  "non_additive",
  "below_follower_threshold",
  "not_reported",
] as const;
export type OrganicMetricReason = (typeof ORGANIC_METRIC_REASONS)[number];

/** The only organic KPI (F12): totalInteractions / reach, computed at query time. */
export const ORGANIC_KPIS = ["engagementRate"] as const;
export type OrganicKpi = (typeof ORGANIC_KPIS)[number];

/** Organic KPI reasons (R6); the ad KPI reason set is separate and unchanged. */
export const ORGANIC_KPI_REASONS = [
  "non_additive",
  "numerator_unavailable",
  "denominator_unavailable",
  "zero_denominator",
] as const;
export type OrganicKpiReason = (typeof ORGANIC_KPI_REASONS)[number];

/** Organic data states (F13): there is no "no_delivery" for organic data. */
export const ORGANIC_DATA_STATES = ["reported", "partial", "unknown", "unsupported"] as const;
export type OrganicDataState = (typeof ORGANIC_DATA_STATES)[number];

/** Organic comparison reasons (no currencies, so no mixed_currency). */
export const ORGANIC_DELTA_REASONS = ["previous_zero", "previous_unavailable"] as const;
export type OrganicDeltaReason = (typeof ORGANIC_DELTA_REASONS)[number];

/**
 * ADR 0016 (Checkpoint 4): the YouTube channel day values the sync stores, each under its own
 * YouTube Analytics name (`views` in the canonical column, the others in `extras`), keyed by
 * Pacific Time day. They mirror providers/youtube/semantics.ts ACCOUNT_REPORT_TARGETS (a test
 * keeps both equal). Exposed day by day only: never summed, averaged, compared or combined.
 * `averageViewDuration` is YouTube's own per-day value (seconds).
 */
export const YOUTUBE_DAY_METRICS = [
  "views",
  "likes",
  "comments",
  "shares",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "subscribersGained",
  "subscribersLost",
] as const;
export type YouTubeDayMetric = (typeof YOUTUBE_DAY_METRICS)[number];

/** YouTube video lifetime statistics (`videos.list` statistics, our UTC capture days). */
export const YOUTUBE_VIDEO_METRICS = ["views", "likes", "comments"] as const;
export type YouTubeVideoMetric = (typeof YOUTUBE_VIDEO_METRICS)[number];

/** [doc] YouTube Analytics reports Pacific Time days (ADR 0016, providers/youtube/semantics.ts). */
export const YOUTUBE_DAY_TIMEZONE = "America/Los_Angeles";

/**
 * [doc] follows_and_unfollows is "not returned if the IG User has less than 100 followers".
 * Behavior on a real account is [PROVISIONAL IR8].
 */
export const FOLLOWER_DELTA_THRESHOLD = 100;
