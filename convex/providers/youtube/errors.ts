import { ProviderError, type ProviderErrorKind } from "../errors";
import type { ProviderOperation } from "../types";
import type { YouTubeFailure } from "./client";

/**
 * YouTube error classification (ADR 0016). Uses the Google API error `reason`s, the RPC/HTTP
 * status and the OAuth `error` field only — never message text. `providerCode` is a reason
 * ("quotaExceeded"), an OAuth error ("invalid_grant"), an RPC status or "http_<status>" /
 * "network" / "timeout" / a transport marker. Messages are generic and never carry payloads,
 * URLs, tokens or request ids.
 *
 * [doc] Reasons from the YouTube Data API error reference and the Google API error model.
 * [PROVISIONAL YR4] Which reasons and statuses a real channel returns is unverified.
 */

const MAX_RETRY_AFTER_MS = 60 * 60_000;

/**
 * Deployment-level problems ("unknown": never reauth, never an account block): the API is not
 * enabled for the OAuth client's Cloud project, or the OAuth client itself is wrong.
 */
const CONFIG_REASONS: ReadonlySet<string> = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);

/**
 * [doc] The daily project quota (it resets at midnight Pacific Time): retried at most hourly,
 * so a task never spins on an exhausted quota.
 */
const QUOTA_REASONS: ReadonlySet<string> = new Set(["quotaExceeded", "dailyLimitExceeded"]);

const REASON_KIND: Readonly<Record<string, ProviderErrorKind>> = {
  authError: "auth",
  unauthorized: "auth",
  invalidCredentials: "auth",
  forbidden: "permission",
  insufficientPermissions: "permission",
  ACCESS_TOKEN_SCOPE_INSUFFICIENT: "permission",
  youtubeSignupRequired: "permission",
  channelClosed: "permission",
  channelSuspended: "permission",
  playlistItemsNotAccessible: "permission",
  rateLimitExceeded: "rate_limited",
  userRateLimitExceeded: "rate_limited",
  RATE_LIMIT_EXCEEDED: "rate_limited",
  channelNotFound: "not_found",
  playlistNotFound: "not_found",
  videoNotFound: "not_found",
  notFound: "not_found",
  backendError: "transient",
  internalError: "transient",
  invalidPageToken: "invalid_request",
  badRequest: "invalid_request",
  invalidParameter: "invalid_request",
  invalidValue: "invalid_request",
  missingRequiredParameter: "invalid_request",
};

const OAUTH_KIND: Readonly<Record<string, ProviderErrorKind>> = {
  invalid_grant: "auth",
  access_denied: "auth",
  // [doc] the revocation endpoint's answer for an unknown or already revoked token.
  invalid_token: "auth",
  invalid_client: "unknown",
  unauthorized_client: "unknown",
  redirect_uri_mismatch: "unknown",
};

const RPC_KIND: Readonly<Record<string, ProviderErrorKind>> = {
  UNAUTHENTICATED: "auth",
  PERMISSION_DENIED: "permission",
  NOT_FOUND: "not_found",
  RESOURCE_EXHAUSTED: "rate_limited",
  UNAVAILABLE: "transient",
  DEADLINE_EXCEEDED: "transient",
  INTERNAL: "transient",
  INVALID_ARGUMENT: "invalid_request",
  FAILED_PRECONDITION: "invalid_request",
  OUT_OF_RANGE: "invalid_request",
};

/** Lower = more severe (wins when a failure carries several reasons). */
const SEVERITY: Readonly<Record<ProviderErrorKind, number>> = {
  auth: 0,
  permission: 1,
  unknown: 2, // configuration reasons
  not_found: 3,
  rate_limited: 4,
  transient: 5,
  invalid_request: 6,
  data: 7,
  unsupported: 8,
};

export type YouTubeClassification = {
  kind: ProviderErrorKind;
  providerCode: string;
  retryAfterMs?: number;
};

function reasonKind(reason: string): ProviderErrorKind | undefined {
  if (CONFIG_REASONS.has(reason)) return "unknown";
  if (QUOTA_REASONS.has(reason)) return "rate_limited";
  return REASON_KIND[reason];
}

function httpKind(status: number): ProviderErrorKind {
  if (status === 401) return "auth";
  if (status === 403) return "permission";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "transient";
  if (status === 400) return "invalid_request";
  return "unknown";
}

function withRetry(
  kind: ProviderErrorKind,
  providerCode: string,
  retryAfterMs: number | undefined,
): YouTubeClassification {
  return kind === "rate_limited" && retryAfterMs !== undefined
    ? { kind, providerCode, retryAfterMs: Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) }
    : { kind, providerCode };
}

export function classifyYouTubeFailure(failure: YouTubeFailure): YouTubeClassification {
  switch (failure.type) {
    case "blocked":
      // A request outside the allowlist is a programming error: never retried.
      return { kind: "unknown", providerCode: "transport_blocked" };
    case "budget_exceeded":
      return { kind: "unknown", providerCode: "request_budget_exceeded" };
    case "network":
      return { kind: "transient", providerCode: "network" };
    case "timeout":
      return { kind: "transient", providerCode: "timeout" };
    case "invalid_json":
      return failure.status >= 500
        ? { kind: "transient", providerCode: `http_${failure.status}` }
        : { kind: "data", providerCode: "invalid_json" };
    case "http":
      break;
  }
  if (failure.oauthError !== undefined) {
    const kind =
      failure.status >= 500 ? "transient" : (OAUTH_KIND[failure.oauthError] ?? "unknown");
    return { kind, providerCode: failure.oauthError };
  }
  let best: { kind: ProviderErrorKind; code: string } | undefined;
  for (const reason of failure.reasons) {
    const kind = reasonKind(reason);
    if (kind !== undefined && (best === undefined || SEVERITY[kind] < SEVERITY[best.kind])) {
      best = { kind, code: reason };
    }
  }
  if (best !== undefined) {
    const retry = QUOTA_REASONS.has(best.code) ? MAX_RETRY_AFTER_MS : failure.retryAfterMs;
    return withRetry(best.kind, best.code, retry);
  }
  if (failure.rpcStatus !== undefined && RPC_KIND[failure.rpcStatus] !== undefined) {
    return withRetry(RPC_KIND[failure.rpcStatus]!, failure.rpcStatus, failure.retryAfterMs);
  }
  return withRetry(httpKind(failure.status), `http_${failure.status}`, failure.retryAfterMs);
}

/**
 * The ProviderError for a classification (generic message; no payloads). OAuth flows pass a
 * D28b `stage` ("config", "token_exchange", "identity", "revoke"): providerCode
 * "<stage>:<code>".
 */
export function youtubeProviderError(
  classification: YouTubeClassification,
  operation: ProviderOperation,
  stage?: string,
): ProviderError {
  return new ProviderError({
    kind: classification.kind,
    platform: "youtube",
    operation,
    message: `YouTube request failed (${classification.kind})`,
    providerCode:
      stage !== undefined ? `${stage}:${classification.providerCode}` : classification.providerCode,
    ...(classification.retryAfterMs !== undefined
      ? { retryAfterMs: classification.retryAfterMs }
      : {}),
  });
}

/** A problem detected by the provider itself (config, credential, payload). */
export function youtubeError(
  kind: ProviderErrorKind,
  operation: ProviderOperation,
  providerCode: string,
  message: string,
): ProviderError {
  return new ProviderError({ kind, platform: "youtube", operation, message, providerCode });
}
