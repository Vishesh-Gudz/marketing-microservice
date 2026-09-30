import type { SocialConnectionProvider, SocialPlatform } from "../../domain/types";
import { ProviderError, type ProviderErrorKind } from "../errors";
import type { ProviderOperation } from "../types";
import type { SocialProviderCapabilities } from "./capabilities";
import type { SocialAccountDiscovery, SocialProvider } from "./types";

/**
 * Social stand-ins for a platform that must not be called (Phase 10, same D8 matrix as
 * convex/providers/unavailable.ts): live mode without Instagram configuration ("auth" /
 * provider_unavailable) and a misconfigured PROVIDER_MODE ("unknown" / provider_mode_*).
 * Every call throws before any network access; capabilities stay readable.
 */
type Failure = {
  kind: Extract<ProviderErrorKind, "auth" | "unknown">;
  providerCode: string;
  message: string;
};

function thrower(platform: SocialPlatform, failure: Failure) {
  return (operation: ProviderOperation) => async (): Promise<never> => {
    throw new ProviderError({ ...failure, platform, operation });
  };
}

export function createUnavailableSocialDiscovery(
  options: { platform: SocialConnectionProvider } & Failure,
): SocialAccountDiscovery {
  const fail = thrower(options.platform, options);
  return Object.freeze({
    platform: options.platform,
    providerId: "unavailable",
    listAccounts: fail("listSocialAccounts"),
  });
}

export function createUnavailableSocialProvider(
  options: { platform: SocialPlatform; capabilities: SocialProviderCapabilities } & Failure,
): SocialProvider {
  const fail = thrower(options.platform, options);
  return Object.freeze({
    platform: options.platform,
    providerId: "unavailable",
    capabilities: options.capabilities,
    getAccount: fail("getSocialAccount"),
    listPosts: fail("listSocialPosts"),
    fetchPostMetrics: fail("fetchPostMetrics"),
    fetchAccountMetrics: fail("fetchAccountMetrics"),
  });
}
