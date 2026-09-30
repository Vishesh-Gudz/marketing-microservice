import { ProviderError, type ProviderErrorKind } from "../errors";
import type { ProviderOperation } from "../types";
import type { GraphFailure, UsageHeaders } from "./client";

/**
 * Meta error classification (Phase 8, D22/D24; docs/providers/meta.md).
 * Classification uses Graph error codes, HTTP status and usage headers ONLY —
 * never message text. `providerCode` is "<code>" or "<code>/<subcode>" (or a
 * transport marker such as "timeout"); messages are generic and never carry
 * payloads, URLs or tokens.
 */

/** Graph throttling codes (app, user, page, ad-account and BUC limits). */
const RATE_LIMIT_CODES: ReadonlySet<number> = new Set([4, 17, 32, 341, 368, 613]);
const AUTH_CODES: ReadonlySet<number> = new Set([102, 190]);
const TRANSIENT_CODES: ReadonlySet<number> = new Set([1, 2]);
const INVALID_REQUEST_CODES: ReadonlySet<number> = new Set([100, 2500, 2635, 3018]);
/** "Too much data" on insights: retried; the engine shrinks the page from attempt 3 (D23). */
const TOO_MUCH_DATA = { code: 100, subcode: 1_487_534 };
const NOT_FOUND = { code: 100, subcode: 33 };
const NONEXISTENT_ALIAS = 803;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

export type MetaClassification = {
  kind: ProviderErrorKind;
  providerCode: string;
  retryAfterMs?: number;
  /** 10/200-299/3/HTTP 403: probe /me/permissions to tell "auth" from "permission". */
  permissionCheck?: boolean;
};

function isRateLimitCode(code: number): boolean {
  return RATE_LIMIT_CODES.has(code) || (code >= 80_000 && code <= 80_014);
}

function isPermissionCode(code: number): boolean {
  return code === 3 || code === 10 || (code >= 200 && code <= 299);
}

/** max(BUC regain-access minutes, ad-account reset seconds, Retry-After), capped at 1 h. */
export function retryAfterFromUsage(usage: UsageHeaders): number | undefined {
  const candidates = [
    usage.regainAccessMinutes !== undefined ? usage.regainAccessMinutes * 60_000 : undefined,
    usage.accountResetSeconds !== undefined ? usage.accountResetSeconds * 1_000 : undefined,
    usage.retryAfterSeconds !== undefined ? usage.retryAfterSeconds * 1_000 : undefined,
  ].filter((value): value is number => value !== undefined);
  if (candidates.length === 0) return undefined;
  return Math.min(Math.max(...candidates), MAX_RETRY_AFTER_MS);
}

export function classifyGraphFailure(failure: GraphFailure): MetaClassification {
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

  const { status, error, usage } = failure;
  const code = error?.code;
  if (code === undefined) {
    // No Graph error object: fall back to the HTTP status.
    const providerCode = `http_${status}`;
    if (status === 429) {
      const retryAfterMs = retryAfterFromUsage(usage);
      return { kind: "rate_limited", providerCode, ...(retryAfterMs ? { retryAfterMs } : {}) };
    }
    if (status === 401) return { kind: "auth", providerCode };
    if (status === 403) return { kind: "permission", providerCode, permissionCheck: true };
    if (status === 404) return { kind: "not_found", providerCode };
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
  if (code === TOO_MUCH_DATA.code && subcode === TOO_MUCH_DATA.subcode) {
    return { kind: "transient", providerCode };
  }
  if ((code === NOT_FOUND.code && subcode === NOT_FOUND.subcode) || code === NONEXISTENT_ALIAS) {
    return { kind: "not_found", providerCode };
  }
  if (TRANSIENT_CODES.has(code) || error?.isTransient === true) {
    return { kind: "transient", providerCode };
  }
  if (isPermissionCode(code)) return { kind: "permission", providerCode, permissionCheck: true };
  if (INVALID_REQUEST_CODES.has(code)) return { kind: "invalid_request", providerCode };
  if (status >= 500) return { kind: "transient", providerCode };
  return { kind: "unknown", providerCode };
}

/** Builds the ProviderError for a classification (generic message; no payloads). */
export function metaProviderError(
  classification: MetaClassification,
  operation: ProviderOperation,
  codePrefix?: string,
): ProviderError {
  return new ProviderError({
    kind: classification.kind,
    platform: "meta",
    operation,
    message: `Meta request failed (${classification.kind})`,
    providerCode: codePrefix
      ? `${codePrefix}:${classification.providerCode}`
      : classification.providerCode,
    ...(classification.retryAfterMs !== undefined
      ? { retryAfterMs: classification.retryAfterMs }
      : {}),
  });
}

/** A Meta-side problem detected by the provider itself (config, credential, payload). */
export function metaError(
  kind: ProviderErrorKind,
  operation: ProviderOperation,
  providerCode: string,
  message: string,
): ProviderError {
  return new ProviderError({ kind, platform: "meta", operation, message, providerCode });
}
