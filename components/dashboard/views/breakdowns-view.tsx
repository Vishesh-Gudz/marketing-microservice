"use client";

import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { api } from "@/convex/_generated/api";
import { humanize, LEVEL_PLURAL } from "@/lib/analytics/labels";
import { useOrg } from "@/lib/analytics/org-context";
import type { BreakdownArgs, BreakdownGroup, EntityLevel } from "@/lib/analytics/types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useAnalyticsScope, useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { VALUES, valueView, type ValueKey } from "@/lib/analytics/values";
import { cn } from "@/lib/utils";
import { DataStateBadge } from "../data-state-badge";
import { EmptyState } from "../empty-state";
import { FilterBar } from "../filter-bar";
import { LabelledSelect } from "../labelled-select";
import { CoverageNotice, FxNotice } from "../notices";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";
import { SpendShare } from "../spend-share";
import { SECTION_HEADING, SURFACE, TABLE_EDGES } from "../surface";
import { UpdatingIndicator } from "../updating-indicator";
import { ValueText } from "../value-text";

const TABS = ["platform", "account", "placement"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABEL: Record<Tab, string> = {
  platform: "By platform",
  account: "By account",
  placement: "By placement",
};
const LEVELS: EntityLevel[] = ["account", "campaign", "ad_group", "ad"];
const COLUMNS: ValueKey[] = [
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "conversions",
  "costPerConversion",
  "roas",
];

function BreakdownTable({ args }: { args: BreakdownArgs }) {
  const org = useOrg();
  const { data, isLoading, isUpdating } = useAnalyticsQuery(api.v1.analytics.breakdown, args);
  const { data: accounts } = useAnalyticsQuery(api.v1.adAccounts.list, {});
  if (isLoading || !data)
    return <Skeleton className="h-64 w-full" role="status" aria-label="Loading breakdown" />;
  const accountName = new Map((accounts ?? []).map((a) => [a.id, a.name]));
  const labelOf = (group: BreakdownGroup) => {
    if (data.by === "account") return accountName.get(group.accountId ?? "") ?? "Ad account";
    if (data.by === "platform") return humanize(group.platform ?? group.key);
    return humanize(group.placement ?? group.key);
  };
  const caption = `${TAB_LABEL[data.by]}${data.by === "placement" ? ` (${LEVEL_PLURAL[data.level].toLowerCase()} level)` : ""}`;
  return (
    <div
      className={cn("relative flex flex-col gap-3", isUpdating && "opacity-60")}
      aria-busy={isUpdating}
    >
      <UpdatingIndicator active={isUpdating} overlay />
      <CoverageNotice coverage={data.coverage} />
      <FxNotice fx={data.fx} />
      {data.groups.length > 0 && (
        <div className={cn(SURFACE, "p-4")}>
          <h2 className={cn(SECTION_HEADING, "mb-3")}>Share of spend</h2>
          <SpendShare
            title="Share of spend"
            reportingCurrency={org.reportingCurrency}
            items={data.groups.map((group) => ({
              key: group.key,
              label: labelOf(group),
              aggregate: group,
            }))}
          />
        </div>
      )}
      {data.groups.length === 0 ? (
        <EmptyState title="Nothing to break down">
          No accounts in this scope report this breakdown.
        </EmptyState>
      ) : (
        <div className={cn(SURFACE, "overflow-x-auto")}>
          <Table data-testid={`breakdown-${data.by}`} className={TABLE_EDGES}>
            <TableCaption className="sr-only">{caption}</TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col" className="sticky left-0 z-10 min-w-48 bg-paper">
                  {humanize(data.by)}
                </TableHead>
                {COLUMNS.map((key) => (
                  <TableHead key={key} scope="col" className="text-right">
                    {VALUES[key].label}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.groups.map((group) => (
                <TableRow key={group.key}>
                  <TableCell className="sticky left-0 z-10 bg-paper whitespace-normal group-hover/row:bg-canvas">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{labelOf(group)}</span>
                      <DataStateBadge state={group.dataState} />
                    </div>
                  </TableCell>
                  {COLUMNS.map((key) => (
                    <TableCell key={key} className="text-right">
                      <ValueText view={valueView(key, group)} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
      {data.by === "placement" && (
        <p className="text-xs text-muted-foreground">
          Placement totals can differ from the platform&apos;s &ldquo;all placements&rdquo; total
          and are never mixed with it; reach is not additive across placements.
        </p>
      )}
    </div>
  );
}

/** Totals split by platform, ad account or placement (v1/analytics:breakdown). */
export function BreakdownsView() {
  const scope = useAnalyticsScope();
  const { searchParams, setParams } = useDashboardFilters();
  const tabParam = searchParams.get("tab");
  const tab: Tab = (TABS as readonly string[]).includes(tabParam ?? "")
    ? (tabParam as Tab)
    : "platform";
  const levelParam = searchParams.get("level");
  const level: EntityLevel = (LEVELS as string[]).includes(levelParam ?? "")
    ? (levelParam as EntityLevel)
    : "account";
  const args: BreakdownArgs = {
    by: tab,
    range: scope.range,
    ...(tab === "placement" ? { level } : {}),
    ...(scope.apiFilters ? { filters: scope.apiFilters } : {}),
  };
  return (
    <>
      <PageHeader
        title="Breakdowns"
        description="Where the budget went, by platform, account or placement."
      />
      <FilterBar compare={false} />
      <Tabs
        value={tab}
        onValueChange={(value) => setParams({ tab: value === "platform" ? undefined : value })}
        className="gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <TabsList aria-label="Breakdown dimension">
            {TABS.map((t) => (
              <TabsTrigger key={t} value={t}>
                {TAB_LABEL[t]}
              </TabsTrigger>
            ))}
          </TabsList>
          {tab === "placement" && (
            <LabelledSelect
              label="Level"
              value={level}
              options={LEVELS.map((l) => ({ value: l, label: LEVEL_PLURAL[l] }))}
              onValueChange={(value) =>
                setParams({ level: value === "account" ? undefined : value })
              }
            />
          )}
        </div>
        {TABS.map((t) => (
          <TabsContent key={t} value={t}>
            {/* Radix mounts only the active panel; one breakdown query at a time. */}
            <QueryBoundary resetKey={JSON.stringify(args)} title="Breakdown">
              <BreakdownTable args={args} />
            </QueryBoundary>
          </TabsContent>
        ))}
      </Tabs>
    </>
  );
}
