"use client";

import type { ReactNode } from "react";
import { compactTick, type ChartRow } from "@/lib/analytics/chart-data";
import { DATA_STATE_LABEL } from "@/lib/analytics/states";
import { EmptyState } from "../empty-state";
import { SeriesChart } from "../series-chart";

export type SeriesGranularity = "day" | "week" | "month";

/**
 * A line of API values over UTC days (organic account series) or UTC capture days (post
 * lifetime totals), drawn by the shared SeriesChart. Gaps are honest (null = no value; never
 * interpolated, never 0), partial buckets are dashed with hollow points, and every chart has
 * an equivalent table view.
 */
export function OrganicSeriesChart<M extends string>({
  title,
  heading,
  rows,
  granularity,
  metric,
  metrics,
  onMetricChange,
  dayOnly = false,
  note,
  aside,
}: {
  title: string;
  /** Accessible chart name, e.g. "Views by day (UTC)". */
  heading: string;
  rows: readonly ChartRow[];
  granularity: SeriesGranularity;
  metric: M;
  metrics: readonly { value: M; label: string }[];
  onMetricChange: (metric: M) => void;
  /** The API reports the metric only per single day (non-additive). */
  dayOnly?: boolean;
  note: string;
  /** Shown next to the title, e.g. the series' data state. */
  aside?: ReactNode;
}) {
  const label = metrics.find((m) => m.value === metric)?.label ?? metric;
  const period = (row: ChartRow) =>
    granularity === "day" || row.from === row.to ? row.from : `${row.from} – ${row.to}`;

  return (
    <SeriesChart
      title={title}
      heading={heading}
      rows={rows}
      granularity={granularity}
      metric={metric}
      metrics={metrics}
      onMetricChange={onMetricChange}
      // The engagement rate is a fraction (0.155 -> 15.5%); every other organic metric counts.
      tick={(value) => compactTick(value, metric === "engagementRate" ? "percent" : "number")}
      period={period}
      periodHeader="Period (UTC)"
      tooltip={(row) => (
        <>
          <p className="font-medium">{period(row)} (UTC)</p>
          <p className="tabular-nums">
            {label}: {row.display}
          </p>
          <p className="text-muted-foreground">{DATA_STATE_LABEL[row.dataState]}</p>
        </>
      )}
      unavailable={
        dayOnly ? (
          <EmptyState title={`${label} is only available per day`}>
            Instagram counts unique accounts for this metric, so its daily values cannot be added up
            into weeks or months. Set the interval to Day to see it.
          </EmptyState>
        ) : undefined
      }
      nothingToChart={
        <>
          No period in the range has a value for {label.toLowerCase()}. Missing values are never
          drawn as zero.
        </>
      }
      note={note}
      aside={aside}
    />
  );
}
