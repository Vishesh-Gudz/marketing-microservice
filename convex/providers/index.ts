import { createMockAdsProvider } from "./mock";
import { createMockOAuthSpec } from "./mock/oauth";
import { createProviderRegistry, type ProviderRegistry } from "./registry";

export {
  createProviderRegistry,
  ProviderNotRegisteredError,
  type ProviderRegistry,
} from "./registry";
export * from "./errors";
export type * from "./types";
export type { AdsProviderCapabilities } from "./capabilities";
export type * from "./oauth";

/**
 * The registry the rest of the service uses. Phase 3: the deterministic mock
 * serves both platforms. Phase 8/9 add the real Meta / Google providers and a
 * PROVIDER_MODE=mock|live switch here; nothing else changes.
 */
export function createDefaultRegistry(): ProviderRegistry {
  return createProviderRegistry({
    ads: [
      createMockAdsProvider({ platform: "meta" }),
      createMockAdsProvider({ platform: "google_ads" }),
    ],
    // Phase 4: mock "instant consent" OAuth. Real specs: Phase 8 (Meta) / Phase 9 (Google).
    oauth: [createMockOAuthSpec("meta"), createMockOAuthSpec("google_ads")],
  });
}
