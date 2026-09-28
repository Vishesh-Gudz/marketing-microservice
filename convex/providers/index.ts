import { createGoogleAdsProvider } from "./google";
import { createGoogleOAuthSpec } from "./google/oauth";
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
 *   live          → the real Meta provider + OAuth spec; Google: the real provider + OAuth
 *                   spec when Google is configured (Phase 9), else the unavailable stub
 *                   ("auth"/provider_unavailable, no Google OAuth) exactly as in Phase 8
 *   misconfigured → unavailable stubs for every platform ("unknown"/provider_mode_*),
 *                   no OAuth specs: no Graph calls, no mock data, no reauth cascade.
 * Construction is pure and never throws; env is read on every call, so fixing the
 * env takes effect on the next call.
 */
/** Google counts as configured when any of its env values is present (Phase 9). */
function googleConfigured(env: Record<string, string | undefined>): boolean {
  return ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_ADS_DEVELOPER_TOKEN"].some(
    (name) => (env[name] ?? "") !== "",
  );
}

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
    case "live": {
      const google = googleConfigured(env);
      const googleVersion =
        env.GOOGLE_ADS_API_VERSION !== undefined ? { version: env.GOOGLE_ADS_API_VERSION } : {};
      const developerToken =
        env.GOOGLE_ADS_DEVELOPER_TOKEN !== undefined
          ? { developerToken: env.GOOGLE_ADS_DEVELOPER_TOKEN }
          : {};
      return createProviderRegistry({
        ads: [
          createMetaAdsProvider({
            ...(env.META_GRAPH_API_VERSION !== undefined
              ? { version: env.META_GRAPH_API_VERSION }
              : {}),
            ...(env.META_APP_ID !== undefined ? { appId: env.META_APP_ID } : {}),
            ...(env.META_APP_SECRET !== undefined ? { appSecret: env.META_APP_SECRET } : {}),
          }),
          google
            ? createGoogleAdsProvider({
                ...googleVersion,
                ...developerToken,
                ...(env.GOOGLE_CLIENT_ID !== undefined ? { clientId: env.GOOGLE_CLIENT_ID } : {}),
                ...(env.GOOGLE_CLIENT_SECRET !== undefined
                  ? { clientSecret: env.GOOGLE_CLIENT_SECRET }
                  : {}),
              })
            : createUnavailableAdsProvider({
                platform: "google_ads",
                capabilities: googleCapabilities,
                kind: "auth",
                providerCode: "provider_unavailable",
                message: "Google Ads is not configured in this deployment",
              }),
        ],
        oauth: [
          createMetaOAuthSpec(
            env.META_GRAPH_API_VERSION !== undefined ? { version: env.META_GRAPH_API_VERSION } : {},
          ),
          ...(google ? [createGoogleOAuthSpec({ ...googleVersion, ...developerToken })] : []),
        ],
      });
    }
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
