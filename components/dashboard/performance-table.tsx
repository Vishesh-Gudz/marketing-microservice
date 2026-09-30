"use client";

import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import Link from "next/link";
import { useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { api } from "@/convex/_generated/api";
import { filterParamsOnly } from "@/lib/analytics/filters";
import { humanize, LEVEL_PLURAL } from "@/lib/analytics/labels";
import type { PerformanceArgs, PerformanceLevel, PerformanceRow } from "@/lib/analytics/types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useAnalyticsScope, useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { valueView, type ValueKey } from "@/lib/analytics/values";
import { cn } from "@/lib/utils";
import { DataStateBadge } from "./data-state-badge";
import { DeltaChip } from "./delta-chip";
import { EmptyState } from "./empty-state";
import { FxNotice } from "./notices";
import { UpdatingIndicator } from "./updating-indicator";
import { ValueText } from "./value-text";

export const SORT_KEYS = ["spend", "impressions", "clicks", "conversions", "name"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const PAGE_SIZES = [25, 50, 100] as const;

const COLUMNS: { key: ValueKey; sortable: boolean; delta: boolean }[] = [
  { key: "spend", sortable: true, delta: true },
  { key: "impressions", sortable: true, delta: false },
  { key: "clicks", sortable: true, delta: false },
  { key: "ctr", sortable: false, delta: false },
  { key: "cpc", sortable: false, delta: false },
  { key: "conversions", sortable: true, delta: true },
  { key: "costPerConversion", sortable: false, delta: false },
  { key: "roas", sortable: false, delta: false },
];

const HEADER: Record<ValueKey, string> = {
  spend: "Spend",
  conversionValue: "Conv. value",
  impressions: "Impr.",
  clicks: "Clicks",
  ctr: "CTR",
  cpc: "CPC",
  cpm: "CPM",
  conversions: "Conv.",
  conversionRate: "Conv. rate",
  costPerConversion: "Cost / conv.",
  roas: "ROAS",
};

function parseSort(params: URLSearchParams): { by: SortKey; dir: "asc" | "desc" } {
  const by = (SORT_KEYS as readonly string[]).includes(params.get("sort") ?? "")
    ? (params.get("sort") as SortKey)
    : "spend";
  const dirParam = params.get("dir");
  const dir = dirParam === "asc" || dirParam === "desc" ? dirParam : by === "name" ? "asc" : "desc";
  return { by, dir };
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: { by: SortKey; dir: "asc" | "desc" };
  onSort: (column: SortKey) => void;
  className?: string;
}) {
  const active = sort.by === column;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <TableHead
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={className}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className="inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        {label}
        <Icon className="size-3.5" aria-hidden="true" />
        <span className="sr-only">
          {active ? `, sorted ${sort.dir === "asc" ? "ascending" : "descending"}` : ", sortable"}
        </span>
      </button>
    </TableHead>
  );
}

/**
 * Campaign / ad group / ad performance (D14): server-side sorting and cursor
 * pagination only (the API sorts the full scoped set; the client never
 * re-sorts a page). The cursor stack restarts whenever the arguments change.
 */
export function PerformanceTable({
  level,
  parent,
  useAccountFilters,
  hrefFor,
  caption,
}: {
  level: PerformanceLevel;
  parent?: PerformanceArgs["parent"];
  /** Apply the global platform/account filters (not allowed together with `parent`). */
  useAccountFilters: boolean;
  hrefFor?: (row: PerformanceRow) => string;
  caption: string;
}) {
  const pageSizeLabelId = useId();
  const scope = useAnalyticsScope();
  const { searchParams, setParams } = useDashboardFilters();
  const params = new URLSearchParams(searchParams.toString());
  const sort = parseSort(params);
  // Page size and position are UI state (D2/D14); sort lives in the URL (D3).
  const [numItems, setNumItems] = useState<number>(PAGE_SIZES[0]);

  const baseArgs = {
    level,
    range: scope.range,
    sort,
    ...(parent ? { parent } : {}),
    ...(useAccountFilters && scope.apiFilters ? { filters: scope.apiFilters } : {}),
    ...(scope.compare ? { compare: scope.compare } : {}),
  };
  const argsKey = JSON.stringify([baseArgs, numItems]);
  const [paging, setPaging] = useState({ key: argsKey, cursors: [null] as (string | null)[] });
  if (paging.key !== argsKey) setPaging({ key: argsKey, cursors: [null] });
  const cursors = paging.key === argsKey ? paging.cursors : [null];
  const cursor = cursors[cursors.length - 1] ?? null;

  const { data, isLoading, isUpdating } = useAnalyticsQuery(api.v1.analytics.performance, {
    ...baseArgs,
    paginationOpts: { numItems, cursor },
  });

  const onSort = (column: SortKey) => {
    const dir =
      sort.by === column
        ? sort.dir === "asc"
          ? "desc"
          : "asc"
        : column === "name"
          ? "asc"
          : "desc";
    setParams({ sort: column, dir });
  };
  const linkQuery = filterParamsOnly(params).toString();
  const withQuery = (href: string) => (linkQuery ? `${href}?${linkQuery}` : href);
  const pageNumber = cursors.length;

  return (
    <section className="flex flex-col gap-3" aria-label={caption}>
      <UpdatingIndicator active={isUpdating} />
      {data && <FxNotice fx={data.fx} />}
      <div
        className={cn("overflow-x-auto rounded-md border", isUpdating && "opacity-60")}
        aria-busy={isLoading || isUpdating}
      >
        <Table>
          <TableCaption className="sr-only">{caption}</TableCaption>
          <TableHeader>
            <TableRow>
              <SortHeader
                label="Name"
                column="name"
                sort={sort}
                onSort={onSort}
                className="sticky left-0 z-10 min-w-56 bg-background"
              />
              {COLUMNS.map((column) =>
                column.sortable ? (
                  <SortHeader
                    key={column.key}
                    label={HEADER[column.key]}
                    column={column.key as SortKey}
                    sort={sort}
                    onSort={onSort}
                    className="text-right"
                  />
                ) : (
                  <TableHead key={column.key} scope="col" className="text-right">
                    {HEADER[column.key]}
                  </TableHead>
                ),
              )}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading &&
              Array.from({ length: 5 }, (_, i) => (
                <TableRow key={i} aria-hidden="true">
                  <TableCell colSpan={COLUMNS.length + 1}>
                    <Skeleton className="h-5 w-full" />
                  </TableCell>
                </TableRow>
              ))}
            {data?.page.map((row) => (
              <TableRow key={row.entity.id} data-row-id={row.entity.id}>
                <TableCell className="sticky left-0 z-10 bg-background whitespace-normal">
                  <div className="flex flex-col gap-1">
                    {hrefFor ? (
                      <Link
                        href={withQuery(hrefFor(row))}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {row.entity.name}
                      </Link>
                    ) : (
                      <span className="font-medium">{row.entity.name}</span>
                    )}
                    <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <span>{humanize(row.entity.platform)}</span>
                      <span aria-hidden="true">·</span>
                      <span>{humanize(row.entity.status)}</span>
                      {row.entity.removed && <Badge variant="outline">Removed</Badge>}
                      <DataStateBadge state={row.dataState} />
                    </div>
                  </div>
                </TableCell>
                {COLUMNS.map((column) => (
                  <TableCell key={column.key} className="text-right align-top">
                    <div className="flex flex-col items-end gap-0.5">
                      <ValueText view={valueView(column.key, row)} />
                      {column.delta && row.comparison && (
                        <DeltaChip metric={column.key} delta={row.comparison.deltas[column.key]} />
                      )}
                    </div>
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {data && data.page.length === 0 && (
          <EmptyState
            className="m-4"
            title={`No ${LEVEL_PLURAL[level].toLowerCase()} in this scope`}
          >
            Nothing has been synced for the selected accounts yet, or the filters exclude
            everything.
          </EmptyState>
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-2">
          <span id={pageSizeLabelId} className="text-muted-foreground">
            Rows per page
          </span>
          <Select value={String(numItems)} onValueChange={(value) => setNumItems(Number(value))}>
            <SelectTrigger size="sm" aria-labelledby={pageSizeLabelId} className="w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground" aria-live="polite">
            Page {pageNumber}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={pageNumber === 1}
            onClick={() => setPaging({ key: argsKey, cursors: cursors.slice(0, -1) })}
          >
            Previous
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!data || data.isDone || isUpdating}
            onClick={() =>
              data && setPaging({ key: argsKey, cursors: [...cursors, data.continueCursor] })
            }
          >
            Next
          </Button>
        </div>
      </div>
    </section>
  );
}
