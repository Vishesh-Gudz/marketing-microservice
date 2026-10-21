import { describe, expect, it } from "vitest";
import { apiError } from "@/convex/lib/errors";
import {
  connectionActionNotice,
  connectionStatusNotice,
  discoveryErrorNotice,
  ERROR_REASON_MESSAGES,
  syncStatusSummary,
} from "./messages";
import type { ConnectionError, ErrorReason, SyncStatus } from "./types";

const AT = "2026-03-08T15:00:00.000Z";
const REASONS = Object.keys(ERROR_REASON_MESSAGES) as ErrorReason[];
const RAW_CODES = [
  "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
  "NOT_ADS_USER",
  "USER_PERMISSION_DENIED",
  "RESOURCE_EXHAUSTED",
  "invalid_grant",
];

function sync(overrides: Partial<SyncStatus> = {}): SyncStatus {
  return { syncState: "idle", consecutiveFailures: 0, ...overrides };
}

describe("ERROR_REASON_MESSAGES", () => {
  it("has distinct, code-free text for every reason", () => {
    const texts = REASONS.map((reason) => ERROR_REASON_MESSAGES[reason]);
    expect(new Set(texts).size).toBe(REASONS.length);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
      for (const code of RAW_CODES) expect(text).not.toContain(code);
      expect(text).not.toMatch(/[a-z]+_[a-z_]+/); // no snake_case reason keys either
    }
  });
});

describe("connectionStatusNotice", () => {
  const base = { status: "active" as const, missingScopes: [], expiresSoon: false };

  it.each([
    ["active", base, "success", "Connected"],
    [
      "active with a missing scope",
      { ...base, missingScopes: ["x"] },
      "warning",
      "Google Ads access is missing",
    ],
    ["active and expiring soon", { ...base, expiresSoon: true }, "info", "Access expires soon"],
    [
      "needing reauthorization",
      { ...base, status: "needs_reauth" },
      "warning",
      "Reconnect required",
    ],
    ["revoked", { ...base, status: "revoked" }, "error", "Disconnected"],
  ] as const)("describes a connection %s", (_label, connection, tone, title) => {
    expect(connectionStatusNotice(connection)).toMatchObject({ tone, title });
  });

  it("a missing scope wins over expiring soon, and never lists scope strings", () => {
    const notice = connectionStatusNotice({
      ...base,
      missingScopes: ["https://www.googleapis.com/auth/adwords"],
      expiresSoon: true,
    });
    expect(notice.title).toBe("Google Ads access is missing");
    expect(JSON.stringify(notice)).not.toContain("googleapis");
  });
});

describe("discoveryErrorNotice", () => {
  const error = (overrides: Partial<ConnectionError> = {}): ConnectionError => ({
    kind: "unknown",
    message: "The platform request failed",
    at: AT,
    ...overrides,
  });

  it("is null without an error", () => {
    expect(discoveryErrorNotice(undefined)).toBeNull();
  });

  it.each(REASONS)("explains the allowlisted reason %s", (reason) => {
    expect(discoveryErrorNotice(error({ reason }))).toEqual({
      tone: "error",
      title: "Your Google Ads accounts could not be loaded",
      message: ERROR_REASON_MESSAGES[reason],
    });
  });

  it.each([
    ["auth", "error", ERROR_REASON_MESSAGES.reauth_required],
    ["rate_limited", "warning", "Google Ads did not respond. Retry discovery in a few minutes."],
    ["transient", "warning", "Google Ads did not respond. Retry discovery in a few minutes."],
    ["unknown", "error", "Retry discovery. If it keeps failing, reconnect Google Ads."],
    ["internal", "error", "Retry discovery. If it keeps failing, reconnect Google Ads."],
    ["something_new", "error", "Retry discovery. If it keeps failing, reconnect Google Ads."],
  ])("falls back on the error kind %s without a reason", (kind, tone, message) => {
    expect(discoveryErrorNotice(error({ kind }))).toMatchObject({ tone, message });
  });

  it("never shows the server message or an unexpected reason value", () => {
    const notice = discoveryErrorNotice(
      error({
        message: "raw provider text NOT_ADS_USER",
        reason: "NOT_ADS_USER" as ErrorReason,
      }),
    );
    expect(JSON.stringify(notice)).not.toContain("raw provider text");
    expect(JSON.stringify(notice)).not.toContain("NOT_ADS_USER");
  });
});

describe("syncStatusSummary", () => {
  it("before any sync state: first sync scheduled", () => {
    expect(syncStatusSummary(undefined)).toMatchObject({
      tone: "info",
      label: "First sync scheduled",
    });
  });

  it.each([
    ["parked", sync({ syncState: "parked" }), "info", "Not syncing"],
    ["running", sync({ syncState: "running" }), "info", "Syncing…"],
    ["blocked", sync({ syncState: "blocked" }), "error", "Sync blocked"],
    ["idle, never run", sync(), "info", "First sync scheduled"],
    ["idle, queued", sync({ lastRunStatus: "queued" }), "info", "Syncing…"],
    ["idle, running", sync({ lastRunStatus: "running" }), "info", "Syncing…"],
    ["idle, succeeded", sync({ lastRunStatus: "succeeded" }), "success", "Up to date"],
    ["idle, partial", sync({ lastRunStatus: "partial" }), "warning", "Last sync partly completed"],
    ["idle, failed", sync({ lastRunStatus: "failed" }), "warning", "Last sync failed"],
    ["idle, cancelled", sync({ lastRunStatus: "cancelled" }), "info", "Last sync was cancelled"],
    ["idle, run pruned but succeeded before", sync({ lastSuccessAt: AT }), "success", "Up to date"],
  ] as const)("%s", (_label, status, tone, label) => {
    expect(syncStatusSummary(status)).toMatchObject({ tone, label });
  });

  it("shows coverage when up to date", () => {
    expect(
      syncStatusSummary(sync({ lastRunStatus: "succeeded", coveredThrough: "2026-03-07" })),
    ).toEqual({ tone: "success", label: "Up to date", detail: "Data through 2026-03-07." });
    expect(syncStatusSummary(sync({ lastRunStatus: "succeeded" }))).not.toHaveProperty("detail");
  });

  it("counts consecutive failures and explains an allowlisted reason", () => {
    const summary = syncStatusSummary(
      sync({
        lastRunStatus: "failed",
        consecutiveFailures: 3,
        lastError: {
          kind: "unknown",
          message: "x",
          reason: "cloud_project_not_approved_for_production",
          at: AT,
        },
      }),
    );
    expect(summary).toEqual({
      tone: "warning",
      label: "Last sync failed (3 failures in a row)",
      detail: ERROR_REASON_MESSAGES.cloud_project_not_approved_for_production,
    });
    expect(syncStatusSummary(sync({ lastRunStatus: "failed", consecutiveFailures: 1 })).label).toBe(
      "Last sync failed",
    );
  });

  it("a blocked or partial sync explains its reason, else a generic line", () => {
    const blocked = (reason?: ErrorReason) =>
      syncStatusSummary(
        sync({
          syncState: "blocked",
          lastRunStatus: "failed",
          ...(reason ? { lastError: { kind: "permission", message: "x", reason, at: AT } } : {}),
        }),
      ).detail;
    expect(blocked("permission_denied")).toBe(ERROR_REASON_MESSAGES.permission_denied);
    expect(blocked()).toMatch(/checked again every 24 hours/);
    expect(
      syncStatusSummary(
        sync({
          lastRunStatus: "partial",
          lastError: { kind: "rate_limited", message: "x", reason: "rate_limited", at: AT },
        }),
      ).detail,
    ).toBe(ERROR_REASON_MESSAGES.rate_limited);
  });

  it("never shows the server message", () => {
    const summary = syncStatusSummary(
      sync({
        lastRunStatus: "failed",
        lastError: { kind: "unknown", message: "raw provider text", at: AT },
      }),
    );
    expect(JSON.stringify(summary)).not.toContain("raw provider text");
  });
});

describe("connectionActionNotice", () => {
  it.each([
    [
      "a return URL outside the allowlist",
      apiError("INVALID_ARGUMENT", "x", { field: "returnUrl" }),
      "This dashboard address is not allowed",
    ],
    [
      "an unconfigured provider",
      apiError("INVALID_ARGUMENT", "x", { field: "provider" }),
      "Google Ads is not available",
    ],
    [
      "an unknown manager status",
      apiError("INVALID_ARGUMENT", "x", { externalId: "1", reason: "manager_status_unknown" }),
      "Account type not confirmed",
    ],
    [
      "a manager account",
      apiError("INVALID_ARGUMENT", "x", { externalId: "1" }),
      "This account cannot be linked",
    ],
    ["a missing connection or account", apiError("NOT_FOUND", "x"), "Not found"],
    [
      "an inactive connection",
      apiError("CONFLICT", "x", { reason: "connection_inactive" }),
      "Connection not active",
    ],
    ["another conflict", apiError("CONFLICT", "x"), "Conflicting change"],
    ["too many pending sign-ins", apiError("RATE_LIMITED", "x"), "Too many attempts"],
    ["a non-admin", apiError("FORBIDDEN", "x"), "Admins only"],
    ["a disabled app", apiError("APP_DISABLED", "x"), "Integration disabled"],
    ["a provider failure", apiError("PROVIDER_ERROR", "x"), "Google Ads did not respond"],
    ["a missing token", apiError("UNAUTHENTICATED", "x"), "Sign-in required"],
    ["bad token claims", apiError("INVALID_TOKEN_CLAIMS", "x"), "Sign-in required"],
    ["an unregistered app", apiError("APP_NOT_REGISTERED", "x"), "Sign-in required"],
    ["an unprovisioned org", apiError("ORG_NOT_PROVISIONED", "x"), "Organization not ready"],
    ["an internal error", apiError("INTERNAL", "x"), "Something went wrong"],
    ["a plain Error", new Error("x"), "Something went wrong"],
    ["a thrown string", "x", "Something went wrong"],
    ["nothing", undefined, "Something went wrong"],
  ])("explains %s", (_label, error, title) => {
    const notice = connectionActionNotice(error);
    expect(notice.title).toBe(title);
    expect(notice.message.length).toBeGreaterThan(0);
  });

  it("never shows error messages or details", () => {
    for (const error of [
      apiError("INVALID_ARGUMENT", "secret server detail", { field: "returnUrl" }),
      apiError("INTERNAL", "secret server detail"),
      new Error("secret server detail ya29.token"),
    ]) {
      const text = JSON.stringify(connectionActionNotice(error));
      expect(text).not.toContain("secret server detail");
      expect(text).not.toContain("ya29");
    }
  });
});
