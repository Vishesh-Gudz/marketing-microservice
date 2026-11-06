"use client";

import { Skeleton } from "@/components/ui/skeleton";
import type { Aggregate, Comparison } from "@/lib/analytics/types";
import { KPI_CARDS, VALUES, valueView, type ValueKey } from "@/lib/analytics/values";
import { cn } from "@/lib/utils";
import { DeltaChip } from "./delta-chip";
import { KPI_CELL, KPI_STRIP } from "./surface";
import { ValueText } from "./value-text";

/** One KPI's value and comparison chip. */
function KpiFigure({
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
    <>
      {aggregate.dataState === "no_delivery" && view.kind === "unavailable" ? (
        // D10: say "No delivery" rather than showing 0.
        <span className="text-base font-medium text-muted-foreground">No delivery</span>
      ) : (
        <ValueText
          view={view}
          // Per-currency values ("Multiple currencies") need less emphasis than one number.
          className={
            view.kind === "value" && view.detail
              ? "text-sm font-medium"
              : "text-2xl leading-tight font-medium tracking-[-0.02em]"
          }
        />
      )}
      {comparison && <DeltaChip metric={metric} delta={comparison.deltas[metric]} />}
    </>
  );
}

// Ten KPIs fill 2 columns on phones and 5 from md up, so no row is ever left half empty.
const STRIP = cn(KPI_STRIP, "grid-cols-2 md:grid-cols-5");
const CELL = KPI_CELL;

/** The 10 headline KPIs with comparison deltas, as one strip (the Overview briefing). */
export function KpiStrip({
  aggregate,
  comparison,
}: {
  aggregate: Aggregate;
  comparison?: Comparison;
}) {
  return (
    <div className={STRIP}>
      {KPI_CARDS.map((metric) => (
        <div key={metric} className={CELL} data-kpi={metric}>
          <h3 className="text-[13px] font-medium text-muted-foreground">{VALUES[metric].label}</h3>
          <KpiFigure metric={metric} aggregate={aggregate} comparison={comparison} />
        </div>
      ))}
    </div>
  );
}

export function KpiStripSkeleton() {
  return (
    <div className={STRIP} aria-hidden="true" data-testid="kpi-skeleton">
      {KPI_CARDS.map((metric) => (
        <div key={metric} className={CELL}>
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-4 w-16" />
        </div>
      ))}
    </div>
  );
}
