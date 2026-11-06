"use client";

import { ArrowRight } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
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
import { AttentionPanel } from "../attention-panel";
import { DeltaChip } from "../delta-chip";
import { EmptyState } from "../empty-state";
import { FilterBar } from "../filter-bar";
import { FreshnessNote } from "../freshness-note";
import { KpiStrip, KpiStripSkeleton } from "../kpi-strip";
import {
  connectionsNeedingReauth,
  CoverageNotice,
  coverageNeedsNotice,
  FxNotice,
  ReauthBanner,
} from "../notices";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";
import { SpendShare } from "../spend-share";
import { TimeSeriesPanel } from "../time-series-panel";
import { UpdatingIndicator } from "../updating-indicator";
import { ValueText } from "../value-text";

const HEADING = "text-[15px] font-medium text-ink";

/** A titled surface of the briefing (platform split, top campaigns). */
function Panel({
  id,
  title,
  action,
  busy,
  children,
}: {
  id: string;
  title: string;
  action?: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={id}
      aria-busy={busy || undefined}
      className={cn(
        "flex flex-col rounded-[14px] border border-line bg-paper shadow-soft",
        busy && "opacity-60",
      )}
    >
      <div className="flex items-center justify-between gap-3 px-4 pt-4 pb-3">
        <h2 id={id} className={HEADING}>
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/**
 * The top of the briefing: what needs attention (connections to reconnect, sync gaps, missing
 * exchange rates), then the key metrics. The reconnect notice is org-wide; the other two
 * describe the numbers in the current filter scope.
 */
function Briefing({ args }: { args: OverviewArgs }) {
  const { data, isLoading, isUpdating } = useAnalyticsQuery(api.v1.analytics.overview, args);
  const { data: connections } = useAnalyticsQuery(api.v1.connections.list, {});
  const inScope = data !== undefined && data.accountCount > 0 ? data : undefined;
  const reauth = connectionsNeedingReauth(connections ?? []).length > 0;
  const coverageGap = inScope !== undefined && coverageNeedsNotice(inScope.coverage);
  const fxMissing = inScope?.fx.status === "missing";
  return (
    <>
      {(reauth || coverageGap || fxMissing) && (
        <AttentionPanel>
          {reauth && <ReauthBanner />}
          {inScope && coverageGap && <CoverageNotice coverage={inScope.coverage} />}
          {inScope && fxMissing && <FxNotice fx={inScope.fx} />}
        </AttentionPanel>
      )}
      {isLoading || !data ? (
        <KpiStripSkeleton />
      ) : data.accountCount === 0 ? (
        <EmptyState title="No ad accounts in this scope">
          Link an ad account (or clear the platform and account filters) to see performance.
        </EmptyState>
      ) : (
        <section
          aria-labelledby="key-metrics"
          aria-busy={isUpdating}
          data-testid="overview-totals"
          className={cn("flex flex-col gap-3", isUpdating && "opacity-60")}
        >
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
            <div className="flex items-center gap-3">
              <h2 id="key-metrics" className={HEADING}>
                Key metrics
              </h2>
              <UpdatingIndicator active={isUpdating} />
            </div>
            <FreshnessNote coverage={data.coverage} />
          </div>
          <KpiStrip aggregate={data.totals} comparison={data.comparison} />
          {data.fx.status === "complete" && <FxNotice fx={data.fx} />}
        </section>
      )}
    </>
  );
}

function PlatformSplit({ args }: { args: BreakdownArgs }) {
  const org = useOrg();
  const { data, isLoading, isUpdating } = useAnalyticsQuery(api.v1.analytics.breakdown, args);
  return (
    <Panel id="platform-split" title="Spend by platform" busy={isUpdating}>
      <div className="px-4 pb-4">
        {isLoading || !data ? (
          <Skeleton className="h-16 w-full" role="status" aria-label="Loading platform split" />
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
      </div>
    </Panel>
  );
}

function TopCampaigns({ args }: { args: PerformanceArgs }) {
  const { searchParams } = useDashboardFilters();
  const query = filterParamsOnly(new URLSearchParams(searchParams.toString())).toString();
  const withQuery = (href: string) => (query ? `${href}?${query}` : href);
  const { data, isLoading, isUpdating } = useAnalyticsQuery(api.v1.analytics.performance, args);
  return (
    <Panel
      id="top-campaigns"
      title="Top campaigns by spend"
      busy={isUpdating}
      action={
        <Link
          href={withQuery("/campaigns")}
          className="inline-flex items-center gap-1 text-sm font-medium text-blue-deep underline-offset-4 hover:underline"
        >
          All campaigns
          <ArrowRight className="size-3.5" aria-hidden="true" />
        </Link>
      }
    >
      {isLoading && (
        <div className="px-4 pb-4">
          <Skeleton className="h-24 w-full" role="status" aria-label="Loading campaigns" />
        </div>
      )}
      {data && data.page.length === 0 && (
        <p className="px-4 pb-4 text-sm text-muted-foreground">No campaigns in this scope yet.</p>
      )}
      {data && data.page.length > 0 && (
        <ol className="border-t border-line">
          {data.page.map((row, index) => (
            <li
              key={row.entity.id}
              className="grid grid-cols-[1.25rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-4 py-2.5 last:border-b-0"
            >
              <span aria-hidden="true" className="font-mono text-xs text-muted-foreground">
                {index + 1}
              </span>
              <div className="min-w-0">
                <Link
                  href={withQuery(`/campaigns/${row.entity.id}`)}
                  className="block truncate font-medium text-ink underline-offset-4 hover:underline"
                >
                  {row.entity.name}
                </Link>
                <p className="text-xs text-muted-foreground">{humanize(row.entity.platform)}</p>
              </div>
              <div className="flex flex-col items-end gap-0.5 text-right">
                <ValueText view={valueView("spend", row)} />
                {row.comparison && <DeltaChip metric="spend" delta={row.comparison.deltas.spend} />}
              </div>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

/** One prompt for the whole page while the organization has no ad account to report on. */
function NoAdAccounts() {
  // Org-wide, outside any boundary, as ReauthBanner always is.
  const { data: connections } = useAnalyticsQuery(api.v1.connections.list, {});
  const reauth = connectionsNeedingReauth(connections ?? []).length > 0;
  return (
    <>
      {reauth && (
        <AttentionPanel>
          <ReauthBanner />
        </AttentionPanel>
      )}
      <NoAdAccountsPrompt />
    </>
  );
}

function NoAdAccountsPrompt() {
  return (
    <EmptyState
      title="No ad accounts linked yet"
      className="py-16"
      action={
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button asChild>
            <Link href="/connections">Go to Connections</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/social">Open Organic</Link>
          </Button>
        </div>
      }
    >
      The Overview reports paid results from Google Ads and Meta Ads. Once an admin connects an ad
      account on the Connections page, its spend, results and trends appear here.
    </EmptyState>
  );
}

/**
 * Overview (D22), as a briefing: what needs attention, the headline KPIs with comparison,
 * the trend, the platform split and the top campaigns, for the org or the filtered accounts.
 * Every figure comes from the existing v1 analytics queries.
 */
export function OverviewView() {
  const scope = useAnalyticsScope();
  // The same subscription as the filter bar's account picker. Manager accounts never report.
  const { data: accounts } = useAnalyticsQuery(api.v1.adAccounts.list, {});
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
  const header = (
    <PageHeader title="Overview" description="Paid performance across your linked ad accounts." />
  );
  if (accounts !== undefined && !accounts.some((account) => !account.isManager)) {
    return (
      <>
        {header}
        <NoAdAccounts />
      </>
    );
  }
  return (
    <>
      {header}
      <FilterBar granularity />
      <QueryBoundary resetKey={JSON.stringify(overviewArgs)} title="Key metrics">
        <Briefing args={overviewArgs} />
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
