import type { AdPlatform } from "../domain/types";
import type { ProviderOperation } from "./types";

/**
 * Provider failure taxonomy. Retryability is DERIVED from the kind so it can
 * never be inconsistent. Callers (Phase 5 sync) retry only retryable errors.
 */
export const PROVIDER_ERROR_KINDS = [
  "auth", //            token invalid/expired/revoked -> reconnect required
  "permission", //      missing scope or no access to the account
  "not_found", //       account/entity no longer exists
  "rate_limited", //    throttled; may carry retryAfterMs
  "transient", //       5xx, network, timeout
  "invalid_request", // bad arguments, foreign cursor, range too long (a caller bug)
  "unsupported", //     capability not supported by this provider
  "data", //            provider payload failed boundary validation
  "unknown", //         unclassified; not retried
] as const;
export type ProviderErrorKind = (typeof PROVIDER_ERROR_KINDS)[number];

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set(["rate_limited", "transient"]);

export function isRetryableKind(kind: ProviderErrorKind): boolean {
  return RETRYABLE.has(kind);
}

export type ProviderErrorOptions = {
  kind: ProviderErrorKind;
  platform: AdPlatform;
  operation: ProviderOperation;
  message: string;
  retryAfterMs?: number;
  /** Platform error code, e.g. Meta error subcode or Google error enum. */
  providerCode?: string;
  cause?: unknown;
};

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly platform: AdPlatform;
  readonly operation: ProviderOperation;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly providerCode?: string;

  constructor(options: ProviderErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderError";
    this.kind = options.kind;
    this.platform = options.platform;
    this.operation = options.operation;
    this.retryable = isRetryableKind(options.kind);
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.providerCode !== undefined) this.providerCode = options.providerCode;
  }

  /** True when the stored connection must be re-authorized by a user (Phase 4). */
  get requiresReauth(): boolean {
    return this.kind === "auth";
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError;
}

/** Normalizes anything thrown inside a provider call. Unclassified errors are "unknown" (not retried). */
export function toProviderError(
  error: unknown,
  platform: AdPlatform,
  operation: ProviderOperation,
): ProviderError {
  if (error instanceof ProviderError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new ProviderError({ kind: "unknown", platform, operation, message, cause: error });
}

// ---------------------------------------------------------------------------
// Mapping (provider record -> canonical row) failures
// ---------------------------------------------------------------------------

export const MAPPING_ERROR_REASONS = [
  "platform_mismatch",
  "account_mismatch",
  "currency_mismatch",
  "unresolved_entity",
  "invalid_record",
] as const;
export type MappingErrorReason = (typeof MAPPING_ERROR_REASONS)[number];

export class MappingError extends Error {
  readonly reason: MappingErrorReason;
  readonly details: Readonly<Record<string, string>>;

  constructor(reason: MappingErrorReason, message: string, details: Record<string, string> = {}) {
    super(message);
    this.name = "MappingError";
    this.reason = reason;
    this.details = Object.freeze({ ...details });
  }
}
