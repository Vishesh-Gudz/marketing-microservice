import type { ConnectionProvider } from "../domain/types";
import { apiError } from "../lib/errors";
import { createDefaultRegistry, type ProviderRegistry } from "../providers";
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

export const OAUTH_CALLBACK_PATH = "/oauth/callback";

/** The single place the connection layer obtains providers and OAuth specs. */
export function providerRegistry(): ProviderRegistry {
  return createDefaultRegistry();
}

/** Redirect URI registered with every platform: <CONVEX_SITE_URL>/oauth/callback. */
export function oauthRedirectUri(): string {
  const site = process.env.CONVEX_SITE_URL;
  if (!site) throw apiError("INTERNAL", "OAuth redirect URI is not available");
  return new URL(OAUTH_CALLBACK_PATH, site).toString();
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
