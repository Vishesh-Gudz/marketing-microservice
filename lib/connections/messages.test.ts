import { describe, expect, it } from "vitest";
import { apiError } from "@/convex/lib/errors";
import {
  connectionActionNotice,
  connectionStatusNotice,
  disconnectedNotice,
  disconnectActionNotice,
  discoveryErrorNotice,
  ERROR_REASON_MESSAGES,
  META_ERROR_REASON_MESSAGES,
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
    expect(connectionStatusNotice(connection, "google_ads")).toMatchObject({ tone, title });
  });

  it("a reconnect-required connection mentions disconnecting to switch Google accounts", () => {
    expect(
      connectionStatusNotice({ ...base, status: "needs_reauth" }, "google_ads").message,
    ).toMatch(/same Google account, or disconnect Google Ads to use a different one/);
  });

  it("a missing scope wins over expiring soon, and never lists scope strings", () => {
    const notice = connectionStatusNotice(
      {
        ...base,
        missingScopes: ["https://www.googleapis.com/auth/adwords"],
        expiresSoon: true,
      },
      "google_ads",
    );
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
    expect(discoveryErrorNotice(undefined, "google_ads")).toBeNull();
  });

  it.each(REASONS)("explains the allowlisted reason %s", (reason) => {
    expect(discoveryErrorNotice(error({ reason }), "google_ads")).toEqual({
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
    expect(discoveryErrorNotice(error({ kind }), "google_ads")).toMatchObject({ tone, message });
  });

  it("never shows the server message or an unexpected reason value", () => {
    const notice = discoveryErrorNotice(
      error({
        message: "raw provider text NOT_ADS_USER",
        reason: "NOT_ADS_USER" as ErrorReason,
      }),
      "google_ads",
    );
    expect(JSON.stringify(notice)).not.toContain("raw provider text");
    expect(JSON.stringify(notice)).not.toContain("NOT_ADS_USER");
  });
});

describe("syncStatusSummary", () => {
  it("before any sync state: first sync scheduled", () => {
    expect(syncStatusSummary(undefined, "google_ads")).toMatchObject({
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
    expect(syncStatusSummary(status, "google_ads")).toMatchObject({ tone, label });
  });

  it("shows coverage when up to date", () => {
    expect(
      syncStatusSummary(
        sync({ lastRunStatus: "succeeded", coveredThrough: "2026-03-07" }),
        "google_ads",
      ),
    ).toEqual({ tone: "success", label: "Up to date", detail: "Data through 2026-03-07." });
    expect(
      syncStatusSummary(sync({ lastRunStatus: "succeeded" }), "google_ads"),
    ).not.toHaveProperty("detail");
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
      "google_ads",
    );
    expect(summary).toEqual({
      tone: "warning",
      label: "Last sync failed (3 failures in a row)",
      detail: ERROR_REASON_MESSAGES.cloud_project_not_approved_for_production,
    });
    expect(
      syncStatusSummary(sync({ lastRunStatus: "failed", consecutiveFailures: 1 }), "google_ads")
        .label,
    ).toBe("Last sync failed");
  });

  it("a blocked or partial sync explains its reason, else a generic line", () => {
    const blocked = (reason?: ErrorReason) =>
      syncStatusSummary(
        sync({
          syncState: "blocked",
          lastRunStatus: "failed",
          ...(reason ? { lastError: { kind: "permission", message: "x", reason, at: AT } } : {}),
        }),
        "google_ads",
      ).detail;
    expect(blocked("permission_denied")).toBe(ERROR_REASON_MESSAGES.permission_denied);
    expect(blocked()).toMatch(/checked again every 24 hours/);
    expect(
      syncStatusSummary(
        sync({
          lastRunStatus: "partial",
          lastError: { kind: "rate_limited", message: "x", reason: "rate_limited", at: AT },
        }),
        "google_ads",
      ).detail,
    ).toBe(ERROR_REASON_MESSAGES.rate_limited);
  });

  it("never shows the server message", () => {
    const summary = syncStatusSummary(
      sync({
        lastRunStatus: "failed",
        lastError: { kind: "unknown", message: "raw provider text", at: AT },
      }),
      "google_ads",
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
    const notice = connectionActionNotice(error, "google_ads");
    expect(notice.title).toBe(title);
    expect(notice.message.length).toBeGreaterThan(0);
  });

  it("never shows error messages or details", () => {
    for (const error of [
      apiError("INVALID_ARGUMENT", "secret server detail", { field: "returnUrl" }),
      apiError("INTERNAL", "secret server detail"),
      new Error("secret server detail ya29.token"),
    ]) {
      const text = JSON.stringify(connectionActionNotice(error, "google_ads"));
      expect(text).not.toContain("secret server detail");
      expect(text).not.toContain("ya29");
    }
  });
});

describe("disconnectActionNotice", () => {
  it.each([
    ["a non-admin", apiError("FORBIDDEN", "x"), "Admins only", /disconnect Google Ads/],
    ["a missing connection", apiError("NOT_FOUND", "x"), "Connection not found", /Reload/],
    ["too many requests", apiError("RATE_LIMITED", "x"), "Too many attempts", /Wait/],
    ["a missing token", apiError("UNAUTHENTICATED", "x"), "Sign-in required", /./],
    ["an internal error", apiError("INTERNAL", "x"), "Something went wrong", /Try again/],
    ["a network failure", new Error("x"), "Something went wrong", /not disconnected/],
  ])("explains %s", (_label, error, title, message) => {
    const notice = disconnectActionNotice(error, "google_ads");
    expect(notice.title).toBe(title);
    expect(notice.message).toMatch(message);
  });

  it("never shows error messages or details", () => {
    for (const error of [
      apiError("FORBIDDEN", "secret server detail"),
      apiError("INTERNAL", "secret server detail"),
      new Error("secret server detail ya29.token"),
    ]) {
      const text = JSON.stringify(disconnectActionNotice(error, "google_ads"));
      expect(text).not.toContain("secret server detail");
      expect(text).not.toContain("ya29");
    }
  });

  it("confirms a disconnect and points to a fresh connection", () => {
    expect(disconnectedNotice("google_ads")).toMatchObject({
      tone: "success",
      title: "Google Ads disconnected",
    });
    expect(disconnectedNotice("google_ads").message).toMatch(/data and history are kept/);
    expect(disconnectedNotice("google_ads").message).toMatch(/any Google account/);
  });
});

describe("Meta Ads wording (never Google's)", () => {
  const base = { status: "active" as const, missingScopes: [], expiresSoon: false };
  const error = (overrides: Partial<ConnectionError> = {}): ConnectionError => ({
    kind: "unknown",
    message: "Meta request failed (unknown)",
    at: AT,
    ...overrides,
  });

  it("has distinct, code-free Meta text for every reason", () => {
    expect(Object.keys(META_ERROR_REASON_MESSAGES).sort()).toEqual([...REASONS].sort());
    const texts = REASONS.map((reason) => META_ERROR_REASON_MESSAGES[reason]);
    expect(new Set(texts).size).toBe(REASONS.length);
    for (const text of texts) {
      expect(text).toMatch(/Meta|Facebook/);
      expect(text).not.toContain("Google");
      for (const code of [...RAW_CODES, "190", "ads_read", "Graph"])
        expect(text).not.toContain(code);
      expect(text).not.toMatch(/[a-z]+_[a-z_]+/);
    }
  });

  it.each([
    ["active", base, "success", "Connected", "Meta Ads is connected."],
    [
      "active with a missing scope",
      { ...base, missingScopes: ["ads_read"] },
      "warning",
      "Meta Ads access is missing",
      "Reconnect and allow access to Meta Ads when Meta asks.",
    ],
    [
      "active and expiring soon (Meta tokens last about 60 days)",
      { ...base, expiresSoon: true },
      "info",
      "Access expires soon",
      "Reconnect Meta Ads soon to keep syncing.",
    ],
    [
      "needing reauthorization",
      { ...base, status: "needs_reauth" },
      "warning",
      "Reconnect required",
      "Meta access expired or was revoked. Reconnect with the same Facebook account, or disconnect Meta Ads to use a different one.",
    ],
    [
      "revoked",
      { ...base, status: "revoked" },
      "error",
      "Disconnected",
      "This Meta Ads connection was disconnected. Connect again to resume syncing.",
    ],
  ] as const)("describes a Meta connection %s", (_label, connection, tone, title, message) => {
    const notice = connectionStatusNotice(connection, "meta");
    expect(notice).toEqual({ tone, title, message });
    expect(JSON.stringify(notice)).not.toContain("ads_read");
  });

  it.each(REASONS)("explains a Meta discovery failure with reason %s in Meta words", (reason) => {
    expect(discoveryErrorNotice(error({ reason }), "meta")).toEqual({
      tone: "error",
      title: "Your Meta ad accounts could not be loaded",
      message: META_ERROR_REASON_MESSAGES[reason],
    });
  });

  it.each([
    ["auth", "error", META_ERROR_REASON_MESSAGES.reauth_required],
    ["rate_limited", "warning", "Meta Ads did not respond. Retry discovery in a few minutes."],
    ["unknown", "error", "Retry discovery. If it keeps failing, reconnect Meta Ads."],
  ])("falls back on the Meta error kind %s without a reason", (kind, tone, message) => {
    expect(discoveryErrorNotice(error({ kind }), "meta")).toMatchObject({ tone, message });
  });

  it("explains Meta sync states with Meta reasons and a Meta default", () => {
    expect(syncStatusSummary(sync({ syncState: "blocked" }), "meta").detail).toBe(
      "Meta denied access to this account or it no longer exists. It is checked again every 24 hours.",
    );
    expect(
      syncStatusSummary(
        sync({
          lastRunStatus: "failed",
          lastError: { kind: "permission", message: "x", reason: "permission_denied", at: AT },
        }),
        "meta",
      ).detail,
    ).toBe(META_ERROR_REASON_MESSAGES.permission_denied);
    expect(
      syncStatusSummary(
        sync({
          syncState: "blocked",
          lastError: { kind: "not_found", message: "x", reason: "account_not_accessible", at: AT },
        }),
        "meta",
      ).detail,
    ).toBe(META_ERROR_REASON_MESSAGES.account_not_accessible);
  });

  it.each([
    [apiError("INVALID_ARGUMENT", "x", { field: "provider" }), "Meta Ads is not available"],
    [apiError("FORBIDDEN", "x"), "Admins only"],
    [apiError("PROVIDER_ERROR", "x"), "Meta Ads did not respond"],
    [apiError("CONFLICT", "x", { reason: "connection_inactive" }), "Connection not active"],
    [apiError("INVALID_ARGUMENT", "x", { externalId: "1" }), "This account cannot be linked"],
  ])("explains Meta action errors (%#) in Meta words", (caught, title) => {
    const notice = connectionActionNotice(caught, "meta");
    expect(notice.title).toBe(title);
    expect(JSON.stringify(notice)).not.toContain("Google");
  });

  it("disconnect notices name Meta Ads and the Facebook account", () => {
    expect(disconnectedNotice("meta")).toEqual({
      tone: "success",
      title: "Meta Ads disconnected",
      message:
        "Linked accounts stopped syncing; their data and history are kept. Connect Meta Ads to sign in with any Facebook account.",
    });
    expect(disconnectActionNotice(apiError("FORBIDDEN", "x"), "meta").message).toBe(
      "Only organization admins can disconnect Meta Ads.",
    );
    expect(disconnectActionNotice(new Error("x"), "meta").message).toBe(
      "Meta Ads was not disconnected. Try again.",
    );
  });

  it("no Meta notice ever contains Google wording", () => {
    const notices = [
      ...(["active", "needs_reauth", "revoked"] as const).map((status) =>
        connectionStatusNotice({ ...base, status }, "meta"),
      ),
      connectionStatusNotice({ ...base, missingScopes: ["x"] }, "meta"),
      ...["auth", "rate_limited", "unknown"].map((kind) =>
        discoveryErrorNotice(error({ kind }), "meta"),
      ),
      ...(["parked", "blocked", "running"] as const).map((syncState) =>
        syncStatusSummary(sync({ syncState }), "meta"),
      ),
      ...(["succeeded", "partial", "failed", "cancelled"] as const).map((lastRunStatus) =>
        syncStatusSummary(sync({ lastRunStatus }), "meta"),
      ),
      ...[
        apiError("INVALID_ARGUMENT", "x", { field: "returnUrl" }),
        apiError("INVALID_ARGUMENT", "x", { field: "provider" }),
        apiError("NOT_FOUND", "x"),
        apiError("RATE_LIMITED", "x"),
        apiError("FORBIDDEN", "x"),
        apiError("APP_DISABLED", "x"),
        new Error("x"),
      ].flatMap((caught) => [
        connectionActionNotice(caught, "meta"),
        disconnectActionNotice(caught, "meta"),
      ]),
      disconnectedNotice("meta"),
    ];
    for (const notice of notices) expect(JSON.stringify(notice)).not.toContain("Google");
  });
});

describe("YouTube wording (ADR 0016)", () => {
  const youtube = { status: "active" as const, missingScopes: [] as string[], expiresSoon: false };

  it("names the missing YouTube Analytics access, and reauth in Google's words", () => {
    expect(
      connectionStatusNotice(
        { ...youtube, missingScopes: ["https://www.googleapis.com/auth/yt-analytics.readonly"] },
        "youtube",
      ),
    ).toEqual({
      tone: "warning",
      title: "YouTube Analytics access is missing",
      message:
        "Daily channel metrics cannot sync. Reconnect YouTube and allow access to YouTube Analytics when Google asks.",
    });
    expect(connectionStatusNotice(youtube, "youtube")).toMatchObject({
      tone: "success",
      message: "YouTube is connected.",
    });
    expect(connectionStatusNotice({ ...youtube, status: "needs_reauth" }, "youtube").message).toBe(
      "Google access expired or was revoked. Reconnect with the same Google account, or disconnect YouTube to use a different one.",
    );
    // Google Ads wording is unchanged.
    expect(connectionStatusNotice({ ...youtube, missingScopes: ["x"] }, "google_ads").title).toBe(
      "Google Ads access is missing",
    );
  });

  it("explains purge_pending: the channel's stored data is still being deleted", () => {
    const notice = connectionActionNotice(
      apiError("CONFLICT", "server text", { reason: "purge_pending", externalId: "UCx" }),
      "youtube",
    );
    expect(notice).toEqual({
      tone: "warning",
      title: "Stored data is still being deleted",
      message:
        "This channel's stored YouTube data is still being deleted. Try again in a few minutes.",
    });
    expect(JSON.stringify(notice)).not.toContain("server text");
    expect(connectionActionNotice(apiError("INVALID_ARGUMENT", "x", {}), "youtube").message).toBe(
      "Choose the channel from the discovered list.",
    );
    expect(
      connectionActionNotice(apiError("INVALID_ARGUMENT", "x", { field: "provider" }), "youtube"),
    ).toMatchObject({
      title: "YouTube is not available",
    });
  });

  it("has no Google Ads or Meta reason texts for YouTube", () => {
    const error: ConnectionError = { kind: "auth", message: "x", reason: "not_ads_user", at: AT };
    expect(discoveryErrorNotice(error, "youtube")).toEqual({
      tone: "error",
      title: "Your YouTube channels could not be loaded",
      message: "Google needs you to sign in again. Reconnect YouTube.",
    });
    expect(disconnectActionNotice(apiError("NOT_FOUND", "x"), "youtube").message).toBe(
      "This YouTube connection no longer exists. Reload the page.",
    );
  });
});
