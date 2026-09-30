import type { SocialAccountMetricKey, SocialPostMetricKey } from "../../domain/metrics";

/**
 * Instagram organic semantics (Phase 10 Stage B): THE table of what the Instagram provider
 * requests and how every value lands in the canonical social tables. Tags:
 *   [doc]              documented by Meta (docs/providers/instagram.md)
 *   [PROVISIONAL IRn]  not verified against a real Instagram account (IR list, same doc)
 *   [Fn] / [Rn]        approved Phase 10 Stage B decisions
 * No value here was observed on a real account. The transport allowlist (transport.ts) is
 * checked independently: everything requested here must also pass it (semantics.test.ts).
 */

// ---------------------------------------------------------------------------
// Media (posts)
// ---------------------------------------------------------------------------

/**
 * Media never ingested (not stored, not counted, never sent an insights request):
 * - AD    [F20] paid/ad media; organic data stays separate from Meta Ads
 * - STORY [I-D14] stories are out of scope
 * [PROVISIONAL IR23] whether either appears on /{ig-id}/media at all.
 */
export const EXCLUDED_MEDIA_PRODUCT_TYPES: ReadonlySet<string> = new Set(["AD", "STORY"]);

/**
 * [R3] A media item without media_product_type cannot be proven organic: it is not ingested
 * and is counted as unresolved (the listing is then incomplete: no removal marking).
 * [PROVISIONAL IR3] that Instagram Login returns media_product_type at all.
 */
export const MEDIA_PRODUCT_TYPE_REQUIRED = true;

/** [doc] media_product_type REELS -> reel; otherwise media_type decides. */
export const REELS_PRODUCT_TYPE = "REELS";
export const MEDIA_TYPE_POST_TYPES = {
  CAROUSEL_ALBUM: "carousel",
  IMAGE: "image",
  VIDEO: "video",
} as const;
/** Any other (feed) value maps to "other". */
export const OTHER_POST_TYPE = "other";

/** [F21] Captions are kept, capped at 2,200 characters (Instagram's caption limit). */
export const CAPTION_MAX_CHARS = 2_200;

/**
 * [F1, R1b] The permalink is the ONLY URL ever stored, and only when it is a valid https URL
 * on instagram.com / www.instagram.com, without user info, at most 2,048 characters.
 * [PROVISIONAL IR25] the exact permalink format.
 */
export const PERMALINK_HOSTS: ReadonlySet<string> = new Set(["instagram.com", "www.instagram.com"]);
export const PERMALINK_MAX_LENGTH = 2_048;

/** The normalized permalink, or undefined when it may not be stored (R1b). */
export function allowedPermalink(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > PERMALINK_MAX_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  if (url.username !== "" || url.password !== "") return undefined;
  // `host` includes a non-default port, which is therefore refused too.
  if (!PERMALINK_HOSTS.has(url.host)) return undefined;
  const href = url.href;
  return href.length <= PERMALINK_MAX_LENGTH ? href : undefined;
}

// ---------------------------------------------------------------------------
// Post (media) lifetime metrics: 3 requests per post [approved I-D6 budget]
// ---------------------------------------------------------------------------

/** [SDK][doc] social-sdk reads these lifetime metrics (2 requests: type + insights). */
export const SDK_POST_METRIC_COLUMNS = {
  likes: "likes",
  comments: "comments",
  saved: "saves",
  shares: "shares",
  reach: "reach",
} as const satisfies Record<string, SocialPostMetricKey>;

/**
 * [doc] The Graph reader reads these (1 request, period=lifetime; Meta fixes media insights
 * to lifetime). [PROVISIONAL IR10] `views` parity with the Instagram app.
 */
export const READER_POST_METRIC_COLUMNS = {
  views: "views",
  total_interactions: "totalInteractions",
} as const satisfies Record<string, SocialPostMetricKey>;

export const READER_POST_METRICS = Object.keys(READER_POST_METRIC_COLUMNS);

/** The canonical post metric columns the Instagram provider fills (capabilities). */
export const INSTAGRAM_POST_METRICS: readonly SocialPostMetricKey[] = [
  ...Object.values(SDK_POST_METRIC_COLUMNS),
  ...Object.values(READER_POST_METRIC_COLUMNS),
];

// ---------------------------------------------------------------------------
// Account daily insights: 2 requests per UTC day [F2, F3]
// ---------------------------------------------------------------------------

type AccountTarget = { column: SocialAccountMetricKey } | { extra: string };

/**
 * [doc][F2] Request A of a UTC day: period=day, metric_type=total_value. Every value is the
 * day's total. [F4] profile_links_taps -> extras.profileLinksTaps (never websiteClicks).
 * [R2] reposts is not requested. [PROVISIONAL IR20] views / comments are "in development".
 */
export const ACCOUNT_INSIGHT_TARGETS = {
  reach: { column: "reach" },
  views: { column: "views" },
  accounts_engaged: { column: "accountsEngaged" },
  total_interactions: { column: "totalInteractions" },
  likes: { extra: "likes" },
  comments: { extra: "comments" },
  shares: { extra: "shares" },
  saves: { extra: "saves" },
  replies: { extra: "replies" },
  profile_links_taps: { extra: "profileLinksTaps" },
} as const satisfies Record<string, AccountTarget>;

export const ACCOUNT_INSIGHT_METRICS = Object.keys(ACCOUNT_INSIGHT_TARGETS);

/**
 * [doc][F3] Request B of a UTC day: follows_and_unfollows with breakdown=follow_type. The
 * documented follow_type values are FOLLOWER, NON_FOLLOWER and UNKNOWN; reading FOLLOWER as
 * follows and NON_FOLLOWER as unfollows is [PROVISIONAL IR8], as is the behavior under 100
 * followers ([doc] "Not returned if the IG User has less than 100 followers").
 * followerDelta = follows - unfollows, only when BOTH are reported and no other value is
 * non-zero; otherwise it stays absent (never derived from one side, never zero-filled).
 */
export const FOLLOWS_METRIC = "follows_and_unfollows";
export const FOLLOW_TYPE_BREAKDOWN = "follow_type";
export const FOLLOW_TYPE_FOLLOWS = "FOLLOWER";
export const FOLLOW_TYPE_UNFOLLOWS = "NON_FOLLOWER";

/** Canonical account columns fetchAccountMetrics fills (the insights column group). */
export const INSTAGRAM_ACCOUNT_METRICS: readonly SocialAccountMetricKey[] = [
  "followerDelta",
  ...Object.values(ACCOUNT_INSIGHT_TARGETS).flatMap((t) => ("column" in t ? [t.column] : [])),
];

/** Account insights requested per UTC day (request A + request B). */
export const ACCOUNT_REQUESTS_PER_DAY = 2;
/** Days per fetchAccountMetrics provider call: 15 x 2 = 30 requests <= 31 per call. */
export const ACCOUNT_DAYS_PER_CALL = 15;

// ---------------------------------------------------------------------------
// Never requested, never mapped
// ---------------------------------------------------------------------------

/**
 * Metrics the provider never requests (enforced again by the transport allowlist):
 * - deprecated [doc]: impressions, plays, video_views, profile_views, website_clicks
 * - ad-inclusive [F6]: total_likes, total_comments, total_views (and any other total_*)
 * - [F5, R2] reposts, profile_visits, follows, profile_activity
 * - not in scope: facebook_views, crossposted_views, ig_reels_* (deferred)
 * Canonical columns never written: videoViews (post), profileViews / websiteClicks (account).
 */
export const NEVER_REQUESTED_METRICS: readonly string[] = [
  "impressions",
  "plays",
  "video_views",
  "profile_views",
  "website_clicks",
  "total_likes",
  "total_comments",
  "total_views",
  "reposts",
  "profile_visits",
  "follows",
  "profile_activity",
  "facebook_views",
  "crossposted_views",
  "ig_reels_avg_watch_time",
  "ig_reels_video_view_total_time",
  "reels_skip_rate",
];
