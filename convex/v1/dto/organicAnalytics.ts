import { v, type Infer } from "convex/values";
import type { OrganicAggregate, OrganicDelta } from "../../analytics/organic/aggregate";
import {
  ORGANIC_ACCOUNT_METRIC_NAMES,
  ORGANIC_ACCOUNT_METRICS,
  ORGANIC_DELTA_REASONS,
  ORGANIC_METRIC_REASONS,
} from "../../analytics/organic/metrics";
import type { OrganicOverview, SeriesPoint } from "../../analytics/organic/queries";
import { countToNumber, fixed6ToNumber } from "../../analytics/numeric";
import { literalUnion } from "../../domain/validators";
import { toIso } from "../../lib/dto";
import { organicDataStateDto, organicKpisDto } from "./socialPost";

/**
 * Organic analytics DTOs (Phase 10 Stage B). Account metrics are on UTC days: every response
 * says so (`timezone: "UTC"`), distinct from post publish days (organization timezone).
 * Unavailable values are omitted (never null, never 0) and explained in unavailableMetrics /
 * unavailableKpis; partialMetrics lists values summed over only part of the synced days (or,
 * for followers, of the accounts). No ad metric, no deprecated metric value, no post delta.
 */

const optionalNumber = v.optional(v.number());
const metricName = literalUnion(ORGANIC_ACCOUNT_METRIC_NAMES);

export const organicDateRangeDto = v.object({ from: v.string(), to: v.string() });

export const organicMetricsDto = v.object({
  /** Sum of each account's latest follower capture in scope (never summed over days). */
  followers: optionalNumber,
  followerDelta: optionalNumber,
  reach: optionalNumber,
  views: optionalNumber,
  accountsEngaged: optionalNumber,
  totalInteractions: optionalNumber,
  likes: optionalNumber,
  comments: optionalNumber,
  shares: optionalNumber,
  saves: optionalNumber,
  replies: optionalNumber,
  profileLinksTaps: optionalNumber,
  /** Latest capture used for `followers` (ISO instant). */
  followersCapturedAt: v.optional(v.string()),
  unavailableMetrics: v.array(
    v.object({ metric: metricName, reason: literalUnion(ORGANIC_METRIC_REASONS) }),
  ),
  partialMetrics: v.array(literalUnion(ORGANIC_ACCOUNT_METRICS)),
});

export const organicAggregateDto = v.object({
  dataState: organicDataStateDto,
  metrics: organicMetricsDto,
  kpis: organicKpisDto,
});
export type OrganicAggregateDto = Infer<typeof organicAggregateDto>;

const deltaDto = v.optional(
  v.object({
    absolute: optionalNumber,
    percent: optionalNumber,
    reason: v.optional(literalUnion(ORGANIC_DELTA_REASONS)),
    partial: v.optional(v.boolean()),
  }),
);

export const organicDeltasDto = v.object({
  followerDelta: deltaDto,
  views: deltaDto,
  totalInteractions: deltaDto,
  likes: deltaDto,
  comments: deltaDto,
  shares: deltaDto,
  saves: deltaDto,
  replies: deltaDto,
  profileLinksTaps: deltaDto,
  engagementRate: deltaDto,
});

export const organicOverviewDto = v.object({
  /** Account-metric days are UTC days. */
  timezone: v.literal("UTC"),
  range: organicDateRangeDto,
  accountCount: v.number(),
  totals: organicAggregateDto,
  comparison: v.optional(
    v.object({
      range: organicDateRangeDto,
      previous: organicAggregateDto,
      deltas: organicDeltasDto,
    }),
  ),
  coverage: v.object({
    dataState: organicDataStateDto,
    accounts: v.array(
      v.object({
        accountId: v.string(),
        /** UTC days of the range with synced account insights. */
        syncedDays: v.number(),
        unsyncedDays: v.number(),
        lastSyncedAt: v.optional(v.string()),
      }),
    ),
  }),
});
export type OrganicOverviewDto = Infer<typeof organicOverviewDto>;

export const organicGranularityValidator = v.union(
  v.literal("day"),
  v.literal("week"),
  v.literal("month"),
);

export const organicSeriesDto = v.object({
  timezone: v.literal("UTC"),
  accountId: v.string(),
  range: organicDateRangeDto,
  granularity: organicGranularityValidator,
  dataState: organicDataStateDto,
  points: v.array(
    v.object({
      /** day: YYYY-MM-DD (UTC); week: the ISO week's Monday; month: YYYY-MM. */
      bucket: v.string(),
      from: v.string(),
      to: v.string(),
      /** The bucket is cut by the requested range. */
      partial: v.boolean(),
      dataState: organicDataStateDto,
      metrics: organicMetricsDto,
      kpis: organicKpisDto,
    }),
  ),
});
export type OrganicSeriesDto = Infer<typeof organicSeriesDto>;

// ---------------------------------------------------------------------------
// Mappers (bigint domain values -> JSON-safe DTOs)
// ---------------------------------------------------------------------------

export function toOrganicAggregateDto(aggregate: OrganicAggregate): OrganicAggregateDto {
  const values: Record<string, number> = {};
  for (const [metric, value] of Object.entries(aggregate.values)) {
    values[metric] = countToNumber(value);
  }
  return {
    dataState: aggregate.dataState,
    metrics: {
      ...values,
      ...(aggregate.followersCapturedAt !== undefined
        ? { followersCapturedAt: toIso(aggregate.followersCapturedAt) }
        : {}),
      unavailableMetrics: aggregate.unavailableMetrics,
      partialMetrics: aggregate.partialMetrics,
    },
    kpis: {
      ...(aggregate.engagementRate !== undefined
        ? { engagementRate: fixed6ToNumber(aggregate.engagementRate) }
        : {}),
      unavailableKpis: aggregate.unavailableKpis,
    },
  };
}

function toDeltaDto(delta: OrganicDelta, rate: boolean) {
  return {
    ...(delta.absolute !== undefined
      ? { absolute: rate ? fixed6ToNumber(delta.absolute) : countToNumber(delta.absolute) }
      : {}),
    ...(delta.percent !== undefined ? { percent: fixed6ToNumber(delta.percent) } : {}),
    ...(delta.reason !== undefined ? { reason: delta.reason } : {}),
    ...(delta.partial ? { partial: true } : {}),
  };
}

export function toOrganicOverviewDto(overview: OrganicOverview): OrganicOverviewDto {
  return {
    timezone: "UTC",
    range: overview.range,
    accountCount: overview.accountCount,
    totals: toOrganicAggregateDto(overview.totals),
    ...(overview.comparison !== undefined
      ? {
          comparison: {
            range: overview.comparison.range,
            previous: toOrganicAggregateDto(overview.comparison.previous),
            deltas: Object.fromEntries(
              Object.entries(overview.comparison.deltas).map(([name, delta]) => [
                name,
                toDeltaDto(delta, name === "engagementRate"),
              ]),
            ),
          },
        }
      : {}),
    coverage: {
      dataState: overview.coverage.dataState,
      accounts: overview.coverage.accounts.map(({ lastSyncedAt, ...rest }) => ({
        ...rest,
        ...(lastSyncedAt !== undefined ? { lastSyncedAt: toIso(lastSyncedAt) } : {}),
      })),
    },
  };
}

export function toOrganicSeriesPointDto(point: SeriesPoint) {
  return {
    bucket: point.key,
    from: point.from,
    to: point.to,
    partial: point.partial,
    ...toOrganicAggregateDto(point.aggregate),
  };
}
