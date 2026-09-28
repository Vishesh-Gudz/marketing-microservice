import type { AdPlatform, ConnectionProvider, SocialPlatform } from "../domain/types";
import type { OAuthSpec } from "./oauth";
import type { SocialProviderCapabilities } from "./social/capabilities";
import type { SocialAccountDiscovery } from "./social/types";
import type { AdsProvider } from "./types";

export class ProviderNotRegisteredError extends Error {
  constructor(
    readonly platform: string,
    readonly family: "ads" | "oauth" | "social" = "ads",
  ) {
    super(`No ${family} provider registered for platform "${platform}"`);
    this.name = "ProviderNotRegisteredError";
  }
}

/**
 * The default-runtime half of an organic social platform (Phase 10): static capabilities,
 * the run-metadata provider id and the SDK-free account discovery. The SDK-backed sync
 * provider is NOT here (it may only exist in "use node" modules): see
 * convex/providers/social/nodeRegistry.ts.
 */
export type SocialRegistration = {
  platform: SocialPlatform;
  providerId: string;
  capabilities: SocialProviderCapabilities;
  discovery: SocialAccountDiscovery;
};

/**
 * Resolves providers by platform. Built from lists (no platform switch):
 * adding a platform = one module per family + one list entry.
 * Families: ads (Phase 3), oauth (Phase 4, keyed by connection provider), social
 * (Phase 10); messaging (Phase 11) adds a sibling map.
 */
export type ProviderRegistry = {
  ads(platform: AdPlatform): AdsProvider;
  hasAds(platform: AdPlatform): boolean;
  adsPlatforms(): AdPlatform[];
  /** OAuth spec used to connect a platform identity. */
  oauth(platform: ConnectionProvider): OAuthSpec;
  hasOAuth(platform: ConnectionProvider): boolean;
  /** Default-runtime social discovery (no SDK). */
  socialDiscovery(platform: SocialPlatform): SocialAccountDiscovery;
  hasSocial(platform: SocialPlatform): boolean;
  socialCapabilities(platform: SocialPlatform): SocialProviderCapabilities;
  socialProviderId(platform: SocialPlatform): string;
  socialPlatforms(): SocialPlatform[];
};

function byPlatform<P extends string, T extends { platform: P }>(
  family: string,
  items: readonly T[],
) {
  const map = new Map<P, T>();
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
  social?: readonly SocialRegistration[];
}): ProviderRegistry {
  const ads = byPlatform<AdPlatform, AdsProvider>("ads", input.ads);
  const oauth = byPlatform<ConnectionProvider, OAuthSpec>("oauth", input.oauth ?? []);
  const social = byPlatform<SocialPlatform, SocialRegistration>("social", input.social ?? []);
  for (const entry of social.values()) {
    if (entry.discovery.platform !== entry.platform) {
      throw new Error(`Social discovery platform mismatch for "${entry.platform}"`);
    }
  }

  const socialEntry = (platform: SocialPlatform): SocialRegistration => {
    const entry = social.get(platform);
    if (entry === undefined) throw new ProviderNotRegisteredError(platform, "social");
    return entry;
  };

  return Object.freeze({
    ads(platform: AdPlatform): AdsProvider {
      const provider = ads.get(platform);
      if (provider === undefined) throw new ProviderNotRegisteredError(platform);
      return provider;
    },
    hasAds: (platform: AdPlatform) => ads.has(platform),
    adsPlatforms: () => [...ads.keys()].sort(),
    oauth(platform: ConnectionProvider): OAuthSpec {
      const spec = oauth.get(platform);
      if (spec === undefined) throw new ProviderNotRegisteredError(platform, "oauth");
      return spec;
    },
    hasOAuth: (platform: ConnectionProvider) => oauth.has(platform),
    socialDiscovery: (platform: SocialPlatform) => socialEntry(platform).discovery,
    hasSocial: (platform: SocialPlatform) => social.has(platform),
    socialCapabilities: (platform: SocialPlatform) => socialEntry(platform).capabilities,
    socialProviderId: (platform: SocialPlatform) => socialEntry(platform).providerId,
    socialPlatforms: () => [...social.keys()].sort(),
  });
}
