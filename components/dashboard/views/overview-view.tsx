"use client";

import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { filterParamsOnly } from "@/lib/analytics/filters";
import { humanize } from "@/lib/analytics/labels";
import { useOrg } from "@/lib/analytics/org-context";
import type {
  BreakdownArgs,
  OverviewArgs,
  PerformanceArgs,
  TimeSeriesArgs,
} from "@/lib/analytics/types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useAnalyticsScope, useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { valueView } from "@/lib/analytics/values";
import { cn } from "@/lib/utils";
import { DeltaChip } from "../delta-chip";
import { EmptyState } from "../empty-state";
import { FilterBar } from "../filter-bar";
import { FreshnessNote } from "../freshness-note";
import { KpiGrid, KpiGridSkeleton } from "../kpi-grid";
import { CoverageNotice, FxNotice, ReauthBanner } from "../notices";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";
import { SpendShare } from "../spend-share";
import { TimeSeriesPanel } from "../time-series-panel";
import { UpdatingIndicator } from "../updating-indicator";
import { ValueText } from "../value-text";

function Totals({ args }: { args: OverviewArgs }) {
  const { data, isLoading, isUpdating } = useAnalyticsQuery(api.v1.analytics.overview, args);
  if (isLoading || !data) return <KpiGridSkeleton />;
  if (data.accountCount === 0) {
    return (
      <EmptyState title="No ad accounts in this scope">
        Link an ad account (or clear the platform and account filters) to see performance.
      </EmptyState>
    );
  }
  return (
    <div
      className={cn("flex flex-col gap-3", isUpdating && "opacity-60")}
      aria-busy={isUpdating}
      data-testid="overview-totals"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <FreshnessNote coverage={data.coverage} />
        <UpdatingIndicator active={isUpdating} />
      </div>
      <CoverageNotice coverage={data.coverage} />
      <FxNotice fx={data.fx} />
      <KpiGrid aggregate={data.totals} comparison={data.comparison} />
    </div>
  );
}

function PlatformSplit({ args }: { args: BreakdownArgs }) {
  const org = useOrg();
  const { data, isLoading } = useAnalyticsQuery(api.v1.analytics.breakdown, args);
  return (
    <section aria-labelledby="platform-split" className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 id="platform-split" className="text-base font-semibold">
        Spend by platform
      </h2>
      {isLoading || !data ? (
        <Skeleton className="h-16 w-full" aria-label="Loading platform split" />
      ) : data.groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">No platforms in this scope.</p>
      ) : (
        <SpendShare
          title="Spend by platform"
          reportingCurrency={org.reportingCurrency}
          items={data.groups.map((group) => ({
            key: group.key,
            label: humanize(group.platform ?? group.key),
            aggregate: group,
          }))}
        />
      )}
    </section>
  );
}

function TopCampaigns({ args }: { args: PerformanceArgs }) {
  const { searchParams } = useDashboardFilters();
  const query = filterParamsOnly(new URLSearchParams(searchParams.toString())).toString();
  const withQuery = (href: string) => (query ? `${href}?${query}` : href);
  const { data, isLoading } = useAnalyticsQuery(api.v1.analytics.performance, args);
  return (
    <section aria-labelledby="top-campaigns" className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h2 id="top-campaigns" className="text-base font-semibold">
          Top campaigns by spend
        </h2>
        <Link href={withQuery("/campaigns")} className="text-sm underline-offset-4 hover:underline">
          All campaigns
        </Link>
      </div>
      {isLoading && <Skeleton className="h-24 w-full" aria-label="Loading campaigns" />}
      {data && data.page.length === 0 && (
        <p className="text-sm text-muted-foreground">No campaigns in this scope yet.</p>
      )}
      {data && data.page.length > 0 && (
        <ol className="divide-y">
          {data.page.map((row) => (
            <li key={row.entity.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0">
                <Link
                  href={withQuery(`/campaigns/${row.entity.id}`)}
                  className="truncate font-medium underline-offset-4 hover:underline"
                >
                  {row.entity.name}
                </Link>
                <p className="text-xs text-muted-foreground">{humanize(row.entity.platform)}</p>
              </div>
              <div className="flex flex-col items-end">
                <ValueText view={valueView("spend", row)} />
                {row.comparison && <DeltaChip metric="spend" delta={row.comparison.deltas.spend} />}
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Overview (D22): headline KPIs with comparison, trend, platform split, top
 * campaigns and data freshness for the org or the filtered accounts.
 */
export function OverviewView() {
  const scope = useAnalyticsScope();
  const filters = scope.apiFilters ? { filters: scope.apiFilters } : {};
  const compare = scope.compare ? { compare: scope.compare } : {};
  const overviewArgs: OverviewArgs = { range: scope.range, ...compare, ...filters };
  const seriesArgs: TimeSeriesArgs = {
    range: scope.range,
    granularity: scope.granularity,
    ...filters,
  };
  const splitArgs: BreakdownArgs = { by: "platform", range: scope.range, ...filters };
  const topArgs: PerformanceArgs = {
    level: "campaign",
    range: scope.range,
    ...compare,
    ...filters,
    sort: { by: "spend", dir: "desc" },
    paginationOpts: { numItems: 5, cursor: null },
  };
  return (
    <>
      <PageHeader title="Overview" description="Paid performance across your linked ad accounts." />
      <ReauthBanner />
      <FilterBar granularity />
      <QueryBoundary resetKey={JSON.stringify(overviewArgs)} title="Key metrics">
        <Totals args={overviewArgs} />
      </QueryBoundary>
      <QueryBoundary resetKey={JSON.stringify(seriesArgs)} title="Chart">
        <TimeSeriesPanel args={seriesArgs} />
      </QueryBoundary>
      <div className="grid gap-4 lg:grid-cols-2">
        <QueryBoundary resetKey={JSON.stringify(splitArgs)} title="Platforms">
          <PlatformSplit args={splitArgs} />
        </QueryBoundary>
        <QueryBoundary resetKey={JSON.stringify(topArgs)} title="Top campaigns">
          <TopCampaigns args={topArgs} />
        </QueryBoundary>
      </div>
    </>
  );
}
