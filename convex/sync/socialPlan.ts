import { addDays, compareDateKeys, toDateKey, todayIn, type DateKey } from "../lib/dates";
import type { SocialProviderCapabilities } from "../providers/social/capabilities";
import type { VideoAnalyticsWindow } from "../providers/social/types";
import { SYNC_LIMITS } from "./config";
import { windowChunks, type DateWindow, type PlanState, type SyncRunKind } from "./plan";
import type { SocialSyncOperation } from "./subject";

/**
 * Pure run planning for organic social subjects (Phase 10). Same run kinds, scheduling
 * fields and run/task machinery as the ad plan (sync/plan.ts, unchanged); only the task
 * list differs. Days are UTC days (I-D11). Task creation is capability-driven: an operation
 * whose capability is absent is never planned, so a provider can never be asked for
 * something it does not implement.
 *
 *   getSocialAccount     always, first (preflight; fatal when it fails)
 *   listSocialPosts      capabilities.posts: full listing on initial/lookback runs,
 *                        incremental listing on incremental/manual runs
 *   fetchPostMetrics     capabilities.postMetrics non-empty: initial and lookback (daily)
 *                        runs; window = the post snapshot window ending today
 *   fetchAccountMetrics  capabilities.accountMetrics non-empty AND, when the platform names a
 *                        capabilities.accountMetricsScope, the connection was granted it (ADR
 *                        0016, open question 13: YouTube without yt-analytics.readonly keeps
 *                        syncing everything else; its days stay unknown). Chunked by
 *                        maxAccountMetricsRangeDays, never older than the platform horizon,
 *                        ending at `latest` = today - accountMetricsDelayDays (absent = 0:
 *                        today; YouTube reports days late, ADR 0016):
 *                          initial      the 30 days up to `latest` (within the horizon)
 *                          incremental  the day before `latest` .. `latest`
 *                          lookback     the accountMetricsLookbackDays days up to `latest`
 *                          backfill     the gap between the horizon and coveredFrom
 *   fetchVideoAnalytics  ADR 0016 Checkpoint 8: capabilities.videoAnalytics declared (YouTube),
 *                        initial and lookback runs only, and only with the same report scope
 *                        as the account metrics. One task per window, both ending at `latest`
 *                        = today in videoAnalytics.dayTimeZone (Pacific Time) - the delay:
 *                          last28    [latest - 27, latest], planned complete
 *                          lifetime  planned with `to` only; its claim resolves `from` to the
 *                                    oldest stored upload's publish day (resolveVideoWindow)
 *                        A window is skipped at claim time when the channel has no stored
 *                        video (the listing of the same run commits first: tasks run in seq).
 *
 * Stage B: Instagram declares posts, post metrics and account metrics
 * (providers/instagram/capabilities.ts), so every operation above is planned. Tasks run in
 * `seq` order: the listing always commits before the snapshots of the same run.
 */

export type SocialTaskSpec = {
  operation: SocialSyncOperation;
  from?: DateKey;
  to?: DateKey;
  /** fetchVideoAnalytics only. */
  videoWindow?: VideoAnalyticsWindow;
  fullListing: boolean;
};

export type SocialRunPlan = {
  kind: SyncRunKind;
  window?: DateWindow;
  structureMode: "none";
  tasks: SocialTaskSpec[];
};

function laterOf(a: DateKey, b: DateKey): DateKey {
  return compareDateKeys(a, b) >= 0 ? a : b;
}

/** The account-metric window of a run kind (undefined = no account-metric task). */
export function socialMetricWindow(input: {
  kind: SyncRunKind;
  state: PlanState;
  capabilities: SocialProviderCapabilities;
  now: number;
}): DateWindow | undefined {
  const { kind, state, capabilities, now } = input;
  const today = todayIn("UTC", now);
  const horizon = addDays(today, -(capabilities.accountMetricsHorizonDays - 1));
  // ADR 0016: the newest day a window may request (today, unless the platform reports late).
  const latest = addDays(today, -(capabilities.accountMetricsDelayDays ?? 0));
  const clamp = (window: DateWindow): DateWindow | undefined => {
    const from = laterOf(window.from, horizon);
    return compareDateKeys(from, window.to) <= 0 ? { from, to: window.to } : undefined;
  };
  switch (kind) {
    case "initial":
      return clamp({ from: addDays(latest, -(SYNC_LIMITS.initialWindowDays - 1)), to: latest });
    case "incremental":
    case "manual":
      return clamp({ from: addDays(latest, -1), to: latest });
    case "lookback":
      return clamp({
        from: addDays(latest, -(capabilities.accountMetricsLookbackDays - 1)),
        to: latest,
      });
    case "backfill": {
      if (state.coveredFrom === undefined) return undefined;
      const to = addDays(state.coveredFrom, -1);
      return clamp({
        from: addDays(to, -(capabilities.maxAccountMetricsRangeDays - 1)),
        to,
      });
    }
  }
}

/**
 * ADR 0016 Checkpoint 8: the newest day a per-video window may request, in the platform's own
 * report-day zone (YouTube Analytics: Pacific Time), the reporting delay applied.
 */
export function videoAnalyticsLatestDay(
  capabilities: SocialProviderCapabilities,
  now: number,
): DateKey | undefined {
  const video = capabilities.videoAnalytics;
  if (video === undefined) return undefined;
  return addDays(todayIn(video.dayTimeZone, now), -(capabilities.accountMetricsDelayDays ?? 0));
}

/**
 * ADR 0016 Checkpoint 8, at claim time: the days one per-video window requests, or undefined
 * when the window is skipped (no stored video, or every stored video is newer than `to`).
 *   last28    the planned days (the channel must have at least one stored video)
 *   lifetime  [publish day of the oldest stored video in the report-day zone, to]; once an
 *             earlier claim of the task resolved `from` (plannedFrom), retries keep it
 */
export function resolveVideoWindow(input: {
  window: VideoAnalyticsWindow;
  plannedFrom?: DateKey;
  to: DateKey;
  /** publishedAt (epoch ms) of the channel's oldest stored video; undefined = none stored. */
  oldestPublishedAt: number | undefined;
  dayTimeZone: string;
}): { from: DateKey; to: DateKey } | undefined {
  if (input.oldestPublishedAt === undefined) return undefined;
  const from =
    input.plannedFrom ??
    (input.window === "lifetime"
      ? toDateKey(input.oldestPublishedAt, input.dayTimeZone)
      : undefined);
  if (from === undefined || compareDateKeys(from, input.to) > 0) return undefined;
  return { from, to: input.to };
}

export function buildSocialRunPlan(input: {
  kind: SyncRunKind;
  state: PlanState;
  capabilities: SocialProviderCapabilities;
  now: number;
  /** The connection holds capabilities.accountMetricsScope (default: true). */
  accountMetricsGranted?: boolean;
}): SocialRunPlan {
  const { kind, capabilities, now } = input;
  const today = todayIn("UTC", now);
  const tasks: SocialTaskSpec[] = [{ operation: "getSocialAccount", fullListing: false }];

  if (capabilities.posts && kind !== "backfill") {
    tasks.push({
      operation: "listSocialPosts",
      fullListing: kind === "initial" || kind === "lookback",
    });
  }
  if (capabilities.postMetrics.length > 0 && (kind === "initial" || kind === "lookback")) {
    tasks.push({
      operation: "fetchPostMetrics",
      from: addDays(today, -(capabilities.postSnapshotWindowDays - 1)),
      to: today,
      fullListing: false,
    });
  }
  const window =
    capabilities.accountMetrics.length > 0 && input.accountMetricsGranted !== false
      ? socialMetricWindow(input)
      : undefined;
  if (window !== undefined) {
    for (const chunk of windowChunks(window, capabilities.maxAccountMetricsRangeDays)) {
      tasks.push({ operation: "fetchAccountMetrics", ...chunk, fullListing: false });
    }
  }
  const video = capabilities.videoAnalytics;
  const latest = videoAnalyticsLatestDay(capabilities, now);
  if (
    video !== undefined &&
    latest !== undefined &&
    input.accountMetricsGranted !== false &&
    (kind === "initial" || kind === "lookback")
  ) {
    tasks.push({
      operation: "fetchVideoAnalytics",
      videoWindow: "last28",
      from: addDays(latest, -(video.recentWindowDays - 1)),
      to: latest,
      fullListing: false,
    });
    tasks.push({
      operation: "fetchVideoAnalytics",
      videoWindow: "lifetime",
      to: latest,
      fullListing: false,
    });
  }
  if (tasks.length > SYNC_LIMITS.maxTasksPerRun) {
    throw new Error("Social run plan exceeds maxTasksPerRun");
  }
  return { kind, ...(window !== undefined ? { window } : {}), structureMode: "none", tasks };
}
