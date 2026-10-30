/**
 * Instagram (Instagram API with Instagram Login) configuration, Phase 10.
 * docs/providers/instagram.md. SDK-free: safe in the default Convex runtime.
 *
 * Values come from Convex env via the connection layer / registry; construction never
 * throws, problems surface per call as ProviderError "unknown" with
 * `instagram_config_invalid` (never "auth": an env mistake must stay reversible).
 */

/**
 * Graph API version. @opencoredev/social-sdk 0.5.0 hard-codes v25.0 for Instagram; the
 * Graph reader and the OAuth identity call use the SAME version so SDK and reader requests
 * never mix versions. Bumping it is coupled to an SDK upgrade (docs/providers/instagram.md).
 */
export const INSTAGRAM_GRAPH_VERSION = "v25.0";

export const GRAPH_HOST = "graph.instagram.com";
export const GRAPH_ORIGIN = `https://${GRAPH_HOST}`;
/** [doc] Instagram Login authorization window. */
export const AUTHORIZE_URL = "https://www.instagram.com/oauth/authorize";
export const TOKEN_HOST = "api.instagram.com";
/** [doc] Authorization code -> short-lived token (form POST). */
export const TOKEN_EXCHANGE_URL = `https://${TOKEN_HOST}/oauth/access_token`;
/** [doc] Short-lived -> long-lived token (GET; the approved secret-in-URL exception). */
export const LONG_LIVED_EXCHANGE_PATH = "/access_token";
/** [doc] Long-lived token refresh (GET; the approved secret-in-URL exception). */
export const REFRESH_PATH = "/refresh_access_token";

/** Run metadata only (syncRuns.providerId); never part of an identity key. */
export const INSTAGRAM_PROVIDER_ID = `instagram-login/${INSTAGRAM_GRAPH_VERSION}`;

export const INSTAGRAM_CONFIG_INVALID = "instagram_config_invalid";

/**
 * [doc] Direct messages need this permission besides `instagram_business_basic` (ADR 0017). It
 * is requested only on request (`extraScopes`), never by a plain connect.
 */
export const INSTAGRAM_MESSAGING_SCOPE = "instagram_business_manage_messages";

/**
 * Webhook fields the messaging subscription asks for (ADR 0017 D7). [assume] Echoes arrive under
 * `messages` (`is_echo`); Meta's field list also names `message_echoes`, not requested here.
 */
export const INSTAGRAM_SUBSCRIBED_FIELDS = "messages,messaging_seen,message_edit";

/** OAuth calls run inside the OAuth callback action. */
export const OAUTH_TIMEOUT_MS = 15_000;
/** Sync calls stay well under the 5-minute task lease. */
export const SYNC_TIMEOUT_MS = 60_000;

/**
 * [doc] Long-lived tokens are valid for 60 days and can be refreshed once they are at
 * least 24 hours old (an unrefreshed token expires). IR13: timing unverified.
 */
export const REFRESH_MIN_AGE_MS = 24 * 60 * 60 * 1000;
/** Our choice: the daily refresh job refreshes tokens expiring within this window. */
export const REFRESH_WINDOW_MS = 10 * 24 * 60 * 60 * 1000;

const NUMERIC_ID = /^\d{1,32}$/;

export function isValidInstagramAppId(value: string | undefined): value is string {
  return value !== undefined && NUMERIC_ID.test(value);
}

export function isValidInstagramSecret(value: string | undefined): value is string {
  return value !== undefined && value.length >= 8 && value.length <= 256 && !/\s/.test(value);
}

/** Instagram professional account ids and media ids are decimal strings. */
export function isInstagramId(value: unknown): value is string {
  return typeof value === "string" && NUMERIC_ID.test(value);
}

/** Instagram counts as configured when any of its env values is present (as for Google). */
export function instagramConfigured(env: Record<string, string | undefined>): boolean {
  return ["INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"].some((name) => (env[name] ?? "") !== "");
}
