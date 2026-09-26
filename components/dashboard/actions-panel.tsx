"use client";

import { Fragment, useId } from "react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
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
import { formatDecimal, formatMultiple } from "@/lib/analytics/format";
import { humanize } from "@/lib/analytics/labels";
import { KPI_LABEL, KPI_REASON_TEXT } from "@/lib/analytics/states";
import type { ActionGroup, ActionsArgs, AdPlatform } from "@/lib/analytics/types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { moneyView, type ValueView } from "@/lib/analytics/values";
import { cn } from "@/lib/utils";
import { DataStateBadge } from "./data-state-badge";
import { EmptyState } from "./empty-state";
import { CoverageNotice, FxNotice } from "./notices";
import { UpdatingIndicator } from "./updating-indicator";
import { ValueText } from "./value-text";

const ALL = "all";

function kpiView(group: ActionGroup, kpi: "costPerAction" | "valuePerSpend"): ValueView {
  if (kpi === "valuePerSpend" && group.valuePerSpend !== undefined) {
    return { kind: "value", text: formatMultiple(group.valuePerSpend), partial: false };
  }
  if (kpi === "costPerAction" && group.costPerAction !== undefined) {
    const money = moneyView(group.costPerAction);
    if (money) return { kind: "value", ...money, partial: false };
  }
  const reason = group.unavailableKpis.find((u) => u.kpi === kpi)?.reason;
  return {
    kind: "unavailable",
    text: "—",
    reason: reason ? KPI_REASON_TEXT[reason] : `${KPI_LABEL[kpi]} not available`,
  };
}

function valueOf(group: ActionGroup): ValueView {
  const money = group.value ? moneyView(group.value) : undefined;
  if (!money) return { kind: "unavailable", text: "—", reason: "No value reported" };
  return { kind: "value", ...money, partial: group.partialValue };
}

/** Rows grouped by action type; one row per attribution window (never summed, D10). */
export function groupByActionType(groups: readonly ActionGroup[]): [string, ActionGroup[]][] {
  const map = new Map<string, ActionGroup[]>();
  for (const group of groups) {
    const list = map.get(group.actionType) ?? [];
    list.push(group);
    map.set(group.actionType, list);
  }
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, rows]) => [
      type,
      [...rows].sort(
        (a, b) =>
          a.attributionWindow.localeCompare(b.attributionWindow) ||
          a.rawActionType.localeCompare(b.rawActionType),
      ),
    ]);
}

function FilterSelect({
  label,
  value,
  options,
  allLabel,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  allLabel: string;
  onChange: (value: string | undefined) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <span id={id} className="text-muted-foreground">
        {label}
      </span>
      <Select value={value} onValueChange={(next) => onChange(next === ALL ? undefined : next)}>
        <SelectTrigger size="sm" className="w-44" aria-labelledby={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option} value={option}>
              {humanize(option)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/**
 * Conversion actions (v1/analytics:actions): primary-only is an API filter;
 * window and action-type selections only choose which groups are shown (groups
 * are independent, so hiding one never changes another). URL state (D3):
 * `primaryOnly`, `window`, `actionType`.
 */
export function ActionsPanel({
  args,
  accountFilters,
}: {
  args: Omit<ActionsArgs, "filters">;
  accountFilters?: { platforms?: AdPlatform[]; accountIds?: string[] };
}) {
  const checkboxId = useId();
  const { searchParams, setParams } = useDashboardFilters();
  const primaryOnly = searchParams.get("primaryOnly") === "1";
  const windowParam = searchParams.get("window");
  const typeParam = searchParams.get("actionType");
  const filters = { ...(accountFilters ?? {}), ...(primaryOnly ? { primaryOnly: true } : {}) };
  const { data, isLoading, isUpdating } = useAnalyticsQuery(api.v1.analytics.actions, {
    ...args,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
  });

  const windows = [...new Set((data?.groups ?? []).map((g) => g.attributionWindow))].sort();
  const types: string[] = [...new Set((data?.groups ?? []).map((g) => g.actionType))].sort();
  const shown = (data?.groups ?? []).filter(
    (g) =>
      (windowParam === null || g.attributionWindow === windowParam) &&
      (typeParam === null || g.actionType === typeParam),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4 text-sm">
        <div className="flex items-center gap-2">
          <Checkbox
            id={checkboxId}
            checked={primaryOnly}
            onCheckedChange={(checked) =>
              setParams({ primaryOnly: checked === true ? "1" : undefined })
            }
          />
          <Label htmlFor={checkboxId} className="font-normal">
            Primary conversions only
          </Label>
        </div>
        <FilterSelect
          label="Window"
          value={windowParam ?? ALL}
          options={
            windowParam && !windows.includes(windowParam) ? [...windows, windowParam] : windows
          }
          allLabel="All windows"
          onChange={(value) => setParams({ window: value })}
        />
        <FilterSelect
          label="Action type"
          value={typeParam ?? ALL}
          options={typeParam && !types.includes(typeParam) ? [...types, typeParam] : types}
          allLabel="All action types"
          onChange={(value) => setParams({ actionType: value })}
        />
        <UpdatingIndicator active={isUpdating} />
      </div>

      {isLoading || !data ? (
        <Skeleton className="h-48 w-full" aria-label="Loading conversions" />
      ) : (
        <div
          className={cn("flex flex-col gap-3", isUpdating && "opacity-60")}
          aria-busy={isUpdating}
        >
          <CoverageNotice coverage={data.coverage} />
          <FxNotice fx={data.fx} />
          {shown.length === 0 ? (
            <EmptyState title="No conversions to show">
              No conversion actions were reported for this period and selection.
            </EmptyState>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <Table data-testid="actions-table">
                <TableCaption className="sr-only">
                  Conversion actions by action type, one row per attribution window
                </TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">Attribution window</TableHead>
                    <TableHead scope="col">Source action</TableHead>
                    <TableHead scope="col" className="text-right">
                      Count
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Value
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Cost / action
                    </TableHead>
                    <TableHead scope="col" className="text-right">
                      Value / spend
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groupByActionType(shown).map(([type, rows]) => (
                    <Fragment key={type}>
                      <TableRow className="bg-muted/40 hover:bg-muted/40" data-action-type={type}>
                        <TableHead scope="rowgroup" colSpan={6} className="font-semibold">
                          {humanize(type)}
                        </TableHead>
                      </TableRow>
                      {rows.map((group) => (
                        <TableRow
                          key={`${group.attributionWindow}:${group.rawActionType}:${group.conversionActionExternalId ?? ""}:${group.attributionBasis}`}
                          data-window={group.attributionWindow}
                        >
                          <TableCell>
                            <span className="font-mono text-xs">{group.attributionWindow}</span>
                            <div className="text-xs text-muted-foreground">
                              {humanize(group.attributionBasis)}
                            </div>
                          </TableCell>
                          <TableCell className="whitespace-normal">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-mono text-xs">{group.rawActionType}</span>
                              {group.isPrimary && <Badge variant="secondary">Primary</Badge>}
                            </div>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {formatDecimal(group.count)}
                          </TableCell>
                          <TableCell className="text-right">
                            <ValueText view={valueOf(group)} />
                          </TableCell>
                          <TableCell className="text-right">
                            <ValueText view={kpiView(group, "costPerAction")} />
                          </TableCell>
                          <TableCell className="text-right">
                            <ValueText view={kpiView(group, "valuePerSpend")} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </Fragment>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <DataStateBadge state={data.dataState} />
            Attribution windows and action types are never added together. Cost per action divides
            the scope&apos;s spend by the action count; value per spend divides the action value by
            that spend.
          </p>
        </div>
      )}
    </div>
  );
}
