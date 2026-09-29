import type { SocialProviderCapabilities } from "../social/capabilities";
import { INSTAGRAM_ACCOUNT_METRICS, INSTAGRAM_POST_METRICS } from "./semantics";

/**
 * Static Instagram capabilities (Phase 10). Stage B: posts, post lifetime metrics and account
 * daily insights are implemented (./semantics.ts, ./mapping.ts, ./node/provider.ts), so the
 * social planner plans every operation. The windows and budgets are the APPROVED Phase 10
 * values (docs/providers/instagram.md):
 * - postMetrics / accountMetrics   the canonical columns the provider fills (semantics.ts);
 *                                  followers is the profile column group of the preflight
 * - accountMetricsHorizonDays 90   [PROVISIONAL IR11] account insights kept for 90 days (I-D9)
 * - accountMetricsLookbackDays 3   our choice: [doc] data "may be delayed up to 48 hours" + 1 day (I-D10)
 * - maxAccountMetricsRangeDays 31  our choice (window chunks per task; 15 days per call)
 * - postSnapshotWindowDays 90      our choice (approved snapshot window; [doc] 2-year retention)
 * - listing pages of 100           [SDK] posts.list accepts limit 1..100
 * - request budget                 approved I-D6: 3 requests per post per day (2 SDK + 1 reader),
 *                                  at most 3 in flight, 1,000 posts per snapshot task,
 *                                  100 listing pages (10K media limit [doc]), 31 requests
 *                                  per provider call (10 posts x 3 + 1 listing request)
 */
export const INSTAGRAM_CAPABILITIES: SocialProviderCapabilities = Object.freeze({
  accountTypes: Object.freeze(["business", "creator"] as const),
  posts: true,
  postMetrics: Object.freeze([...INSTAGRAM_POST_METRICS]),
  accountMetrics: Object.freeze([...INSTAGRAM_ACCOUNT_METRICS]),
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
