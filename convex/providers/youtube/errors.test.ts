import { describe, expect, it } from "vitest";
import type { YouTubeFailure } from "./client";
import { classifyYouTubeFailure, youtubeProviderError } from "./errors";

// ADR 0016: classification by reason, OAuth error, RPC status and HTTP status only.

const http = (
  status: number,
  extra: Partial<Extract<YouTubeFailure, { type: "http" }>> = {},
): YouTubeFailure => ({ type: "http", status, reasons: [], ...extra });

describe("classifyYouTubeFailure", () => {
  it.each<[string, YouTubeFailure, string, string]>([
    ["revoked refresh token", http(400, { oauthError: "invalid_grant" }), "auth", "invalid_grant"],
    [
      "wrong OAuth client",
      http(401, { oauthError: "invalid_client" }),
      "unknown",
      "invalid_client",
    ],
    [
      "token endpoint outage",
      http(503, { oauthError: "invalid_grant" }),
      "transient",
      "invalid_grant",
    ],
    ["expired access token", http(401, { reasons: ["authError"] }), "auth", "authError"],
    [
      "scope not granted",
      http(403, { reasons: ["insufficientPermissions"] }),
      "permission",
      "insufficientPermissions",
    ],
    [
      "no channel",
      http(403, { reasons: ["youtubeSignupRequired"] }),
      "permission",
      "youtubeSignupRequired",
    ],
    [
      "API not enabled",
      http(403, { reasons: ["accessNotConfigured"] }),
      "unknown",
      "accessNotConfigured",
    ],
    [
      "service disabled",
      http(403, { reasons: ["SERVICE_DISABLED"] }),
      "unknown",
      "SERVICE_DISABLED",
    ],
    [
      "burst limit",
      http(403, { reasons: ["rateLimitExceeded"] }),
      "rate_limited",
      "rateLimitExceeded",
    ],
    [
      "deleted playlist",
      http(404, { reasons: ["playlistNotFound"] }),
      "not_found",
      "playlistNotFound",
    ],
    ["backend error", http(500, { reasons: ["backendError"] }), "transient", "backendError"],
    [
      "expired page token",
      http(400, { reasons: ["invalidPageToken"] }),
      "invalid_request",
      "invalidPageToken",
    ],
    [
      "unknown reason, RPC status",
      http(403, { reasons: ["somethingNew"], rpcStatus: "PERMISSION_DENIED" }),
      "permission",
      "PERMISSION_DENIED",
    ],
    ["bare 401", http(401), "auth", "http_401"],
    ["bare 403", http(403), "permission", "http_403"],
    ["bare 404", http(404), "not_found", "http_404"],
    ["bare 429", http(429), "rate_limited", "http_429"],
    ["bare 502", http(502), "transient", "http_502"],
    ["bare 400", http(400), "invalid_request", "http_400"],
    ["bare 418", http(418), "unknown", "http_418"],
    ["network", { type: "network" }, "transient", "network"],
    ["timeout", { type: "timeout" }, "transient", "timeout"],
    ["non-JSON 200", { type: "invalid_json", status: 200 }, "data", "invalid_json"],
    ["non-JSON 503", { type: "invalid_json", status: 503 }, "transient", "http_503"],
    ["allowlist refusal", { type: "blocked" }, "unknown", "transport_blocked"],
    ["spent budget", { type: "budget_exceeded" }, "unknown", "request_budget_exceeded"],
  ])("%s", (_label, failure, kind, providerCode) => {
    expect(classifyYouTubeFailure(failure)).toMatchObject({ kind, providerCode });
  });

  it("lets the most severe reason win", () => {
    const failure = http(403, { reasons: ["rateLimitExceeded", "insufficientPermissions"] });
    expect(classifyYouTubeFailure(failure)).toEqual({
      kind: "permission",
      providerCode: "insufficientPermissions",
    });
  });

  it("retries an exhausted daily quota at most hourly and caps Retry-After at 1 h", () => {
    expect(classifyYouTubeFailure(http(403, { reasons: ["quotaExceeded"] }))).toEqual({
      kind: "rate_limited",
      providerCode: "quotaExceeded",
      retryAfterMs: 3_600_000,
    });
    expect(
      classifyYouTubeFailure(http(429, { reasons: ["rateLimitExceeded"], retryAfterMs: 30_000 })),
    ).toEqual({ kind: "rate_limited", providerCode: "rateLimitExceeded", retryAfterMs: 30_000 });
    expect(classifyYouTubeFailure(http(429, { retryAfterMs: 86_400_000 })).retryAfterMs).toBe(
      3_600_000,
    );
  });
});

describe("youtubeProviderError", () => {
  it("is a generic, retryability-derived ProviderError", () => {
    const error = youtubeProviderError(
      { kind: "rate_limited", providerCode: "quotaExceeded", retryAfterMs: 1_000 },
      "listSocialPosts",
    );
    expect(error).toMatchObject({
      kind: "rate_limited",
      platform: "youtube",
      operation: "listSocialPosts",
      providerCode: "quotaExceeded",
      retryAfterMs: 1_000,
      retryable: true,
      message: "YouTube request failed (rate_limited)",
    });
  });
});
