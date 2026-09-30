"use client";

import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/analytics/format";
import { humanize } from "@/lib/analytics/labels";
import type { EntitySummary } from "@/lib/analytics/types";
import { PageHeader } from "./page-header";

/** Name and attributes of a campaign / ad group / ad (from overview `entity`, D5). */
export function EntityHeader({ entity }: { entity: EntitySummary }) {
  const facts: [string, string][] = [
    ["Platform", humanize(entity.platform)],
    ["Status", humanize(entity.status)],
    ...(entity.deliveryStatus
      ? ([["Delivery", humanize(entity.deliveryStatus)]] as [string, string][])
      : []),
    ...(entity.objective
      ? ([["Objective", humanize(entity.objective)]] as [string, string][])
      : []),
    ...(entity.channelType
      ? ([["Channel", humanize(entity.channelType)]] as [string, string][])
      : []),
    ...(entity.budget
      ? ([
          [
            "Budget",
            `${formatMoney(entity.budget)}${entity.budgetType && entity.budgetType !== "none" ? ` ${entity.budgetType}` : ""}`,
          ],
        ] as [string, string][])
      : []),
    ["Currency", entity.currency],
  ];
  return (
    <PageHeader
      title={
        <span className="flex flex-wrap items-center gap-2">
          {entity.name}
          {entity.removed && <Badge variant="outline">Removed</Badge>}
        </span>
      }
    >
      <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
        {facts.map(([term, value]) => (
          <div key={term} className="flex gap-1">
            <dt className="text-muted-foreground">{term}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
    </PageHeader>
  );
}
