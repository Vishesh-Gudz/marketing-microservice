"use client";

import { formatDateKey } from "@/lib/analytics/chart-data";
import { getDisplayLocale } from "@/lib/analytics/format";
import { useOrg } from "@/lib/analytics/org-context";
import type { Coverage } from "@/lib/analytics/types";

export function formatInstant(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat(getDisplayLocale(), {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  }).format(new Date(iso));
}

/** Data freshness from analytics coverage (D17: read-only; no sync UI). */
export function FreshnessNote({ coverage }: { coverage: Coverage }) {
  const { timezone } = useOrg();
  const through = coverage.accounts
    .map((a) => a.coveredThrough)
    .filter((d): d is string => d !== undefined)
    .sort()
    .at(-1);
  const lastSync = coverage.accounts
    .map((a) => a.lastSyncedAt)
    .filter((d): d is string => d !== undefined)
    .sort()
    .at(-1);
  if (!through && !lastSync) {
    return <p className="text-xs text-muted-foreground">Nothing has been synced yet.</p>;
  }
  return (
    <p className="text-xs text-muted-foreground" data-testid="freshness">
      {through ? `Data through ${formatDateKey(through)}` : ""}
      {through && lastSync ? " · " : ""}
      {lastSync ? `last synced ${formatInstant(lastSync, timezone)} (${timezone})` : ""}
    </p>
  );
}
