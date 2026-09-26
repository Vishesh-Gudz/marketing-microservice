"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import type { Aggregate, Comparison } from "@/lib/analytics/types";
import { KPI_CARDS, VALUES, valueView, type ValueKey } from "@/lib/analytics/values";
import { DeltaChip } from "./delta-chip";
import { ValueText } from "./value-text";

export function KpiCard({
  metric,
  aggregate,
  comparison,
}: {
  metric: ValueKey;
  aggregate: Aggregate;
  comparison?: Comparison;
}) {
  const view = valueView(metric, aggregate);
  return (
    <Card className="gap-2 py-4" data-kpi={metric}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          <h3>{VALUES[metric].label}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 px-4">
        {aggregate.dataState === "no_delivery" && view.kind === "unavailable" ? (
          // D10: say "No delivery" rather than showing 0.
          <span className="text-base font-medium text-muted-foreground">No delivery</span>
        ) : (
          <ValueText
            view={view}
            // Per-currency values ("Multiple currencies") need less emphasis than one number.
            className={
              view.kind === "value" && view.detail
                ? "text-base font-semibold"
                : "text-2xl font-semibold"
            }
          />
        )}
        {comparison && <DeltaChip metric={metric} delta={comparison.deltas[metric]} />}
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
