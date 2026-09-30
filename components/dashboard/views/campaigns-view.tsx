"use client";

import { FilterBar } from "../filter-bar";
import { PageHeader } from "../page-header";
import { PerformanceTable } from "../performance-table";
import { QueryBoundary } from "../query-boundary";
import { useAnalyticsScope, useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";

/** All campaigns of the org (or the filtered accounts), sorted and paginated by the API. */
export function CampaignsView() {
  const scope = useAnalyticsScope();
  const { searchParams } = useDashboardFilters();
  const resetKey = JSON.stringify([
    scope.range,
    scope.compare,
    scope.apiFilters,
    searchParams.toString(),
  ]);
  return (
    <>
      <PageHeader title="Campaigns" description="Campaign performance for the selected period." />
      <FilterBar />
      <QueryBoundary resetKey={resetKey} title="Campaigns">
        <PerformanceTable
          level="campaign"
          useAccountFilters
          caption="Campaigns"
          hrefFor={(row) => `/campaigns/${row.entity.id}`}
        />
      </QueryBoundary>
    </>
  );
}
