import type { AdPlatform } from "../domain/types";
import type { AdsProviderCapabilities } from "./capabilities";
import { ProviderError, type ProviderErrorKind } from "./errors";
import type { AdsProvider, ProviderOperation } from "./types";

/**
 * Generic stand-in for a platform that must not be called (Phase 8, D8):
 * - live mode registers it for google_ads (kind "auth", code "provider_unavailable"), so
 *   leftover mock Google connections move to needs_reauth instead of syncing synthetic data;
 * - a misconfigured PROVIDER_MODE registers it for every platform (kind "unknown", code
 *   "provider_mode_missing" / "provider_mode_invalid"): tasks fail without reauth, reversibly.
 * It declares static capabilities so capability lookups (planner, guards, analytics) stay
 * total and stored data stays readable. Every call throws before any network access.
 */
export function createUnavailableAdsProvider(options: {
  platform: AdPlatform;
  capabilities: AdsProviderCapabilities;
  kind: Extract<ProviderErrorKind, "auth" | "unknown">;
  providerCode: string;
  message: string;
}): AdsProvider {
  const { platform, kind, providerCode, message } = options;
  const fail = (operation: ProviderOperation) => async (): Promise<never> => {
    throw new ProviderError({ kind, platform, operation, message, providerCode });
  };
  return Object.freeze({
    platform,
    providerId: "unavailable",
    capabilities: options.capabilities,
    listAccounts: fail("listAccounts"),
    getAccount: fail("getAccount"),
    listCampaigns: fail("listCampaigns"),
    listAdGroups: fail("listAdGroups"),
    listAds: fail("listAds"),
    listCreatives: fail("listCreatives"),
    fetchDailyMetrics: fail("fetchDailyMetrics"),
    fetchActionMetrics: fail("fetchActionMetrics"),
  });
}
