import type { AdPlatform } from "../domain/types";
import type { AdsProvider } from "./types";

export class ProviderNotRegisteredError extends Error {
  constructor(readonly platform: string) {
    super(`No ads provider registered for platform "${platform}"`);
    this.name = "ProviderNotRegisteredError";
  }
}

/**
 * Resolves providers by platform. Built from a list (no platform switch):
 * adding Meta/Google later = one provider module + one list entry.
 * Later families (social in Phase 10, messaging in Phase 11) add sibling maps.
 */
export type ProviderRegistry = {
  ads(platform: AdPlatform): AdsProvider;
  hasAds(platform: AdPlatform): boolean;
  adsPlatforms(): AdPlatform[];
};

export function createProviderRegistry(input: { ads: readonly AdsProvider[] }): ProviderRegistry {
  const ads = new Map<AdPlatform, AdsProvider>();
  for (const provider of input.ads) {
    if (ads.has(provider.platform)) {
      throw new Error(`Duplicate ads provider registration for platform "${provider.platform}"`);
    }
    ads.set(provider.platform, provider);
  }

  return Object.freeze({
    ads(platform: AdPlatform): AdsProvider {
      const provider = ads.get(platform);
      if (provider === undefined) throw new ProviderNotRegisteredError(platform);
      return provider;
    },
    hasAds: (platform: AdPlatform) => ads.has(platform),
    adsPlatforms: () => [...ads.keys()].sort(),
  });
}
