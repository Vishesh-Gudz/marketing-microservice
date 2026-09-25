import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import * as analytics from "../analytics/queries";
import {
  actionTypeValidator,
  adPlatformValidator,
  entityLevelValidator,
} from "../domain/validators";
import { orgQuery } from "../lib/tenancy";
import {
  actionsDto,
  breakdownByValidator,
  breakdownDto,
  granularityValidator,
  overviewDto,
  performanceLevelValidator,
  performancePageDto,
  timeSeriesDto,
  toActionGroupDto,
  toAggregateDto,
  toComparisonDto,
  toCoverageDto,
  toFxDto,
  toPerformanceRowDto,
} from "./dto/analytics";

/**
 * Analytics (Phase 6): read-only, tenant-scoped queries over the canonical
 * metric tables (docs/analytics.md). Ranges are explicit inclusive DateKeys
 * applied to each ad account's own local days; presets are resolved by the
 * caller with convex/analytics/periods.ts. Queries fail with INVALID_ARGUMENT
 * `too_many_rows` instead of returning truncated data.
 */

const range = v.object({ from: v.string(), to: v.string() });
const compare = v.optional(v.union(v.literal("previous_period"), range));
const accountFilters = {
  platforms: v.optional(v.array(adPlatformValidator)),
  accountIds: v.optional(v.array(v.string())),
};
const filters = v.optional(v.object(accountFilters));
const entity = v.object({ level: entityLevelValidator, id: v.string() });

/** Org (or filtered) totals, KPIs, coverage and an optional comparison period. */
export const overview = orgQuery({
  args: { range, compare, filters },
  returns: overviewDto,
  handler: async (ctx, args) => {
    const result = await analytics.overview(ctx, args);
    const currency = result.fx.reportingCurrency;
    return {
      range: result.range,
      accountCount: result.accountCount,
      totals: toAggregateDto(result.totals, currency),
      ...(result.comparison ? { comparison: toComparisonDto(result.comparison, currency) } : {}),
      coverage: toCoverageDto(result.coverage),
      fx: toFxDto(result.fx),
    };
  },
});

/** Day / ISO-week / month series of the org (or filtered accounts), or of one entity. */
export const timeSeries = orgQuery({
  args: { range, granularity: granularityValidator, filters, entity: v.optional(entity) },
  returns: timeSeriesDto,
  handler: async (ctx, args) => {
    const result = await analytics.timeSeries(ctx, args);
    const currency = result.fx.reportingCurrency;
    return {
      range: result.range,
      granularity: result.granularity,
      level: result.level,
      points: result.points.map((point) => ({
        bucket: point.key,
        from: point.from,
        to: point.to,
        partial: point.partial,
        ...toAggregateDto(point, currency),
      })),
      coverage: toCoverageDto(result.coverage),
      fx: toFxDto(result.fx),
    };
  },
});

/** Campaign / ad group / ad performance with KPIs, sorted and paginated. */
export const performance = orgQuery({
  args: {
    level: performanceLevelValidator,
    range,
    parent: v.optional(
      v.object({
        accountId: v.optional(v.string()),
        campaignId: v.optional(v.string()),
        adGroupId: v.optional(v.string()),
      }),
    ),
    filters,
    sort: v.optional(
      v.object({
        by: v.union(
          v.literal("spend"),
          v.literal("impressions"),
          v.literal("clicks"),
          v.literal("conversions"),
          v.literal("name"),
        ),
        dir: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
      }),
    ),
    compare,
    paginationOpts: paginationOptsValidator,
  },
  returns: performancePageDto,
  handler: async (ctx, args) => {
    const result = await analytics.performance(ctx, args);
    const currency = result.fx.reportingCurrency;
    return {
      page: result.page.map((row) => toPerformanceRowDto(row, currency)),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
      range: result.range,
      fx: toFxDto(result.fx),
    };
  },
});

/** Totals split by platform, ad account, or placement (never mixed with "all" rows). */
export const breakdown = orgQuery({
  args: { by: breakdownByValidator, range, level: v.optional(entityLevelValidator), filters },
  returns: breakdownDto,
  handler: async (ctx, args) => {
    const result = await analytics.breakdown(ctx, args);
    const currency = result.fx.reportingCurrency;
    return {
      by: result.by,
      level: result.level,
      range: result.range,
      groups: result.groups.map(({ aggregate, ...group }) => ({
        ...group,
        ...toAggregateDto(aggregate, currency),
      })),
      coverage: toCoverageDto(result.coverage),
      fx: toFxDto(result.fx),
    };
  },
});

/** Conversion/action metrics per action type and attribution window (never summed across them). */
export const actions = orgQuery({
  args: {
    range,
    level: v.optional(entityLevelValidator),
    entity: v.optional(entity),
    filters: v.optional(
      v.object({
        ...accountFilters,
        actionTypes: v.optional(v.array(actionTypeValidator)),
        attributionWindows: v.optional(v.array(v.string())),
        primaryOnly: v.optional(v.boolean()),
      }),
    ),
  },
  returns: actionsDto,
  handler: async (ctx, args) => {
    const result = await analytics.actions(ctx, args);
    const currency = result.fx.reportingCurrency;
    return {
      range: result.range,
      level: result.level,
      dataState: result.dataState,
      groups: result.groups.map((group) => toActionGroupDto(group, currency)),
      coverage: toCoverageDto(result.coverage),
      fx: toFxDto(result.fx),
    };
  },
});
