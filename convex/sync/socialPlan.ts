import { addDays, compareDateKeys, todayIn, type DateKey } from "../lib/dates";
import type { SocialProviderCapabilities } from "../providers/social/capabilities";
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
 *   fetchAccountMetrics  capabilities.accountMetrics non-empty, chunked by
 *                        maxAccountMetricsRangeDays, never older than the platform horizon:
 *                          initial      last min(30, horizon) days
 *                          incremental  yesterday .. today
 *                          lookback     last accountMetricsLookbackDays days
 *                          backfill     the gap between the horizon and coveredFrom
 *
 * Stage A: Instagram declares no posts and no metrics, so every social run is the
 * preflight alone (which fails closed with instagram_mapping_pending).
 */

export type SocialTaskSpec = {
  operation: SocialSyncOperation;
  from?: DateKey;
  to?: DateKey;
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
  const clamp = (window: DateWindow): DateWindow | undefined => {
    const from = laterOf(window.from, horizon);
    return compareDateKeys(from, window.to) <= 0 ? { from, to: window.to } : undefined;
  };
  switch (kind) {
    case "initial":
      return clamp({ from: addDays(today, -(SYNC_LIMITS.initialWindowDays - 1)), to: today });
    case "incremental":
    case "manual":
      return clamp({ from: addDays(today, -1), to: today });
    case "lookback":
      return clamp({
        from: addDays(today, -(capabilities.accountMetricsLookbackDays - 1)),
        to: today,
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

export function buildSocialRunPlan(input: {
  kind: SyncRunKind;
  state: PlanState;
  capabilities: SocialProviderCapabilities;
  now: number;
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
  const window = capabilities.accountMetrics.length > 0 ? socialMetricWindow(input) : undefined;
  if (window !== undefined) {
    for (const chunk of windowChunks(window, capabilities.maxAccountMetricsRangeDays)) {
      tasks.push({ operation: "fetchAccountMetrics", ...chunk, fullListing: false });
    }
  }
  if (tasks.length > SYNC_LIMITS.maxTasksPerRun) {
    throw new Error("Social run plan exceeds maxTasksPerRun");
  }
  return { kind, ...(window !== undefined ? { window } : {}), structureMode: "none", tasks };
}
