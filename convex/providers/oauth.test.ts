import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from ".";
import {
  createMockOAuthSpec,
  MOCK_INVALID_CODE,
  MOCK_UNAVAILABLE_CODE,
  mockAuthorizationCode,
  parseMockUser,
} from "./mock/oauth";
import { missingScopes } from "./oauth";
import { runOAuthSpecContract } from "./oauth.suite";
import { ProviderNotRegisteredError, createProviderRegistry } from "./registry";

for (const platform of ["meta", "google_ads"] as const) {
  runOAuthSpecContract({
    name: `mock ${platform}`,
    create: () => createMockOAuthSpec(platform),
    config: {},
    validCode: (url) => new URL(url).searchParams.get("code")!,
    invalidCode: MOCK_INVALID_CODE,
  });
}

describe("mock OAuth specifics", () => {
  const now = 1_790_000_000_000;

  it("mirrors platform token models: Meta ~60 day expiry, Google refreshable", async () => {
    const meta = await createMockOAuthSpec("meta").exchangeCode({
      code: mockAuthorizationCode("meta", undefined),
      redirectUri: "https://x.test/cb",
      config: {},
      now,
    });
    expect(meta.expiresAt).toBe(now + 60 * 24 * 60 * 60 * 1000);
    expect(meta.refreshable).toBe(false);

    const google = await createMockOAuthSpec("google_ads").exchangeCode({
      code: mockAuthorizationCode("google_ads", undefined),
      redirectUri: "https://x.test/cb",
      config: {},
      now,
    });
    expect(google.expiresAt).toBeUndefined();
    expect(google.refreshable).toBe(true);
  });

  it("classifies an unavailable token endpoint as transient", async () => {
    await expect(
      createMockOAuthSpec("meta").exchangeCode({
        code: MOCK_UNAVAILABLE_CODE,
        redirectUri: "https://x.test/cb",
        config: {},
        now,
      }),
    ).rejects.toMatchObject({ kind: "transient", retryable: true });
  });

  it("surfaces missing required scopes for limited grants", async () => {
    const spec = createMockOAuthSpec("google_ads");
    const grant = await spec.exchangeCode({
      code: mockAuthorizationCode("google_ads", undefined, "limited"),
      redirectUri: "https://x.test/cb",
      config: {},
      now,
    });
    expect(missingScopes(spec, grant.grantedScopes)).toEqual([
      "https://www.googleapis.com/auth/adwords",
    ]);
  });

  it("only Google-like specs can refresh", async () => {
    const google = createMockOAuthSpec("google_ads");
    const refreshed = await google.refresh!(
      { kind: "mock", token: "mock-token-google_ads-7" },
      {},
      now,
    );
    expect(refreshed.identity.externalUserId).toBe("mock-user-7");
    await expect(
      createMockOAuthSpec("meta").refresh!({ kind: "mock", token: "t" }, {}, now),
    ).rejects.toMatchObject({
      kind: "unsupported",
    });
  });
});

describe("registry oauth family", () => {
  it("serves mock OAuth specs for both platforms by default", () => {
    const registry = createDefaultRegistry();
    expect(registry.oauth("meta").providerId).toBe("mock");
    expect(registry.hasOAuth("google_ads")).toBe(true);
  });

  it("throws a typed error for unregistered OAuth platforms and rejects duplicates", () => {
    const registry = createProviderRegistry({ ads: [] });
    expect(() => registry.oauth("meta")).toThrow(ProviderNotRegisteredError);
    expect(() =>
      createProviderRegistry({
        ads: [],
        oauth: [createMockOAuthSpec("meta"), createMockOAuthSpec("meta")],
      }),
    ).toThrow(/Duplicate/);
  });
});

describe("mock user grammar (Phase 5 test seam)", () => {
  const now = 1_790_000_000_000;

  it("parses id, scenario and variant; unknown parts are ignored", () => {
    expect(parseMockUser("1")).toEqual({ id: "1" });
    expect(parseMockUser("1--rate_limited")).toEqual({ id: "1", scenario: "rate_limited" });
    expect(parseMockUser("7--default--v2")).toEqual({ id: "7", scenario: "default", variant: 2 });
    expect(parseMockUser("1--bogus--vx")).toEqual({ id: "1" });
  });

  it("keeps the identity stable across scenarios, so reconnect targets the same connection", async () => {
    const spec = createMockOAuthSpec("google_ads");
    const plain = await spec.exchangeCode({
      code: mockAuthorizationCode("google_ads", undefined, "1"),
      redirectUri: "https://x.test/cb",
      config: {},
      now,
    });
    const scenario = await spec.exchangeCode({
      code: mockAuthorizationCode("google_ads", undefined, "1--transient--v1"),
      redirectUri: "https://x.test/cb",
      config: {},
      now,
    });
    expect(scenario.identity).toEqual(plain.identity);
    expect(scenario.credential).toMatchObject({ kind: "mock", scenario: "transient", variant: 1 });
    expect(plain.credential).not.toHaveProperty("scenario");
    const refreshed = await spec.refresh!(scenario.credential, {}, now);
    expect(refreshed.identity).toEqual(plain.identity);
    expect(refreshed.credential).toMatchObject({ scenario: "transient", variant: 1 });
  });
});
