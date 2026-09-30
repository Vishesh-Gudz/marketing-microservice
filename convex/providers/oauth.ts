import type { ConnectionProvider } from "../domain/types";

/**
 * OAuth contract for connecting a platform identity (Phase 4). Tenant-free like
 * AdsProvider: specs see a state string, redirect URI, PKCE values, client
 * config and a clock value — never an orgId or Convex id. Failures are
 * ProviderErrors (operation "oauthExchange" / "oauthRefresh" / "oauthRevoke").
 *
 * Phase 4 ships mock specs only; the real Meta (Phase 8) and Google Ads
 * (Phase 9) specs implement this same interface.
 */

/** Platform app configuration, read from Convex env vars by the connections layer. */
export type OAuthClientConfig = {
  clientId?: string;
  clientSecret?: string;
  /** Platform-specific extras (e.g. Meta Login for Business config_id). */
  extra?: Readonly<Record<string, string>>;
};

export type OAuthIdentity = {
  /** Stable platform user id (Meta user id / Google `sub`). */
  externalUserId: string;
  displayName?: string;
};

export type OAuthGrant<TCredential> = {
  /** Opaque credential handed to AdsProvider via ProviderContext.credential. Encrypted at rest. */
  credential: TCredential;
  identity: OAuthIdentity;
  grantedScopes: string[];
  /** Access-token expiry (epoch ms) when the platform imposes one (Meta ~60 days). */
  expiresAt?: number;
  /** True when `refresh` can mint new access tokens without user interaction (Google). */
  refreshable: boolean;
};

export type AuthorizationUrlInput = {
  /** Opaque, single-use state value (the raw nonce). */
  state: string;
  redirectUri: string;
  /** PKCE S256 challenge, when `usesPkce`. */
  codeChallenge?: string;
  config: OAuthClientConfig;
};

export type ExchangeCodeInput = {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
  config: OAuthClientConfig;
  /** Caller-supplied clock (epoch ms) so specs stay deterministic. */
  now: number;
};

export interface OAuthSpec<TCredential = unknown> {
  /** The connection provider (an ad platform, or Instagram Login in Phase 10). */
  readonly platform: ConnectionProvider;
  readonly providerId: string;
  /** Scopes requested at consent. */
  readonly requestedScopes: readonly string[];
  /** Scopes ads listing needs; missing ones are surfaced on the connection. */
  readonly requiredScopes: readonly string[];
  readonly usesPkce: boolean;

  buildAuthorizationUrl(input: AuthorizationUrlInput): string;
  exchangeCode(input: ExchangeCodeInput): Promise<OAuthGrant<TCredential>>;
  /**
   * Google: mint a fresh grant from a refresh token. Instagram (Phase 10): exchange a
   * long-lived token (at least 24 h old) for a new one. Absent when the platform cannot refresh.
   */
  refresh?(
    credential: TCredential,
    config: OAuthClientConfig,
    now: number,
  ): Promise<OAuthGrant<TCredential>>;
  /** Best-effort revocation at the platform on disconnect. */
  revoke?(credential: TCredential, config: OAuthClientConfig): Promise<void>;
}

/** Scopes required but not granted (order preserved). */
export function missingScopes(
  spec: Pick<OAuthSpec, "requiredScopes">,
  granted: readonly string[],
): string[] {
  const have = new Set(granted);
  return spec.requiredScopes.filter((scope) => !have.has(scope));
}
