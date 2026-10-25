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
 * Checkpoint 1 covers channel and video METADATA only; no metric is read or stored yet.
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
