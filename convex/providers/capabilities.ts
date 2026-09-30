import type { AdMetricKey } from "../domain/metrics";
import type { AdGroupKind, AdPlatform, EntityLevel, Placement } from "../domain/types";
import { ProviderError } from "./errors";
import type { ProviderOperation } from "./types";

/**
 * Static, declarative description of what a provider supports. The contract
 * suite verifies that emitted data never exceeds what is declared here.
 */
export type AdsProviderCapabilities = {
  entities: { campaigns: boolean; adGroups: boolean; ads: boolean; creatives: boolean };
  adGroupKinds: readonly AdGroupKind[];
  /** Honors EntityRequest.updatedSince. */
  incrementalEntities: boolean;
  metricLevels: readonly EntityLevel[];
  /** Supports MetricsRequest.breakdown = "placement". */
  placementBreakdown: boolean;
  /** Placements that may appear in rows (always includes "all"). */
  placements: readonly Placement[];
  /** Metric columns that may appear; all others are always absent. */
  reportedMetrics: readonly AdMetricKey[];
  actionMetrics: boolean;
  attributionWindows: readonly string[];
  /** Longer metric ranges are rejected with invalid_request (sync chunks by month). */
  maxMetricsRangeDays: number;
  defaultPageSize: number;
  maxPageSize: number;
  /** How far back the platform restates data; a hint for Phase 5 lookback syncs. */
  restatementLookbackDays: number;
};

export function assertCapability(
  supported: boolean,
  platform: AdPlatform,
  operation: ProviderOperation,
  what: string,
): asserts supported {
  if (!supported) {
    throw new ProviderError({
      kind: "unsupported",
      platform,
      operation,
      message: `${platform} provider does not support ${what}`,
    });
  }
}
