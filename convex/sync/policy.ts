import { fnv1a } from "../providers/hash";
import { SYNC_LIMITS } from "./config";

/**
 * Pure retry/error policy (docs/sync.md "Retry and error policy"). Only
 * provider `rate_limited` and `transient` errors are retried; everything else
 * fails, skips, blocks the account, or requires re-authorization.
 */

/** Where a failure came from. Provider kinds are the Phase 3 ProviderError kinds. */
export type SyncFailure =
  | {
      source: "provider";
      kind:
        | "auth"
        | "permission"
        | "not_found"
        | "rate_limited"
        | "transient"
        | "invalid_request"
        | "unsupported"
        | "data"
        | "unknown";
      retryAfterMs?: number;
      code?: string;
    }
  /** Credential could not be used (connection inactive/deleted). */
  | { source: "credential"; kind: "credential_unavailable" }
  /** Page rejected by a sync guard or by mapping scope checks. */
  | { source: "guard"; kind: GuardFailureKind }
  /** The account's currency/timezone/type changed at the platform. */
  | { source: "account"; kind: "account_changed" }
  /** Anything else (missing encryption key, bugs). Never retried. */
  | { source: "internal"; kind: "internal" };

export type GuardFailureKind =
  | "cursor_loop"
  | "page_limit"
  | "empty_page_limit"
  | "page_too_large"
  | "out_of_scope"
  | "duplicate_keys"
  | "invalid_record"
  | "stale_lease";

export type TaskCounters = {
  attempt: number;
  pageTransientFailures: number;
  rateLimitHits: number;
  hasCursor: boolean;
  restartedFromScratch: boolean;
};

export type FailureDecision =
  | { action: "retry"; delayMs: number; transient: boolean; throttle: boolean }
  | { action: "restart" }
  | { action: "fail_task" }
  | { action: "skip_task" }
  | { action: "block_account" }
  | { action: "reauth" }
  | { action: "cancel_run" };

/** Deterministic jitter in [0, 20%) of `delayMs`, keyed by task and attempt. */
export function jitter(delayMs: number, key: string): number {
  return Math.floor(((fnv1a(key) % 1000) / 1000) * 0.2 * delayMs);
}

export function transientDelayMs(failures: number, key: string): number {
  const base = Math.min(
    SYNC_LIMITS.transientBaseDelayMs * 2 ** Math.min(failures - 1, 16),
    SYNC_LIMITS.transientMaxDelayMs,
  );
  return Math.min(base + jitter(base, key), SYNC_LIMITS.transientMaxDelayMs);
}

export function rateLimitDelayMs(hits: number, retryAfterMs: number | undefined, key: string) {
  const backoff = SYNC_LIMITS.rateLimitBaseDelayMs * 2 ** Math.min(hits - 1, 16);
  const base = Math.max(retryAfterMs ?? 0, backoff);
  return Math.min(base + jitter(base, key), SYNC_LIMITS.maxBackoffMs);
}

/**
 * Decides what to do with a failed page. `counters` describe the task BEFORE
 * this failure; `key` makes the jitter deterministic (task id).
 */
export function decideFailure(
  failure: SyncFailure,
  counters: TaskCounters,
  key: string,
): FailureDecision {
  switch (failure.source) {
    case "credential":
      return { action: "cancel_run" };
    case "account":
      return { action: "block_account" };
    case "guard":
    case "internal":
      return { action: "fail_task" };
    case "provider":
      break;
  }
  switch (failure.kind) {
    case "auth":
      return { action: "reauth" };
    case "permission":
    case "not_found":
      return { action: "block_account" };
    case "rate_limited": {
      const hits = counters.rateLimitHits + 1;
      if (hits >= SYNC_LIMITS.maxRateLimitHits) return { action: "fail_task" };
      return {
        action: "retry",
        delayMs: rateLimitDelayMs(hits, failure.retryAfterMs, `${key}:rl:${hits}`),
        transient: false,
        throttle: true,
      };
    }
    case "transient": {
      const failures = counters.pageTransientFailures + 1;
      if (failures >= SYNC_LIMITS.maxPageAttempts) return { action: "fail_task" };
      return {
        action: "retry",
        delayMs: transientDelayMs(failures, `${key}:tr:${counters.attempt}`),
        transient: true,
        throttle: false,
      };
    }
    case "invalid_request":
      // Cursors can expire at the platform: restart the task once from page 1.
      return counters.hasCursor && !counters.restartedFromScratch
        ? { action: "restart" }
        : { action: "fail_task" };
    case "unsupported":
      return { action: "skip_task" };
    case "data":
    case "unknown":
      return { action: "fail_task" };
  }
}

const PROVIDER_KINDS = new Set([
  "auth",
  "permission",
  "not_found",
  "rate_limited",
  "transient",
  "invalid_request",
  "unsupported",
  "data",
  "unknown",
]);
const GUARD_KINDS = new Set([
  "cursor_loop",
  "page_limit",
  "empty_page_limit",
  "page_too_large",
  "out_of_scope",
  "duplicate_keys",
  "invalid_record",
  "stale_lease",
]);

/** Parses a serialized failure; anything unrecognized is an internal failure (never retried). */
export function toSyncFailure(raw: {
  source: string;
  kind: string;
  retryAfterMs?: number;
  code?: string;
}): SyncFailure {
  if (raw.source === "provider" && PROVIDER_KINDS.has(raw.kind)) {
    return {
      source: "provider",
      kind: raw.kind as Extract<SyncFailure, { source: "provider" }>["kind"],
      ...(raw.retryAfterMs !== undefined ? { retryAfterMs: raw.retryAfterMs } : {}),
      ...(raw.code !== undefined ? { code: raw.code } : {}),
    };
  }
  if (raw.source === "credential") return { source: "credential", kind: "credential_unavailable" };
  if (raw.source === "guard" && GUARD_KINDS.has(raw.kind)) {
    return { source: "guard", kind: raw.kind as GuardFailureKind };
  }
  if (raw.source === "account") return { source: "account", kind: "account_changed" };
  return { source: "internal", kind: "internal" };
}

/** Kinds that block an account (cleared, with an audit entry, by the next successful run). */
export const BLOCKING_KINDS: ReadonlySet<string> = new Set([
  "permission",
  "not_found",
  "account_changed",
]);

export function isBlockingError(error: { kind: string } | undefined): boolean {
  return error !== undefined && BLOCKING_KINDS.has(error.kind);
}

/**
 * lastError precedence for NON-successful outcomes. A blocking reason is kept
 * until a newer blocking reason replaces it or a successful run clears it (and
 * audits sync.account_unblocked). Non-blocking outcomes (inactive connection,
 * cancellation, auth, transient failures, ...) never overwrite it; they are
 * still recorded on the run, the connection and the audit log.
 */
export function retainBlockingError<T extends { kind: string }>(
  current: T | undefined,
  incoming: T,
): T {
  return isBlockingError(current) && !isBlockingError(incoming) ? current! : incoming;
}

const GENERIC_MESSAGES: Record<string, string> = {
  auth: "Re-authorization required",
  permission: "No access to this ad account",
  not_found: "Ad account not found or not accessible",
  rate_limited: "Platform rate limit reached",
  transient: "Platform temporarily unavailable",
  invalid_request: "The platform rejected the request",
  unsupported: "Operation not supported by the platform",
  data: "The platform returned invalid data",
  unknown: "Unexpected platform error",
  credential_unavailable: "Connection credential unavailable",
  account_changed: "Ad account currency, timezone or type changed at the platform",
  internal: "Internal sync error",
  cursor_loop: "Pagination did not advance",
  page_limit: "Too many pages",
  empty_page_limit: "Too many empty pages",
  page_too_large: "Page exceeded the size limit",
  out_of_scope: "Records outside the requested scope",
  duplicate_keys: "Duplicate records in one page",
  invalid_record: "Invalid records",
  stale_lease: "Task stalled repeatedly",
  suspicious_empty_listing: "Removal marking skipped: listing removed too many entities",
  connection_inactive: "Connection is not active",
};

/** Sanitized, storable error: kind + optional platform code + a GENERIC message. */
export function sanitizeFailure(
  failure: SyncFailure | { kind: string; code?: string },
  at: number,
) {
  const code = "code" in failure && typeof failure.code === "string" ? failure.code : undefined;
  return {
    kind: failure.kind,
    ...(code !== undefined ? { code: code.slice(0, 64) } : {}),
    message: GENERIC_MESSAGES[failure.kind] ?? "Sync error",
    at,
  };
}
