/**
 * YouTube organic provider configuration (ADR 0016, docs/providers/youtube.md). SDK-free and
 * runtime-free: safe in the default Convex runtime and in Node.
 *
 * Values come from Convex env (YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET, a Google OAuth web
 * client of its own Google Cloud project, Y-D3); construction never throws, problems surface
 * per call as ProviderError "unknown" / youtube_config_invalid (never "auth": an env mistake
 * must stay reversible and must not push every YouTube connection into needs_reauth).
 * No client id or secret is ever logged or put in a URL or an error.
 */

export {
  isValidGoogleClientId as isValidYouTubeClientId,
  isValidGoogleClientSecret as isValidYouTubeClientSecret,
  OAUTH_TOKEN_URL,
} from "../google/config";

/** YouTube Data API v3 [doc]. The Analytics API (youtubeanalytics.googleapis.com) is Checkpoint 3. */
export const YOUTUBE_DATA_HOST = "www.googleapis.com";
export const YOUTUBE_DATA_BASE = `https://${YOUTUBE_DATA_HOST}/youtube/v3`;

/** Run metadata only (syncRuns.providerId); never part of an identity key. */
export const YOUTUBE_PROVIDER_ID = "youtube-data-api/v3";

export const YOUTUBE_CONFIG_INVALID = "youtube_config_invalid";

/** Sync calls stay well under the 5-minute task lease. */
export const SYNC_TIMEOUT_MS = 60_000;

/**
 * [doc] Channel ids are "UC" + 22 characters of the URL-safe alphabet, video ids are 11
 * characters of it. [PROVISIONAL YR1] observed on a real channel.
 */
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
/**
 * Playlist ids (the uploads playlist): the format is not documented, so only the alphabet and
 * a length bound are checked. [PROVISIONAL YR2]
 */
const PLAYLIST_ID = /^[A-Za-z0-9_-]{2,64}$/;

export function isYouTubeChannelId(value: unknown): value is string {
  return typeof value === "string" && CHANNEL_ID.test(value);
}

export function isYouTubeVideoId(value: unknown): value is string {
  return typeof value === "string" && VIDEO_ID.test(value);
}

export function isYouTubePlaylistId(value: unknown): value is string {
  return typeof value === "string" && PLAYLIST_ID.test(value);
}

/** YouTube counts as configured when any of its env values is present (as for Google Ads). */
export function youtubeConfigured(env: Record<string, string | undefined>): boolean {
  return ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET"].some((name) => (env[name] ?? "") !== "");
}
