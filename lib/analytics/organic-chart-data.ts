import type { ChartRow } from "./chart-data";
import { formatCount, formatPercent, getDisplayLocale } from "./format";
import { ORGANIC_METRIC_REASON_TEXT, ORGANIC_KPI_REASON_TEXT } from "./organic-states";
import type { OrganicSeriesPoint, PostSnapshot } from "./organic-types";
import type { OrganicValueKey, PostValueKey } from "./organic-values";

/**
 * Organic chart rows, built ONLY from API points (no arithmetic, no interpolation): an
 * unknown bucket or an unavailable value is `null` (a line gap), never 0; an explicit 0 is
 * plotted as 0. Partial buckets are marked incomplete (drawn dashed). Account buckets are UTC
 * days / ISO weeks / months of UTC days.
 */

export const ORGANIC_CHART_METRICS = [
  "views",
  "totalInteractions",
  "followerDelta",
  "reach",
  "accountsEngaged",
  "engagementRate",
  "followers",
] as const satisfies readonly OrganicValueKey[];
export type OrganicChartMetric = (typeof ORGANIC_CHART_METRICS)[number];

export function isOrganicChartMetric(
  value: string | null | undefined,
): value is OrganicChartMetric {
  return (ORGANIC_CHART_METRICS as readonly (string | null | undefined)[]).includes(value);
}

const EMPTY = "—";

function display(metric: string, value: number, locale: string | undefined): string {
  return metric === "engagementRate" ? formatPercent(value, locale) : formatCount(value, locale);
}

function pointValue(point: OrganicSeriesPoint, metric: OrganicChartMetric): number | undefined {
  return metric === "engagementRate" ? point.kpis.engagementRate : point.metrics[metric];
}

/** The API's reason a bucket has no value for `metric` (undefined when it has one). */
export function pointReason(point: OrganicSeriesPoint, metric: OrganicChartMetric) {
  if (metric === "engagementRate") {
    const entry = point.kpis.unavailableKpis.find((u) => u.kpi === metric);
    return entry
      ? { reason: entry.reason, text: ORGANIC_KPI_REASON_TEXT[entry.reason] }
      : undefined;
  }
  const entry = point.metrics.unavailableMetrics.find((u) => u.metric === metric);
  return entry
    ? { reason: entry.reason, text: ORGANIC_METRIC_REASON_TEXT[entry.reason] }
    : undefined;
}

export type OrganicSeriesRows = {
  rows: ChartRow[];
  /**
   * Every bucket reports the metric as non-additive (reach, accounts engaged and the
   * engagement rate only exist per single UTC day): the API says so, the chart explains it.
   */
  dayOnly: boolean;
};

export function organicSeriesRows(
  points: readonly OrganicSeriesPoint[],
  metric: OrganicChartMetric,
  locale: string | undefined = getDisplayLocale(),
): OrganicSeriesRows {
  const rows = points.map((point): ChartRow => {
    const value = pointValue(point, metric);
    return {
      bucket: point.bucket,
      from: point.from,
      to: point.to,
      dataState: point.dataState,
      incomplete: point.partial || point.dataState === "partial",
      value: value ?? null,
      display: value === undefined ? EMPTY : display(metric, value, locale),
    };
  });
  const dayOnly =
    points.length > 0 &&
    points.every((point) => pointReason(point, metric)?.reason === "non_additive");
  return { rows, dayOnly };
}

/**
 * Lifetime totals at each capture of a post (bucket = UTC capture day). These are cumulative
 * lifetime values, NOT daily performance; nothing is differenced.
 */
export function postSnapshotRows(
  snapshots: readonly PostSnapshot[],
  metric: PostValueKey,
  locale: string | undefined = getDisplayLocale(),
): ChartRow[] {
  return snapshots.map((snapshot) => {
    const value =
      metric === "engagementRate" ? snapshot.kpis.engagementRate : snapshot.metrics[metric];
    return {
      bucket: snapshot.capturedDate,
      from: snapshot.capturedDate,
      to: snapshot.capturedDate,
      dataState: snapshot.dataState,
      incomplete: false,
      value: value ?? null,
      display: value === undefined ? EMPTY : display(metric, value, locale),
    };
  });
}
