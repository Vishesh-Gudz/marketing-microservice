import { describe, expect, it } from "vitest";
import { isRetryableKind } from "../errors";
import { classifyInstagramFailure, instagramProviderError } from "./errors";
import type { InstagramFailure } from "./transport";

// Instagram errors normalize into the EXISTING ProviderError model, by code/status/usage
// only. [PROVISIONAL IR4]: real HTTP statuses of these codes are unverified.

const http = (status: number, code?: number, subcode?: number, usage = {}): InstagramFailure => ({
  type: "http",
  status,
  ...(code !== undefined ? { error: { code, ...(subcode !== undefined ? { subcode } : {}) } } : {}),
  usage,
});

describe("classifyInstagramFailure", () => {
  it.each([
    [http(400, 190), "auth", "190"],
    [http(400, 190, 463), "auth", "190/463"],
    [http(401, 102), "auth", "102"],
    [http(400, 4), "rate_limited", "4"],
    [http(400, 17), "rate_limited", "17"],
    [http(400, 613), "rate_limited", "613"],
    [http(400, 80002), "rate_limited", "80002"],
    [http(403, 10), "permission", "10"],
    [http(403, 200), "permission", "200"],
    [http(400, 100, 33), "not_found", "100/33"],
    [http(400, 100), "invalid_request", "100"],
    [http(500, 1), "transient", "1"],
    [http(500, 2), "transient", "2"],
    [http(400, 999999), "unknown", "999999"],
    [http(503, 999999), "transient", "999999"],
    [http(401), "auth", "http_401"],
    [http(403), "permission", "http_403"],
    [http(404), "not_found", "http_404"],
    [http(410), "not_found", "http_410"],
    [http(429), "rate_limited", "http_429"],
    [http(502), "transient", "http_502"],
    [http(418), "unknown", "http_418"],
  ])("%j -> %s / %s", (failure, kind, providerCode) => {
    expect(classifyInstagramFailure(failure)).toMatchObject({ kind, providerCode });
  });

  it("maps transport outcomes", () => {
    expect(classifyInstagramFailure({ type: "network" })).toEqual({
      kind: "transient",
      providerCode: "network",
    });
    expect(classifyInstagramFailure({ type: "timeout" })).toEqual({
      kind: "transient",
      providerCode: "timeout",
    });
    expect(classifyInstagramFailure({ type: "invalid_json", status: 200 })).toEqual({
      kind: "data",
      providerCode: "invalid_json",
    });
    expect(classifyInstagramFailure({ type: "invalid_json", status: 502 }).kind).toBe("transient");
    // Refusals and budget exhaustion are never retried.
    expect(classifyInstagramFailure({ type: "blocked", reason: "path" })).toEqual({
      kind: "unknown",
      providerCode: "transport_blocked",
    });
    expect(classifyInstagramFailure({ type: "budget_exceeded" })).toEqual({
      kind: "unknown",
      providerCode: "request_budget_exceeded",
    });
  });

  it("derives retryAfter from the usage headers, capped at one hour", () => {
    expect(
      classifyInstagramFailure(http(400, 4, undefined, { regainAccessMinutes: 3 })).retryAfterMs,
    ).toBe(180_000);
    expect(
      classifyInstagramFailure(http(429, undefined, undefined, { retryAfterSeconds: 7 }))
        .retryAfterMs,
    ).toBe(7_000);
    expect(
      classifyInstagramFailure(http(400, 4, undefined, { regainAccessMinutes: 900 })).retryAfterMs,
    ).toBe(3_600_000);
    expect(classifyInstagramFailure(http(400, 4)).retryAfterMs).toBeUndefined();
  });

  it("only rate limits and transient failures are retryable", () => {
    expect(isRetryableKind(classifyInstagramFailure(http(400, 4)).kind)).toBe(true);
    expect(isRetryableKind(classifyInstagramFailure(http(503)).kind)).toBe(true);
    expect(isRetryableKind(classifyInstagramFailure(http(400, 190)).kind)).toBe(false);
    expect(
      isRetryableKind(classifyInstagramFailure({ type: "blocked", reason: "host" }).kind),
    ).toBe(false);
  });
});

describe("instagramProviderError", () => {
  it("builds a generic, payload-free ProviderError with an optional D28b stage", () => {
    const error = instagramProviderError(
      { kind: "auth", providerCode: "190" },
      "oauthExchange",
      "identity",
    );
    expect(error.platform).toBe("instagram");
    expect(error.kind).toBe("auth");
    expect(error.requiresReauth).toBe(true);
    expect(error.providerCode).toBe("identity:190");
    expect(error.message).toBe("Instagram request failed (auth)");
    expect(error.cause).toBeUndefined();
  });
});
