"use client";

import { useId } from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { LEVEL_PLURAL } from "@/lib/analytics/labels";
import { useAnalyticsScope, useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { ActionsPanel } from "../actions-panel";
import { FilterBar } from "../filter-bar";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

const LEVELS = ["account", "campaign"] as const;
type Level = (typeof LEVELS)[number];

/** Conversion actions per type and attribution window for the org or the filtered accounts. */
export function ConversionsView() {
  const id = useId();
  const scope = useAnalyticsScope();
  const { searchParams, setParams } = useDashboardFilters();
  const levelParam = searchParams.get("level");
  const level: Level = (LEVELS as readonly string[]).includes(levelParam ?? "")
    ? (levelParam as Level)
    : "account";
  const args = { range: scope.range, level };
  return (
    <>
      <PageHeader
        title="Conversions"
        description="Conversion actions as each platform reports them, per attribution window."
      />
      <FilterBar compare={false} />
      <div className="flex items-center gap-2 text-sm">
        <span id={id} className="text-muted-foreground">
          Level
        </span>
        <Select
          value={level}
          onValueChange={(value) => setParams({ level: value === "account" ? undefined : value })}
        >
          <SelectTrigger size="sm" className="w-36" aria-labelledby={id}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVELS.map((l) => (
              <SelectItem key={l} value={l}>
                {LEVEL_PLURAL[l]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <QueryBoundary
        resetKey={JSON.stringify([args, scope.apiFilters, searchParams.get("primaryOnly")])}
        title="Conversions"
      >
        <ActionsPanel args={args} accountFilters={scope.apiFilters} />
      </QueryBoundary>
    </>
  );
}
