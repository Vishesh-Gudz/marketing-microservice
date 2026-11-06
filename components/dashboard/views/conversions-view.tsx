"use client";

import { LEVEL_PLURAL } from "@/lib/analytics/labels";
import { useAnalyticsScope, useDashboardFilters } from "@/lib/analytics/use-dashboard-filters";
import { ActionsPanel } from "../actions-panel";
import { FilterBar } from "../filter-bar";
import { LabelledSelect } from "../labelled-select";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";

const LEVELS = ["account", "campaign"] as const;
type Level = (typeof LEVELS)[number];

/** Conversion actions per type and attribution window for the org or the filtered accounts. */
export function ConversionsView() {
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
      <div className="flex flex-wrap items-center gap-2">
        <LabelledSelect
          label="Level"
          value={level}
          options={LEVELS.map((l) => ({ value: l, label: LEVEL_PLURAL[l] }))}
          onValueChange={(value) => setParams({ level: value === "account" ? undefined : value })}
        />
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
