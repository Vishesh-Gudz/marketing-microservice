import { describe, expect, it } from "vitest";
import type { GoogleFailure } from "./client";
import { classifyAdsErrorCode, classifyGoogleFailure, googleProviderError } from "./errors";

// Phase 9: classification by structured codes and status only (docs/providers/google-ads.md).

const http = (fields: Partial<Extract<GoogleFailure, { type: "http" }>>): GoogleFailure => ({
  type: "http",
  status: 400,
  adsErrors: [],
  ...fields,
});
const ads = (family: string, code: string, status = 400) =>
  http({ status, adsErrors: [{ family, code }] });

describe("classifyGoogleFailure", () => {
  it.each([
    [ads("authenticationError", "OAUTH_TOKEN_INVALID", 401), "auth", "OAUTH_TOKEN_INVALID"],
    [ads("authenticationError", "NOT_ADS_USER", 401), "auth", "NOT_ADS_USER"],
    [ads("authenticationError", "CUSTOMER_NOT_FOUND"), "not_found", "CUSTOMER_NOT_FOUND"],
    [
      ads("authenticationError", "CLIENT_CUSTOMER_ID_INVALID"),
      "invalid_request",
      "CLIENT_CUSTOMER_ID_INVALID",
    ],
    [
      ads("authenticationError", "DEVELOPER_TOKEN_INVALID", 401),
      "unknown",
      "DEVELOPER_TOKEN_INVALID",
    ],
    [
      ads("authenticationError", "ORGANIZATION_NOT_ASSOCIATED_WITH_DEVELOPER_TOKEN"),
      "unknown",
      "ORGANIZATION_NOT_ASSOCIATED_WITH_DEVELOPER_TOKEN",
    ],
    [
      ads("authorizationError", "USER_PERMISSION_DENIED", 403),
      "permission",
      "USER_PERMISSION_DENIED",
    ],
    [ads("authorizationError", "CUSTOMER_NOT_ENABLED", 403), "permission", "CUSTOMER_NOT_ENABLED"],
    // Our Google Cloud project has Test access: configuration, NOT the user's permission.
    [
      ads("authorizationError", "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION", 403),
      "unknown",
      "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
    ],
    // Legacy developer-token enums (pre-sunset bodies) stay configuration.
    [
      ads("authorizationError", "DEVELOPER_TOKEN_NOT_APPROVED", 403),
      "unknown",
      "DEVELOPER_TOKEN_NOT_APPROVED",
    ],
    [
      ads("authorizationError", "DEVELOPER_TOKEN_PROHIBITED", 403),
      "unknown",
      "DEVELOPER_TOKEN_PROHIBITED",
    ],
    [ads("quotaError", "RESOURCE_EXHAUSTED", 429), "rate_limited", "RESOURCE_EXHAUSTED"],
    [
      ads("quotaError", "RESOURCE_TEMPORARILY_EXHAUSTED", 429),
      "rate_limited",
      "RESOURCE_TEMPORARILY_EXHAUSTED",
    ],
    [ads("internalError", "TRANSIENT_ERROR", 500), "transient", "TRANSIENT_ERROR"],
    [ads("requestError", "EXPIRED_PAGE_TOKEN"), "invalid_request", "EXPIRED_PAGE_TOKEN"],
    [ads("queryError", "UNRECOGNIZED_FIELD"), "invalid_request", "UNRECOGNIZED_FIELD"],
    [ads("mysteryError", "SOMETHING"), "unknown", "SOMETHING"],
    [http({ status: 400, oauthError: "invalid_grant" }), "auth", "invalid_grant"],
    [http({ status: 400, oauthError: "access_denied" }), "auth", "access_denied"],
    [http({ status: 401, oauthError: "invalid_client" }), "unknown", "invalid_client"],
    [
      http({ status: 400, oauthError: "redirect_uri_mismatch" }),
      "unknown",
      "redirect_uri_mismatch",
    ],
    [
      http({ status: 503, oauthError: "temporarily_unavailable" }),
      "transient",
      "temporarily_unavailable",
    ],
    [http({ status: 403, rpcStatus: "PERMISSION_DENIED" }), "permission", "PERMISSION_DENIED"],
    [http({ status: 503, rpcStatus: "UNAVAILABLE" }), "transient", "UNAVAILABLE"],
    [http({ status: 504, rpcStatus: "DEADLINE_EXCEEDED" }), "transient", "DEADLINE_EXCEEDED"],
    [http({ status: 401 }), "auth", "http_401"],
    [http({ status: 404 }), "not_found", "http_404"],
    [http({ status: 429 }), "rate_limited", "http_429"],
    [http({ status: 502 }), "transient", "http_502"],
    [http({ status: 418 }), "unknown", "http_418"],
    [{ type: "network" } as GoogleFailure, "transient", "network"],
    [{ type: "timeout" } as GoogleFailure, "transient", "timeout"],
    [{ type: "invalid_json", status: 200 } as GoogleFailure, "data", "invalid_json"],
    [{ type: "invalid_json", status: 503 } as GoogleFailure, "transient", "http_503"],
  ])("%j → %s / %s", (failure, kind, providerCode) => {
    expect(classifyGoogleFailure(failure)).toMatchObject({ kind, providerCode });
  });

  it("picks the most severe of several errors", () => {
    expect(
      classifyGoogleFailure(
        http({
          adsErrors: [
            { family: "quotaError", code: "RESOURCE_EXHAUSTED" },
            { family: "authorizationError", code: "USER_PERMISSION_DENIED" },
            { family: "requestError", code: "INVALID_PAGE_TOKEN" },
          ],
        }),
      ),
    ).toMatchObject({ kind: "permission", providerCode: "USER_PERMISSION_DENIED" });
    expect(
      classifyGoogleFailure(
        http({
          adsErrors: [
            { family: "authorizationError", code: "USER_PERMISSION_DENIED" },
            { family: "authenticationError", code: "OAUTH_TOKEN_INVALID" },
          ],
        }),
      ),
    ).toMatchObject({ kind: "auth" });
  });

  it("carries the retry delay only for rate limits, capped at one hour", () => {
    expect(
      classifyGoogleFailure(
        http({
          status: 429,
          adsErrors: [{ family: "quotaError", code: "RESOURCE_EXHAUSTED" }],
          retryAfterMs: 30_000,
        }),
      ),
    ).toEqual({ kind: "rate_limited", providerCode: "RESOURCE_EXHAUSTED", retryAfterMs: 30_000 });
    expect(
      classifyGoogleFailure(http({ status: 429, retryAfterMs: 10 * 60 * 60_000 })).retryAfterMs,
    ).toBe(60 * 60_000);
    expect(classifyGoogleFailure(http({ status: 500, retryAfterMs: 5_000 }))).not.toHaveProperty(
      "retryAfterMs",
    );
  });

  it("never uses the family default for configuration codes", () => {
    for (const family of ["authenticationError", "authorizationError"]) {
      for (const code of [
        "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
        "DEVELOPER_TOKEN_NOT_APPROVED",
      ]) {
        expect(classifyAdsErrorCode({ family, code })).toBe("unknown");
      }
    }
  });
});

describe("googleProviderError", () => {
  it("builds generic, prefixed, typed errors", () => {
    const error = googleProviderError(
      { kind: "rate_limited", providerCode: "RESOURCE_EXHAUSTED", retryAfterMs: 1_000 },
      "fetchDailyMetrics",
      "api_access",
    );
    expect(error).toMatchObject({
      kind: "rate_limited",
      platform: "google_ads",
      retryable: true,
      retryAfterMs: 1_000,
      providerCode: "api_access:RESOURCE_EXHAUSTED",
      message: "Google Ads request failed (rate_limited)",
    });
  });
});
