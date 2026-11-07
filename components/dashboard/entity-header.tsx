"use client";

import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/analytics/format";
import { humanize } from "@/lib/analytics/labels";
import type { EntitySummary } from "@/lib/analytics/types";
import { PageHeader } from "./page-header";
import { PlatformName } from "./platform-name";

/** Name and attributes of a campaign / ad group / ad (from overview `entity`, D5). */
export function EntityHeader({ entity }: { entity: EntitySummary }) {
  const facts: [string, ReactNode][] = [
    ["Platform", <PlatformName key="platform" platform={entity.platform} />],
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
      <dl className="mt-2 flex flex-wrap gap-1.5 text-xs">
        {facts.map(([term, value]) => (
          <div
            key={term}
            className="flex items-center gap-1 rounded-full border border-line bg-paper px-2.5 py-1"
          >
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="font-medium text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </PageHeader>
  );
}
