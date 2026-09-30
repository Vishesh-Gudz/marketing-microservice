"use client";

import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/convex/_generated/api";
import type { EntitySummary, OverviewArgs, PerformanceLevel } from "@/lib/analytics/types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useAnalyticsScope, useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { cn } from "@/lib/utils";
import { EntityHeader } from "../entity-header";
import { FilterBar } from "../filter-bar";
import { KpiGrid, KpiGridSkeleton } from "../kpi-grid";
import { CoverageNotice, FxNotice } from "../notices";
import { QueryBoundary } from "../query-boundary";
import { TimeSeriesPanel } from "../time-series-panel";
import { UpdatingIndicator } from "../updating-indicator";

export type EntityTab = { value: string; label: string; content: ReactNode };

/**
 * Shared detail layout for one campaign / ad group (D5): overview with `entity`
 * gives the summary, totals and comparison; the time series and each tab are
 * separate regions. Account filters do not apply to one entity. A foreign,
 * unknown or malformed id (API NOT_FOUND) or a URL whose parent does not match
 * renders the dashboard's not-found page.
 */
export function EntityDetail({
  level,
  id,
  breadcrumbs,
  validate,
  tabs,
}: {
  level: PerformanceLevel;
  id: string;
  breadcrumbs: (entity: EntitySummary | undefined) => ReactNode;
  /** URL consistency check (e.g. the ad group belongs to the campaign in the URL). */
  validate?: (entity: EntitySummary) => boolean;
  tabs: (entity: EntitySummary) => EntityTab[];
}) {
  const scope = useAnalyticsScope();
  const { searchParams, setParams } = useDashboardFilters();
  const overviewArgs: OverviewArgs = {
    range: scope.range,
    entity: { level, id },
    ...(scope.compare ? { compare: scope.compare } : {}),
  };
  const { data, isLoading, isUpdating } = useAnalyticsQuery(
    api.v1.analytics.overview,
    overviewArgs,
  );

  if (isLoading || !data) {
    return (
      <>
        {breadcrumbs(undefined)}
        <Skeleton className="h-10 w-72" />
        <KpiGridSkeleton />
      </>
    );
  }
  const entity = data.entity;
  if (!entity || (validate && !validate(entity))) notFound();

  const seriesArgs = { range: scope.range, granularity: scope.granularity, entity: { level, id } };
  const entityTabs = tabs(entity);
  const tabParam = searchParams.get("tab");
  const activeTab = entityTabs.some((t) => t.value === tabParam)
    ? (tabParam as string)
    : entityTabs[0]!.value;
  return (
    <>
      {breadcrumbs(entity)}
      <EntityHeader entity={entity} />
      <FilterBar accounts={false} granularity />
      <div
        className={cn("flex flex-col gap-3", isUpdating && "opacity-60")}
        aria-busy={isUpdating}
        data-testid="entity-totals"
      >
        <UpdatingIndicator active={isUpdating} />
        <CoverageNotice coverage={data.coverage} />
        <FxNotice fx={data.fx} />
        <KpiGrid aggregate={data.totals} comparison={data.comparison} />
      </div>
      <QueryBoundary resetKey={JSON.stringify(seriesArgs)} title="Chart">
        <TimeSeriesPanel args={seriesArgs} />
      </QueryBoundary>
      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          setParams({ tab: value === entityTabs[0]!.value ? undefined : value })
        }
        className="gap-3"
      >
        <TabsList aria-label="Details">
          {entityTabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        {entityTabs.map((tab) => (
          <TabsContent key={tab.value} value={tab.value}>
            {/* Radix mounts only the active panel, so only its query runs. */}
            <QueryBoundary
              resetKey={JSON.stringify([tab.value, overviewArgs, searchParams.toString()])}
              title={tab.label}
            >
              {tab.content}
            </QueryBoundary>
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
