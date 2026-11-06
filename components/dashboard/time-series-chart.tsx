"use client";

import {
  axisTick,
  buildSeries,
  CHART_METRICS,
  type ChartMetric,
  type ChartRow,
} from "@/lib/analytics/chart-data";
import type { Granularity } from "@/lib/analytics/filters";
import { DATA_STATE_LABEL } from "@/lib/analytics/states";
import type { TimeSeriesPoint } from "@/lib/analytics/types";
import { VALUES } from "@/lib/analytics/values";
import { EmptyState } from "./empty-state";
import { SeriesChart } from "./series-chart";

const GRANULARITY_LABEL: Record<Granularity, string> = { day: "Day", week: "Week", month: "Month" };
const METRICS = CHART_METRICS.map((value) => ({ value, label: VALUES[value].label }));

/**
 * Paid metric over time (D6). Unsynced buckets are gaps, buckets without delivery are 0,
 * partial buckets are drawn dashed with hollow points, and every chart has an equivalent
 * table view (the shared SeriesChart).
 */
export function TimeSeriesChart({
  points,
  granularity,
  reportingCurrency,
  metric,
  onMetricChange,
  title = "Over time",
}: {
  points: readonly TimeSeriesPoint[];
  granularity: Granularity;
  reportingCurrency: string;
  metric: ChartMetric;
  onMetricChange: (metric: ChartMetric) => void;
  title?: string;
}) {
  const series = buildSeries(points, metric, reportingCurrency);
  const label = VALUES[metric].label;
  const currency = series.available ? series.currency : undefined;
  const heading = `${label}${currency ? ` (${currency})` : ""} by ${GRANULARITY_LABEL[granularity].toLowerCase()}`;
  const period = (row: ChartRow) => (granularity === "day" ? row.from : `${row.from} – ${row.to}`);

  return (
    <SeriesChart
      title={title}
      heading={heading}
      rows={series.available ? series.rows : []}
      granularity={granularity}
      metric={metric}
      metrics={METRICS}
      onMetricChange={onMetricChange}
      tick={(value) => axisTick(value, metric, currency)}
      period={period}
      tooltip={(row) => (
        <>
          <div className="font-medium">{period(row)}</div>
          <div className="tabular-nums">{row.display}</div>
          {row.dataState !== "reported" && (
            <div className="text-muted-foreground">{DATA_STATE_LABEL[row.dataState]}</div>
          )}
          {row.dataState === "no_delivery" && (
            <div className="text-muted-foreground">Plotted as 0 (nothing delivered)</div>
          )}
          {row.incomplete && <div className="text-muted-foreground">Partial bucket</div>}
        </>
      )}
      unavailable={
        series.available ? undefined : (
          <EmptyState title="This metric cannot be charted in one currency">
            The accounts use different currencies and exchange rates are missing, so their amounts
            cannot be combined. Filter to accounts with one currency or add exchange rates.
          </EmptyState>
        )
      }
      nothingToChart={<>No bucket in the range has a value for {label.toLowerCase()}.</>}
      note="Dashed segments and hollow points are partial buckets; gaps are periods without synced data."
    />
  );
}
