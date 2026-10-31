import { v } from "convex/values";
import type { ProviderOperation } from "../types";
import { UNIFIED_BASIC_PERMISSION, UNIFIED_GRAPH_ORIGIN, UNIFIED_GRAPH_VERSION } from "./config";
import { classifyInstagramFailure, instagramError, instagramProviderError } from "./errors";
import { canonicalId, parseRaw } from "./schemas";
import {
  sendInstagram,
  UNIFIED_ACCOUNT_FIELDS,
  type InstagramResult,
  type RequestBudget,
} from "./transport";

/**
 * Instagram API with Unified Login (config.ts): the documented calls of a connect and of
 * account discovery, in the default runtime, each through the transport allowlist:
 *
 * 1. GET /v26.0/oauth/access_token   authorization code -> Business Integration System User
 *    access token [doc: Unified Login authentication]. The approved secret-in-URL form.
 * 2. GET /v26.0/debug_token          the token is valid, was issued to this app, and which
 *    permissions it carries [doc: Graph API access token debugging]. The app token travels as
 *    `access_token` (the documented form; the approved secret-in-URL exception).
 * 3. GET /v26.0/me/assigned_instagram_accounts?fields=id,username   the Instagram account(s)
 *    the client assigned [doc: Unified Login get-started]; `/me` alone is the system user.
 *
 * Nothing here logs; failures are ProviderErrors with staged codes only (D28b).
 */

const rawUnifiedToken = v.object({ access_token: v.string() });

const rawUnifiedDebugToken = v.object({
  data: v.object({
    is_valid: v.boolean(),
    app_id: v.optional(v.union(v.string(), v.number())),
    scopes: v.optional(v.array(v.string())),
  }),
});

const rawAssignedAccounts = v.object({
  data: v.array(
    v.object({ id: v.union(v.string(), v.number()), username: v.optional(v.string()) }),
  ),
});

/** Permission names as Meta reports them (lower-case words joined by underscores). */
const PERMISSION = /^[a-z][a-z_]{0,63}$/;
/** [doc] Instagram usernames: letters, digits, periods and underscores, at most 30. */
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

export type UnifiedAccount = { userId: string; username?: string };

type Call = { timeoutMs: number; budget: RequestBudget };

function failed(
  stage: string,
  operation: ProviderOperation,
  result: Extract<InstagramResult, { ok: false }>,
) {
  const classification = classifyInstagramFailure(result.failure);
  // An invalid, expired or already used authorization code: the user starts again.
  if (
    stage === "token_exchange" &&
    result.failure.type === "http" &&
    result.failure.status === 400
  ) {
    classification.kind = "auth";
  }
  return instagramProviderError(classification, operation, stage);
}

function graphUrl(path: string): URL {
  return new URL(`${UNIFIED_GRAPH_ORIGIN}/${UNIFIED_GRAPH_VERSION}/${path}`);
}

/** 1. The authorization code for a system-user access token. */
export async function exchangeUnifiedCode(
  input: { code: string; redirectUri: string; appId: string; appSecret: string },
  call: Call,
): Promise<string> {
  const url = graphUrl("oauth/access_token");
  url.searchParams.set("client_id", input.appId);
  url.searchParams.set("client_secret", input.appSecret);
  url.searchParams.set("code", input.code);
  url.searchParams.set("redirect_uri", input.redirectUri);
  const result = await sendInstagram(
    "oauth",
    url,
    { method: "GET", headers: { Accept: "application/json" } },
    call,
  );
  if (!result.ok) throw failed("token_exchange", "oauthExchange", result);
  return parseRaw(rawUnifiedToken, result.body, "oauthExchange", "token", "token_exchange")
    .access_token;
}

/** 2. The token is valid and this app's; returns its granted permissions. */
export async function inspectUnifiedToken(
  input: { token: string; appId: string; appSecret: string },
  call: Call,
): Promise<string[]> {
  const url = graphUrl("debug_token");
  url.searchParams.set("input_token", input.token);
  url.searchParams.set("access_token", `${input.appId}|${input.appSecret}`);
  const result = await sendInstagram(
    "oauth",
    url,
    { method: "GET", headers: { Accept: "application/json" } },
    call,
  );
  if (!result.ok) throw failed("debug_token", "oauthExchange", result);
  const data = parseRaw(
    rawUnifiedDebugToken,
    result.body,
    "oauthExchange",
    "debug_token",
    "debug_token",
  ).data;
  if (!data.is_valid) {
    throw instagramError(
      "auth",
      "oauthExchange",
      "debug_token:invalid",
      "Instagram token is not valid",
    );
  }
  if (data.app_id === undefined || String(data.app_id) !== input.appId) {
    throw instagramError(
      "auth",
      "oauthExchange",
      "debug_token:app_id_mismatch",
      "Instagram token was issued to a different app",
    );
  }
  const scopes = [...new Set((data.scopes ?? []).filter((scope) => PERMISSION.test(scope)))];
  if (!scopes.includes(UNIFIED_BASIC_PERMISSION)) {
    throw instagramError(
      "permission",
      "oauthExchange",
      "debug_token:permission_missing",
      "The Instagram connection was not granted instagram_basic",
    );
  }
  return scopes;
}

/** 3. The Instagram accounts the client assigned to this app. */
export async function readUnifiedAccounts(
  token: string,
  operation: ProviderOperation,
  call: Call & { stage?: string },
): Promise<UnifiedAccount[]> {
  const url = graphUrl("me/assigned_instagram_accounts");
  url.searchParams.set("fields", UNIFIED_ACCOUNT_FIELDS);
  const result = await sendInstagram(
    "graph_reader",
    url,
    { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } },
    call,
  );
  if (!result.ok) throw failed(call.stage ?? "accounts", operation, result);
  const { data } = parseRaw(rawAssignedAccounts, result.body, operation, "account", call.stage);
  return data.map((item) => {
    const userId = canonicalId(item.id);
    if (userId === undefined) {
      throw instagramError(
        "data",
        operation,
        call.stage ? `${call.stage}:identity_invalid` : "identity_invalid",
        "Unexpected Instagram account identity",
      );
    }
    const username =
      item.username !== undefined && USERNAME.test(item.username) ? item.username : undefined;
    return { userId, ...(username !== undefined ? { username } : {}) };
  });
}
