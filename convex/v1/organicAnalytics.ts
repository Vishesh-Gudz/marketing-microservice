import { v } from "convex/values";
import { organicAccountSeries, organicOverview } from "../analytics/organic/queries";
import { orgQuery } from "../lib/tenancy";
import {
  organicGranularityValidator,
  organicOverviewDto,
  organicSeriesDto,
  toOrganicOverviewDto,
  toOrganicSeriesPointDto,
} from "./dto/organicAnalytics";

/**
 * Organic Instagram analytics (Phase 10 Stage B): read-only, tenant-scoped, query-time
 * aggregation over the canonical social tables the sync writes. Never a provider call.
 * Ranges are explicit inclusive UTC days (account metrics are keyed by UTC day; resolve
 * presets with convex/analytics/organic/dates.ts `resolveOrganicPreset`, i.e. against
 * today in UTC). Queries fail with INVALID_ARGUMENT `too_many_rows` instead of truncating.
 */

const range = v.object({ from: v.string(), to: v.string() });

/**
 * Totals of the org's social accounts (or the given ones) over the range, with an optional
 * comparison period. Additive metrics are summed across accounts and days; reach,
 * accountsEngaged and engagementRate only exist for one account on one UTC day; followers is
 * the sum of each account's latest capture. Another org's account id is NOT_FOUND.
 */
export const overview = orgQuery({
  args: {
    range,
    compare: v.optional(v.union(v.literal("previous_period"), range)),
    socialAccountIds: v.optional(v.array(v.string())),
  },
  returns: organicOverviewDto,
  handler: async (ctx, args) => {
    return toOrganicOverviewDto(
      await organicOverview(ctx, {
        range: args.range,
        ...(args.compare !== undefined ? { compare: args.compare } : {}),
        ...(args.socialAccountIds !== undefined ? { socialAccountIds: args.socialAccountIds } : {}),
      }),
    );
  },
});

/** One account's day / ISO-week / month series over UTC days (default: day). */
export const accountSeries = orgQuery({
  args: {
    socialAccountId: v.string(),
    range,
    granularity: v.optional(organicGranularityValidator),
  },
  returns: organicSeriesDto,
  handler: async (ctx, args) => {
    const result = await organicAccountSeries(ctx, {
      socialAccountId: args.socialAccountId,
      range: args.range,
      ...(args.granularity !== undefined ? { granularity: args.granularity } : {}),
    });
    return {
      timezone: "UTC" as const,
      accountId: result.accountId,
      range: result.range,
      granularity: result.granularity,
      dataState: result.dataState,
      points: result.points.map(toOrganicSeriesPointDto),
    };
  },
});
