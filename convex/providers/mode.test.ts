import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultRegistry } from ".";
import { expectProviderError } from "./contract.suite";
import { isLocalDeployment, resolveProviderMode } from "./mode";

// Phase 8 D8: PROVIDER_MODE fails closed. Pure resolution + the composed registry.

const CLOUD = "https://happy-otter-123.convex.cloud";
const LOCAL = "http://127.0.0.1:3210";
const META_ENV = { META_APP_ID: "1234567890", META_APP_SECRET: "test-app-secret" };

describe("resolveProviderMode (confirmed D8 matrix)", () => {
  it.each([
    [{ CONVEX_CLOUD_URL: undefined }, { mode: "mock" }],
    [{ CONVEX_CLOUD_URL: LOCAL }, { mode: "mock" }],
    [{ CONVEX_CLOUD_URL: "http://localhost:3210" }, { mode: "mock" }],
    [{ CONVEX_CLOUD_URL: "http://[::1]:3210" }, { mode: "mock" }],
    [{ CONVEX_CLOUD_URL: CLOUD }, { mode: "misconfigured", code: "provider_mode_missing" }],
    [{ CONVEX_CLOUD_URL: "" }, { mode: "misconfigured", code: "provider_mode_missing" }],
    [{ PROVIDER_MODE: "mock", CONVEX_CLOUD_URL: CLOUD }, { mode: "mock" }],
    [{ PROVIDER_MODE: "live", CONVEX_CLOUD_URL: CLOUD }, { mode: "live" }],
    [{ PROVIDER_MODE: "live", CONVEX_CLOUD_URL: LOCAL }, { mode: "live" }],
    [{ PROVIDER_MODE: "mock", CONVEX_CLOUD_URL: LOCAL }, { mode: "mock" }],
    [
      { PROVIDER_MODE: "Live", CONVEX_CLOUD_URL: CLOUD },
      { mode: "misconfigured", code: "provider_mode_invalid" },
    ],
    [
      { PROVIDER_MODE: "prod", CONVEX_CLOUD_URL: LOCAL },
      { mode: "misconfigured", code: "provider_mode_invalid" },
    ],
    [
      { PROVIDER_MODE: "", CONVEX_CLOUD_URL: LOCAL },
      { mode: "misconfigured", code: "provider_mode_invalid" },
    ],
    [
      { PROVIDER_MODE: " live", CONVEX_CLOUD_URL: CLOUD },
      { mode: "misconfigured", code: "provider_mode_invalid" },
    ],
  ])("%j → %j", (env, expected) => {
    expect(resolveProviderMode(env)).toEqual(expected);
  });

  it("never falls back to live or mock on an invalid value", () => {
    for (const value of ["LIVE", "production", "true", "1", "mock ", "mocks"]) {
      for (const url of [undefined, LOCAL, CLOUD]) {
        expect(resolveProviderMode({ PROVIDER_MODE: value, CONVEX_CLOUD_URL: url }).mode).toBe(
          "misconfigured",
        );
      }
    }
  });

  it("recognizes only loopback hosts as local", () => {
    expect(isLocalDeployment(undefined)).toBe(true);
    expect(isLocalDeployment(LOCAL)).toBe(true);
    expect(isLocalDeployment(CLOUD)).toBe(false);
    expect(isLocalDeployment("http://127.0.0.1.evil.test")).toBe(false);
    expect(isLocalDeployment("not a url")).toBe(false);
  });
});

describe("createDefaultRegistry per mode", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("mock: the deterministic mocks for both platforms (unchanged local default)", () => {
    const registry = createDefaultRegistry({});
    expect(registry.ads("meta").providerId).toBe("mock");
    expect(registry.ads("google_ads").providerId).toBe("mock");
    expect(registry.oauth("meta").providerId).toBe("mock");
    expect(registry.hasOAuth("google_ads")).toBe(true);
  });

  it("live: real Meta + Meta OAuth; Google is an unavailable stub with no OAuth (D8-A)", async () => {
    const registry = createDefaultRegistry({
      PROVIDER_MODE: "live",
      CONVEX_CLOUD_URL: CLOUD,
      ...META_ENV,
    });
    expect(registry.ads("meta").providerId).toBe("meta-marketing-api/v26.0");
    expect(registry.oauth("meta").providerId).toBe("meta-marketing-api/v26.0");
    expect(registry.hasOAuth("google_ads")).toBe(false);
    const google = registry.ads("google_ads");
    expect(google.providerId).toBe("unavailable");
    expect(google.capabilities.metricLevels.length).toBeGreaterThan(0);
    await expect(
      google.getAccount({ credential: {}, attempt: 1 }, { accountExternalId: "1" }),
    ).rejects.toMatchObject({
      kind: "auth",
      providerCode: "provider_unavailable",
    });
    const withOverride = createDefaultRegistry({
      PROVIDER_MODE: "live",
      META_GRAPH_API_VERSION: "v27.0",
      ...META_ENV,
    });
    expect(withOverride.ads("meta").providerId).toBe("meta-marketing-api/v27.0");
  });

  it.each([
    [{ CONVEX_CLOUD_URL: CLOUD }, "provider_mode_missing"],
    [{ PROVIDER_MODE: "Live" }, "provider_mode_invalid"],
  ])("misconfigured %j: stubs everywhere, no OAuth, no network, no reauth", async (env, code) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const registry = createDefaultRegistry({ ...env, ...META_ENV });
    expect(registry.hasOAuth("meta")).toBe(false);
    expect(registry.hasOAuth("google_ads")).toBe(false);
    for (const platform of ["meta", "google_ads"] as const) {
      const provider = registry.ads(platform);
      expect(provider.providerId).toBe("unavailable");
      expect(provider.capabilities.metricLevels.length).toBeGreaterThan(0);
      await expect(provider.listAccounts({ credential: {}, attempt: 1 }, {})).rejects.toMatchObject(
        {
          kind: "unknown",
          providerCode: code,
          retryable: false,
        },
      );
      await expectProviderError(
        provider.fetchDailyMetrics(
          { credential: {}, attempt: 1 },
          {
            accountExternalId: "1",
            level: "account",
            from: "2026-01-01",
            to: "2026-01-01",
            breakdown: "none",
          },
        ),
        "unknown",
      );
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("construction never throws, whatever the environment", () => {
    for (const env of [
      {},
      { PROVIDER_MODE: "???" },
      { PROVIDER_MODE: "live" },
      { PROVIDER_MODE: "live", META_GRAPH_API_VERSION: "garbage", META_APP_ID: "x" },
      { CONVEX_CLOUD_URL: "::::" },
    ]) {
      expect(() => createDefaultRegistry(env)).not.toThrow();
    }
  });

  it("defaults to process.env (local convex-test: mock)", () => {
    expect(createDefaultRegistry().ads("meta").providerId).toBe("mock");
  });
});
