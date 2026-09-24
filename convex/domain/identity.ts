import type { AdPlatform, SocialPlatform } from "./types";

/**
 * Canonical external-id forms. External ids are ALWAYS strings: Google ids are
 * int64 and exceed Number.MAX_SAFE_INTEGER.
 *
 * Natural keys (enforced by the Phase 5 write path via the matching indexes):
 *   adAccounts                              (orgId, platform, externalId)
 *   campaigns / adGroups / ads / creatives  (orgId, adAccountId, externalId)
 *   socialAccounts                          (orgId, platform, externalId)
 *   socialPosts                             (orgId, socialAccountId, externalId)
 * Because account keys include the platform and child keys include their ad
 * account, Meta and Google ids can never collide, and the same external
 * account connected by two orgs yields two independent rows.
 */
export class ExternalIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExternalIdError";
  }
}

const NUMERIC_ID = /^\d{1,20}$/;

/** Numeric platform id as a string ("120210000000001"). */
export function normalizeNumericId(raw: string, label = "id"): string {
  const value = raw.trim();
  if (!NUMERIC_ID.test(value)) {
    throw new ExternalIdError(`${label} must be a numeric string, got "${raw}"`);
  }
  return value;
}

/** Meta ad account: "act_123" or "123" -> "123". */
export function normalizeMetaAdAccountId(raw: string): string {
  return normalizeNumericId(raw.trim().replace(/^act_/, ""), "Meta ad account id");
}

/** Google Ads customer: "123-456-7890" or "1234567890" -> "1234567890". */
export function normalizeGoogleCustomerId(raw: string): string {
  const value = raw.trim().replace(/-/g, "");
  if (!/^\d{10}$/.test(value)) {
    throw new ExternalIdError(`Google Ads customer id must have 10 digits, got "${raw}"`);
  }
  return value;
}

export function normalizeAdAccountExternalId(platform: AdPlatform, raw: string): string {
  switch (platform) {
    case "meta":
      return normalizeMetaAdAccountId(raw);
    case "google_ads":
      return normalizeGoogleCustomerId(raw);
  }
}

/**
 * Google ad ids are only unique within their ad group, so the canonical
 * external id is "{adGroupId}~{adId}" (same shape as the ad_group_ad resource name suffix).
 */
export function googleAdExternalId(adGroupId: string, adId: string): string {
  return `${normalizeNumericId(adGroupId, "Google ad group id")}~${normalizeNumericId(adId, "Google ad id")}`;
}

export function parseGoogleAdExternalId(externalId: string): { adGroupId: string; adId: string } {
  const match = /^(\d{1,20})~(\d{1,20})$/.exec(externalId);
  if (!match) throw new ExternalIdError(`Invalid Google ad external id "${externalId}"`);
  return { adGroupId: match[1]!, adId: match[2]! };
}

/** Instagram user/media ids and Facebook page ids are numeric strings. */
export function normalizeSocialExternalId(platform: SocialPlatform, raw: string): string {
  return normalizeNumericId(raw, `${platform} id`);
}
