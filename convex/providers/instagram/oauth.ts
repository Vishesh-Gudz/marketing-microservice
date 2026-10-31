import type { OAuthClientConfig, OAuthGrant, OAuthSpec } from "../oauth";
import {
  AUTHORIZE_URL,
  GRAPH_ORIGIN,
  INSTAGRAM_CONFIG_INVALID,
  INSTAGRAM_MESSAGING_SCOPE,
  INSTAGRAM_PROVIDER_ID,
  isValidInstagramAppId,
  isValidInstagramSecret,
  LONG_LIVED_EXCHANGE_PATH,
  OAUTH_TIMEOUT_MS,
  isValidUnifiedConfigId,
  REFRESH_MIN_AGE_MS,
  REFRESH_PATH,
  TOKEN_EXCHANGE_URL,
  UNIFIED_DIALOG_URL,
} from "./config";
import {
  isInstagramCredential,
  isInstagramUnifiedCredential,
  type InstagramCredential,
  type InstagramUnifiedCredential,
} from "./credential";
import { classifyInstagramFailure, instagramError, instagramProviderError } from "./errors";
import { createInstagramGraphReader } from "./graphReader";
import {
  canonicalId,
  parsePermissions,
  parseRaw,
  rawLongLivedToken,
  rawShortLivedEnvelope,
  rawShortLivedToken,
  type RawShortLivedToken,
} from "./schemas";
import { RequestBudget, sendInstagram, type InstagramResult } from "./transport";
import { exchangeUnifiedCode, inspectUnifiedToken, readUnifiedAccounts } from "./unified";

/**
 * Instagram OAuthSpec (Phase 10, I-D1/I-D2): Instagram API with Instagram Login, our own
 * implementation (not the SDK helper), SDK-free and default-runtime safe (the OAuth
 * callback is a default-runtime httpAction; discovery runs from the same identity).
 *
 * Scopes [doc]: instagram_business_basic + instagram_business_manage_insights — no publishing
 * or comments. (Meta's business-login page lists no `manage_insights` scope while the insights
 * references require it: real-account item.) ADR 0017: a connect for direct messages adds
 * instagram_business_manage_messages (`extraScopes`), and only that.
 * No PKCE (not documented for Instagram Login): the single-use state nonce is the CSRF
 * defense. Every request goes through the transport allowlist (transport.ts).
 *
 * Unified Login (config.ts, unified.ts): with a configuration id (INSTAGRAM_LOGIN_CONFIG_ID)
 * the authorization goes through the Facebook Login for Business dialog (`config_id`, no
 * scope) and the exchange is code -> system-user token -> debug_token -> the one assigned
 * Instagram account, all on graph.facebook.com/v26.0. Without it, nothing below changes.
 *
 * D28b stages (providerCode "<stage>:<code>"): token_exchange, long_lived_exchange,
 * identity, config; refresh failures use token_refresh; Unified Login adds debug_token. Authorization codes and short-lived
 * tokens only ever exist in this function's memory; only the long-lived token is returned
 * (inside the credential, which the connection layer encrypts).
 */

export const INSTAGRAM_SCOPES = [
  "instagram_business_basic",
  "instagram_business_manage_insights",
] as const;

/** Scopes a connect may add on request (ADR 0017): the messaging permission only. */
export const INSTAGRAM_OPTIONAL_SCOPES: readonly string[] = [INSTAGRAM_MESSAGING_SCOPE];

export const INSTAGRAM_OAUTH_STAGES = [
  "token_exchange",
  "long_lived_exchange",
  "identity",
  "config",
  "token_refresh",
] as const;
export type InstagramOAuthStage = (typeof INSTAGRAM_OAUTH_STAGES)[number];

/** Requests of one code exchange: code exchange + long-lived exchange + identity. */
const EXCHANGE_BUDGET = 3;

type Config = { appId: string; appSecret: string };

function requireConfig(config: OAuthClientConfig, operation: "oauthExchange" | "oauthRefresh") {
  if (!isValidInstagramAppId(config.clientId) || !isValidInstagramSecret(config.clientSecret)) {
    throw instagramError(
      "unknown",
      operation,
      `config:${INSTAGRAM_CONFIG_INVALID}`,
      "Instagram app configuration is missing or invalid",
    );
  }
  return { appId: config.clientId, appSecret: config.clientSecret } satisfies Config;
}

/**
 * Unified Login (config.ts) is used when the connection layer passes a configuration id
 * (INSTAGRAM_LOGIN_CONFIG_ID); an invalid one is a configuration error, never a fallback.
 */
function unifiedConfigId(
  config: OAuthClientConfig,
  operation: "oauthExchange" | "oauthRefresh",
): string | undefined {
  const configId = config.extra?.configId;
  if (configId === undefined) return undefined;
  if (!isValidUnifiedConfigId(configId)) {
    throw instagramError(
      "unknown",
      operation,
      `config:${INSTAGRAM_CONFIG_INVALID}`,
      "Instagram app configuration is missing or invalid",
    );
  }
  return configId;
}

/** Requests of one Unified Login exchange: code exchange + debug_token + account lookup. */
const UNIFIED_EXCHANGE_BUDGET = 3;

/** Seconds -> epoch ms from `now`; absent or non-positive = no expiry reported. */
function expiryFrom(now: number, expiresIn: number | undefined): number | undefined {
  return expiresIn !== undefined && Number.isFinite(expiresIn) && expiresIn > 0
    ? now + Math.floor(expiresIn) * 1_000
    : undefined;
}

/** [doc] `{ data: [entry] }`; the flat entry of older docs is tolerated. */
function shortLivedEntry(body: unknown): RawShortLivedToken {
  const envelope = body as { data?: unknown } | null;
  if (envelope !== null && typeof envelope === "object" && "data" in envelope) {
    const { data } = parseRaw(
      rawShortLivedEnvelope,
      body,
      "oauthExchange",
      "token",
      "token_exchange",
    );
    if (data.length !== 1) {
      throw instagramError(
        "data",
        "oauthExchange",
        "token_exchange:schema",
        "Unexpected token payload",
      );
    }
    return parseRaw(rawShortLivedToken, data[0], "oauthExchange", "token", "token_exchange");
  }
  return parseRaw(rawShortLivedToken, body, "oauthExchange", "token", "token_exchange");
}

export function createInstagramOAuthSpec(
  options: { timeoutMs?: number } = {},
): OAuthSpec<InstagramCredential | InstagramUnifiedCredential> {
  const timeoutMs = options.timeoutMs ?? OAUTH_TIMEOUT_MS;
  const reader = createInstagramGraphReader({ timeoutMs });

  const stageError = (
    stage: InstagramOAuthStage,
    operation: "oauthExchange" | "oauthRefresh",
    result: Extract<InstagramResult, { ok: false }>,
  ) => {
    const classification = classifyInstagramFailure(result.failure);
    // An invalid, expired or already used authorization code (OAuthException, HTTP 400)
    // is a user-side failure: non-retryable "auth" (the user starts again).
    if (
      stage === "token_exchange" &&
      result.failure.type === "http" &&
      result.failure.status === 400
    ) {
      classification.kind = "auth";
    }
    return instagramProviderError(classification, operation, stage);
  };

  const spec: OAuthSpec<InstagramCredential | InstagramUnifiedCredential> = {
    platform: "instagram",
    providerId: INSTAGRAM_PROVIDER_ID,
    requestedScopes: INSTAGRAM_SCOPES,
    requiredScopes: INSTAGRAM_SCOPES,
    usesPkce: false,

    buildAuthorizationUrl({ state, redirectUri, config, extraScopes = [] }) {
      const { appId } = requireConfig(config, "oauthExchange");
      // ADR 0017: the messaging permission is the only scope ever added, on top of the
      // analytics scopes (a reconnect for messages never drops them).
      if (extraScopes.some((scope) => !INSTAGRAM_OPTIONAL_SCOPES.includes(scope))) {
        throw instagramError(
          "invalid_request",
          "oauthExchange",
          "config:scope_not_allowed",
          "Instagram scope not allowed",
        );
      }
      const configId = unifiedConfigId(config, "oauthExchange");
      if (configId !== undefined) {
        // [doc] Unified Login: the configuration defines the permissions; no `scope` is sent,
        // so the messaging permission (extraScopes) comes from the configuration itself.
        const url = new URL(UNIFIED_DIALOG_URL);
        url.searchParams.set("client_id", appId);
        url.searchParams.set("config_id", configId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("state", state);
        return url.toString();
      }
      const url = new URL(AUTHORIZE_URL);
      url.searchParams.set("client_id", appId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      // [doc] comma-separated scope list.
      url.searchParams.set("scope", [...INSTAGRAM_SCOPES, ...new Set(extraScopes)].join(","));
      url.searchParams.set("state", state);
      return url.toString();
    },

    async exchangeCode({
      code,
      redirectUri,
      config,
      now,
    }): Promise<OAuthGrant<InstagramCredential | InstagramUnifiedCredential>> {
      const { appId, appSecret } = requireConfig(config, "oauthExchange");
      if (unifiedConfigId(config, "oauthExchange") !== undefined) {
        const call = { timeoutMs, budget: new RequestBudget(UNIFIED_EXCHANGE_BUDGET) };
        const token = await exchangeUnifiedCode({ code, redirectUri, appId, appSecret }, call);
        const grantedScopes = await inspectUnifiedToken({ token, appId, appSecret }, call);
        const accounts = await readUnifiedAccounts(token, "oauthExchange", {
          ...call,
          stage: "identity",
        });
        if (accounts.length !== 1) {
          // One connection is one Instagram account: the client assigns exactly one.
          throw instagramError(
            "data",
            "oauthExchange",
            accounts.length === 0 ? "identity:no_account" : "identity:multiple_accounts",
            accounts.length === 0
              ? "No Instagram account was assigned to the app"
              : "Assign exactly one Instagram account to the app",
          );
        }
        const account = accounts[0]!;
        return {
          credential: {
            kind: "instagram",
            v: 1,
            setup: "unified",
            accessToken: token,
            tokenType: "system_user",
            appId,
            userId: account.userId,
            issuedAt: now,
          },
          identity: {
            externalUserId: account.userId,
            ...(account.username !== undefined ? { displayName: account.username } : {}),
          },
          grantedScopes,
          // [doc] The configuration's token never expires and is never refreshed: no expiry is
          // stored, so the refresh job never selects it.
          refreshable: false,
        };
      }
      const budget = new RequestBudget(EXCHANGE_BUDGET);

      // 1. Authorization code -> short-lived token (form POST: secrets never in a URL).
      const short = await sendInstagram(
        "oauth",
        new URL(TOKEN_EXCHANGE_URL),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams({
            client_id: appId,
            client_secret: appSecret,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
            code,
          }).toString(),
        },
        { timeoutMs, budget },
      );
      if (!short.ok) throw stageError("token_exchange", "oauthExchange", short);
      const shortToken = shortLivedEntry(short.body);
      const scopedUserId = canonicalId(shortToken.user_id);
      if (scopedUserId === undefined) {
        throw instagramError(
          "data",
          "oauthExchange",
          "token_exchange:identity_invalid",
          "Unexpected Instagram account identity",
        );
      }

      // 2. Short-lived -> long-lived token (~60 days). The APPROVED secret-in-URL exception:
      //    Meta documents only this GET form. The URL exists only for this fetch.
      const longUrl = new URL(`${GRAPH_ORIGIN}${LONG_LIVED_EXCHANGE_PATH}`);
      longUrl.searchParams.set("grant_type", "ig_exchange_token");
      longUrl.searchParams.set("client_secret", appSecret);
      longUrl.searchParams.set("access_token", shortToken.access_token);
      const long = await sendInstagram(
        "oauth",
        longUrl,
        { method: "GET", headers: { Accept: "application/json" } },
        { timeoutMs, budget },
      );
      if (!long.ok) throw stageError("long_lived_exchange", "oauthExchange", long);
      const longToken = parseRaw(
        rawLongLivedToken,
        long.body,
        "oauthExchange",
        "token",
        "long_lived_exchange",
      );

      // 3. Identity + account type from the Graph reader (the SDK drops account_type).
      //    [PROVISIONAL IR2] the code-exchange user_id is not assumed to equal /me.user_id;
      //    the documented professional account id (/me.user_id) is the identity.
      const identity = await reader.readIdentity(longToken.access_token, {
        operation: "oauthExchange",
        stage: "identity",
        budget,
      });

      const expiresAt = expiryFrom(now, longToken.expires_in);
      return {
        credential: {
          kind: "instagram",
          v: 1,
          accessToken: longToken.access_token,
          tokenType: "long_lived",
          appId,
          userId: identity.userId,
          issuedAt: now,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
        identity: {
          externalUserId: identity.userId,
          ...(identity.username !== undefined ? { displayName: identity.username } : {}),
          scopedUserId,
        },
        grantedScopes: parsePermissions(shortToken.permissions),
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        refreshable: true,
      };
    },

    /**
     * [doc] Long-lived token refresh (token at least 24 h old; the approved secret-in-URL
     * exception). Identity and scopes are unchanged by a refresh: the returned grant keeps
     * the stored identity and reports NO scopes (callers must not overwrite granted scopes).
     */
    async refresh(
      credential,
      config,
      now,
    ): Promise<OAuthGrant<InstagramCredential | InstagramUnifiedCredential>> {
      if (isInstagramUnifiedCredential(credential)) {
        // Never selected (no expiry is stored); refused without touching the connection.
        throw instagramError(
          "invalid_request",
          "oauthRefresh",
          "token_refresh:not_refreshable",
          "Unified Login tokens are not refreshed",
        );
      }
      if (!isInstagramCredential(credential)) {
        throw instagramError(
          "auth",
          "oauthRefresh",
          "token_refresh:credential_invalid",
          "Unusable Instagram credential",
        );
      }
      const { appId } = requireConfig(config, "oauthRefresh");
      if (credential.appId !== appId) {
        throw instagramError(
          "auth",
          "oauthRefresh",
          "token_refresh:app_id_mismatch",
          "Instagram token was issued to a different app",
        );
      }
      if (now - credential.issuedAt < REFRESH_MIN_AGE_MS) {
        throw instagramError(
          "invalid_request",
          "oauthRefresh",
          "token_refresh:token_too_new",
          "Instagram tokens can be refreshed once they are at least 24 hours old",
        );
      }
      const url = new URL(`${GRAPH_ORIGIN}${REFRESH_PATH}`);
      url.searchParams.set("grant_type", "ig_refresh_token");
      url.searchParams.set("access_token", credential.accessToken);
      const result = await sendInstagram(
        "oauth",
        url,
        { method: "GET", headers: { Accept: "application/json" } },
        { timeoutMs, budget: new RequestBudget(1) },
      );
      if (!result.ok) throw stageError("token_refresh", "oauthRefresh", result);
      const token = parseRaw(
        rawLongLivedToken,
        result.body,
        "oauthRefresh",
        "token",
        "token_refresh",
      );
      const expiresAt = expiryFrom(now, token.expires_in);
      return {
        credential: {
          kind: "instagram",
          v: 1,
          accessToken: token.access_token,
          tokenType: "long_lived",
          appId: credential.appId,
          userId: credential.userId,
          issuedAt: now,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
        },
        identity: { externalUserId: credential.userId },
        grantedScopes: [],
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        refreshable: true,
      };
    },
    // No revoke: Instagram Login documents no token revocation endpoint. Disconnect deletes
    // the local credential (as for Meta); platform-side removal is the user's app settings.
  };
  return Object.freeze(spec);
}
