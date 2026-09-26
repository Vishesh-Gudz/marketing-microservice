import { describe, expect, it } from "vitest";
import type { GraphFailure } from "./client";
import { classifyGraphFailure, metaProviderError, retryAfterFromUsage } from "./errors";

const http = (
  status: number,
  code?: number,
  subcode?: number,
  extra: Partial<Extract<GraphFailure, { type: "http" }>> = {},
): GraphFailure => ({
  type: "http",
  status,
  ...(code !== undefined ? { error: { code, ...(subcode !== undefined ? { subcode } : {}) } } : {}),
  usage: {},
  ...extra,
});

describe("Meta error classification (D22)", () => {
  it.each([
    ["network", { type: "network" } as GraphFailure, "transient", "network"],
    ["timeout", { type: "timeout" } as GraphFailure, "transient", "timeout"],
    ["5xx without body", http(503), "transient", "http_503"],
    ["code 1", http(500, 1), "transient", "1"],
    ["code 2", http(503, 2), "transient", "2"],
    [
      "is_transient",
      { ...http(400, 9999), error: { code: 9999, isTransient: true } } as GraphFailure,
      "transient",
      "9999",
    ],
    ["too much data", http(400, 100, 1_487_534), "transient", "100/1487534"],
    ["app limit 4", http(400, 4), "rate_limited", "4"],
    ["user limit 17", http(400, 17, 2_446_079), "rate_limited", "17/2446079"],
    ["page limit 32", http(400, 32), "rate_limited", "32"],
    ["341", http(400, 341), "rate_limited", "341"],
    ["368", http(400, 368), "rate_limited", "368"],
    ["613", http(400, 613, 1_487_742), "rate_limited", "613/1487742"],
    ["BUC 80000", http(400, 80_000), "rate_limited", "80000"],
    ["BUC 80014", http(400, 80_014), "rate_limited", "80014"],
    ["HTTP 429", http(429), "rate_limited", "http_429"],
    ["token 190", http(400, 190, 463), "auth", "190/463"],
    ["session 102", http(400, 102), "auth", "102"],
    ["HTTP 401", http(401), "auth", "http_401"],
    ["not found 100/33", http(400, 100, 33), "not_found", "100/33"],
    ["alias 803", http(400, 803), "not_found", "803"],
    ["HTTP 404", http(404), "not_found", "http_404"],
    ["invalid 100", http(400, 100), "invalid_request", "100"],
    ["unknown path 2500", http(400, 2500), "invalid_request", "2500"],
    ["deprecated version 2635", http(400, 2635), "invalid_request", "2635"],
    ["37 months 3018", http(400, 3018), "invalid_request", "3018"],
    ["non-JSON 2xx", { type: "invalid_json", status: 200 } as GraphFailure, "data", "invalid_json"],
    ["unclassified", http(400, 12_345), "unknown", "12345"],
  ])("%s → %s", (_label, failure, kind, providerCode) => {
    const result = classifyGraphFailure(failure);
    expect(result.kind).toBe(kind);
    expect(result.providerCode).toBe(providerCode);
    expect(result.permissionCheck).toBeUndefined();
  });

  it.each([
    ["10", http(400, 10)],
    ["200", http(400, 200)],
    ["294", http(400, 294)],
    ["3", http(400, 3)],
    ["HTTP 403", http(403)],
  ])("permission code %s asks for the /me/permissions probe", (_label, failure) => {
    expect(classifyGraphFailure(failure)).toMatchObject({
      kind: "permission",
      permissionCheck: true,
    });
  });

  it("derives retryAfterMs from usage headers, capped at 1 hour", () => {
    expect(
      classifyGraphFailure(
        http(400, 17, undefined, { usage: { regainAccessMinutes: 5, accountResetSeconds: 120 } }),
      ),
    ).toMatchObject({ kind: "rate_limited", retryAfterMs: 300_000 });
    expect(retryAfterFromUsage({ accountResetSeconds: 400 })).toBe(400_000);
    expect(retryAfterFromUsage({ retryAfterSeconds: 30 })).toBe(30_000);
    expect(retryAfterFromUsage({ regainAccessMinutes: 600 })).toBe(3_600_000);
    expect(retryAfterFromUsage({})).toBeUndefined();
    expect(classifyGraphFailure(http(400, 4))).not.toHaveProperty("retryAfterMs");
  });

  it("builds non-leaking ProviderErrors (generic message, staged code)", () => {
    const error = metaProviderError(
      classifyGraphFailure(http(400, 190)),
      "oauthExchange",
      "debug_token",
    );
    expect(error).toMatchObject({
      kind: "auth",
      platform: "meta",
      providerCode: "debug_token:190",
    });
    expect(error.message).toBe("Meta request failed (auth)");
    expect(error.cause).toBeUndefined();
    expect(metaProviderError(classifyGraphFailure(http(400, 4)), "listAccounts").retryable).toBe(
      true,
    );
  });
});
