import type { OAuthClientConfig, OAuthGrant, OAuthSpec } from "../oauth";
import { createGoogleAdsClient, type GoogleFailure } from "./client";
import {
  AUTHORIZE_URL,
  GOOGLE_CONFIG_INVALID,
  googleProviderId,
  isValidGoogleClientId,
  isValidGoogleClientSecret,
  OAUTH_TIMEOUT_MS,
  resolveGoogleVersion,
} from "./config";
import type { GoogleCredential } from "./credential";
import { classifyGoogleFailure, googleError, googleProviderError } from "./errors";
import { parseRaw, rawAccessibleCustomers, rawTokenResponse, rawUserinfo } from "./schemas";

/**
 * Google Ads OAuthSpec (Phase 9, G-D4/G-D5/G-D6): OAuth 2.0 authorization code with PKCE
 * S256, `access_type=offline` + `prompt=consent` (a refresh token is always issued), scopes
 * `adwords` + `openid` only. The identity is the OpenID `sub`; no email or profile is
 * requested or stored. No `refresh` (G-D5a: the provider mints access tokens itself) and no
 * `revoke` (G-D6). No developer token (sunset 2026-09-09): API access is the access level of
 * the Google Cloud project that owns the OAuth client.
 *
 * Every failure is a ProviderError with providerCode "<stage>:<code>" for the sanitized
 * OAuth diagnostics (D28b): config, token_exchange, identity, api_access.
 */

export const GOOGLE_ADS_SCOPE = "https://www.googleapis.com/auth/adwords";
export const GOOGLE_SCOPES = [GOOGLE_ADS_SCOPE, "openid"] as const;

export const GOOGLE_OAUTH_STAGES = ["config", "token_exchange", "identity", "api_access"] as const;
export type GoogleOAuthStage = (typeof GOOGLE_OAUTH_STAGES)[number];

type Config = { clientId: string; clientSecret: string };

const SUB = /^[A-Za-z0-9_-]{1,255}$/;

export function createGoogleOAuthSpec(
  options: { version?: string; timeoutMs?: number } = {},
): OAuthSpec<GoogleCredential> {
  const version = resolveGoogleVersion(options.version);
  const client = createGoogleAdsClient({
    version: version.version,
    timeoutMs: options.timeoutMs ?? OAUTH_TIMEOUT_MS,
  });

  const configError = () =>
    googleError(
      "unknown",
      "oauthExchange",
      `config:${GOOGLE_CONFIG_INVALID}`,
      "Google OAuth configuration is missing or invalid",
    );

  function requireConfig(config: OAuthClientConfig): Config {
    if (
      !version.valid ||
      !isValidGoogleClientId(config.clientId) ||
      !isValidGoogleClientSecret(config.clientSecret)
    ) {
      throw configError();
    }
    return { clientId: config.clientId, clientSecret: config.clientSecret };
  }

  const stageError = (stage: GoogleOAuthStage, failure: GoogleFailure) =>
    googleProviderError(classifyGoogleFailure(failure), "oauthExchange", stage);

  return {
    platform: "google_ads",
    providerId: googleProviderId(version),
    requestedScopes: GOOGLE_SCOPES,
    requiredScopes: [GOOGLE_ADS_SCOPE],
    usesPkce: true,

    buildAuthorizationUrl({ state, redirectUri, codeChallenge, config }) {
      const { clientId } = requireConfig(config);
      if (codeChallenge === undefined) throw configError();
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: GOOGLE_SCOPES.join(" "),
        state,
        code_challenge: codeChallenge,
        code_challenge_method: "S256",
        access_type: "offline",
        prompt: "consent",
        include_granted_scopes: "false",
      }).toString();
      return url.toString();
    },

    async exchangeCode({ code, redirectUri, codeVerifier, config, now }) {
      const cfg = requireConfig(config);
      if (codeVerifier === undefined) {
        throw googleError(
          "auth",
          "oauthExchange",
          "token_exchange:invalid_request",
          "PKCE verifier missing",
        );
      }

      // 1. Authorization code (+ PKCE verifier) → access + refresh token (form body).
      const exchanged = await client.token({
        grant_type: "authorization_code",
        code,
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      });
      if (!exchanged.ok) throw stageError("token_exchange", exchanged.failure);
      const token = parseRaw(
        rawTokenResponse,
        exchanged.body,
        "oauthExchange",
        "token",
        "token_exchange",
      );
      if (token.refresh_token === undefined || token.refresh_token === "") {
        throw googleError(
          "auth",
          "oauthExchange",
          "token_exchange:no_refresh_token",
          "Google did not issue a refresh token",
        );
      }
      const grantedScopes = (token.scope ?? "").split(" ").filter((s) => s !== "");

      // 2. Identity: OpenID `sub` only (no email, no profile).
      const info = await client.userinfo(token.access_token);
      if (!info.ok) throw stageError("identity", info.failure);
      const { sub } = parseRaw(rawUserinfo, info.body, "oauthExchange", "userinfo", "identity");
      if (!SUB.test(sub)) {
        throw googleError("data", "oauthExchange", "identity:schema", "Unexpected OpenID subject");
      }

      // 3. API access: the user can reach the Google Ads API through our Cloud project.
      const access = await client.listAccessibleCustomers({ accessToken: token.access_token });
      if (!access.ok) throw stageError("api_access", access.failure);
      parseRaw(rawAccessibleCustomers, access.body, "oauthExchange", "customers", "api_access");

      const credential: GoogleCredential = {
        kind: "google",
        v: 1,
        refreshToken: token.refresh_token,
        clientId: cfg.clientId,
        issuedAt: now,
        scopes: grantedScopes,
      };
      return {
        credential,
        identity: { externalUserId: sub },
        grantedScopes,
        refreshable: true,
      } satisfies OAuthGrant<GoogleCredential>;
    },
  };
}
