"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { api } from "@/convex/_generated/api";
import { formatDateKey } from "@/lib/analytics/chart-data";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { formatCustomerId } from "@/lib/connections/customer-id";
import { syncStatusSummary } from "@/lib/connections/messages";
import { accountAnalyticsHref } from "@/lib/connections/navigation";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";

const SUMMARY_BADGE = {
  success: "secondary",
  info: "outline",
  warning: "outline",
  error: "destructive",
} as const;

/** Linked Google Ads accounts with their read-only sync status (every role). */
export function LinkedAccounts() {
  const { timezone } = useOrg();
  const searchParams = useSearchParams();
  const { data: accounts } = useAnalyticsQuery(api.v1.adAccounts.list, {});

  if (accounts === undefined) {
    return <Skeleton className="h-24 w-full" aria-label="Loading linked accounts" />;
  }
  const linked = accounts.filter((a) => a.platform === "google_ads" && a.linked && !a.isManager);

  return (
    <section aria-labelledby="linked-accounts" className="flex flex-col gap-3">
      <h3 id="linked-accounts" className="text-base font-semibold">
        Linked accounts
      </h3>
      {linked.length === 0 ? (
        <EmptyState title="No Google Ads account linked yet">
          Connect Google Ads and link an account to start syncing.
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableCaption className="sr-only">
              Linked Google Ads accounts and sync status
            </TableCaption>
            <TableHeader>
              <TableRow>
                <TableHead scope="col">Account</TableHead>
                <TableHead scope="col">Sync status</TableHead>
                <TableHead scope="col">Data coverage</TableHead>
                <TableHead scope="col">Last successful sync</TableHead>
                <TableHead scope="col">Next sync</TableHead>
                <TableHead scope="col">
                  <span className="sr-only">Analytics</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {linked.map((account) => {
                const summary = syncStatusSummary(account.sync);
                const sync = account.sync;
                return (
                  <TableRow key={account.id} data-account-id={account.id}>
                    <TableCell className="whitespace-normal">
                      <div className="font-medium">{account.name}</div>
                      <div className="font-mono text-xs text-muted-foreground">
                        {formatCustomerId(account.externalId)}
                      </div>
                    </TableCell>
                    <TableCell className="whitespace-normal">
                      <Badge variant={SUMMARY_BADGE[summary.tone]}>{summary.label}</Badge>
                      {summary.detail && (
                        <p className="mt-1 text-xs text-muted-foreground">{summary.detail}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      {sync?.coveredFrom && sync.coveredThrough
                        ? `${formatDateKey(sync.coveredFrom)} – ${formatDateKey(sync.coveredThrough)}`
                        : "—"}
                    </TableCell>
                    <TableCell>
                      {sync?.lastSuccessAt ? formatInstant(sync.lastSuccessAt, timezone) : "Never"}
                    </TableCell>
                    <TableCell>
                      {sync?.nextRunAt ? formatInstant(sync.nextRunAt, timezone) : "—"}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={accountAnalyticsHref(account.id, searchParams)}
                        className="text-sm font-medium underline underline-offset-4"
                        aria-label={`View analytics for ${account.name}`}
                      >
                        View analytics
                      </Link>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
