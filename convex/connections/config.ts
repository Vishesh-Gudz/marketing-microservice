import type { ConnectionProvider } from "../domain/types";
import { apiError } from "../lib/errors";
import { createDefaultRegistry, type ProviderRegistry } from "../providers";
import { isLocalDeployment } from "../providers/mode";
import type { OAuthClientConfig } from "../providers/oauth";

/** Connection-layer constants (docs/connections.md). */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const MAX_PENDING_STATES_PER_ORG = 10;
export const DISCOVERY_MAX_PAGES = 20;
export const MAX_LINK_BATCH = 50;
export const EXPIRES_SOON_MS = 10 * 24 * 60 * 60 * 1000;
/** Consumed/failed states are kept this long for diagnostics, then swept. */
export const STATE_RETENTION_MS = 60 * 60 * 1000;
export const SWEEP_BATCH = 200;
/**
 * S2: how long a granted (consented, encrypted) credential waits for its initiator to claim it
 * with `v1/connections:completeConnect`. Unclaimed grants are deleted by the sweep.
 */
export const OAUTH_GRANT_TTL_MS = 10 * 60 * 1000;
/** Claim codes are randomToken() values (32 random bytes, base64url: 43 characters). */
export const CLAIM_CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const OAUTH_CALLBACK_PATH = "/oauth/callback";

/**
 * D8: new platform connections stay closed on cloud deployments until the OAuth callback
 * ownership fix (S2) is deployed and verified; an operator then sets
 * OAUTH_CONNECTIONS_ENABLED=true (exactly). Local deployments and in-process tests are
 * unaffected (loopback or absent CONVEX_CLOUD_URL).
 */
export function connectionsEnabled(
  env: { OAUTH_CONNECTIONS_ENABLED?: string; CONVEX_CLOUD_URL?: string } = {
    OAUTH_CONNECTIONS_ENABLED: process.env.OAUTH_CONNECTIONS_ENABLED,
    CONVEX_CLOUD_URL: process.env.CONVEX_CLOUD_URL,
  },
): boolean {
  return isLocalDeployment(env.CONVEX_CLOUD_URL) || env.OAUTH_CONNECTIONS_ENABLED === "true";
}

/** The single place the connection layer obtains providers and OAuth specs. */
export function providerRegistry(): ProviderRegistry {
  return createDefaultRegistry();
}

/**
 * Optional per-provider override of the callback ORIGIN (Convex env var name). Meta only:
 * Facebook Login for Business requires HTTPS redirect URIs except `http://localhost` while the
 * app is in development mode, and a local deployment's CONVEX_SITE_URL is
 * `http://127.0.0.1:<port>`. Every other provider always uses CONVEX_SITE_URL.
 */
export const REDIRECT_ORIGIN_ENV: Partial<Record<ConnectionProvider, string>> = {
  meta: "META_OAUTH_REDIRECT_ORIGIN",
};

const LOOPBACK_SITE_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Validates a redirect-origin override against the deployment's CONVEX_SITE_URL. The ONLY
 * accepted value is `http://localhost:<CONVEX_SITE_URL's port>` on a LOCAL deployment (a plain
 * http CONVEX_SITE_URL on a loopback host): the same backend under the host name Meta allows in
 * development mode. Everything else is refused, including every https origin: a cloud deployment
 * leaves the override unset and uses its https CONVEX_SITE_URL, so authorization codes can only
 * be redirected to this deployment. Returns the origin, or why it is refused (never the value).
 */
export function validateRedirectOrigin(
  value: string,
  site: string,
): { ok: true; origin: string } | { ok: false; reason: string } {
  let url: URL;
  let siteUrl: URL;
  try {
    url = new URL(value);
    siteUrl = new URL(site);
  } catch {
    return { ok: false, reason: "it is not an absolute URL" };
  }
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return { ok: false, reason: "it must be an origin without a path, query or fragment" };
  }
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "it must not contain credentials" };
  }
  if (url.protocol !== "http:" || url.hostname !== "localhost") {
    return { ok: false, reason: "only http://localhost is allowed" };
  }
  if (siteUrl.protocol !== "http:" || !LOOPBACK_SITE_HOSTS.has(siteUrl.hostname)) {
    return { ok: false, reason: "it is only allowed on a local deployment" };
  }
  // Both are http here; an omitted port is 80.
  if ((url.port || "80") !== (siteUrl.port || "80")) {
    return { ok: false, reason: "its port must match CONVEX_SITE_URL" };
  }
  return { ok: true, origin: url.origin };
}

/**
 * Redirect URI of `provider`'s OAuth flow: <origin>/oauth/callback, where origin is
 * CONVEX_SITE_URL unless the provider has a valid override (REDIRECT_ORIGIN_ENV; unset or
 * empty = none). beginConnect (authorization URL) and the callback (code exchange) both call
 * this with the same provider, so every stage uses the same URI. An invalid override fails
 * closed with INTERNAL naming the variable, never its value.
 */
export function oauthRedirectUri(provider: ConnectionProvider): string {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) throw apiError("INTERNAL", "OAuth redirect URI is not available");
  const envName = REDIRECT_ORIGIN_ENV[provider];
  const override = envName === undefined ? undefined : process.env[envName];
  if (envName === undefined || override === undefined || override === "") {
    return new URL(OAUTH_CALLBACK_PATH, site).toString();
  }
  const checked = validateRedirectOrigin(override, site);
  if (!checked.ok) throw apiError("INTERNAL", `${envName} is invalid: ${checked.reason}.`);
  return new URL(OAUTH_CALLBACK_PATH, checked.origin).toString();
}

/** Platform app credentials (Convex env vars). Mock specs need none. */
const CLIENT_ENV: Record<
  ConnectionProvider,
  { clientId: string; clientSecret: string; extra: Record<string, string> }
> = {
  meta: {
    clientId: "META_APP_ID",
    clientSecret: "META_APP_SECRET",
    extra: { configId: "META_LOGIN_CONFIG_ID" },
  },
  google_ads: { clientId: "GOOGLE_CLIENT_ID", clientSecret: "GOOGLE_CLIENT_SECRET", extra: {} },
  // Phase 10: Instagram API with Instagram Login (organic Instagram only).
  instagram: { clientId: "INSTAGRAM_APP_ID", clientSecret: "INSTAGRAM_APP_SECRET", extra: {} },
};

export function oauthClientConfig(platform: ConnectionProvider): OAuthClientConfig {
  const names = CLIENT_ENV[platform];
  const clientId = process.env[names.clientId];
  const clientSecret = process.env[names.clientSecret];
  const extra = Object.fromEntries(
    Object.entries(names.extra)
      .map(([key, envName]) => [key, process.env[envName]] as const)
      .filter((entry): entry is readonly [string, string] => entry[1] !== undefined),
  );
  return {
    ...(clientId ? { clientId } : {}),
    ...(clientSecret ? { clientSecret } : {}),
    ...(Object.keys(extra).length ? { extra } : {}),
  };
}
