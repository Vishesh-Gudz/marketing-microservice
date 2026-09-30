/**
 * Meta provider configuration (Phase 8). Values come from Convex env via
 * createDefaultRegistry(); construction never throws, problems surface per call
 * as ProviderError "unknown" (never "auth": an env mistake must stay reversible
 * and must not push every Meta connection into needs_reauth).
 *
 * No Business portfolio, app id or secret is hard-coded: the app is identified
 * only by deployment configuration (META_APP_ID, META_LOGIN_CONFIG_ID).
 */

/** Pinned Marketing API version (D1). Bumped via the version runbook (docs/providers/meta.md). */
export const META_API_VERSION = "v26.0";

const VERSION = /^v\d{1,3}\.0$/;
const NUMERIC_ID = /^\d{1,32}$/;

export type MetaVersion = { version: string; valid: boolean };

/** Effective version: the optional META_GRAPH_API_VERSION override, else the pinned one. */
export function resolveMetaVersion(override: string | undefined): MetaVersion {
  if (override === undefined) return { version: META_API_VERSION, valid: true };
  return VERSION.test(override)
    ? { version: override, valid: true }
    : { version: "invalid", valid: false };
}

/**
 * Run metadata only (written to syncRuns.providerId). Never part of any identity key:
 * connections, credentials, sync accounts and canonical rows key on platform "meta".
 */
export function metaProviderId(version: MetaVersion): string {
  return `meta-marketing-api/${version.version}`;
}

export const META_CONFIG_INVALID = "meta_config_invalid";

export function isValidMetaAppId(value: string | undefined): value is string {
  return value !== undefined && NUMERIC_ID.test(value);
}

export function isValidMetaSecret(value: string | undefined): value is string {
  return value !== undefined && value.length >= 8 && value.length <= 256 && !/\s/.test(value);
}

/** Facebook Login for Business configuration id. */
export function isValidMetaConfigId(value: string | undefined): value is string {
  return value !== undefined && NUMERIC_ID.test(value);
}

export const GRAPH_ORIGIN = "https://graph.facebook.com";
export const DIALOG_ORIGIN = "https://www.facebook.com";

/** D2: per-request timeouts (sync operations stay well under the 5-minute task lease). */
export const SYNC_TIMEOUT_MS = 60_000;
/** OAuth calls and discovery run inside the OAuth callback action (10-minute limit). */
export const OAUTH_TIMEOUT_MS = 15_000;
