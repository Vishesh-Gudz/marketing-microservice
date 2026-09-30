"use client";

import { AlertTriangle, Info } from "lucide-react";
import type { ReactNode } from "react";
import { formatDateKey } from "@/lib/analytics/chart-data";
import { useOrg } from "@/lib/analytics/org-context";
import type { OrganicCoverage, SocialAccount } from "@/lib/analytics/organic-types";
import { cn } from "@/lib/utils";
import { formatInstant } from "../freshness-note";

/**
 * Organic data freshness and coverage, straight from the API (the dashboard computes no
 * coverage): the account's covered UTC days and last successful sync (v1/socialAccounts:get),
 * and the range's synced/unsynced UTC days (v1/organicAnalytics:overview).
 */

function OrganicNotice({
  tone,
  label,
  children,
}: {
  tone: "info" | "warning";
  label: string;
  children: ReactNode;
}) {
  const Icon = tone === "warning" ? AlertTriangle : Info;
  return (
    <div
      role={tone === "warning" ? "status" : undefined}
      aria-label={label}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        tone === "warning"
          ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100"
          : "bg-muted/40 text-muted-foreground",
      )}
    >
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

/** "Account metrics synced through … (UTC) · last synced …" or the first-sync notice. */
export function OrganicFreshness({ account }: { account: SocialAccount }) {
  const { timezone } = useOrg();
  if (account.lastSyncedAt === undefined && account.coverage === undefined) {
    return (
      <OrganicNotice tone="info" label="History loading">
        History loading: the first sync of this account has not finished yet. Values appear once it
        completes.
      </OrganicNotice>
    );
  }
  return (
    <p className="text-xs text-muted-foreground" data-testid="organic-freshness">
      {account.coverage
        ? `Account metrics synced through ${formatDateKey(account.coverage.through)} (UTC)`
        : ""}
      {account.coverage && account.lastSyncedAt ? " · " : ""}
      {account.lastSyncedAt
        ? `last synced ${formatInstant(account.lastSyncedAt, timezone)} (${timezone})`
        : ""}
    </p>
  );
}

/** Coverage of the selected UTC range (partial / unknown / unsupported), from the API. */
export function OrganicCoverageNotice({ coverage }: { coverage: OrganicCoverage }) {
  if (coverage.dataState === "unknown") {
    return (
      <OrganicNotice tone="warning" label="Data not synced">
        No account data synced for this period yet. Values appear once the account finishes syncing;
        missing values are never shown as zero.
      </OrganicNotice>
    );
  }
  if (coverage.dataState === "unsupported") {
    return (
      <OrganicNotice tone="info" label="Not supported">
        Account metrics are not supported for this account.
      </OrganicNotice>
    );
  }
  // The dashboard shows one account: its API counts are displayed as they are.
  const account = coverage.accounts[0];
  if (coverage.dataState !== "partial" || account === undefined || account.unsyncedDays === 0) {
    return null;
  }
  return (
    <OrganicNotice tone="warning" label="Partial data">
      Partial: {account.unsyncedDays} UTC {account.unsyncedDays === 1 ? "day" : "days"} of this
      range not synced yet ({account.syncedDays} synced); values marked * cover the synced days
      only.
    </OrganicNotice>
  );
}
