import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import {
  isSyncErrorReason,
  SYNC_ERROR_REASONS,
  syncErrorReason,
  toPublicSyncStatus,
} from "./publicStatus";

// The public sync view exposes only DTO-safe fields: the platform error `code` never leaves
// the server, and only allowlisted codes become a `reason`.

function syncAccount(overrides: Partial<Doc<"syncAccounts">> = {}): Doc<"syncAccounts"> {
  return {
    _id: "s1" as Id<"syncAccounts">,
    _creationTime: 0,
    orgId: "o1" as Id<"organizations">,
    adAccountId: "a1" as Id<"adAccounts">,
    state: "idle",
    structureStale: false,
    consecutiveFailures: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  } as Doc<"syncAccounts">;
}

describe("syncErrorReason", () => {
  it.each([
    ["CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION", "cloud_project_not_approved_for_production"],
    ["google_config_invalid", "provider_config_invalid"],
    ["DEVELOPER_TOKEN_NOT_APPROVED", "provider_config_invalid"],
    ["invalid_grant", "reauth_required"],
    ["client_id_mismatch", "reauth_required"],
    ["provider_mode_missing", "provider_mode_misconfigured"],
    ["no_route", "account_not_accessible"],
    ["RESOURCE_EXHAUSTED", "rate_limited"],
    ["NOT_ADS_USER", "not_ads_user"],
    [
      "api_access:CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
      "cloud_project_not_approved_for_production",
    ],
  ])("%s → %s", (code, reason) => {
    expect(syncErrorReason(code)).toBe(reason);
  });

  it.each([undefined, "", "190", "SOMETHING_NEW", "toString", "__proto__", "fakeRequestId123"])(
    "drops non-allowlisted code %s",
    (code) => {
      expect(syncErrorReason(code)).toBeUndefined();
    },
  );

  it("every mapped reason is a published reason", () => {
    for (const code of [
      "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
      "google_config_invalid",
      "invalid_grant",
      "USER_PERMISSION_DENIED",
      "CUSTOMER_NOT_ENABLED",
      "CUSTOMER_NOT_FOUND",
      "provider_unavailable",
      "NOT_ADS_USER",
    ]) {
      expect(SYNC_ERROR_REASONS).toContain(syncErrorReason(code));
    }
  });
});

describe("syncErrorReason for Meta Ads (code + classified kind)", () => {
  const meta = (code: string | undefined, kind: string) =>
    syncErrorReason(code, { platform: "meta", kind });

  it.each([
    // Expired or invalid token, and a credential this app can no longer use.
    ["190", "auth", "reauth_required"],
    ["190/463", "auth", "reauth_required"],
    ["102", "auth", "reauth_required"],
    ["http_401", "auth", "reauth_required"],
    ["credential_invalid", "auth", "reauth_required"],
    ["app_id_mismatch", "auth", "reauth_required"],
    // A permission code whose ads_read probe found the grant gone is "auth" ...
    ["200", "auth", "reauth_required"],
    // ... otherwise it is a missing permission on this account.
    ["200", "permission", "permission_denied"],
    ["10", "permission", "permission_denied"],
    ["http_403", "permission", "permission_denied"],
    // Throttling (app, user, ad-account and business use case limits).
    ["4", "rate_limited", "rate_limited"],
    ["17", "rate_limited", "rate_limited"],
    ["613", "rate_limited", "rate_limited"],
    ["80004", "rate_limited", "rate_limited"],
    // Missing or inaccessible ad account.
    ["100/33", "not_found", "account_not_accessible"],
    ["803", "not_found", "account_not_found"],
    // Missing or invalid configuration (also staged, as recorded by OAuth diagnostics).
    ["meta_config_invalid", "unknown", "provider_config_invalid"],
    ["config:meta_config_invalid", "unknown", "provider_config_invalid"],
    ["provider_mode_missing", "unknown", "provider_mode_misconfigured"],
    ["provider_unavailable", "auth", "provider_unavailable"],
  ])("%s (%s) → %s", (code, kind, reason) => {
    expect(meta(code, kind)).toBe(reason);
    expect(SYNC_ERROR_REASONS).toContain(reason);
  });

  it.each([
    [undefined, "unknown"],
    ["", "unknown"],
    ["1", "transient"],
    ["100/1487534", "transient"],
    ["insights_row_too_large", "data"],
    ["invalid_json", "data"],
    ["2635", "invalid_request"],
    ["SOMETHING_NEW", "unknown"],
    ["toString", "unknown"],
    ["__proto__", "__proto__"],
    ["17", "constructor"],
  ])("explains nothing for %s (%s)", (code, kind) => {
    expect(meta(code, kind)).toBeUndefined();
  });

  it.each([
    "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
    "NOT_ADS_USER",
    "RESOURCE_EXHAUSTED",
    "CUSTOMER_NOT_FOUND",
    "invalid_grant",
  ])("a Google code (%s) never explains a Meta error", (code) => {
    expect(meta(code, "unknown")).toBeUndefined();
  });

  it("Google Ads keeps the code-only allowlist (the kind is ignored)", () => {
    expect(syncErrorReason("NOT_ADS_USER", { platform: "google_ads", kind: "auth" })).toBe(
      "not_ads_user",
    );
    expect(syncErrorReason("190", { platform: "google_ads", kind: "auth" })).toBeUndefined();
    expect(syncErrorReason("SOMETHING", { platform: "google_ads", kind: "rate_limited" })).toBe(
      undefined,
    );
  });
});

describe("isSyncErrorReason", () => {
  it("accepts every published reason and nothing else", () => {
    for (const reason of SYNC_ERROR_REASONS) expect(isSyncErrorReason(reason)).toBe(true);
    for (const value of [undefined, null, 1, "", "NOT_ADS_USER", "toString", "__proto__"]) {
      expect(isSyncErrorReason(value)).toBe(false);
    }
  });
});

describe("toPublicSyncStatus", () => {
  it("exposes state, schedule, coverage and a sanitized error; never the code", () => {
    const status = toPublicSyncStatus(
      syncAccount({
        state: "idle",
        lastSuccessAt: Date.UTC(2026, 2, 8),
        nextPlanAt: Date.UTC(2026, 2, 8, 1),
        coveredFrom: "2026-02-07",
        coveredThrough: "2026-03-07",
        consecutiveFailures: 2,
        lastError: {
          kind: "unknown",
          code: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
          message: "Unexpected platform error",
          at: Date.UTC(2026, 2, 8, 2),
        },
      }),
      { status: "failed" },
    );
    expect(status).toEqual({
      syncState: "idle",
      lastSuccessAt: "2026-03-08T00:00:00.000Z",
      lastRunStatus: "failed",
      consecutiveFailures: 2,
      nextRunAt: "2026-03-08T01:00:00.000Z",
      coveredFrom: "2026-02-07",
      coveredThrough: "2026-03-07",
      lastError: {
        kind: "unknown",
        message: "Unexpected platform error",
        reason: "cloud_project_not_approved_for_production",
        at: "2026-03-08T02:00:00.000Z",
      },
    });
    expect(JSON.stringify(status)).not.toContain("CLOUD_PROJECT");
  });

  it("an unknown code keeps only kind + generic message", () => {
    const status = toPublicSyncStatus(
      syncAccount({
        lastError: {
          kind: "transient",
          code: "http_503",
          message: "Platform temporarily unavailable",
          at: 1,
        },
      }),
      null,
    );
    expect(status.lastError).toEqual({
      kind: "transient",
      message: "Platform temporarily unavailable",
      at: "1970-01-01T00:00:00.001Z",
    });
    expect(status).not.toHaveProperty("lastRunStatus");
  });

  it("explains a Meta Ads error from its code and kind; never the code", () => {
    const error = (kind: string, code: string) =>
      syncAccount({ lastError: { kind, code, message: "Re-authorization required", at: 1 } });
    const expired = toPublicSyncStatus(error("auth", "190/460"), null, "meta");
    expect(expired.lastError).toEqual({
      kind: "auth",
      message: "Re-authorization required",
      reason: "reauth_required",
      at: "1970-01-01T00:00:00.001Z",
    });
    expect(JSON.stringify(expired)).not.toContain("190");
    // The same code on a Google Ads account keeps the code-only allowlist (no reason).
    expect(
      toPublicSyncStatus(error("auth", "190/460"), null, "google_ads").lastError,
    ).not.toHaveProperty("reason");
  });
});
