import {
  isValidGoogleClientId as isValidYouTubeClientId,
  isValidGoogleClientSecret as isValidYouTubeClientSecret,
} from "../google/config";

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

export { isValidYouTubeClientId, isValidYouTubeClientSecret };
export { AUTHORIZE_URL, OAUTH_TOKEN_URL } from "../google/config";

/**
 * [doc] Google's token revocation endpoint. The token travels in the form body only (the
 * documented `?token=` query form is never used: no secret in a URL). [PROVISIONAL YR11]
 */
export const OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/** YouTube Data API v3 [doc]. */
export const YOUTUBE_DATA_HOST = "www.googleapis.com";
export const YOUTUBE_DATA_BASE = `https://${YOUTUBE_DATA_HOST}/youtube/v3`;
/** YouTube Analytics API v2 [doc] (`reports.query`). */
export const YOUTUBE_ANALYTICS_BASE = "https://youtubeanalytics.googleapis.com/v2";

/** Run metadata only (syncRuns.providerId); never part of an identity key. */
export const YOUTUBE_PROVIDER_ID = "youtube-data-api/v3";

export const YOUTUBE_CONFIG_INVALID = "youtube_config_invalid";

/** Sync calls stay well under the 5-minute task lease. */
export const SYNC_TIMEOUT_MS = 60_000;
/** OAuth, discovery and revocation run inside the OAuth callback and connection actions. */
export const OAUTH_TIMEOUT_MS = 15_000;

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

/**
 * The YouTube OAuth app settings. `googleAdsClientId` (GOOGLE_CLIENT_ID) is read ONLY to refuse
 * a client shared with Google Ads (Y-D3): Google documents that revocation "removes all OAuth
 * 2.0 scopes previously granted to a project", so a YouTube disconnect through a shared client
 * could revoke a Google Ads grant.
 */
export type YouTubeAppConfig = {
  clientId?: string;
  clientSecret?: string;
  googleAdsClientId?: string;
};

/** The settings from Convex env (only the values that are set). */
export function youtubeAppConfig(env: Record<string, string | undefined>): YouTubeAppConfig {
  const value = (name: string) =>
    env[name] !== undefined && env[name] !== "" ? env[name] : undefined;
  const clientId = value("YOUTUBE_CLIENT_ID");
  const clientSecret = value("YOUTUBE_CLIENT_SECRET");
  const googleAdsClientId = value("GOOGLE_CLIENT_ID");
  return {
    ...(clientId !== undefined ? { clientId } : {}),
    ...(clientSecret !== undefined ? { clientSecret } : {}),
    ...(googleAdsClientId !== undefined ? { googleAdsClientId } : {}),
  };
}

/** True when `clientId` is also the Google Ads OAuth client (never allowed for YouTube). */
export function sharesGoogleAdsClient(
  clientId: string | undefined,
  googleAdsClientId: string | undefined,
): boolean {
  return (
    clientId !== undefined && googleAdsClientId !== undefined && clientId === googleAdsClientId
  );
}

/** A complete, valid YouTube OAuth client of its own. */
export function isValidYouTubeApp(
  app: YouTubeAppConfig,
): app is YouTubeAppConfig & { clientId: string; clientSecret: string } {
  return (
    isValidYouTubeClientId(app.clientId) &&
    isValidYouTubeClientSecret(app.clientSecret) &&
    !sharesGoogleAdsClient(app.clientId, app.googleAdsClientId)
  );
}
