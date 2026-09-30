"use client";

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import {
  ORGANIC_CHART_METRICS,
  organicSeriesRows,
  type OrganicChartMetric,
} from "@/lib/analytics/organic-chart-data";
import type { OrganicSeriesArgs } from "@/lib/analytics/organic-types";
import { organicLabel } from "@/lib/analytics/organic-values";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { cn } from "@/lib/utils";
import { DataStateBadge } from "../data-state-badge";
import { UpdatingIndicator } from "../updating-indicator";
import { OrganicSeriesChart } from "./organic-series-chart";

const GRANULARITY_TEXT = { day: "day", week: "week", month: "month" } as const;
const METRICS = ORGANIC_CHART_METRICS.map((value) => ({ value, label: organicLabel(value) }));

/** Loads v1/organicAnalytics:accountSeries (UTC buckets) and charts one metric (UI state). */
export function OrganicSeriesPanel({ args }: { args: OrganicSeriesArgs }) {
  const [metric, setMetric] = useState<OrganicChartMetric>("views");
  const { data, isLoading, isUpdating } = useAnalyticsQuery(
    api.v1.organicAnalytics.accountSeries,
    args,
  );
  if (isLoading || !data) {
    return <Skeleton className="h-80 w-full rounded-lg" role="status" aria-label="Loading chart" />;
  }
  const { rows, dayOnly } = organicSeriesRows(data.points, metric);
  const label = organicLabel(metric);
  return (
    <div
      className={cn("flex flex-col gap-2 rounded-lg border p-4", isUpdating && "opacity-60")}
      aria-busy={isUpdating}
      data-testid="organic-series"
    >
      <div className="flex items-center justify-between gap-2">
        <UpdatingIndicator active={isUpdating} />
        <DataStateBadge state={data.dataState} />
      </div>
      <OrganicSeriesChart
        title="Account metrics over time (UTC)"
        heading={`${label} by ${GRANULARITY_TEXT[data.granularity]} (UTC)`}
        rows={rows}
        granularity={data.granularity}
        metric={metric}
        metrics={METRICS}
        onMetricChange={setMetric}
        dayOnly={dayOnly}
        note="UTC days. Dashed segments and hollow points are partial periods; gaps are periods without a value (never shown as zero)."
      />
    </div>
  );
}
