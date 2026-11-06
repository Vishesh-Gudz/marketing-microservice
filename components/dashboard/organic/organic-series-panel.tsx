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
import { SURFACE } from "../surface";
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
    return (
      <Skeleton className="h-80 w-full rounded-[14px]" role="status" aria-label="Loading chart" />
    );
  }
  const { rows, dayOnly } = organicSeriesRows(data.points, metric);
  const label = organicLabel(metric);
  return (
    <div className="relative">
      <UpdatingIndicator active={isUpdating} overlay />
      <div
        className={cn(SURFACE, "p-4", isUpdating && "opacity-60")}
        aria-busy={isUpdating}
        data-testid="organic-series"
      >
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
          aside={<DataStateBadge state={data.dataState} />}
        />
      </div>
    </div>
  );
}
