"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import { DeltaChip } from "../delta-chip";
import { formatInstant } from "../freshness-note";
import { ValueText } from "../value-text";

/**
 * One organic KPI card: the API's value (or "—" with the API's reason, never 0), the
 * comparison delta the API provides (additive metrics and the engagement rate only), and for
 * followers the capture time ("as of"): followers is a snapshot, not an end-of-day value.
 */
export function OrganicKpiCard({
  valueKey,
  aggregate,
  comparison,
}: {
  valueKey: OrganicValueKey;
  aggregate: OrganicAggregate;
  comparison?: OrganicComparison;
}) {
  const { timezone } = useOrg();
  const view = organicValueView(valueKey, aggregate);
  const delta =
    comparison !== undefined && valueKey in comparison.deltas
      ? comparison.deltas[valueKey as keyof OrganicComparison["deltas"]]
      : undefined;
  const capturedAt = valueKey === "followers" ? aggregate.metrics.followersCapturedAt : undefined;
  return (
    <Card className="gap-2 py-4" data-kpi={valueKey}>
      <CardHeader className="px-4">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          <h3>{organicLabel(valueKey)}</h3>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1 px-4">
        <ValueText view={view} className="text-2xl font-semibold" />
        {capturedAt !== undefined && view.kind === "value" && (
          <p className="text-xs text-muted-foreground">
            as of {formatInstant(capturedAt, timezone)}
          </p>
        )}
        {delta !== undefined && <DeltaChip metric={valueKey} delta={delta} />}
      </CardContent>
    </Card>
  );
}

/** Headline organic KPIs plus the "Engagement details" row (N9). */
export function OrganicKpiGrid({
  aggregate,
  comparison,
}: {
  aggregate: OrganicAggregate;
  comparison?: OrganicComparison;
}) {
  return (
    <section aria-label="Key metrics" className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {ORGANIC_HEADLINE.map((key) => (
          <OrganicKpiCard key={key} valueKey={key} aggregate={aggregate} comparison={comparison} />
        ))}
      </div>
      <section aria-labelledby="engagement-details" className="flex flex-col gap-2">
        <h2 id="engagement-details" className="text-sm font-medium text-muted-foreground">
          Engagement details
        </h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
          {ORGANIC_DETAILS.map((key) => (
            <OrganicKpiCard
              key={key}
              valueKey={key}
              aggregate={aggregate}
              comparison={comparison}
            />
          ))}
        </div>
      </section>
    </section>
  );
}

export function OrganicKpiGridSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-hidden="true" data-testid="organic-kpi-skeleton">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {ORGANIC_HEADLINE.map((key) => (
          <Skeleton key={key} className="h-24 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
        {ORGANIC_DETAILS.map((key) => (
          <Skeleton key={key} className="h-20 rounded-xl" />
        ))}
      </div>
    </div>
  );
}
