"use client";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { humanize } from "@/lib/analytics/labels";
import { parseSocialParams } from "@/lib/analytics/organic-filters";
import type { OrganicOverviewArgs, OrganicSeriesArgs } from "@/lib/analytics/organic-types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useAnalyticsScope, useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { cn } from "@/lib/utils";
import { EmptyState } from "../empty-state";
import { FilterBar } from "../filter-bar";
import { ReauthBanner } from "../notices";
import { OrganicCoverageNotice, OrganicFreshness } from "../organic/organic-coverage-note";
import { OrganicKpiGrid, OrganicKpiGridSkeleton } from "../organic/organic-kpi-grid";
import { OrganicSeriesPanel } from "../organic/organic-series-panel";
import { SocialAccountPicker } from "../organic/social-account-picker";
import { SocialPostsTable } from "../organic/social-posts-table";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";
import { UpdatingIndicator } from "../updating-indicator";

/** The selected account's identity, link state and data freshness (v1/socialAccounts:get). */
function AccountSummary({ socialAccountId }: { socialAccountId: string }) {
  const { data } = useAnalyticsQuery(api.v1.socialAccounts.get, { socialAccountId });
  if (!data) return <Skeleton className="h-10 w-full" role="status" aria-label="Loading account" />;
  return (
    <div className="flex flex-col gap-1" data-testid="social-account-summary">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">
          {data.username !== undefined ? `@${data.username}` : data.name}
        </span>
        {data.username !== undefined && data.name !== data.username && (
          <span className="text-muted-foreground">{data.name}</span>
        )}
        <Badge variant="secondary">{humanize(data.accountType)}</Badge>
        {!data.linked && <Badge variant="outline">Unlinked — history only</Badge>}
      </div>
      <OrganicFreshness account={data} />
    </div>
  );
}

/** Headline and detail KPIs of the selected account over the selected UTC range. */
function OrganicTotals({ args }: { args: OrganicOverviewArgs }) {
  const { data, isLoading, isUpdating } = useAnalyticsQuery(api.v1.organicAnalytics.overview, args);
  if (isLoading || !data) return <OrganicKpiGridSkeleton />;
  return (
    <div
      className={cn("flex flex-col gap-3", isUpdating && "opacity-60")}
      aria-busy={isUpdating}
      data-testid="organic-totals"
    >
      <UpdatingIndicator active={isUpdating} />
      <OrganicCoverageNotice coverage={data.coverage} />
      <OrganicKpiGrid aggregate={data.totals} comparison={data.comparison} />
    </div>
  );
}

/**
 * Organic Instagram (Phase 10 Stage B, B3): ONE account at a time, entirely separate from paid
 * analytics. Account metrics are UTC days (presets resolve against today in UTC); posts are
 * filtered by publish day in the org timezone and show lifetime totals. Every value comes from
 * the public v1 API; the dashboard computes none.
 */
export function OrganicView() {
  const { searchParams, setParams } = useDashboardFilters();
  const social = parseSocialParams(new URLSearchParams(searchParams.toString()));
  const scope = useAnalyticsScope({ dayBasis: "utc" });
  const accounts = useAnalyticsQuery(api.v1.socialAccounts.list, {
    paginationOpts: { numItems: 100, cursor: null },
  });

  const header = (
    <>
      <PageHeader
        title="Instagram (organic)"
        description="Organic performance of a connected Instagram professional account — separate from paid ads. Account metrics use UTC days."
      />
      <ReauthBanner />
    </>
  );

  if (accounts.isLoading || !accounts.data) {
    return (
      <>
        {header}
        <Skeleton className="h-16 w-full" role="status" aria-label="Loading Instagram accounts" />
      </>
    );
  }
  const list = accounts.data.page;
  if (list.length === 0) {
    return (
      <>
        {header}
        <EmptyState title="No Instagram account connected">
          Organic analytics needs an Instagram professional (business or creator) account that is
          connected and linked through your integration. Connections are managed outside this
          dashboard; once an account is linked and synced, its data appears here.
        </EmptyState>
      </>
    );
  }

  const selectedId = social.account ?? list[0]!.id;
  const listed = list.some((account) => account.id === selectedId);
  const picker = (
    <SocialAccountPicker
      accounts={list}
      selectedId={selectedId}
      onSelect={(accountId) => setParams({ account: accountId })}
      truncated={!accounts.data.isDone}
    />
  );
  if (!listed && accounts.data.isDone) {
    return (
      <>
        {header}
        {picker}
        <EmptyState title="This Instagram account is not available">
          The account in the link does not exist or is not visible to your organization. Choose one
          of your accounts above.
        </EmptyState>
      </>
    );
  }

  const overviewArgs: OrganicOverviewArgs = {
    range: scope.range,
    ...(scope.compare ? { compare: scope.compare } : {}),
    socialAccountIds: [selectedId],
  };
  const seriesArgs: OrganicSeriesArgs = {
    socialAccountId: selectedId,
    range: scope.range,
    granularity: scope.granularity,
  };
  return (
    <>
      {header}
      <div className="flex flex-wrap items-end justify-between gap-3">
        {picker}
        <QueryBoundary resetKey={`account:${selectedId}`} title="Account">
          <AccountSummary socialAccountId={selectedId} />
        </QueryBoundary>
      </div>
      <FilterBar dayBasis="utc" accounts={false} granularity />
      <QueryBoundary resetKey={JSON.stringify(overviewArgs)} title="Key metrics">
        <OrganicTotals args={overviewArgs} />
      </QueryBoundary>
      <QueryBoundary resetKey={JSON.stringify(seriesArgs)} title="Chart">
        <OrganicSeriesPanel args={seriesArgs} />
      </QueryBoundary>
      <QueryBoundary
        resetKey={JSON.stringify([selectedId, scope.range, social.postOrder])}
        title="Posts"
      >
        <SocialPostsTable
          socialAccountId={selectedId}
          range={scope.range}
          postOrder={social.postOrder}
        />
      </QueryBoundary>
    </>
  );
}
