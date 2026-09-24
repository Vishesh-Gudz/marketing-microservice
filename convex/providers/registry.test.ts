import { describe, expect, it } from "vitest";
import { createDefaultRegistry } from ".";
import { createMockAdsProvider } from "./mock";
import { createProviderRegistry, ProviderNotRegisteredError } from "./registry";

describe("provider registry", () => {
  it("resolves providers by their own platform", () => {
    const meta = createMockAdsProvider({ platform: "meta" });
    const registry = createProviderRegistry({ ads: [meta] });
    expect(registry.ads("meta")).toBe(meta);
    expect(registry.hasAds("meta")).toBe(true);
    expect(registry.hasAds("google_ads")).toBe(false);
  });

  it("throws a typed error for unregistered platforms", () => {
    const registry = createProviderRegistry({ ads: [] });
    expect(() => registry.ads("google_ads")).toThrow(ProviderNotRegisteredError);
  });

  it("rejects duplicate registrations", () => {
    expect(() =>
      createProviderRegistry({
        ads: [
          createMockAdsProvider({ platform: "meta" }),
          createMockAdsProvider({ platform: "meta" }),
        ],
      }),
    ).toThrow(/Duplicate/);
  });

  it("is immutable", () => {
    const registry = createProviderRegistry({ ads: [createMockAdsProvider({ platform: "meta" })] });
    expect(Object.isFrozen(registry)).toBe(true);
  });

  it("serves the mock for both platforms by default in Phase 3", () => {
    const registry = createDefaultRegistry();
    expect(registry.adsPlatforms()).toEqual(["google_ads", "meta"]);
    expect(registry.ads("meta").providerId).toBe("mock");
    expect(registry.ads("google_ads").platform).toBe("google_ads");
  });
});
