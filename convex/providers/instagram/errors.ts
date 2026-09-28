import { ProviderError, type ProviderErrorKind } from "../errors";
import type { ProviderOperation } from "../types";
import type { InstagramFailure, UsageHints } from "./transport";

/**
 * Instagram error classification (Phase 10), mirroring the Meta provider (same Graph
 * error-code family). Classification uses Graph/OAuth error CODES, the HTTP status and the
 * usage headers ONLY — never message text. `providerCode` is "<code>" or "<code>/<subcode>",
 * or a transport marker ("timeout", "http_503", "transport_blocked", ...). Messages are
 * generic and never carry payloads, URLs, tokens or codes.
 *
 * [PROVISIONAL IR4] Which HTTP statuses Instagram pairs with codes 190, 4, 17 and 80002 is
 * not verified against a real account; the code wins over the status when both exist.
 */

/** Throttling codes (app, user, BUC and the Instagram 8000x family). */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 341, 368, 613]);
const AUTH_CODES: ReadonlySet<number> = new Set([102, 190]);
const TRANSIENT_CODES: ReadonlySet<number> = new Set([1, 2]);
const NOT_FOUND = { code: 100, subcode: 33 };
const MAX_RETRY_AFTER_MS = 60 * 60_000;

export type InstagramClassification = {
  kind: ProviderErrorKind;
  providerCode: string;
  retryAfterMs?: number;
};

function isRateLimitCode(code: number): boolean {
  return RATE_LIMIT_CODES.has(code) || (code >= 80_000 && code <= 80_014);
}

function isPermissionCode(code: number): boolean {
  return code === 3 || code === 10 || (code >= 200 && code <= 299);
}

/** max(BUC regain-access minutes, Retry-After), capped at 1 h. */
export function retryAfterFromUsage(usage: UsageHints): number | undefined {
  const candidates = [
    usage.regainAccessMinutes !== undefined ? usage.regainAccessMinutes * 60_000 : undefined,
    usage.retryAfterSeconds !== undefined ? usage.retryAfterSeconds * 1_000 : undefined,
  ].filter((value): value is number => value !== undefined);
  if (candidates.length === 0) return undefined;
  return Math.min(Math.max(...candidates), MAX_RETRY_AFTER_MS);
}

export function classifyInstagramFailure(failure: InstagramFailure): InstagramClassification {
  switch (failure.type) {
    case "blocked":
      // A request outside the allowlist is a programming error or SDK drift: never retried.
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

  const { status, error, usage } = failure;
  const code = error?.code;
  if (code === undefined) {
    const providerCode = `http_${status}`;
    if (status === 429) {
      const retryAfterMs = retryAfterFromUsage(usage);
      return { kind: "rate_limited", providerCode, ...(retryAfterMs ? { retryAfterMs } : {}) };
    }
    if (status === 401) return { kind: "auth", providerCode };
    if (status === 403) return { kind: "permission", providerCode };
    if (status === 404 || status === 410) return { kind: "not_found", providerCode };
    if (status >= 500) return { kind: "transient", providerCode };
    return { kind: "unknown", providerCode };
  }

  const subcode = error?.subcode;
  const providerCode = subcode === undefined ? `${code}` : `${code}/${subcode}`;
  if (isRateLimitCode(code)) {
    const retryAfterMs = retryAfterFromUsage(usage);
    return { kind: "rate_limited", providerCode, ...(retryAfterMs ? { retryAfterMs } : {}) };
  }
  if (AUTH_CODES.has(code)) return { kind: "auth", providerCode };
  if (code === NOT_FOUND.code && subcode === NOT_FOUND.subcode) {
    return { kind: "not_found", providerCode };
  }
  if (TRANSIENT_CODES.has(code) || error?.isTransient === true) {
    return { kind: "transient", providerCode };
  }
  if (isPermissionCode(code)) return { kind: "permission", providerCode };
  if (code === 100) return { kind: "invalid_request", providerCode };
  if (status >= 500) return { kind: "transient", providerCode };
  return { kind: "unknown", providerCode };
}

/** The ProviderError for a classification (generic message; no payloads). */
export function instagramProviderError(
  classification: InstagramClassification,
  operation: ProviderOperation,
  stage?: string,
): ProviderError {
  return new ProviderError({
    kind: classification.kind,
    platform: "instagram",
    operation,
    message: `Instagram request failed (${classification.kind})`,
    providerCode: stage ? `${stage}:${classification.providerCode}` : classification.providerCode,
    ...(classification.retryAfterMs !== undefined
      ? { retryAfterMs: classification.retryAfterMs }
      : {}),
  });
}

/** A problem detected by the provider itself (config, credential, payload, pending mapping). */
export function instagramError(
  kind: ProviderErrorKind,
  operation: ProviderOperation,
  providerCode: string,
  message: string,
): ProviderError {
  return new ProviderError({ kind, platform: "instagram", operation, message, providerCode });
}
