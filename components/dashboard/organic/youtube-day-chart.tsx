"use client";

import { useState } from "react";
import { compactTick, formatDateKey, type ChartRow } from "@/lib/analytics/chart-data";
import type { YouTubeDay } from "@/lib/analytics/youtube-types";
import {
  YOUTUBE_CHART_LABEL,
  YOUTUBE_CHART_METRICS,
  YOUTUBE_DAY_STATUS_LABEL,
  youtubeDayRows,
  type YouTubeChartMetric,
} from "@/lib/analytics/youtube-values";
import { SeriesChart } from "../series-chart";

const METRICS = YOUTUBE_CHART_METRICS.map((value) => ({
  value,
  label: YOUTUBE_CHART_LABEL[value],
}));

/**
 * One channel metric per Pacific Time day, as YouTube reported it (the server's day values; no
 * value is computed here). Days that are not reported, not synced or lack the metric are gaps,
 * never 0. The metric is UI state; the day table below is the full data view.
 */
export function YouTubeDayChart({
  days,
  reportingDelayDays,
}: {
  days: readonly YouTubeDay[];
  reportingDelayDays: number;
}) {
  const [metric, setMetric] = useState<YouTubeChartMetric>("views");
  const label = YOUTUBE_CHART_LABEL[metric];
  const status = new Map(days.map((day) => [day.date, day.status]));
  const stateLabel = (row: ChartRow) => {
    const day = status.get(row.bucket);
    return day === undefined ? "" : YOUTUBE_DAY_STATUS_LABEL[day];
  };
  return (
    <SeriesChart
      title="Channel metrics by day"
      heading={`${label} by day (Pacific Time)`}
      rows={youtubeDayRows(days, metric)}
      granularity="day"
      metric={metric}
      metrics={METRICS}
      onMetricChange={setMetric}
      tick={(value) => compactTick(value, "number")}
      period={(row) => formatDateKey(row.from)}
      periodHeader="Day (PT)"
      stateLabel={stateLabel}
      tooltip={(row) => (
        <>
          <p className="font-medium">{formatDateKey(row.from)} (PT)</p>
          <p className="tabular-nums">
            {label}: {row.display}
          </p>
          <p className="text-muted-foreground">{stateLabel(row)}</p>
        </>
      )}
      nothingToChart={
        <>
          No day in this range has a value for {label.toLowerCase()}. Missing values are never drawn
          as zero.
        </>
      }
      note={`Pacific Time days, as YouTube reported them. Gaps are days without a value, never zero; YouTube reports days about ${reportingDelayDays} days late.`}
    />
  );
}
