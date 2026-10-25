import { createGoogleAdsProvider } from "./google";
import { INSTAGRAM_CAPABILITIES } from "./instagram/capabilities";
import { INSTAGRAM_PROVIDER_ID, instagramConfigured } from "./instagram/config";
import { createInstagramDiscovery } from "./instagram/discovery";
import { createInstagramOAuthSpec } from "./instagram/oauth";
import { createGoogleOAuthSpec } from "./google/oauth";
import { createMockAdsProvider } from "./mock";
import { createMockOAuthSpec } from "./mock/oauth";
import { META_CAPABILITIES, createMetaAdsProvider } from "./meta";
import { createMetaOAuthSpec } from "./meta/oauth";
import { resolveProviderMode, type ProviderModeResolution } from "./mode";
import { createProviderRegistry, type ProviderRegistry, type SocialRegistration } from "./registry";
import {
  createMockInstagramOAuthSpec,
  createMockSocialDiscovery,
  MOCK_SOCIAL_PROVIDER_ID,
} from "./social/mock";
import {
  createMockYouTubeDiscovery,
  createMockYouTubeOAuthSpec,
  MOCK_YOUTUBE_PROVIDER_ID,
} from "./social/mock/youtube";
import { createUnavailableSocialDiscovery } from "./social/unavailable";
import { createUnavailableAdsProvider } from "./unavailable";
import { YOUTUBE_CAPABILITIES } from "./youtube/capabilities";
import { YOUTUBE_PROVIDER_ID, youtubeAppConfig, youtubeConfigured } from "./youtube/config";
import { createYouTubeDiscovery } from "./youtube/discovery";
import { createYouTubeOAuthSpec } from "./youtube/oauth";

export {
  createProviderRegistry,
  ProviderNotRegisteredError,
  type ProviderRegistry,
  type SocialRegistration,
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
 * Instagram (Phase 10, organic social; same matrix): mock → the social mock (discovery +
 * mock Instagram OAuth); live → the Instagram OAuth spec + SDK-free discovery when
 * Instagram is configured, else an unavailable discovery ("auth"/provider_unavailable) and
 * no OAuth spec; misconfigured → an unavailable discovery ("unknown"/provider_mode_*).
 * Instagram capabilities are always registered (static, read by the planner). The
 * SDK-backed sync provider is resolved only in "use node" code (social/nodeRegistry.ts).
 * Construction is pure and never throws; env is read on every call, so fixing the
 * env takes effect on the next call.
 */
function instagramRegistration(
  providerId: string,
  discovery: SocialRegistration["discovery"],
): SocialRegistration {
  return { platform: "instagram", providerId, capabilities: INSTAGRAM_CAPABILITIES, discovery };
}

/**
 * YouTube (ADR 0016, organic social; same matrix as Instagram): mock → the mock YouTube OAuth
 * spec + discovery; live → the YouTube OAuth spec + default-runtime discovery when
 * YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET are set (a client shared with Google Ads is refused
 * per call as youtube_config_invalid), else an unavailable discovery ("auth" /
 * provider_unavailable) and no OAuth spec; misconfigured → an unavailable discovery ("unknown").
 */
function youtubeRegistration(
  providerId: string,
  discovery: SocialRegistration["discovery"],
): SocialRegistration {
  return { platform: "youtube", providerId, capabilities: YOUTUBE_CAPABILITIES, discovery };
}

/**
 * Google counts as configured when either OAuth client value is present (Phase 9). There is
 * no developer token (sunset 2026-09-09; access belongs to the OAuth client's Cloud project).
 */
function googleConfigured(env: Record<string, string | undefined>): boolean {
  return ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].some((name) => (env[name] ?? "") !== "");
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
        oauth: [
          createMockOAuthSpec("meta"),
          createMockOAuthSpec("google_ads"),
          createMockInstagramOAuthSpec(),
          createMockYouTubeOAuthSpec(),
        ],
        social: [
          instagramRegistration(MOCK_SOCIAL_PROVIDER_ID, createMockSocialDiscovery()),
          youtubeRegistration(MOCK_YOUTUBE_PROVIDER_ID, createMockYouTubeDiscovery()),
        ],
      });
    case "live": {
      const google = googleConfigured(env);
      const instagram = instagramConfigured(env);
      const youtube = youtubeConfigured(env);
      const googleVersion =
        env.GOOGLE_ADS_API_VERSION !== undefined ? { version: env.GOOGLE_ADS_API_VERSION } : {};
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
          ...(google ? [createGoogleOAuthSpec(googleVersion)] : []),
          ...(instagram ? [createInstagramOAuthSpec()] : []),
          ...(youtube ? [createYouTubeOAuthSpec()] : []),
        ],
        social: [
          instagram
            ? instagramRegistration(INSTAGRAM_PROVIDER_ID, createInstagramDiscovery())
            : instagramRegistration(
                "unavailable",
                createUnavailableSocialDiscovery({
                  platform: "instagram",
                  kind: "auth",
                  providerCode: "provider_unavailable",
                  message: "Instagram is not configured in this deployment",
                }),
              ),
          youtube
            ? youtubeRegistration(
                YOUTUBE_PROVIDER_ID,
                createYouTubeDiscovery(youtubeAppConfig(env)),
              )
            : youtubeRegistration(
                "unavailable",
                createUnavailableSocialDiscovery({
                  platform: "youtube",
                  kind: "auth",
                  providerCode: "provider_unavailable",
                  message: "YouTube is not configured in this deployment",
                }),
              ),
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
        social: [
          instagramRegistration(
            "unavailable",
            createUnavailableSocialDiscovery({
              platform: "instagram",
              kind: "unknown",
              providerCode: mode.code,
              message: "PROVIDER_MODE is missing or invalid",
            }),
          ),
          youtubeRegistration(
            "unavailable",
            createUnavailableSocialDiscovery({
              platform: "youtube",
              kind: "unknown",
              providerCode: mode.code,
              message: "PROVIDER_MODE is missing or invalid",
            }),
          ),
        ],
      });
  }
}
