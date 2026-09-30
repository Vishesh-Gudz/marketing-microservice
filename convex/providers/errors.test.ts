import { describe, expect, it } from "vitest";
import {
  isProviderError,
  isRetryableKind,
  MappingError,
  PROVIDER_ERROR_KINDS,
  ProviderError,
  toProviderError,
} from "./errors";

describe("ProviderError", () => {
  it("derives retryability from the kind (only rate_limited and transient retry)", () => {
    const retryable = PROVIDER_ERROR_KINDS.filter(isRetryableKind);
    expect(retryable).toEqual(["rate_limited", "transient"]);
    for (const kind of PROVIDER_ERROR_KINDS) {
      const error = new ProviderError({
        kind,
        platform: "meta",
        operation: "listAds",
        message: kind,
      });
      expect(error.retryable, kind).toBe(retryable.includes(kind));
    }
  });

  it("flags auth errors as requiring re-authorization", () => {
    const auth = new ProviderError({
      kind: "auth",
      platform: "google_ads",
      operation: "listAccounts",
      message: "x",
    });
    const permission = new ProviderError({
      kind: "permission",
      platform: "google_ads",
      operation: "listAccounts",
      message: "x",
    });
    expect(auth.requiresReauth).toBe(true);
    expect(permission.requiresReauth).toBe(false);
  });

  it("carries retryAfterMs and provider codes when given", () => {
    const error = new ProviderError({
      kind: "rate_limited",
      platform: "meta",
      operation: "fetchDailyMetrics",
      message: "slow down",
      retryAfterMs: 1500,
      providerCode: "80004",
    });
    expect(error).toMatchObject({
      retryAfterMs: 1500,
      providerCode: "80004",
      name: "ProviderError",
    });
    expect(isProviderError(error)).toBe(true);
    expect(isProviderError(new Error("x"))).toBe(false);
  });

  it("toProviderError passes ProviderErrors through and classifies the rest as unknown", () => {
    const original = new ProviderError({
      kind: "transient",
      platform: "meta",
      operation: "listAds",
      message: "503",
    });
    expect(toProviderError(original, "meta", "listAds")).toBe(original);

    const wrapped = toProviderError(new TypeError("boom"), "google_ads", "listCampaigns");
    expect(wrapped).toMatchObject({
      kind: "unknown",
      retryable: false,
      platform: "google_ads",
      operation: "listCampaigns",
    });
    expect(wrapped.message).toBe("boom");
    expect(toProviderError("string failure", "meta", "listAds").message).toBe("string failure");
  });
});

describe("MappingError", () => {
  it("exposes a reason and frozen details", () => {
    const error = new MappingError("currency_mismatch", "nope", { record: "EUR", scope: "USD" });
    expect(error.reason).toBe("currency_mismatch");
    expect(Object.isFrozen(error.details)).toBe(true);
    expect(error.name).toBe("MappingError");
  });
});
