"use client";

import { Skeleton } from "@/components/ui/skeleton";
import type { Aggregate, Comparison } from "@/lib/analytics/types";
import { KPI_CARDS, VALUES, valueView, type ValueKey } from "@/lib/analytics/values";
import { DeltaChip } from "./delta-chip";
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

// One surface split by hairlines (the cells sit on a 1 px gap over the line colour). Ten KPIs
// fill 2 columns on phones and 5 from md up, so no row is ever left half empty.
const STRIP =
  "grid grid-cols-2 gap-px overflow-hidden rounded-[14px] border border-line bg-line shadow-soft md:grid-cols-5";
const CELL = "flex min-h-28 min-w-0 flex-col items-start gap-1.5 bg-paper px-4 py-3.5";

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
