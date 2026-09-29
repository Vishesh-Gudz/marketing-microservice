import { compareDateKeys, type DateKey } from "../../lib/dates";
import { ratioFixed6 } from "../numeric";
import { rangeDays, type DateRange } from "../periods";
import {
  ADDITIVE_ACCOUNT_METRICS,
  DEPRECATED_ACCOUNT_METRICS,
  DEPRECATED_POST_METRICS,
  EXTRA_ACCOUNT_METRICS,
  FOLLOWER_DELTA_THRESHOLD,
  NON_ADDITIVE_ACCOUNT_METRICS,
  ORGANIC_POST_METRICS,
  type OrganicAccountMetric,
  type OrganicAccountMetricName,
  type OrganicDataState,
  type OrganicDeltaReason,
  type OrganicKpi,
  type OrganicKpiReason,
  type OrganicMetricReason,
  type OrganicPostMetric,
  type OrganicPostMetricName,
} from "./metrics";

/**
 * PURE organic aggregation (Phase 10 Stage B) over canonical rows already read by the caller.
 * Rules (F12, F13, R6, R7, R13; docs of Stage B):
 * - Missing is never zero: a metric no synced row reports is unavailable (with a reason);
 *   an explicit 0 stays 0.
 * - A day counts as synced for account insights when its row carries insightsSyncedAt (F7,
 *   R8): a synced day without a value is "not reported"; a day without a stamp is unknown.
 * - Additive metrics are summed over the synced rows that report them (exact bigint); some
 *   synced rows lacking the value make the metric partial.
 * - reach / accountsEngaged are unique-account counts: available only when the SCOPE is one
 *   account and one UTC day; any wider scope is non_additive, whatever is stored.
 * - followers is a snapshot: each account's latest in-scope capture, summed across accounts
 *   (never across days); accounts without a usable capture make it partial.
 * - engagementRate = totalInteractions / reach, only for one account and one UTC day (else
 *   non_additive), from the same row; never stored.
 * - Reason precedence: deprecated_metric > non_additive > below_follower_threshold >
 *   not_reported. `unsupported` is the capability-level data state, not a metric reason.
 */

/** The stored fields of one socialAccountMetricsDaily row the aggregation reads. */
export type DayRow = {
  date: DateKey;
  followers?: number;
  followersCapturedAt?: number;
  insightsSyncedAt?: number;
  followerDelta?: number;
  reach?: number;
  views?: number;
  accountsEngaged?: number;
  totalInteractions?: number;
  extras?: Record<string, number>;
};

export type AccountDays = { accountId: string; rows: readonly DayRow[] };

export type UnavailableMetric = { metric: OrganicAccountMetricName; reason: OrganicMetricReason };
export type UnavailableKpi = { kpi: OrganicKpi; reason: OrganicKpiReason };

export type OrganicAggregate = {
  dataState: OrganicDataState;
  /** Exact values (bigint counts); absent = unavailable (see unavailableMetrics). */
  values: Partial<Record<OrganicAccountMetric, bigint>>;
  /** Latest follower capture used for `followers` (epoch ms). */
  followersCapturedAt?: number;
  unavailableMetrics: UnavailableMetric[];
  partialMetrics: OrganicAccountMetric[];
  /** totalInteractions / reach as a 6-decimal fixed-point fraction. */
  engagementRate?: bigint;
  unavailableKpis: UnavailableKpi[];
  /** Account-days in scope, and those with synced insights. */
  expectedDays: number;
  syncedDays: number;
};

const EXTRAS: ReadonlySet<string> = new Set(EXTRA_ACCOUNT_METRICS);

/** A metric of a row: canonical column, or `extras` for the Instagram-only counts. */
function metricOf(row: DayRow, metric: OrganicAccountMetric): number | undefined {
  if (EXTRAS.has(metric)) return row.extras?.[metric];
  return (row as Record<string, unknown>)[metric] as number | undefined;
}

function inRange(date: DateKey, range: DateRange): boolean {
  return compareDateKeys(date, range.from) >= 0 && compareDateKeys(date, range.to) <= 0;
}

/** The latest row of an account with a usable follower capture (value AND capture time). */
function latestCapture(rows: readonly DayRow[]): DayRow | undefined {
  let latest: DayRow | undefined;
  for (const row of rows) {
    if (row.followers === undefined || row.followersCapturedAt === undefined) continue;
    if (latest === undefined || compareDateKeys(row.date, latest.date) > 0) latest = row;
  }
  return latest;
}

export function aggregateOrganic(input: {
  accounts: readonly AccountDays[];
  range: DateRange;
  /** The platform declares account metrics at all (capabilities). */
  supported: boolean;
}): OrganicAggregate {
  const { range } = input;
  const accounts = input.accounts.map((account) => ({
    ...account,
    rows: account.rows.filter((row) => inRange(row.date, range)),
  }));
  const days = rangeDays(range);
  const singleAccountDay = accounts.length === 1 && days === 1;
  const synced = accounts.flatMap((account) =>
    account.rows.filter((row) => row.insightsSyncedAt !== undefined),
  );
  const expectedDays = accounts.length * days;

  const dataState: OrganicDataState = !input.supported
    ? "unsupported"
    : synced.length === 0
      ? "unknown"
      : synced.length >= expectedDays
        ? "reported"
        : "partial";

  const values: Partial<Record<OrganicAccountMetric, bigint>> = {};
  const unavailable = new Map<OrganicAccountMetricName, OrganicMetricReason>();
  const partial: OrganicAccountMetric[] = [];

  // followers: latest usable capture per account, summed across accounts.
  const captures = accounts.map((account) => latestCapture(account.rows));
  const captured = captures.filter((row): row is DayRow => row !== undefined);
  let followersCapturedAt: number | undefined;
  if (captured.length === 0) {
    unavailable.set("followers", "not_reported");
  } else {
    values.followers = captured.reduce((sum, row) => sum + BigInt(row.followers!), 0n);
    followersCapturedAt = Math.max(...captured.map((row) => row.followersCapturedAt!));
    if (captured.length < accounts.length) partial.push("followers");
  }

  // Additive metrics over synced rows.
  for (const metric of ADDITIVE_ACCOUNT_METRICS) {
    const reported = synced
      .map((row) => metricOf(row, metric))
      .filter((value): value is number => value !== undefined);
    if (reported.length > 0) {
      values[metric] = reported.reduce((sum, value) => sum + BigInt(value), 0n);
      if (reported.length < synced.length) partial.push(metric);
      continue;
    }
    if (
      metric === "followerDelta" &&
      captures.length > 0 &&
      captures.every((row) => row !== undefined && row.followers! < FOLLOWER_DELTA_THRESHOLD)
    ) {
      // [PROVISIONAL IR8] not reported under 100 followers: inferred from stored captures.
      unavailable.set(metric, "below_follower_threshold");
    } else {
      unavailable.set(metric, "not_reported");
    }
  }

  // Non-additive metrics: one account, one UTC day only.
  for (const metric of NON_ADDITIVE_ACCOUNT_METRICS) {
    if (!singleAccountDay) {
      unavailable.set(metric, "non_additive");
      continue;
    }
    const value = synced[0] === undefined ? undefined : metricOf(synced[0], metric);
    if (value === undefined) unavailable.set(metric, "not_reported");
    else values[metric] = BigInt(value);
  }

  for (const metric of DEPRECATED_ACCOUNT_METRICS) unavailable.set(metric, "deprecated_metric");

  // engagementRate: same row, one account, one UTC day.
  const unavailableKpis: UnavailableKpi[] = [];
  let engagementRate: bigint | undefined;
  if (!singleAccountDay) {
    unavailableKpis.push({ kpi: "engagementRate", reason: "non_additive" });
  } else {
    const rate = rateOf(synced[0]?.totalInteractions, synced[0]?.reach);
    if ("reason" in rate) unavailableKpis.push({ kpi: "engagementRate", reason: rate.reason });
    else engagementRate = rate.value;
  }

  const order = [...ORDERED_ACCOUNT_NAMES];
  return {
    dataState,
    values,
    ...(followersCapturedAt !== undefined ? { followersCapturedAt } : {}),
    unavailableMetrics: order
      .filter((metric) => unavailable.has(metric))
      .map((metric) => ({ metric, reason: unavailable.get(metric)! })),
    partialMetrics: order.filter((metric): metric is OrganicAccountMetric =>
      (partial as string[]).includes(metric),
    ),
    ...(engagementRate !== undefined ? { engagementRate } : {}),
    unavailableKpis,
    expectedDays,
    syncedDays: synced.length,
  };
}

const ORDERED_ACCOUNT_NAMES: readonly OrganicAccountMetricName[] = [
  "followers",
  "followerDelta",
  "reach",
  "views",
  "accountsEngaged",
  "totalInteractions",
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "profileLinksTaps",
  ...DEPRECATED_ACCOUNT_METRICS,
];

/** totalInteractions / reach with the organic KPI reasons (R6), in precedence order. */
export function rateOf(
  numerator: number | undefined,
  denominator: number | undefined,
): { value: bigint } | { reason: Exclude<OrganicKpiReason, "non_additive"> } {
  if (numerator === undefined) return { reason: "numerator_unavailable" };
  if (denominator === undefined) return { reason: "denominator_unavailable" };
  if (denominator === 0) return { reason: "zero_denominator" };
  return { value: ratioFixed6(BigInt(numerator), BigInt(denominator)) };
}

// ---------------------------------------------------------------------------
// Post lifetime snapshots (never differenced: F14)
// ---------------------------------------------------------------------------

export type SnapshotRow = Partial<Record<OrganicPostMetric | "videoViews", number>>;

export type PostMetrics = {
  dataState: OrganicDataState;
  values: Partial<Record<OrganicPostMetric, number>>;
  unavailableMetrics: { metric: OrganicPostMetricName; reason: OrganicMetricReason }[];
  engagementRate?: bigint;
  unavailableKpis: UnavailableKpi[];
};

/**
 * The metrics of ONE lifetime snapshot. `supported` = the post metrics the platform declares
 * (capabilities): a declared metric missing from the snapshot is not reported (the snapshot is
 * then partial); videoViews is deprecated. engagementRate = totalInteractions / reach of the
 * same snapshot (F12).
 */
export function postMetricsOf(snapshot: SnapshotRow, supported: readonly string[]): PostMetrics {
  const values: Partial<Record<OrganicPostMetric, number>> = {};
  const unavailableMetrics: PostMetrics["unavailableMetrics"] = [];
  let missing = 0;
  for (const metric of ORGANIC_POST_METRICS) {
    const value = snapshot[metric];
    if (value !== undefined) {
      values[metric] = value;
      continue;
    }
    unavailableMetrics.push({ metric, reason: "not_reported" });
    if (supported.includes(metric)) missing++;
  }
  for (const metric of DEPRECATED_POST_METRICS) {
    unavailableMetrics.push({ metric, reason: "deprecated_metric" });
  }
  const rate = rateOf(snapshot.totalInteractions, snapshot.reach);
  return {
    dataState: supported.length === 0 ? "unsupported" : missing === 0 ? "reported" : "partial",
    values,
    unavailableMetrics,
    ...("value" in rate ? { engagementRate: rate.value } : {}),
    unavailableKpis: "reason" in rate ? [{ kpi: "engagementRate", reason: rate.reason }] : [],
  };
}

// ---------------------------------------------------------------------------
// Comparison (additive metrics and engagementRate only; snapshots are never compared)
// ---------------------------------------------------------------------------

export type OrganicDelta = {
  absolute?: bigint;
  percent?: bigint;
  reason?: OrganicDeltaReason;
  partial?: boolean;
};

export type ComparedMetric = (typeof ADDITIVE_ACCOUNT_METRICS)[number] | "engagementRate";

function delta(
  current: bigint | undefined,
  previous: bigint | undefined,
  partial: boolean,
): OrganicDelta | undefined {
  const flag = partial ? { partial: true } : {};
  if (current === undefined) return undefined;
  if (previous === undefined) return { reason: "previous_unavailable", ...flag };
  const absolute = current - previous;
  if (previous <= 0n) return { absolute, reason: "previous_zero", ...flag };
  return { absolute, percent: ratioFixed6(absolute, previous), ...flag };
}

/**
 * Period-over-period deltas with the Phase 6 rules (previous 0 -> previous_zero; previous
 * missing -> previous_unavailable; current missing -> no delta). followers, reach and
 * accountsEngaged are never compared (snapshot / unique counts).
 */
export function compareOrganic(
  current: OrganicAggregate,
  previous: OrganicAggregate,
): Partial<Record<ComparedMetric, OrganicDelta>> {
  const either = current.dataState === "partial" || previous.dataState === "partial";
  const deltas: Partial<Record<ComparedMetric, OrganicDelta>> = {};
  for (const metric of ADDITIVE_ACCOUNT_METRICS) {
    const partial =
      either || current.partialMetrics.includes(metric) || previous.partialMetrics.includes(metric);
    const value = delta(current.values[metric], previous.values[metric], partial);
    if (value !== undefined) deltas[metric] = value;
  }
  const rate = delta(current.engagementRate, previous.engagementRate, either);
  if (rate !== undefined) deltas.engagementRate = rate;
  return deltas;
}
