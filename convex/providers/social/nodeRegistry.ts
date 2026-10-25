"use node";

import type { SocialPlatform } from "../../domain/types";
import { INSTAGRAM_CAPABILITIES } from "../instagram/capabilities";
import { instagramConfigured } from "../instagram/config";
import { createInstagramSocialProvider } from "../instagram/node/provider";
import { resolveProviderMode } from "../mode";
import { ProviderNotRegisteredError } from "../registry";
import { YOUTUBE_CAPABILITIES } from "../youtube/capabilities";
import { youtubeAppConfig, youtubeConfigured } from "../youtube/config";
import { createYouTubeSocialProvider } from "../youtube/provider";
import { createMockSocialProvider } from "./mock";
import { createMockYouTubeSocialProvider } from "./mock/youtube";
import type { SocialProvider } from "./types";
import { createUnavailableSocialProvider } from "./unavailable";

/**
 * Resolves the social SYNC provider (Phase 10; YouTube: ADR 0016). "use node": imported ONLY
 * by the "use node" social worker (convex/sync/socialWorker.ts), never by default-runtime
 * code (ESLint-enforced). Same PROVIDER_MODE matrix (D8) as createDefaultRegistry:
 *   mock          -> the platform's mock social provider
 *   live          -> the platform's provider when it is configured, else an unavailable
 *                    stub ("auth" / provider_unavailable)
 *   misconfigured -> an unavailable stub ("unknown" / provider_mode_*)
 * Env is read per call; construction never throws for instagram or youtube.
 */
export function socialProviderFor(
  platform: SocialPlatform,
  env: Record<string, string | undefined> = process.env,
): SocialProvider {
  if (platform === "youtube") return youtubeProviderFor(env);
  if (platform !== "instagram") throw new ProviderNotRegisteredError(platform, "social");
  const mode = resolveProviderMode(env);
  switch (mode.mode) {
    case "mock":
      return createMockSocialProvider();
    case "live":
      return instagramConfigured(env)
        ? createInstagramSocialProvider({
            ...(env.INSTAGRAM_APP_ID !== undefined ? { appId: env.INSTAGRAM_APP_ID } : {}),
          })
        : createUnavailableSocialProvider({
            platform,
            capabilities: INSTAGRAM_CAPABILITIES,
            kind: "auth",
            providerCode: "provider_unavailable",
            message: "Instagram is not configured in this deployment",
          });
    case "misconfigured":
      return createUnavailableSocialProvider({
        platform,
        capabilities: INSTAGRAM_CAPABILITIES,
        kind: "unknown",
        providerCode: mode.code,
        message: "PROVIDER_MODE is missing or invalid",
      });
  }
}

/** YouTube (ADR 0016): plain fetch, no SDK; the same matrix as Instagram. */
function youtubeProviderFor(env: Record<string, string | undefined>): SocialProvider {
  const mode = resolveProviderMode(env);
  switch (mode.mode) {
    case "mock":
      return createMockYouTubeSocialProvider();
    case "live":
      return youtubeConfigured(env)
        ? createYouTubeSocialProvider(youtubeAppConfig(env))
        : createUnavailableSocialProvider({
            platform: "youtube",
            capabilities: YOUTUBE_CAPABILITIES,
            kind: "auth",
            providerCode: "provider_unavailable",
            message: "YouTube is not configured in this deployment",
          });
    case "misconfigured":
      return createUnavailableSocialProvider({
        platform: "youtube",
        capabilities: YOUTUBE_CAPABILITIES,
        kind: "unknown",
        providerCode: mode.code,
        message: "PROVIDER_MODE is missing or invalid",
      });
  }
}
