import type { SocialAccountMetricKey, SocialPostMetricKey } from "../../domain/metrics";
import type { SocialAccountType, SocialPlatform } from "../../domain/types";
import { ProviderError } from "../errors";
import type { ProviderOperation } from "../types";

/**
 * Explicit request budget of a social provider (Phase 10, I-D6). Every loop that makes
 * platform requests is bounded by one of these values; exceeding a bound fails or
 * truncates EXPLICITLY (a ProviderError or a reported truncation), never silently.
 */
export type SocialRequestBudget = {
  /** Requests one daily post snapshot costs (Instagram: 2 SDK + 1 Graph reader). */
  requestsPerPostSnapshot: number;
  /** Platform requests in flight at once within one provider call. */
  maxConcurrentRequests: number;
  /** Hard cap of posts per snapshot task (larger windows are reported as truncated). */
  maxPostsPerSnapshotTask: number;
  /** Pages of one post listing (Instagram lists at most the 10K most recent media). */
  maxListingPages: number;
  /** Hard cap of platform requests inside ONE provider call (one page). */
  maxRequestsPerProviderCall: number;
};

/**
 * Static, declarative description of what a social provider supports (read in the default
 * runtime by the planner, so it never lives in an SDK module). Nothing is declared that the
 * provider does not implement: an empty metric list means the operation is never planned.
 */
export type SocialProviderCapabilities = {
  /** Account types the provider discovers and syncs; anything else fails closed. */
  accountTypes: readonly SocialAccountType[];
  /** listPosts is implemented. */
  posts: boolean;
  /** Metric columns fetchPostMetrics may emit ([] = never planned). */
  postMetrics: readonly SocialPostMetricKey[];
  /** Metric columns fetchAccountMetrics may emit ([] = never planned). */
  accountMetrics: readonly SocialAccountMetricKey[];
  /** How far back the platform keeps daily account metrics (UTC days, today included). */
  accountMetricsHorizonDays: number;
  /** Days re-requested by lookback runs (platform reporting delay buffer). */
  accountMetricsLookbackDays: number;
  /**
   * ADR 0016: days the platform needs before a day's account metrics are available (YouTube
   * Analytics: 48-72 h). Account-metric windows end this many days before today, so lagging
   * days stay unknown instead of being synced as "not reported". Absent = 0 (Instagram).
   */
  accountMetricsDelayDays?: number;
  /** Longer account-metric ranges are rejected with invalid_request (the plan chunks). */
  maxAccountMetricsRangeDays: number;
  /** Posts published within this many UTC days get a daily lifetime snapshot. */
  postSnapshotWindowDays: number;
  /** Post listing page size. */
  defaultPageSize: number;
  maxPageSize: number;
  /** Posts per fetchPostMetrics page. */
  postMetricsPageSize: number;
  requestBudget: SocialRequestBudget;
};

export function assertSocialCapability(
  supported: boolean,
  platform: SocialPlatform,
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
