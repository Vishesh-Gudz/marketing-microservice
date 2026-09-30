import type { AdsProviderCapabilities } from "../capabilities";
import { GOOGLE_ATTRIBUTION_WINDOWS, GOOGLE_PLACEMENTS } from "./semantics";

/**
 * Static Google Ads capabilities (Phase 9) — Stage B.
 *
 * Declared from the implemented mapping (mapping.ts / semantics.ts); nothing is declared that
 * the mapping does not emit. Items tagged [PROVISIONAL GRn] there are not yet verified
 * against a real account (docs/providers/google-ads.md, "Real-account validation required"):
 * - ad groups of kind `ad_group` and `asset_group` (Performance Max, GR10 / GR20);
 * - placements: the documented ad_network_type values with a canonical placement, unmapped
 *   values as "other" (GR11); asset groups have no placement rows (G-D12);
 * - reported metrics: cost, impressions, clicks, conversions, conversion value and all
 *   conversions (GR12 / GR13); never reach, link clicks, video or engagement metrics;
 * - action metrics: all_conversions per conversion action (identity = resource name,
 *   isPrimary = primary_for_goal) in the "action_setting" window bucket on the interaction
 *   date (GR15);
 * - `incrementalEntities: false` (full listings; change_status is out of scope);
 * - page size 500 = the sync's per-page cap (one fixed 10,000-row Google page is sliced,
 *   G-D16);
 * - lookback 30 days (the sync caps lookback at 30; longer conversion restatement is a
 *   documented limitation, G-D20).
 */
const capabilities: AdsProviderCapabilities = {
  entities: { campaigns: true, adGroups: true, ads: true, creatives: true },
  adGroupKinds: ["ad_group", "asset_group"],
  incrementalEntities: false,
  metricLevels: ["account", "campaign", "ad_group", "ad"],
  placementBreakdown: true,
  placements: GOOGLE_PLACEMENTS,
  reportedMetrics: [
    "spendMicros",
    "impressions",
    "clicks",
    "conversions",
    "conversionValueMicros",
    "allConversions",
  ],
  actionMetrics: true,
  attributionWindows: GOOGLE_ATTRIBUTION_WINDOWS,
  maxMetricsRangeDays: 31,
  defaultPageSize: 500,
  maxPageSize: 500,
  restatementLookbackDays: 30,
};

export const GOOGLE_CAPABILITIES: AdsProviderCapabilities = Object.freeze(capabilities);
