import { normalizeMetaAdAccountId } from "../../domain/identity";
import type { OAuthClientConfig, OAuthGrant, OAuthSpec } from "../oauth";
import { createGraphClient, type GraphResult } from "./client";
import {
  DIALOG_ORIGIN,
  isValidMetaAppId,
  isValidMetaConfigId,
  isValidMetaSecret,
  META_CONFIG_INVALID,
  metaProviderId,
  OAUTH_TIMEOUT_MS,
  resolveMetaVersion,
} from "./config";
import type { MetaCredential } from "./credential";
import { classifyGraphFailure, metaError, metaProviderError } from "./errors";
import { parseRaw, rawDebugToken, rawMe, rawTokenResponse, type RawDebugToken } from "./schemas";

/**
 * Meta OAuthSpec (Phase 8): Facebook Login for Business with a long-lived USER
 * token (D4-A). Scopes: ads_read ONLY (D9-A); business_management only if real-account
 * validation proves it necessary. No PKCE (Meta PKCE is OIDC-only), no refresh
 * (long-lived user tokens cannot be extended), no platform revoke (D7).
 *
 * Every failure is a ProviderError with providerCode "<stage>:<code>" so the
 * connection layer can store sanitized diagnostics (D28b). Stages:
 * code_exchange, long_lived_exchange, debug_token, identity, config.
 */

export const META_OAUTH_STAGES = [
  "code_exchange",
  "long_lived_exchange",
  "debug_token",
  "identity",
  "config",
] as const;
export type MetaOAuthStage = (typeof META_OAUTH_STAGES)[number];

export const META_SCOPES = ["ads_read"] as const;

type Config = { appId: string; appSecret: string; configId: string };

/** The app id, secret and Login for Business configuration id, when all are valid. */
function validConfig(config: OAuthClientConfig): Config | undefined {
  const configId = config.extra?.configId;
  if (
    !isValidMetaAppId(config.clientId) ||
    !isValidMetaSecret(config.clientSecret) ||
    !isValidMetaConfigId(configId)
  ) {
    return undefined;
  }
  return { appId: config.clientId, appSecret: config.clientSecret, configId };
}

function requireConfig(config: OAuthClientConfig): Config {
  const valid = validConfig(config);
  if (valid === undefined) {
    throw metaError(
      "unknown",
      "oauthExchange",
      `config:${META_CONFIG_INVALID}`,
      "Meta app configuration is missing or invalid",
    );
  }
  return valid;
}

/** Seconds → epoch ms; 0 or absent means "never" (debug_token convention). */
function finiteExpiry(seconds: number | undefined): number | undefined {
  return seconds !== undefined && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1_000
    : undefined;
}

function grantedAdAccountIds(debug: RawDebugToken["data"]): string[] | undefined {
  const entry = debug.granular_scopes?.find((s) => s.scope === "ads_read");
  if (entry?.target_ids === undefined) return undefined;
  try {
    return [...new Set(entry.target_ids.map((id) => normalizeMetaAdAccountId(id)))].sort();
  } catch {
    // Unknown shape (R20, real-account validation): capture nothing rather than guess.
    return undefined;
  }
}

export function createMetaOAuthSpec(
  options: { version?: string; timeoutMs?: number } = {},
): OAuthSpec<MetaCredential> {
  const version = resolveMetaVersion(options.version);
  const client = createGraphClient({
    version: version.version,
    timeoutMs: options.timeoutMs ?? OAUTH_TIMEOUT_MS,
  });

  const stageError = (stage: MetaOAuthStage, result: Extract<GraphResult, { ok: false }>) => {
    const classification = classifyGraphFailure(result.failure);
    // An invalid, expired or already used authorization code is a user-side
    // failure: non-retryable "auth" (the user starts the connection again).
    if (stage === "code_exchange" && result.failure.type === "http") {
      if (result.failure.error?.code === 100) classification.kind = "auth";
    }
    if (classification.permissionCheck) classification.kind = "permission";
    return metaProviderError(classification, "oauthExchange", stage);
  };

  const spec: OAuthSpec<MetaCredential> = {
    platform: "meta",
    providerId: metaProviderId(version),
    requestedScopes: META_SCOPES,
    requiredScopes: META_SCOPES,
    usesPkce: false,

    isConfigured: (config) => version.valid && validConfig(config) !== undefined,

    buildAuthorizationUrl({ state, redirectUri, config }) {
      if (!version.valid) {
        throw metaError(
          "unknown",
          "oauthExchange",
          `config:${META_CONFIG_INVALID}`,
          "Invalid Meta API version",
        );
      }
      const { appId, configId } = requireConfig(config);
      const url = new URL(`${DIALOG_ORIGIN}/${version.version}/dialog/oauth`);
      url.searchParams.set("client_id", appId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("config_id", configId);
      // Re-prompt for permissions the user declined earlier (reconnect).
      url.searchParams.set("auth_type", "rerequest");
      return url.toString();
    },

    async exchangeCode({ code, redirectUri, config, now }): Promise<OAuthGrant<MetaCredential>> {
      if (!version.valid) {
        throw metaError(
          "unknown",
          "oauthExchange",
          `config:${META_CONFIG_INVALID}`,
          "Invalid Meta API version",
        );
      }
      const { appId, appSecret } = requireConfig(config);

      // 1. Authorization code → short-lived user token (form POST; secrets never in a URL).
      const short = await client.postForm("oauth/access_token", {
        client_id: appId,
        client_secret: appSecret,
        redirect_uri: redirectUri,
        code,
      });
      if (!short.ok) throw stageError("code_exchange", short);
      const shortToken = parseRaw(
        rawTokenResponse,
        short.body,
        "oauthExchange",
        "token",
        "code_exchange",
      );

      // 2. Short-lived → long-lived user token (~60 days).
      const long = await client.postForm("oauth/access_token", {
        grant_type: "fb_exchange_token",
        client_id: appId,
        client_secret: appSecret,
        fb_exchange_token: shortToken.access_token,
      });
      if (!long.ok) throw stageError("long_lived_exchange", long);
      const longToken = parseRaw(
        rawTokenResponse,
        long.body,
        "oauthExchange",
        "token",
        "long_lived_exchange",
      );

      // 3. Inspect the token with the app token: validity, app binding, scopes, expiry.
      //    (input_token is a query parameter; header/body alternatives are V2 at G2.)
      const debugResult = await client.getAsApp(
        "debug_token",
        { input_token: longToken.access_token },
        `${appId}|${appSecret}`,
      );
      if (!debugResult.ok) throw stageError("debug_token", debugResult);
      const debug = parseRaw(
        rawDebugToken,
        debugResult.body,
        "oauthExchange",
        "debug_token",
        "debug_token",
      ).data;
      if (!debug.is_valid) {
        throw metaError("auth", "oauthExchange", "debug_token:190", "Meta token is not valid");
      }
      if (debug.app_id !== appId) {
        throw metaError(
          "auth",
          "oauthExchange",
          "debug_token:app_id_mismatch",
          "Meta token was issued to a different app",
        );
      }

      // 4. App-scoped user identity.
      const meResult = await client.get(
        "me",
        { fields: "id,name" },
        { accessToken: longToken.access_token, appSecret },
      );
      if (!meResult.ok) throw stageError("identity", meResult);
      const me = parseRaw(rawMe, meResult.body, "oauthExchange", "user", "identity");
      if (!/^\d{1,32}$/.test(me.id) || (debug.user_id !== undefined && debug.user_id !== me.id)) {
        throw metaError(
          "data",
          "oauthExchange",
          "identity:user_mismatch",
          "Unexpected Meta user identity",
        );
      }

      // D5: min of the FINITE expiries (0/absent = never); omitted when both are infinite.
      const expiries = [
        finiteExpiry(debug.expires_at),
        finiteExpiry(debug.data_access_expires_at),
      ].filter((value): value is number => value !== undefined);
      const expiresAt = expiries.length > 0 ? Math.min(...expiries) : undefined;
      const tokenExpiresAt = finiteExpiry(debug.expires_at);
      const dataAccessExpiresAt = finiteExpiry(debug.data_access_expires_at);
      const granted = grantedAdAccountIds(debug);
      const displayName = me.name?.trim();

      return {
        credential: {
          kind: "meta",
          v: 1,
          accessToken: longToken.access_token,
          tokenType: "user",
          appId,
          issuedAt: now,
          ...(tokenExpiresAt !== undefined ? { expiresAt: tokenExpiresAt } : {}),
          ...(dataAccessExpiresAt !== undefined ? { dataAccessExpiresAt } : {}),
          ...(granted !== undefined ? { grantedAdAccountIds: granted } : {}),
        },
        identity: {
          externalUserId: me.id,
          ...(displayName ? { displayName: displayName.slice(0, 120) } : {}),
        },
        grantedScopes: [...new Set(debug.scopes ?? [])],
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        refreshable: false,
      };
    },
    // No refresh (D4-A) and no revoke (D7): revoking would deauthorize this Meta
    // user for the app in EVERY org; disconnect deletes only the local credential.
  };
  return Object.freeze(spec);
}
