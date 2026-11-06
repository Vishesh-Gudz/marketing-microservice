"use client";

import type { ReactNode } from "react";
import { formatDateKey } from "@/lib/analytics/chart-data";
import { useOrg } from "@/lib/analytics/org-context";
import type { OrganicCoverage, SocialAccount } from "@/lib/analytics/organic-types";
import { formatInstant } from "../freshness-note";
import { Notice } from "../notices";

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
  // Same tones, roles and labels as the shared Notice.
  return (
    <Notice tone={tone} label={label}>
      {children}
    </Notice>
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
