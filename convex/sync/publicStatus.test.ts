import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { SYNC_ERROR_REASONS, syncErrorReason, toPublicSyncStatus } from "./publicStatus";

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
    ]) {
      expect(SYNC_ERROR_REASONS).toContain(syncErrorReason(code));
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
});
