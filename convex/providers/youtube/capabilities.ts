import type { SocialProviderCapabilities } from "../social/capabilities";
import { CHANNEL_ACCOUNT_TYPE, LISTING_PAGE_SIZE } from "./semantics";

/**
 * Static YouTube capabilities (ADR 0016). Checkpoint 1 implements the channel preflight and
 * the video listing only: `postMetrics` and `accountMetrics` are empty, so the social planner
 * never plans a metric task for YouTube (Checkpoint 3 declares them). Values:
 * - accountTypes ["channel"]          every YouTube account is a channel (Y-D2)
 * - listing pages of 50               [doc] Data API list pages hold at most 50 items
 * - maxListingPages 100               ours: 5,000 most recent uploads per listing; a longer
 *                                     listing is reported as truncated (never silent)
 * - maxRequestsPerProviderCall 4      1 token + 1 channel (first page) + 1 playlistItems +
 *                                     1 videos request
 * - maxConcurrentRequests 1           the requests of one call run one after another
 * - accountMetricsHorizonDays 395     ours (Y-D7): the engine's backfill horizon; YouTube keeps
 *                                     channel history (no platform retention window [doc])
 * - accountMetricsLookbackDays 7      ours (Y-D7): [doc] 48-72 h processing latency; whether
 *                                     data is revised later is [PROVISIONAL YR9]
 * - maxAccountMetricsRangeDays 31     ours: one window chunk per task
 * - postSnapshotWindowDays 90         ours (Y-D8)
 * The metric windows, snapshot window, requestsPerPostSnapshot and maxPostsPerSnapshotTask
 * take effect only once metrics are declared (Checkpoint 3).
 */
export const YOUTUBE_CAPABILITIES: SocialProviderCapabilities = Object.freeze({
  accountTypes: Object.freeze([CHANNEL_ACCOUNT_TYPE] as const),
  posts: true,
  postMetrics: Object.freeze([]),
  accountMetrics: Object.freeze([]),
  accountMetricsHorizonDays: 395,
  accountMetricsLookbackDays: 7,
  maxAccountMetricsRangeDays: 31,
  postSnapshotWindowDays: 90,
  defaultPageSize: LISTING_PAGE_SIZE,
  maxPageSize: LISTING_PAGE_SIZE,
  postMetricsPageSize: LISTING_PAGE_SIZE,
  requestBudget: Object.freeze({
    requestsPerPostSnapshot: 1,
    maxConcurrentRequests: 1,
    maxPostsPerSnapshotTask: 1_000,
    maxListingPages: 100,
    maxRequestsPerProviderCall: 4,
  }),
});
