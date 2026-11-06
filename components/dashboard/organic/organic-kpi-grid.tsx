"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { useOrg } from "@/lib/analytics/org-context";
import type { OrganicAggregate, OrganicComparison } from "@/lib/analytics/organic-types";
import {
  ORGANIC_DETAILS,
  ORGANIC_HEADLINE,
  organicLabel,
  organicValueView,
  type OrganicValueKey,
} from "@/lib/analytics/organic-values";
import { cn } from "@/lib/utils";
import { DeltaChip } from "../delta-chip";
import { formatInstant } from "../freshness-note";
import { KPI_CELL, KPI_STRIP } from "../surface";
import { ValueText } from "../value-text";

// Six headline KPIs fill 2, 3 or 6 columns; the seven details leave the last row short on
// smaller screens, which the strip draws blank.
const HEADLINE_STRIP = cn(KPI_STRIP, "grid-cols-2 sm:grid-cols-3 lg:grid-cols-6");
const DETAILS_STRIP = cn(KPI_STRIP, "grid-cols-2 sm:grid-cols-4 lg:grid-cols-7");
const DETAIL_CELL = cn(KPI_CELL, "min-h-22 py-3");

/**
 * One organic KPI cell: the API's value (or "—" with the API's reason, never 0), the
 * comparison delta the API provides (additive metrics and the engagement rate only), and for
 * followers the capture time ("as of"): followers is a snapshot, not an end-of-day value.
 */
export function OrganicKpiCard({
  valueKey,
  aggregate,
  comparison,
  detail = false,
}: {
  valueKey: OrganicValueKey;
  aggregate: OrganicAggregate;
  comparison?: OrganicComparison;
  /** A smaller cell of the "Engagement details" strip. */
  detail?: boolean;
}) {
  const { timezone } = useOrg();
  const view = organicValueView(valueKey, aggregate);
  const delta =
    comparison !== undefined && valueKey in comparison.deltas
      ? comparison.deltas[valueKey as keyof OrganicComparison["deltas"]]
      : undefined;
  const capturedAt = valueKey === "followers" ? aggregate.metrics.followersCapturedAt : undefined;
  return (
    <div className={detail ? DETAIL_CELL : KPI_CELL} data-kpi={valueKey}>
      <h3 className="text-[13px] font-medium text-muted-foreground">{organicLabel(valueKey)}</h3>
      <ValueText
        view={view}
        className={
          detail
            ? "text-lg leading-tight font-medium tracking-[-0.01em]"
            : "text-2xl leading-tight font-medium tracking-[-0.02em]"
        }
      />
      {capturedAt !== undefined && view.kind === "value" && (
        <p className="text-xs text-muted-foreground">as of {formatInstant(capturedAt, timezone)}</p>
      )}
      {delta !== undefined && <DeltaChip metric={valueKey} delta={delta} />}
    </div>
  );
}

/** Headline organic KPIs plus the "Engagement details" strip (N9). */
export function OrganicKpiGrid({
  aggregate,
  comparison,
}: {
  aggregate: OrganicAggregate;
  comparison?: OrganicComparison;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className={HEADLINE_STRIP}>
        {ORGANIC_HEADLINE.map((key) => (
          <OrganicKpiCard key={key} valueKey={key} aggregate={aggregate} comparison={comparison} />
        ))}
      </div>
      <section aria-labelledby="engagement-details" className="flex flex-col gap-2">
        <h2 id="engagement-details" className="text-[13px] font-medium text-muted-foreground">
          Engagement details
        </h2>
        <div className={DETAILS_STRIP}>
          {ORGANIC_DETAILS.map((key) => (
            <OrganicKpiCard
              key={key}
              valueKey={key}
              aggregate={aggregate}
              comparison={comparison}
              detail
            />
          ))}
        </div>
      </section>
    </div>
  );
}

export function OrganicKpiGridSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-hidden="true" data-testid="organic-kpi-skeleton">
      <div className={HEADLINE_STRIP}>
        {ORGANIC_HEADLINE.map((key) => (
          <div key={key} className={KPI_CELL}>
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-7 w-24" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-2">
        <Skeleton className="h-4 w-32" />
        <div className={DETAILS_STRIP}>
          {ORGANIC_DETAILS.map((key) => (
            <div key={key} className={DETAIL_CELL}>
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-5 w-14" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
