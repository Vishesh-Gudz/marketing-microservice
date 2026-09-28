import type { SocialProviderCapabilities } from "../social/capabilities";

/**
 * Static Instagram capabilities (Phase 10) — Stage A.
 *
 * Nothing is declared that the provider does not implement: post listing, post metrics and
 * account metrics are Stage B (their mapping fails closed with "instagram_mapping_pending"),
 * so `posts` is false and both metric lists are empty — the social planner therefore plans
 * only the preflight. The windows and budgets below are the APPROVED Phase 10 values
 * (docs/providers/instagram.md); Stage B uses them unchanged:
 * - accountMetricsHorizonDays 90   [doc] "User Metrics data is stored for up to 90 days" (I-D9)
 * - accountMetricsLookbackDays 3   our choice: [doc] data "may be delayed up to 48 hours" + 1 day (I-D10)
 * - maxAccountMetricsRangeDays 31  our choice (window chunks per task)
 * - postSnapshotWindowDays 90      our choice (approved snapshot window)
 * - listing pages of 100           [SDK] posts.list accepts limit 1..100
 * - request budget                 approved I-D6: 3 requests per post per day (2 SDK + 1 reader),
 *                                  at most 3 in flight, 1,000 posts per snapshot task,
 *                                  100 listing pages (10K media limit [doc]), 31 requests
 *                                  per provider call (10 posts x 3 + 1 listing request)
 */
export const INSTAGRAM_CAPABILITIES: SocialProviderCapabilities = Object.freeze({
  accountTypes: Object.freeze(["business", "creator"] as const),
  posts: false,
  postMetrics: Object.freeze([]),
  accountMetrics: Object.freeze([]),
  accountMetricsHorizonDays: 90,
  accountMetricsLookbackDays: 3,
  maxAccountMetricsRangeDays: 31,
  postSnapshotWindowDays: 90,
  defaultPageSize: 100,
  maxPageSize: 100,
  postMetricsPageSize: 10,
  requestBudget: Object.freeze({
    requestsPerPostSnapshot: 3,
    maxConcurrentRequests: 3,
    maxPostsPerSnapshotTask: 1_000,
    maxListingPages: 100,
    maxRequestsPerProviderCall: 31,
  }),
});
