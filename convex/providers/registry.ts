import type { AdPlatform } from "../domain/types";
import type { OAuthSpec } from "./oauth";
import type { AdsProvider } from "./types";

export class ProviderNotRegisteredError extends Error {
  constructor(
    readonly platform: string,
    readonly family: "ads" | "oauth" = "ads",
  ) {
    super(`No ${family} provider registered for platform "${platform}"`);
    this.name = "ProviderNotRegisteredError";
  }
}

/**
 * Resolves providers by platform. Built from lists (no platform switch):
 * adding Meta/Google later = one module per family + one list entry.
 * Families: ads (Phase 3), oauth (Phase 4); social (Phase 10) and messaging
 * (Phase 11) add sibling maps.
 */
export type ProviderRegistry = {
  ads(platform: AdPlatform): AdsProvider;
  hasAds(platform: AdPlatform): boolean;
  adsPlatforms(): AdPlatform[];
  /** OAuth spec used to connect a platform identity. */
  oauth(platform: AdPlatform): OAuthSpec;
  hasOAuth(platform: AdPlatform): boolean;
};

function byPlatform<T extends { platform: AdPlatform }>(family: string, items: readonly T[]) {
  const map = new Map<AdPlatform, T>();
  for (const item of items) {
    if (map.has(item.platform)) {
      throw new Error(`Duplicate ${family} provider registration for platform "${item.platform}"`);
    }
    map.set(item.platform, item);
  }
  return map;
}

export function createProviderRegistry(input: {
  ads: readonly AdsProvider[];
  oauth?: readonly OAuthSpec[];
}): ProviderRegistry {
  const ads = byPlatform("ads", input.ads);
  const oauth = byPlatform("oauth", input.oauth ?? []);

  return Object.freeze({
    ads(platform: AdPlatform): AdsProvider {
      const provider = ads.get(platform);
      if (provider === undefined) throw new ProviderNotRegisteredError(platform);
      return provider;
    },
    hasAds: (platform: AdPlatform) => ads.has(platform),
    adsPlatforms: () => [...ads.keys()].sort(),
    oauth(platform: AdPlatform): OAuthSpec {
      const spec = oauth.get(platform);
      if (spec === undefined) throw new ProviderNotRegisteredError(platform, "oauth");
      return spec;
    },
    hasOAuth: (platform: AdPlatform) => oauth.has(platform),
  });
}
