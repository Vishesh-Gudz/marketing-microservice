import type { AdsProviderCapabilities } from "../capabilities";
import { ACTION_WINDOWS, META_PLACEMENTS } from "./semantics";

/**
 * Static Meta capabilities (Phase 8, D21) — Stage B.
 *
 * Declared from the implemented mapping (mapping.ts / semantics.ts). Items tagged
 * [PROVISIONAL] there are not yet verified against a real ad account
 * (docs/providers/meta.md, "Real-account validation required"):
 * - conversions / conversionValueMicros: omni_purchase + lead with the ad set attribution
 *   setting (R15 / D19);
 * - action metrics: conversion action types in fixed 1d_click / 7d_click / 1d_view windows,
 *   reported on the impression date (R14, R16 / D20);
 * - placements: publisher_platform values, unknown values as "other" (R9);
 * - incrementalEntities: false — the updated_time filtering syntax is unverified (V17), so
 *   every listing is a full listing (costlier, never incomplete);
 * - page sizes: 500, provisional until real throughput is measured (D33).
 * `allConversions` is never reported (no Meta equivalent).
 */
const capabilities: AdsProviderCapabilities = {
  entities: { campaigns: true, adGroups: true, ads: true, creatives: true },
  adGroupKinds: ["ad_set"],
  incrementalEntities: false,
  metricLevels: ["account", "campaign", "ad_group", "ad"],
  placementBreakdown: true,
  placements: META_PLACEMENTS,
  reportedMetrics: [
    "spendMicros",
    "impressions",
    "reach",
    "clicks",
    "linkClicks",
    "videoPlays",
    "videoViews",
    "videoCompletions",
    "engagements",
    "reactions",
    "comments",
    "shares",
    "saves",
    "follows",
    "conversions",
    "conversionValueMicros",
  ],
  actionMetrics: true,
  attributionWindows: ACTION_WINDOWS,
  maxMetricsRangeDays: 31,
  defaultPageSize: 500,
  maxPageSize: 500,
  restatementLookbackDays: 28,
};

export const META_CAPABILITIES: AdsProviderCapabilities = Object.freeze(capabilities);
