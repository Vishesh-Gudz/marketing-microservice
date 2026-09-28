import { ProviderError, type ProviderErrorKind } from "../errors";
import type { ProviderOperation } from "../types";
import type { GoogleAdsErrorCode, GoogleFailure } from "./client";

/**
 * Google Ads error classification (Phase 9; docs/providers/google-ads.md "Errors").
 * Uses structured GoogleAdsFailure error codes, the RPC/HTTP status and the OAuth `error`
 * field only — never message text. `providerCode` is a bare enum ("USER_PERMISSION_DENIED"),
 * an OAuth error ("invalid_grant"), an RPC status or "http_<status>" / "network" / "timeout".
 * Messages are generic and never carry payloads, URLs, tokens or request ids.
 */

const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** Developer-token / organization problems: configuration, never reauth or an account block. */
const CONFIG_CODES: ReadonlySet<string> = new Set([
  "DEVELOPER_TOKEN_NOT_APPROVED",
  "DEVELOPER_TOKEN_PROHIBITED",
  "DEVELOPER_TOKEN_INVALID",
  "ORGANIZATION_NOT_ASSOCIATED_WITH_DEVELOPER_TOKEN",
]);
/** AuthenticationError codes that are NOT a user credential problem. */
const NOT_AUTH_CODES: Readonly<Record<string, ProviderErrorKind>> = {
  CUSTOMER_NOT_FOUND: "not_found",
  CLIENT_CUSTOMER_ID_INVALID: "invalid_request",
  CLIENT_CUSTOMER_ID_IS_REQUIRED: "invalid_request",
};
const FAMILY_KIND: Readonly<Record<string, ProviderErrorKind>> = {
  authenticationError: "auth",
  authorizationError: "permission",
  quotaError: "rate_limited",
  internalError: "transient",
  requestError: "invalid_request",
  queryError: "invalid_request",
};
const OAUTH_KIND: Readonly<Record<string, ProviderErrorKind>> = {
  invalid_grant: "auth",
  access_denied: "auth",
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
  ABORTED: "transient",
  INVALID_ARGUMENT: "invalid_request",
  FAILED_PRECONDITION: "invalid_request",
  OUT_OF_RANGE: "invalid_request",
};

/** Lower = more severe (wins when a failure carries several errors). */
const SEVERITY: Readonly<Record<ProviderErrorKind, number>> = {
  auth: 0,
  permission: 1,
  unknown: 2, // configuration codes
  not_found: 3,
  rate_limited: 4,
  transient: 5,
  invalid_request: 6,
  data: 7,
  unsupported: 8,
};

export type GoogleClassification = {
  kind: ProviderErrorKind;
  providerCode: string;
  retryAfterMs?: number;
};

export function classifyAdsErrorCode({ family, code }: GoogleAdsErrorCode): ProviderErrorKind {
  if (CONFIG_CODES.has(code)) return "unknown";
  if (family === "authenticationError" && NOT_AUTH_CODES[code] !== undefined) {
    return NOT_AUTH_CODES[code];
  }
  if (code === "CUSTOMER_NOT_FOUND") return "not_found";
  return FAMILY_KIND[family] ?? "unknown";
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
): GoogleClassification {
  return kind === "rate_limited" && retryAfterMs !== undefined
    ? { kind, providerCode, retryAfterMs: Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) }
    : { kind, providerCode };
}

export function classifyGoogleFailure(failure: GoogleFailure): GoogleClassification {
  switch (failure.type) {
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
  if (failure.adsErrors.length > 0) {
    let best: { kind: ProviderErrorKind; code: string } | undefined;
    for (const error of failure.adsErrors) {
      const kind = classifyAdsErrorCode(error);
      if (best === undefined || SEVERITY[kind] < SEVERITY[best.kind]) {
        best = { kind, code: error.code };
      }
    }
    return withRetry(best!.kind, best!.code, failure.retryAfterMs);
  }
  if (failure.rpcStatus !== undefined && RPC_KIND[failure.rpcStatus] !== undefined) {
    return withRetry(RPC_KIND[failure.rpcStatus]!, failure.rpcStatus, failure.retryAfterMs);
  }
  return withRetry(httpKind(failure.status), `http_${failure.status}`, failure.retryAfterMs);
}

/** Builds the ProviderError for a classification (generic message; no payloads). */
export function googleProviderError(
  classification: GoogleClassification,
  operation: ProviderOperation,
  codePrefix?: string,
): ProviderError {
  return new ProviderError({
    kind: classification.kind,
    platform: "google_ads",
    operation,
    message: `Google Ads request failed (${classification.kind})`,
    providerCode: codePrefix
      ? `${codePrefix}:${classification.providerCode}`
      : classification.providerCode,
    ...(classification.retryAfterMs !== undefined
      ? { retryAfterMs: classification.retryAfterMs }
      : {}),
  });
}

/** A Google-side problem detected by the provider itself (config, credential, payload). */
export function googleError(
  kind: ProviderErrorKind,
  operation: ProviderOperation,
  providerCode: string,
  message: string,
): ProviderError {
  return new ProviderError({ kind, platform: "google_ads", operation, message, providerCode });
}
