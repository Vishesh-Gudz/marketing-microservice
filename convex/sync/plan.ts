import { ENTITY_LEVELS, PLACEMENTS, type EntityLevel, type Placement } from "../domain/types";
import {
  addDays,
  compareDateKeys,
  diffDays,
  monthChunks,
  todayIn,
  type DateKey,
} from "../lib/dates";
import type { AdsProviderCapabilities } from "../providers/capabilities";
import type { MetricsBreakdown } from "../providers/types";
import { SYNC_CADENCE, SYNC_LIMITS } from "./config";

/**
 * Pure run planning: which run kind is due, which windows (in the AD ACCOUNT
 * timezone), and which tasks. Task creation is capability-driven: an
 * unsupported entity listing, level, breakdown or action metric is never planned.
 */

export type SyncRunKind = "initial" | "incremental" | "lookback" | "backfill" | "manual";
export type StructureMode = "full" | "incremental" | "none";
export type SyncOperation =
  | "getAccount"
  | "listCampaigns"
  | "listAdGroups"
  | "listCreatives"
  | "listAds"
  | "fetchDailyMetrics"
  | "fetchActionMetrics";

export type DateWindow = { from: DateKey; to: DateKey };

export type TaskSpec = {
  operation: SyncOperation;
  level?: EntityLevel;
  from?: DateKey;
  to?: DateKey;
  breakdown?: MetricsBreakdown;
  updatedSince?: number;
  fullListing: boolean;
};

export type RunPlan = {
  kind: SyncRunKind;
  window?: DateWindow;
  structureMode: StructureMode;
  updatedSince?: number;
  tasks: TaskSpec[];
};

/** The subset of syncAccounts the planner decides on. */
export type PlanState = {
  initialDoneAt?: number;
  nextIncrementalAt?: number;
  nextLookbackAt?: number;
  lastStructureStartedAt?: number;
  structureStale: boolean;
  coveredFrom?: DateKey;
  coveredThrough?: DateKey;
  backfillHorizon: DateKey;
};

/** Structure listings in dependency order: creatives before ads (mapAd resolves creatives). */
export const STRUCTURE_OPERATIONS = [
  { operation: "listCampaigns", entity: "campaigns" },
  { operation: "listAdGroups", entity: "adGroups" },
  { operation: "listCreatives", entity: "creatives" },
  { operation: "listAds", entity: "ads" },
] as const satisfies readonly {
  operation: SyncOperation;
  entity: keyof AdsProviderCapabilities["entities"];
}[];

export function isStructureOperation(operation: SyncOperation): boolean {
  return STRUCTURE_OPERATIONS.some((s) => s.operation === operation);
}

export function isMetricOperation(operation: SyncOperation): boolean {
  return operation === "fetchDailyMetrics" || operation === "fetchActionMetrics";
}

/** Tables whose rows carry removedAt (creatives do not; they are never marked removed). */
export function removalTableFor(
  operation: SyncOperation,
): "campaigns" | "adGroups" | "ads" | undefined {
  switch (operation) {
    case "listCampaigns":
      return "campaigns";
    case "listAdGroups":
      return "adGroups";
    case "listAds":
      return "ads";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export function backfillPending(state: PlanState): boolean {
  return (
    state.coveredFrom !== undefined && compareDateKeys(state.coveredFrom, state.backfillHorizon) > 0
  );
}

/** The run kind due now, by priority initial > lookback > incremental > backfill. */
export function dueKind(state: PlanState, now: number): SyncRunKind | undefined {
  if (state.initialDoneAt === undefined) return "initial";
  if ((state.nextLookbackAt ?? 0) <= now) return "lookback";
  if ((state.nextIncrementalAt ?? 0) <= now) return "incremental";
  if (backfillPending(state)) return "backfill";
  return undefined;
}

/** Earliest instant any run kind becomes due. */
export function nextDueAt(state: PlanState, now: number): number {
  if (state.initialDoneAt === undefined || backfillPending(state)) return now;
  return Math.min(state.nextLookbackAt ?? now, state.nextIncrementalAt ?? now);
}

/** Backoff after consecutive failed runs: 15 min, 30 min, ... capped at 6 h. */
export function failureBackoffMs(consecutiveFailures: number): number {
  if (consecutiveFailures <= 0) return 0;
  return Math.min(
    SYNC_LIMITS.failureBaseBackoffMs * 2 ** Math.min(consecutiveFailures - 1, 16),
    SYNC_LIMITS.maxFailureBackoffMs,
  );
}

// ---------------------------------------------------------------------------
// Windows (account-local days)
// ---------------------------------------------------------------------------

function laterOf(a: DateKey, b: DateKey): DateKey {
  return compareDateKeys(a, b) >= 0 ? a : b;
}

function earlierOf(a: DateKey, b: DateKey): DateKey {
  return compareDateKeys(a, b) <= 0 ? a : b;
}

/** First day after the covered range, bounded by the catch-up limit (older gaps are backfilled). */
function catchUpFrom(state: PlanState, today: DateKey): DateKey | undefined {
  if (state.coveredThrough === undefined) return undefined;
  const limit = addDays(today, -(SYNC_LIMITS.maxCatchUpDays - 1));
  return laterOf(addDays(state.coveredThrough, 1), limit);
}

export function metricWindow(input: {
  kind: SyncRunKind;
  state: PlanState;
  capabilities: AdsProviderCapabilities;
  timezone: string;
  now: number;
  manualWindow?: DateWindow;
}): DateWindow | undefined {
  const today = todayIn(input.timezone, input.now);
  const { state } = input;
  switch (input.kind) {
    case "initial":
      return { from: addDays(today, -(SYNC_LIMITS.initialWindowDays - 1)), to: today };
    case "incremental": {
      const catchUp = catchUpFrom(state, today);
      const from = addDays(today, -1);
      return { from: catchUp === undefined ? from : earlierOf(from, catchUp), to: today };
    }
    case "lookback": {
      const days = Math.min(
        input.capabilities.restatementLookbackDays,
        SYNC_LIMITS.maxLookbackDays,
      );
      const catchUp = catchUpFrom(state, today);
      const from = addDays(today, -days);
      return { from: catchUp === undefined ? from : earlierOf(from, catchUp), to: today };
    }
    case "backfill": {
      if (!backfillPending(state)) return undefined;
      const to = addDays(state.coveredFrom!, -1);
      const monthStart = `${to.slice(0, 7)}-01`;
      return { from: laterOf(monthStart, state.backfillHorizon), to };
    }
    case "manual":
      return input.manualWindow;
  }
}

/** Validates a manually requested window against the account's "today". */
export function validateManualWindow(
  window: DateWindow,
  timezone: string,
  now: number,
): string | undefined {
  const span = diffDays(window.from, window.to);
  if (span < 0) return "from must not be after to";
  if (span + 1 > SYNC_LIMITS.maxManualWindowDays) {
    return `window exceeds ${SYNC_LIMITS.maxManualWindowDays} days`;
  }
  if (compareDateKeys(window.to, todayIn(timezone, now)) > 0) return "window ends in the future";
  return undefined;
}

/** Splits a window at month boundaries and into <= maxDays pieces; NEWEST first. */
export function windowChunks(window: DateWindow, maxDays: number): DateWindow[] {
  const chunks: DateWindow[] = [];
  for (const month of monthChunks(window.from, window.to)) {
    let start = month.from;
    while (compareDateKeys(start, month.to) <= 0) {
      const end = earlierOf(addDays(start, maxDays - 1), month.to);
      chunks.push({ from: start, to: end });
      start = addDays(end, 1);
    }
  }
  return chunks.reverse();
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export function structureModeFor(
  kind: SyncRunKind,
  state: PlanState,
  capabilities: AdsProviderCapabilities,
): StructureMode {
  switch (kind) {
    case "initial":
    case "lookback":
    case "manual":
      return "full";
    case "incremental":
      if (state.structureStale) return "full";
      return capabilities.incrementalEntities && state.lastStructureStartedAt !== undefined
        ? "incremental"
        : "none";
    case "backfill":
      return "none";
  }
}

/** Metric levels whose entities can be stored (the account level always can). */
export function syncableLevels(capabilities: AdsProviderCapabilities): EntityLevel[] {
  const listable: Record<EntityLevel, boolean> = {
    account: true,
    campaign: capabilities.entities.campaigns,
    ad_group: capabilities.entities.adGroups,
    ad: capabilities.entities.ads,
  };
  return ENTITY_LEVELS.filter(
    (level) => capabilities.metricLevels.includes(level) && listable[level],
  );
}

/** Placements a response may contain for a breakdown (guards incoming rows). */
export function allowedPlacements(
  breakdown: MetricsBreakdown,
  capabilities: AdsProviderCapabilities,
): readonly Placement[] {
  return breakdown === "none" ? ["all"] : capabilities.placements;
}

/** Placements a completed request is authoritative for (the prune scope). */
export function prunePlacements(breakdown: MetricsBreakdown): readonly Placement[] {
  return breakdown === "none" ? ["all"] : PLACEMENTS;
}

export function buildRunPlan(input: {
  kind: SyncRunKind;
  state: PlanState;
  capabilities: AdsProviderCapabilities;
  timezone: string;
  now: number;
  manualWindow?: DateWindow;
}): RunPlan {
  const { kind, state, capabilities: caps } = input;
  const structureMode = structureModeFor(kind, state, caps);
  const updatedSince =
    structureMode === "incremental" && state.lastStructureStartedAt !== undefined
      ? state.lastStructureStartedAt - SYNC_CADENCE.structureOverlapMs
      : undefined;

  const tasks: TaskSpec[] = [{ operation: "getAccount", fullListing: false }];

  if (structureMode !== "none") {
    for (const { operation, entity } of STRUCTURE_OPERATIONS) {
      if (!caps.entities[entity]) continue;
      tasks.push({
        operation,
        fullListing: structureMode === "full",
        ...(updatedSince !== undefined ? { updatedSince } : {}),
      });
    }
  }

  const window = metricWindow(input);
  if (window !== undefined) {
    const maxDays = Math.min(SYNC_LIMITS.maxWindowDays, caps.maxMetricsRangeDays);
    const chunks = windowChunks(window, maxDays);
    const levels = syncableLevels(caps);
    const dailyBreakdown: MetricsBreakdown = caps.placementBreakdown ? "placement" : "none";
    for (const chunk of chunks) {
      for (const level of levels) {
        tasks.push({
          operation: "fetchDailyMetrics",
          level,
          ...chunk,
          breakdown: dailyBreakdown,
          fullListing: false,
        });
      }
    }
    if (caps.actionMetrics) {
      for (const chunk of chunks) {
        for (const level of levels) {
          tasks.push({
            operation: "fetchActionMetrics",
            level,
            ...chunk,
            breakdown: "none",
            fullListing: false,
          });
        }
      }
    }
  }

  if (tasks.length > SYNC_LIMITS.maxTasksPerRun) {
    throw new Error(`Run plan has ${tasks.length} tasks (max ${SYNC_LIMITS.maxTasksPerRun})`);
  }
  return {
    kind,
    ...(window !== undefined ? { window } : {}),
    structureMode,
    ...(updatedSince !== undefined ? { updatedSince } : {}),
    tasks,
  };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export type Coverage = { from: DateKey; through: DateKey };

/**
 * Merges completed windows into the contiguous covered range. Overlapping or
 * adjacent windows extend it; a NEWER window after a gap restarts coverage
 * (the gap is then backfilled); an older window behind a gap is ignored.
 */
export function mergeCoverage(
  coverage: Coverage | undefined,
  completed: readonly DateWindow[],
): Coverage | undefined {
  let result = coverage;
  const newestFirst = [...completed].sort((a, b) => compareDateKeys(b.to, a.to));
  for (const window of newestFirst) {
    if (result === undefined) {
      result = { from: window.from, through: window.to };
      continue;
    }
    const touches =
      compareDateKeys(window.from, addDays(result.through, 1)) <= 0 &&
      compareDateKeys(window.to, addDays(result.from, -1)) >= 0;
    if (touches) {
      result = {
        from: earlierOf(result.from, window.from),
        through: laterOf(result.through, window.to),
      };
    } else if (compareDateKeys(window.from, result.through) > 0) {
      result = { from: window.from, through: window.to };
    }
  }
  return result;
}
