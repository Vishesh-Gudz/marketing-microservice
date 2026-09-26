import { createMockAdsProvider } from "./mock";
import { createMockOAuthSpec } from "./mock/oauth";
import { META_CAPABILITIES, createMetaAdsProvider } from "./meta";
import { createMetaOAuthSpec } from "./meta/oauth";
import { resolveProviderMode, type ProviderModeResolution } from "./mode";
import { createProviderRegistry, type ProviderRegistry } from "./registry";
import { createUnavailableAdsProvider } from "./unavailable";

export {
  createProviderRegistry,
  ProviderNotRegisteredError,
  type ProviderRegistry,
} from "./registry";
export * from "./errors";
export type * from "./types";
export type { AdsProviderCapabilities } from "./capabilities";
export type * from "./oauth";
export { resolveProviderMode, type ProviderModeResolution } from "./mode";

/**
 * The registry the rest of the service uses (Phase 8, D8). PROVIDER_MODE fails closed
 * (see mode.ts):
 *   mock          → the deterministic mocks (Phases 3-7 behavior, the local default)
 *   live          → the real Meta provider + OAuth spec; Google is an unavailable stub
 *                   ("auth"/provider_unavailable) until Phase 9 — no Google OAuth
 *   misconfigured → unavailable stubs for every platform ("unknown"/provider_mode_*),
 *                   no OAuth specs: no Graph calls, no mock data, no reauth cascade.
 * Construction is pure and never throws; env is read on every call, so fixing the
 * env takes effect on the next call.
 */
export function createDefaultRegistry(
  env: Record<string, string | undefined> = process.env,
): ProviderRegistry {
  const mode: ProviderModeResolution = resolveProviderMode(env);
  const googleCapabilities = createMockAdsProvider({ platform: "google_ads" }).capabilities;

  switch (mode.mode) {
    case "mock":
      return createProviderRegistry({
        ads: [
          createMockAdsProvider({ platform: "meta" }),
          createMockAdsProvider({ platform: "google_ads" }),
        ],
        oauth: [createMockOAuthSpec("meta"), createMockOAuthSpec("google_ads")],
      });
    case "live":
      return createProviderRegistry({
        ads: [
          createMetaAdsProvider({
            ...(env.META_GRAPH_API_VERSION !== undefined
              ? { version: env.META_GRAPH_API_VERSION }
              : {}),
            ...(env.META_APP_ID !== undefined ? { appId: env.META_APP_ID } : {}),
            ...(env.META_APP_SECRET !== undefined ? { appSecret: env.META_APP_SECRET } : {}),
          }),
          createUnavailableAdsProvider({
            platform: "google_ads",
            capabilities: googleCapabilities,
            kind: "auth",
            providerCode: "provider_unavailable",
            message: "Google Ads is not available in live mode yet",
          }),
        ],
        oauth: [
          createMetaOAuthSpec(
            env.META_GRAPH_API_VERSION !== undefined ? { version: env.META_GRAPH_API_VERSION } : {},
          ),
        ],
      });
    case "misconfigured":
      return createProviderRegistry({
        ads: [
          createUnavailableAdsProvider({
            platform: "meta",
            capabilities: META_CAPABILITIES,
            kind: "unknown",
            providerCode: mode.code,
            message: "PROVIDER_MODE is missing or invalid",
          }),
          createUnavailableAdsProvider({
            platform: "google_ads",
            capabilities: googleCapabilities,
            kind: "unknown",
            providerCode: mode.code,
            message: "PROVIDER_MODE is missing or invalid",
          }),
        ],
        oauth: [],
      });
  }
}
