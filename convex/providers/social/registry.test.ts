import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from "..";
import { isProviderError } from "../errors";
import { INSTAGRAM_CAPABILITIES } from "../instagram/capabilities";
import { INSTAGRAM_PROVIDER_ID } from "../instagram/config";
import { createProviderRegistry, ProviderNotRegisteredError } from "../registry";
import { YOUTUBE_CAPABILITIES } from "../youtube/capabilities";
import { YOUTUBE_PROVIDER_ID } from "../youtube/config";
import { createMockSocialDiscovery, MOCK_SOCIAL_PROVIDER_ID } from "./mock";
import { MOCK_YOUTUBE_PROVIDER_ID } from "./mock/youtube";
import { socialProviderFor } from "./nodeRegistry";

// Phase 10 registry: the social family (default-runtime discovery + static capabilities),
// the Instagram OAuth spec, and the Node-only sync provider, all on the D8 PROVIDER_MODE
// matrix. Ads registrations are unchanged.

const LIVE = {
  PROVIDER_MODE: "live",
  INSTAGRAM_APP_ID: "1790000000000001",
  INSTAGRAM_APP_SECRET: "fake-secret-1",
};
const CLOUD = "https://happy-animal-123.convex.cloud";
const YOUTUBE_ENV = {
  YOUTUBE_CLIENT_ID: "100000000001-fakeyoutubeclient.apps.googleusercontent.com",
  YOUTUBE_CLIENT_SECRET: "fake-secret-1",
};

async function rejection(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  if (!isProviderError(error)) throw new Error("expected ProviderError");
  return error;
}

describe("default registry: social family", () => {
  it("mock mode: mock discovery, mock Instagram OAuth, static capabilities", () => {
    const registry = createDefaultRegistry({});
    expect(registry.socialPlatforms()).toEqual(["instagram", "youtube"]);
    expect(registry.socialProviderId("instagram")).toBe(MOCK_SOCIAL_PROVIDER_ID);
    expect(registry.socialCapabilities("instagram")).toBe(INSTAGRAM_CAPABILITIES);
    expect(registry.oauth("instagram").providerId).toBe(MOCK_SOCIAL_PROVIDER_ID);
    expect(registry.adsPlatforms()).toEqual(["google_ads", "meta"]);
  });

  it("live mode with Instagram configured: the real OAuth spec and discovery", () => {
    const registry = createDefaultRegistry(LIVE);
    expect(registry.oauth("instagram").providerId).toBe(INSTAGRAM_PROVIDER_ID);
    expect(registry.socialDiscovery("instagram").providerId).toBe(INSTAGRAM_PROVIDER_ID);
    expect(registry.oauth("instagram").usesPkce).toBe(false);
  });

  it("live mode without Instagram: no OAuth spec, discovery fails closed as auth", async () => {
    const registry = createDefaultRegistry({ PROVIDER_MODE: "live" });
    expect(registry.hasOAuth("instagram")).toBe(false);
    expect(registry.socialCapabilities("instagram")).toBe(INSTAGRAM_CAPABILITIES);
    const error = await rejection(
      registry.socialDiscovery("instagram").listAccounts({ credential: {}, attempt: 1 }, {}),
    );
    expect([error.kind, error.providerCode]).toEqual(["auth", "provider_unavailable"]);
  });

  it("misconfigured mode: no OAuth spec, discovery fails as unknown (never reauth)", async () => {
    const registry = createDefaultRegistry({ CONVEX_CLOUD_URL: CLOUD });
    expect(registry.hasOAuth("instagram")).toBe(false);
    const error = await rejection(
      registry.socialDiscovery("instagram").listAccounts({ credential: {}, attempt: 1 }, {}),
    );
    expect([error.kind, error.providerCode]).toEqual(["unknown", "provider_mode_missing"]);
  });

  it("registers YouTube on the same matrix with its own OAuth client (ADR 0016)", async () => {
    const mock = createDefaultRegistry({});
    expect(mock.socialProviderId("youtube")).toBe(MOCK_YOUTUBE_PROVIDER_ID);
    expect(mock.socialCapabilities("youtube")).toBe(YOUTUBE_CAPABILITIES);
    expect(mock.oauth("youtube").providerId).toBe(MOCK_YOUTUBE_PROVIDER_ID);

    const live = createDefaultRegistry({ ...LIVE, ...YOUTUBE_ENV });
    expect(live.oauth("youtube").providerId).toBe(YOUTUBE_PROVIDER_ID);
    expect(live.oauth("youtube").usesPkce).toBe(true);
    expect(live.socialDiscovery("youtube").providerId).toBe(YOUTUBE_PROVIDER_ID);
    // Instagram's registration is unchanged by YouTube's.
    expect(live.oauth("instagram").providerId).toBe(INSTAGRAM_PROVIDER_ID);

    const unconfigured = createDefaultRegistry({ PROVIDER_MODE: "live" });
    expect(unconfigured.hasOAuth("youtube")).toBe(false);
    const auth = await rejection(
      unconfigured.socialDiscovery("youtube").listAccounts({ credential: {}, attempt: 1 }, {}),
    );
    expect([auth.kind, auth.providerCode]).toEqual(["auth", "provider_unavailable"]);

    const misconfigured = createDefaultRegistry({ CONVEX_CLOUD_URL: CLOUD });
    expect(misconfigured.hasOAuth("youtube")).toBe(false);
    const unknown = await rejection(
      misconfigured.socialDiscovery("youtube").listAccounts({ credential: {}, attempt: 1 }, {}),
    );
    expect([unknown.kind, unknown.providerCode]).toEqual(["unknown", "provider_mode_missing"]);
  });

  it("refuses a YouTube OAuth client shared with Google Ads (Y-D3)", async () => {
    const shared = createDefaultRegistry({
      PROVIDER_MODE: "live",
      ...YOUTUBE_ENV,
      GOOGLE_CLIENT_ID: YOUTUBE_ENV.YOUTUBE_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: "fake-ads-secret-1",
    });
    expect(
      shared.oauth("youtube").isConfigured?.({
        clientId: YOUTUBE_ENV.YOUTUBE_CLIENT_ID,
        clientSecret: YOUTUBE_ENV.YOUTUBE_CLIENT_SECRET,
        extra: { googleAdsClientId: YOUTUBE_ENV.YOUTUBE_CLIENT_ID },
      }),
    ).toBe(false);
    const discovery = await rejection(
      shared.socialDiscovery("youtube").listAccounts({ credential: {}, attempt: 1 }, {}),
    );
    expect([discovery.kind, discovery.providerCode]).toEqual(["unknown", "youtube_config_invalid"]);
    const sync = await rejection(
      socialProviderFor("youtube", {
        PROVIDER_MODE: "live",
        ...YOUTUBE_ENV,
        GOOGLE_CLIENT_ID: YOUTUBE_ENV.YOUTUBE_CLIENT_ID,
      }).getAccount({ credential: {}, attempt: 1 }, { accountExternalId: "UC1" }),
    );
    expect([sync.kind, sync.providerCode]).toEqual(["unknown", "youtube_config_invalid"]);
    // Google Ads itself is unaffected by the YouTube settings.
    expect(shared.hasOAuth("google_ads")).toBe(true);
  });

  it("facebook (organic) is not registered", () => {
    const registry = createDefaultRegistry({});
    expect(registry.hasSocial("facebook")).toBe(false);
    expect(() => registry.socialDiscovery("facebook")).toThrow(ProviderNotRegisteredError);
  });

  it("rejects duplicate or mismatched social registrations", () => {
    const entry = {
      platform: "instagram" as const,
      providerId: "x",
      capabilities: INSTAGRAM_CAPABILITIES,
      discovery: createMockSocialDiscovery(),
    };
    expect(() => createProviderRegistry({ ads: [], social: [entry, entry] })).toThrow(/Duplicate/);
    expect(() =>
      createProviderRegistry({ ads: [], social: [{ ...entry, platform: "facebook" }] }),
    ).toThrow(/mismatch/);
  });
});

describe("node registry (Node-only sync provider)", () => {
  it("follows the same D8 matrix", async () => {
    expect(socialProviderFor("instagram", {}).providerId).toBe(MOCK_SOCIAL_PROVIDER_ID);
    expect(socialProviderFor("instagram", LIVE).providerId).toBe(INSTAGRAM_PROVIDER_ID);
    const unconfigured = socialProviderFor("instagram", { PROVIDER_MODE: "live" });
    const auth = await rejection(
      unconfigured.getAccount({ credential: {}, attempt: 1 }, { accountExternalId: "1" }),
    );
    expect([auth.kind, auth.providerCode]).toEqual(["auth", "provider_unavailable"]);
    const misconfigured = socialProviderFor("instagram", { PROVIDER_MODE: "Live" });
    const unknown = await rejection(
      misconfigured.listPosts({ credential: {}, attempt: 1 }, { accountExternalId: "1" }),
    );
    expect([unknown.kind, unknown.providerCode]).toEqual(["unknown", "provider_mode_invalid"]);
    expect(() => socialProviderFor("facebook", {})).toThrow(ProviderNotRegisteredError);
  });

  it("resolves YouTube on the same matrix (ADR 0016)", async () => {
    expect(socialProviderFor("youtube", {}).providerId).toBe(MOCK_YOUTUBE_PROVIDER_ID);
    const live = socialProviderFor("youtube", {
      PROVIDER_MODE: "live",
      YOUTUBE_CLIENT_ID: "100000000001-fakeyoutubeclient.apps.googleusercontent.com",
      YOUTUBE_CLIENT_SECRET: "fake-secret-1",
    });
    expect(live.providerId).toBe(YOUTUBE_PROVIDER_ID);
    expect(live.capabilities).toBe(YOUTUBE_CAPABILITIES);
    const unconfigured = socialProviderFor("youtube", { PROVIDER_MODE: "live" });
    const auth = await rejection(
      unconfigured.getAccount({ credential: {}, attempt: 1 }, { accountExternalId: "UC1" }),
    );
    expect([auth.kind, auth.providerCode]).toEqual(["auth", "provider_unavailable"]);
    const misconfigured = socialProviderFor("youtube", { CONVEX_CLOUD_URL: CLOUD });
    const unknown = await rejection(
      misconfigured.listPosts({ credential: {}, attempt: 1 }, { accountExternalId: "UC1" }),
    );
    expect([unknown.kind, unknown.providerCode]).toEqual(["unknown", "provider_mode_missing"]);
    // Instagram is unaffected.
    expect(socialProviderFor("instagram", {}).providerId).toBe(MOCK_SOCIAL_PROVIDER_ID);
  });
});
