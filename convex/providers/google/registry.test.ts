import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultRegistry } from "..";
import {
  FAKE_DEVELOPER_TOKEN,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
} from "./fakeGoogleAds.fixtures";

// Phase 9 Stage A: the Phase 8 D8 matrix with Google. Live mode registers the real Google
// provider + OAuth only when Google is configured; otherwise the Phase 8 D8-A stub stays.
// Mock and misconfigured are unchanged whatever the Google env says.

const CLOUD = "https://happy-otter-123.convex.cloud";
const META_ENV = { META_APP_ID: "1234567890", META_APP_SECRET: "test-app-secret" };
const GOOGLE_ENV = {
  GOOGLE_CLIENT_ID: FAKE_GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: FAKE_GOOGLE_CLIENT_SECRET,
  GOOGLE_ADS_DEVELOPER_TOKEN: FAKE_DEVELOPER_TOKEN,
};
const LIVE = { PROVIDER_MODE: "live", CONVEX_CLOUD_URL: CLOUD, ...META_ENV };
const CTX = {
  credential: {
    kind: "google",
    v: 1,
    refreshToken: "test-refresh-x",
    clientId: FAKE_GOOGLE_CLIENT_ID,
    issuedAt: 1,
    scopes: [],
  },
  attempt: 1,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("live mode", () => {
  it("registers the real Google provider and OAuth spec when Google is configured", () => {
    const registry = createDefaultRegistry({ ...LIVE, ...GOOGLE_ENV });
    expect(registry.ads("google_ads").providerId).toBe("google-ads-api/v25");
    expect(registry.oauth("google_ads")).toMatchObject({
      providerId: "google-ads-api/v25",
      usesPkce: true,
      requiredScopes: ["https://www.googleapis.com/auth/adwords"],
    });
    // Meta is untouched.
    expect(registry.ads("meta").providerId).toBe("meta-marketing-api/v26.0");
    expect(registry.oauth("meta").providerId).toBe("meta-marketing-api/v26.0");
  });

  it("applies a valid GOOGLE_ADS_API_VERSION override to provider and OAuth", () => {
    const registry = createDefaultRegistry({
      ...LIVE,
      ...GOOGLE_ENV,
      GOOGLE_ADS_API_VERSION: "v26",
    });
    expect(registry.ads("google_ads").providerId).toBe("google-ads-api/v26");
    expect(registry.oauth("google_ads").providerId).toBe("google-ads-api/v26");
  });

  it.each([
    ["no Google env", {}],
    [
      "empty Google env",
      { GOOGLE_CLIENT_ID: "", GOOGLE_CLIENT_SECRET: "", GOOGLE_ADS_DEVELOPER_TOKEN: "" },
    ],
  ])(
    "keeps the Phase 8 stub with %s (auth / provider_unavailable, no OAuth)",
    async (_label, env: Record<string, string>) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const registry = createDefaultRegistry({ ...LIVE, ...env });
      expect(registry.hasOAuth("google_ads")).toBe(false);
      const google = registry.ads("google_ads");
      expect(google.providerId).toBe("unavailable");
      await expect(
        google.getAccount({ credential: {}, attempt: 1 }, { accountExternalId: "1" }),
      ).rejects.toMatchObject({ kind: "auth", providerCode: "provider_unavailable" });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["only a developer token", { GOOGLE_ADS_DEVELOPER_TOKEN: FAKE_DEVELOPER_TOKEN }],
    ["no developer token", { ...GOOGLE_ENV, GOOGLE_ADS_DEVELOPER_TOKEN: "" }],
    ["a malformed client id", { ...GOOGLE_ENV, GOOGLE_CLIENT_ID: "not-a-client" }],
    ["an invalid version override", { ...GOOGLE_ENV, GOOGLE_ADS_API_VERSION: "latest" }],
  ])(
    "partial or invalid Google env (%s) fails closed as configuration, with no network",
    async (_label, env: Record<string, string>) => {
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const registry = createDefaultRegistry({ ...LIVE, ...env });
      const google = registry.ads("google_ads");
      for (const call of [
        () => google.listAccounts(CTX, {}),
        () => google.getAccount(CTX, { accountExternalId: "2220000001" }),
      ]) {
        await expect(call()).rejects.toMatchObject({
          kind: "unknown",
          providerCode: "google_config_invalid",
          retryable: false,
        });
      }
      // The OAuth spec refuses to start a flow (never a half-configured consent).
      expect(() =>
        registry.oauth("google_ads").buildAuthorizationUrl({
          state: "s",
          redirectUri: "https://x.convex.site/oauth/callback",
          codeChallenge: "c",
          config: {
            clientId: env.GOOGLE_CLIENT_ID ?? "",
            clientSecret: env.GOOGLE_CLIENT_SECRET ?? "",
          },
        }),
      ).toThrow(
        expect.objectContaining({ kind: "unknown", providerCode: "config:google_config_invalid" }),
      );
      expect(fetch).not.toHaveBeenCalled();
    },
  );
});

describe("mock and misconfigured modes ignore Google env", () => {
  it("mock stays the deterministic mock", () => {
    const registry = createDefaultRegistry({ ...GOOGLE_ENV });
    expect(registry.ads("google_ads").providerId).toBe("mock");
    expect(registry.oauth("google_ads").providerId).toBe("mock");
  });

  it("misconfigured stays unavailable everywhere with no OAuth", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const registry = createDefaultRegistry({ CONVEX_CLOUD_URL: CLOUD, ...META_ENV, ...GOOGLE_ENV });
    expect(registry.hasOAuth("google_ads")).toBe(false);
    expect(registry.ads("google_ads").providerId).toBe("unavailable");
    await expect(registry.ads("google_ads").listAccounts(CTX, {})).rejects.toMatchObject({
      kind: "unknown",
      providerCode: "provider_mode_missing",
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
