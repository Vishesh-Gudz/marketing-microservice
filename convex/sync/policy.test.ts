import { describe, expect, it } from "vitest";
import { SYNC_LIMITS } from "./config";
import {
  decideFailure,
  isBlockingError,
  retainBlockingError,
  rateLimitDelayMs,
  sanitizeFailure,
  toSyncFailure,
  transientDelayMs,
  type SyncFailure,
  type TaskCounters,
} from "./policy";

const counters: TaskCounters = {
  attempt: 1,
  pageTransientFailures: 0,
  rateLimitHits: 0,
  hasCursor: false,
  restartedFromScratch: false,
};
const provider = (kind: Extract<SyncFailure, { source: "provider" }>["kind"], extra = {}) =>
  ({ source: "provider", kind, ...extra }) as SyncFailure;

describe("provider error kinds", () => {
  it.each([
    ["auth", "reauth"],
    ["permission", "block_account"],
    ["not_found", "block_account"],
    ["invalid_request", "fail_task"],
    ["unsupported", "skip_task"],
    ["data", "fail_task"],
    ["unknown", "fail_task"],
  ] as const)("%s -> %s (never retried)", (kind, action) => {
    expect(decideFailure(provider(kind), counters, "task").action).toBe(action);
  });

  it("retries transient errors with backoff, up to 5 attempts per page", () => {
    const first = decideFailure(provider("transient"), counters, "task");
    expect(first).toMatchObject({ action: "retry", transient: true, throttle: false });
    let state = counters;
    const actions: string[] = [];
    for (let i = 0; i < SYNC_LIMITS.maxPageAttempts; i++) {
      const decision = decideFailure(provider("transient"), state, "task");
      actions.push(decision.action);
      state = {
        ...state,
        attempt: state.attempt + 1,
        pageTransientFailures: state.pageTransientFailures + 1,
      };
    }
    expect(actions).toEqual(["retry", "retry", "retry", "retry", "fail_task"]);
  });

  it("retries rate limits after max(retryAfter, backoff), capped, up to 10 hits", () => {
    const decision = decideFailure(
      provider("rate_limited", { retryAfterMs: 120_000 }),
      counters,
      "t",
    );
    expect(decision).toMatchObject({ action: "retry", throttle: true, transient: false });
    if (decision.action !== "retry") throw new Error("expected retry");
    expect(decision.delayMs).toBeGreaterThanOrEqual(120_000);
    expect(decision.delayMs).toBeLessThanOrEqual(SYNC_LIMITS.maxBackoffMs);
    expect(
      decideFailure(provider("rate_limited"), { ...counters, rateLimitHits: 9 }, "t").action,
    ).toBe("fail_task");
    expect(
      decideFailure(provider("rate_limited"), { ...counters, rateLimitHits: 8 }, "t").action,
    ).toBe("retry");
    // Rate limits do not consume the transient budget.
    expect(
      decideFailure(provider("rate_limited"), { ...counters, pageTransientFailures: 4 }, "t")
        .action,
    ).toBe("retry");
  });

  it("restarts a task once when a cursor is rejected (expired platform cursor)", () => {
    expect(
      decideFailure(provider("invalid_request"), { ...counters, hasCursor: true }, "t"),
    ).toEqual({
      action: "restart",
    });
    expect(
      decideFailure(
        provider("invalid_request"),
        { ...counters, hasCursor: true, restartedFromScratch: true },
        "t",
      ).action,
    ).toBe("fail_task");
  });
});

describe("non-provider failures", () => {
  it("cancels on unusable credentials, blocks on account drift, fails guards and internals", () => {
    expect(
      decideFailure({ source: "credential", kind: "credential_unavailable" }, counters, "t").action,
    ).toBe("cancel_run");
    expect(
      decideFailure({ source: "account", kind: "account_changed" }, counters, "t").action,
    ).toBe("block_account");
    expect(decideFailure({ source: "guard", kind: "cursor_loop" }, counters, "t").action).toBe(
      "fail_task",
    );
    expect(decideFailure({ source: "internal", kind: "internal" }, counters, "t").action).toBe(
      "fail_task",
    );
  });

  it("parses serialized failures strictly (anything unknown is internal)", () => {
    expect(toSyncFailure({ source: "provider", kind: "transient", retryAfterMs: 5 })).toEqual({
      source: "provider",
      kind: "transient",
      retryAfterMs: 5,
    });
    expect(toSyncFailure({ source: "provider", kind: "made_up" })).toEqual({
      source: "internal",
      kind: "internal",
    });
    expect(toSyncFailure({ source: "guard", kind: "nope" })).toEqual({
      source: "internal",
      kind: "internal",
    });
  });
});

describe("backoff and sanitizing", () => {
  it("is deterministic and bounded", () => {
    expect(transientDelayMs(1, "k")).toBe(transientDelayMs(1, "k"));
    expect(transientDelayMs(1, "k")).toBeGreaterThanOrEqual(SYNC_LIMITS.transientBaseDelayMs);
    expect(transientDelayMs(30, "k")).toBeLessThanOrEqual(SYNC_LIMITS.transientMaxDelayMs);
    expect(rateLimitDelayMs(30, 10 * 3_600_000, "k")).toBe(SYNC_LIMITS.maxBackoffMs);
  });

  it("stores only the kind, a bounded code and a generic message", () => {
    const stored = sanitizeFailure({ source: "provider", kind: "data", code: "x".repeat(200) }, 1);
    expect(stored).toEqual({
      kind: "data",
      code: "x".repeat(64),
      message: "The platform returned invalid data",
      at: 1,
    });
  });
});

describe("lastError precedence (blocking reasons)", () => {
  const blocked = { kind: "permission", message: "No access to this ad account", at: 1 };
  const inactive = { kind: "connection_inactive", message: "Connection is not active", at: 2 };
  const drift = { kind: "account_changed", message: "changed", at: 3 };

  it("never lets a non-blocking outcome overwrite a blocking reason", () => {
    expect(retainBlockingError(blocked, inactive)).toBe(blocked);
    expect(retainBlockingError(blocked, { kind: "auth", message: "x", at: 4 })).toBe(blocked);
    expect(retainBlockingError(blocked, { kind: "internal", message: "x", at: 4 })).toBe(blocked);
  });

  it("lets a newer blocking reason replace an older one", () => {
    expect(retainBlockingError(blocked, drift)).toBe(drift);
  });

  it("records non-blocking outcomes normally when nothing is blocking", () => {
    expect(retainBlockingError(undefined, inactive)).toBe(inactive);
    expect(retainBlockingError({ kind: "transient", message: "x", at: 0 }, inactive)).toBe(
      inactive,
    );
    expect(isBlockingError(blocked)).toBe(true);
    expect(isBlockingError(inactive)).toBe(false);
    expect(isBlockingError(undefined)).toBe(false);
  });
});
