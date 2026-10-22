"use client";

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import type { ChartMetric } from "@/lib/analytics/chart-data";
import { useOrg } from "@/lib/analytics/org-context";
import type { TimeSeriesArgs } from "@/lib/analytics/types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { cn } from "@/lib/utils";
import { TimeSeriesChart } from "./time-series-chart";
import { UpdatingIndicator } from "./updating-indicator";

/** Loads v1/analytics:timeSeries and renders the chart (the metric is a UI toggle, D2). */
export function TimeSeriesPanel({ args, title }: { args: TimeSeriesArgs; title?: string }) {
  const org = useOrg();
  const [metric, setMetric] = useState<ChartMetric>("spend");
  const { data, isLoading, isUpdating } = useAnalyticsQuery(api.v1.analytics.timeSeries, args);

  if (isLoading || !data) {
    return <Skeleton className="h-80 w-full rounded-lg" role="status" aria-label="Loading chart" />;
  }
  return (
    <div className={cn("rounded-lg border p-4", isUpdating && "opacity-60")} aria-busy={isUpdating}>
      <UpdatingIndicator active={isUpdating} />
      <TimeSeriesChart
        points={data.points}
        granularity={data.granularity}
        reportingCurrency={org.reportingCurrency}
        metric={metric}
        onMetricChange={setMetric}
        title={title}
      />
    </div>
  );
}
