import type { OAuthClientConfig, OAuthGrant, OAuthSpec } from "../oauth";
import { YouTubeRequestBudget } from "./client";
import {
  AUTHORIZE_URL,
  isValidYouTubeApp,
  isYouTubeChannelId,
  OAUTH_TIMEOUT_MS,
  YOUTUBE_PROVIDER_ID,
  type YouTubeAppConfig,
} from "./config";
import { isYouTubeCredential, type YouTubeCredential } from "./credential";
import { classifyYouTubeFailure, youtubeError, youtubeProviderError } from "./errors";
import { capTitle, handleOf } from "./mapping";
import { parseRaw, rawGrantTokenResponse } from "./schemas";
import { bodyOf, configError, createYouTubeSession } from "./session";

/**
 * YouTube OAuthSpec (ADR 0016, Y-D2..Y-D5): Google OAuth 2.0 authorization code with PKCE
 * S256, `access_type=offline` + `prompt=consent` (a refresh token on every consent),
 * `include_granted_scopes=false` (no scopes of other grants), through YouTube's OWN OAuth
 * client (YOUTUBE_CLIENT_ID, never the Google Ads client).
 *
 * Scopes (both required): `youtube.readonly` (channel and video metadata; [doc] Analytics
 * `reports.query` also requires it) and `yt-analytics.readonly` (analytics, Checkpoint 3).
 * Nothing that can write, no monetary scope, no `openid` / email / profile.
 *
 * The identity is the channel of the consent (`channels.list?mine=true`): its id becomes
 * `connections.externalUserId` and the credential's channel. Google's granular consent lets a
 * user untick scopes: without `youtube.readonly` the channel cannot be read and the connection
 * fails; without `yt-analytics.readonly` it is created with that scope reported missing.
 *
 * No `refresh` (access tokens are minted per provider call, Y-D5); `revoke` revokes the
 * refresh token (and so the grant) at Google on disconnect, best effort.
 *
 * Every failure is a ProviderError with providerCode "<stage>:<code>" for the sanitized OAuth
 * diagnostics (D28b): config, token_exchange, identity, revoke. Authorization codes, access
 * tokens and the PKCE verifier only ever exist in this function's memory; only the refresh
 * token is returned (inside the credential, which the connection layer encrypts).
 */

export const YOUTUBE_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
export const YOUTUBE_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";
export const YOUTUBE_SCOPES = [YOUTUBE_READONLY_SCOPE, YOUTUBE_ANALYTICS_SCOPE] as const;

export const YOUTUBE_OAUTH_STAGES = ["config", "token_exchange", "identity", "revoke"] as const;
export type YouTubeOAuthStage = (typeof YOUTUBE_OAUTH_STAGES)[number];

/** Requests of one code exchange: code exchange + channel identity. */
const EXCHANGE_BUDGET = 2;
/** Requests of one revocation. */
const REVOKE_BUDGET = 1;

/** Google scope strings we keep from the token response (anything else is dropped). */
const SCOPE =
  /^(?:https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._-]{1,64}|openid|email|profile)$/;

function appOf(config: OAuthClientConfig): YouTubeAppConfig {
  const googleAdsClientId = config.extra?.googleAdsClientId;
  return {
    ...(config.clientId !== undefined ? { clientId: config.clientId } : {}),
    ...(config.clientSecret !== undefined ? { clientSecret: config.clientSecret } : {}),
    ...(googleAdsClientId !== undefined ? { googleAdsClientId } : {}),
  };
}

function grantedScopesOf(scope: string | undefined): string[] {
  return [...new Set((scope ?? "").split(" ").filter((s) => SCOPE.test(s)))];
}

export function createYouTubeOAuthSpec(
  options: { timeoutMs?: number } = {},
): OAuthSpec<YouTubeCredential> {
  const timeoutMs = options.timeoutMs ?? OAUTH_TIMEOUT_MS;

  const fail = (
    kind: "auth" | "permission" | "data",
    stage: YouTubeOAuthStage,
    code: string,
    message: string,
  ) => youtubeError(kind, "oauthExchange", `${stage}:${code}`, message);

  return Object.freeze({
    platform: "youtube" as const,
    providerId: YOUTUBE_PROVIDER_ID,
    requestedScopes: YOUTUBE_SCOPES,
    requiredScopes: YOUTUBE_SCOPES,
    usesPkce: true,

    isConfigured(config: OAuthClientConfig) {
      return isValidYouTubeApp(appOf(config));
    },

    buildAuthorizationUrl({ state, redirectUri, codeChallenge, config }) {
      const app = appOf(config);
      if (!isValidYouTubeApp(app) || codeChallenge === undefined) {
        throw configError("oauthExchange", "config");
      }
      const url = new URL(AUTHORIZE_URL);
      url.search = new URLSearchParams({
        client_id: app.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: YOUTUBE_SCOPES.join(" "),
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
      const operation = "oauthExchange" as const;
      const app = appOf(config);
      if (!isValidYouTubeApp(app)) throw configError(operation, "config");
      if (codeVerifier === undefined) {
        throw fail("auth", "token_exchange", "invalid_request", "PKCE verifier missing");
      }
      const { client, ownedChannels } = createYouTubeSession(app, { timeoutMs });
      const budget = new YouTubeRequestBudget(EXCHANGE_BUDGET);

      // 1. Authorization code (+ PKCE verifier) -> access + refresh token (form body).
      const exchanged = await client.exchangeCode(
        {
          code,
          redirectUri,
          codeVerifier,
          clientId: app.clientId,
          clientSecret: app.clientSecret,
        },
        budget,
      );
      const token = parseRaw(
        rawGrantTokenResponse,
        bodyOf(exchanged, operation, "token_exchange"),
        operation,
        "token",
        "token_exchange",
      );
      if (token.refresh_token === undefined || token.refresh_token === "") {
        throw fail(
          "auth",
          "token_exchange",
          "no_refresh_token",
          "Google did not issue a refresh token",
        );
      }
      const grantedScopes = grantedScopesOf(token.scope);
      if (!grantedScopes.includes(YOUTUBE_READONLY_SCOPE)) {
        // Granular consent: without youtube.readonly the channel cannot even be identified.
        throw fail("permission", "identity", "youtube_scope_missing", "YouTube access not granted");
      }

      // 2. Identity: the channel of this consent.
      const channels = await ownedChannels(token.access_token, operation, budget, "identity");
      if (channels.length === 0) {
        throw fail("permission", "identity", "no_channel", "The Google account has no channel");
      }
      if (channels.length > 1) {
        // [PROVISIONAL YR10] one consent selects one channel; anything else fails closed.
        throw fail("data", "identity", "multiple_channels", "More than one channel returned");
      }
      const channel = channels[0]!;
      if (!isYouTubeChannelId(channel.id)) {
        throw fail("data", "identity", "identity_invalid", "Unexpected channel id");
      }

      const credential: YouTubeCredential = {
        kind: "youtube",
        v: 1,
        refreshToken: token.refresh_token,
        clientId: app.clientId,
        channelId: channel.id,
        issuedAt: now,
        scopes: grantedScopes,
      };
      const displayName = capTitle(channel.snippet?.title) ?? handleOf(channel.snippet?.customUrl);
      return {
        credential,
        identity: {
          externalUserId: channel.id,
          ...(displayName !== undefined ? { displayName } : {}),
        },
        grantedScopes,
        refreshable: true,
      } satisfies OAuthGrant<YouTubeCredential>;
    },

    async revoke(credential, config) {
      const operation = "oauthRevoke" as const;
      if (!isYouTubeCredential(credential)) return; // nothing of ours to revoke
      const app = appOf(config);
      // Never through a client shared with Google Ads, and never a Google Ads token (Y-D3).
      if (!isValidYouTubeApp(app) || credential.clientId === app.googleAdsClientId) {
        throw configError(operation, "revoke");
      }
      const { client } = createYouTubeSession(app, { timeoutMs });
      const result = await client.revokeToken(
        credential.refreshToken,
        new YouTubeRequestBudget(REVOKE_BUDGET),
      );
      if (result.ok) return;
      const { failure } = result;
      // [doc] success may carry an empty body; an unknown token is already revoked.
      if (failure.type === "invalid_json" && failure.status < 300) return;
      if (failure.type === "http" && failure.oauthError === "invalid_token") return;
      throw youtubeProviderError(classifyYouTubeFailure(failure), operation, "revoke");
    },
  } satisfies OAuthSpec<YouTubeCredential>);
}
