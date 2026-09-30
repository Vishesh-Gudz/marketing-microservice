/**
 * Google Ads provider configuration (Phase 9). Values come from Convex env via
 * createDefaultRegistry(); construction never throws, problems surface per call as
 * ProviderError "unknown" / google_config_invalid (never "auth": an env mistake must stay
 * reversible and must not push every Google connection into needs_reauth).
 * No client id, secret or developer token is ever logged or put in a URL or an error.
 */

/** Pinned Google Ads API version (G-D1; v25 released 2026-07-22). Bumped via the runbook. */
export const GOOGLE_ADS_API_VERSION = "v25";

const VERSION = /^v\d{2,3}$/;

export type GoogleVersion = { version: string; valid: boolean };

/** Effective version: the optional GOOGLE_ADS_API_VERSION override, else the pinned one. */
export function resolveGoogleVersion(override: string | undefined): GoogleVersion {
  if (override === undefined) return { version: GOOGLE_ADS_API_VERSION, valid: true };
  return VERSION.test(override)
    ? { version: override, valid: true }
    : { version: "invalid", valid: false };
}

/** Run metadata only (syncRuns.providerId); never part of an identity key. */
export function googleProviderId(version: GoogleVersion): string {
  return `google-ads-api/${version.version}`;
}

export const GOOGLE_CONFIG_INVALID = "google_config_invalid";

/** OAuth web client ids: "<project number>-<id>.apps.googleusercontent.com". */
export function isValidGoogleClientId(value: string | undefined): value is string {
  return (
    value !== undefined && /^\d{1,32}-[a-z0-9]{1,64}\.apps\.googleusercontent\.com$/.test(value)
  );
}

export function isValidGoogleClientSecret(value: string | undefined): value is string {
  return value !== undefined && value.length >= 8 && value.length <= 256 && !/\s/.test(value);
}

/** Developer tokens are opaque; only a conservative shape is enforced. */
export function isValidDeveloperToken(value: string | undefined): value is string {
  return value !== undefined && /^[A-Za-z0-9_-]{10,64}$/.test(value);
}

export const GOOGLE_ADS_ORIGIN = "https://googleads.googleapis.com";
export const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";
export const AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";

/** Sync calls stay well under the 5-minute task lease. */
export const SYNC_TIMEOUT_MS = 60_000;
/** OAuth and discovery run inside the OAuth callback action. */
export const OAUTH_TIMEOUT_MS = 15_000;

/** Google search pages are a fixed 10,000 rows (v19+, page_size cannot be set). */
export const GOOGLE_SEARCH_PAGE_ROWS = 10_000;
/** Accessible customers examined when resolving a route (fail closed beyond). */
export const MAX_ROUTE_CANDIDATES = 100;
/** Accounts discovered through all hierarchies of one connection (fail closed beyond). */
export const MAX_HIERARCHY_ACCOUNTS = 10_000;
/** Search calls one discovery page may make before returning (bounded action time). */
export const MAX_DISCOVERY_CALLS_PER_PAGE = 25;
