"use client";

import { spendShares } from "@/lib/analytics/chart-data";
import { formatPercent } from "@/lib/analytics/format";
import type { Aggregate } from "@/lib/analytics/types";
import { valueView } from "@/lib/analytics/values";
import { DataStateBadge } from "./data-state-badge";
import { ValueText } from "./value-text";

export type ShareItem = { key: string; label: string; aggregate: Aggregate };

/**
 * Horizontal bar chart of spend share (D6): exact spend text per group, with
 * bars only when all amounts are in one currency. The bars are decorative;
 * the share is also written out.
 */
export function SpendShare({
  items,
  reportingCurrency,
  title,
}: {
  items: readonly ShareItem[];
  reportingCurrency: string;
  title: string;
}) {
  const shares = spendShares(
    items.map((i) => i.aggregate.metrics.spend),
    reportingCurrency,
  );
  return (
    <figure className="flex flex-col gap-2" aria-label={title}>
      <ul className="flex flex-col gap-2">
        {items.map((item, i) => {
          const share = shares.available ? shares.shares[i] : null;
          return (
            <li key={item.key} className="grid gap-1" data-share-key={item.key}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="flex items-center gap-2 font-medium">
                  {item.label}
                  <DataStateBadge state={item.aggregate.dataState} />
                </span>
                <span className="flex items-center gap-2">
                  <ValueText view={valueView("spend", item.aggregate)} />
                  {share != null && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {formatPercent(share, undefined, 0)}
                    </span>
                  )}
                </span>
              </div>
              {shares.available && (
                <div className="h-2 rounded-full bg-muted" aria-hidden="true">
                  <div
                    className="h-2 rounded-full bg-[var(--chart-1)]"
                    style={{ width: `${Math.round((share ?? 0) * 100)}%` }}
                  />
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!shares.available && shares.reason === "mixed_currency" && (
        <figcaption className="text-xs text-muted-foreground">
          Shares are not shown: the amounts are in different currencies and cannot be combined.
        </figcaption>
      )}
    </figure>
  );
}
