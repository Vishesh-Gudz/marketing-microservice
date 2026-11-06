"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Aggregate, Comparison } from "@/lib/analytics/types";
import { KPI_CARDS, VALUES, valueView, type ValueKey } from "@/lib/analytics/values";
import { DeltaChip } from "./delta-chip";
import { ValueText } from "./value-text";

/** One KPI's value and comparison chip (shared by the KPI cards and the KPI strip). */
export function KpiFigure({
  metric,
  aggregate,
  comparison,
  valueClassName = "text-2xl font-semibold",
  detailClassName = "text-base font-semibold",
}: {
  metric: ValueKey;
  aggregate: Aggregate;
  comparison?: Comparison;
  /** Classes of a single value. */
  valueClassName?: string;
  /** Classes of a per-currency value ("Multiple currencies"), which needs less emphasis. */
  detailClassName?: string;
}) {
  const view = valueView(metric, aggregate);
  return (
    <>
      {aggregate.dataState === "no_delivery" && view.kind === "unavailable" ? (
        // D10: say "No delivery" rather than showing 0.
        <span className="text-base font-medium text-muted-foreground">No delivery</span>
      ) : (
        <ValueText
          view={view}
          className={view.kind === "value" && view.detail ? detailClassName : valueClassName}
        />
      )}
      {comparison && <DeltaChip metric={metric} delta={comparison.deltas[metric]} />}
    </>
  );
}

export function KpiCard({
  metric,
  aggregate,
  comparison,
}: {
  metric: ValueKey;
  aggregate: Aggregate;
  comparison?: Comparison;
}) {
  return (
    <Card className="gap-2 py-4" data-kpi={metric}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          <h3>{VALUES[metric].label}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 px-4">
        <KpiFigure metric={metric} aggregate={aggregate} comparison={comparison} />
      </CardContent>
    </Card>
  );
}

/** The 10 headline KPIs with comparison deltas. */
export function KpiGrid({
  aggregate,
  comparison,
}: {
  aggregate: Aggregate;
  comparison?: Comparison;
}) {
  return (
    <section aria-label="Key metrics">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {KPI_CARDS.map((metric) => (
          <KpiCard key={metric} metric={metric} aggregate={aggregate} comparison={comparison} />
        ))}
      </div>
    </section>
  );
}

export function KpiGridSkeleton() {
  return (
    <div
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5"
      aria-hidden="true"
      data-testid="kpi-skeleton"
    >
      {KPI_CARDS.map((metric) => (
        <Skeleton key={metric} className="h-24 rounded-xl" />
      ))}
    </div>
  );
}
