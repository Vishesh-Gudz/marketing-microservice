"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { formatDateKey } from "@/lib/analytics/chart-data";
import { useOrg } from "@/lib/analytics/org-context";
import type { OrganicCoverage, SocialAccount } from "@/lib/analytics/organic-types";
import { formatInstant } from "../freshness-note";
import { Notice } from "../notices";

/**
 * Organic data freshness and coverage, straight from the API (the dashboard computes no
 * coverage): the account's covered UTC days and last successful sync (v1/socialAccounts:get),
 * the range's synced/unsynced UTC days (v1/organicAnalytics:overview), and (O2) why an account
 * is never synced (v1/socialAccounts `organicSync`).
 */

/** O2: the account's organic data cannot sync (v1/socialAccounts `organicSync`). */
export function organicSyncBlocked(account: Pick<SocialAccount, "organicSync"> | undefined) {
  return account?.organicSync === "insights_permission_missing";
}

/**
 * O2: an Instagram connection made through Meta's Unified Login without
 * instagram_manage_insights: nothing will sync until it is reconnected with that permission, so
 * this replaces the history-loading line and the empty key metrics, chart and posts. Admins get
 * the way to Connections; other roles are told who can fix it.
 */
export function InsightsPermissionNotice() {
  const { role } = useOrg();
  return (
    <div data-testid="insights-permission-notice">
      <Notice tone="warning" label="Instagram analytics need one more permission">
        <h2 className="font-medium">Instagram analytics need one more permission</h2>
        <p className="mt-1">
          Add instagram_manage_insights to the Meta login configuration, then reconnect Instagram on
          Connections. Direct messages keep working meanwhile.
        </p>
        {role === "admin" ? (
          <Button asChild size="sm" variant="outline" className="mt-3">
            <Link href="/connections">Open Connections</Link>
          </Button>
        ) : (
          <p className="mt-1">Ask an admin to reconnect Instagram.</p>
        )}
      </Notice>
    </div>
  );
}

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
