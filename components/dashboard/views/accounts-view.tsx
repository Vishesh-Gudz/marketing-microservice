"use client";

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
import { humanize } from "@/lib/analytics/labels";
import { useOrg } from "@/lib/analytics/org-context";
import type { BreakdownArgs, BreakdownGroup, Coverage } from "@/lib/analytics/types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { useAnalyticsScope } from "@/lib/analytics/use-dashboard-filters";
import { VALUES, valueView, type ValueKey } from "@/lib/analytics/values";
import { cn } from "@/lib/utils";
import { EmptyState } from "../empty-state";
import { FilterBar } from "../filter-bar";
import { formatInstant } from "../freshness-note";
import { FxNotice, ReauthBanner } from "../notices";
import { PageHeader } from "../page-header";
import { QueryBoundary } from "../query-boundary";
import { UpdatingIndicator } from "../updating-indicator";
import { ValueText } from "../value-text";

const KPI_COLUMNS: ValueKey[] = ["spend", "impressions", "clicks", "conversions"];

function AccountsTable({ args }: { args: BreakdownArgs }) {
  const org = useOrg();
  const { data: accounts } = useAnalyticsQuery(api.v1.adAccounts.list, {});
  const { data: connections } = useAnalyticsQuery(api.v1.connections.list, {});
  // KPIs and coverage per account for the selected range.
  const { data: breakdown, isUpdating } = useAnalyticsQuery(api.v1.analytics.breakdown, args);
  if (accounts === undefined) {
    return <Skeleton className="h-48 w-full" aria-label="Loading accounts" />;
  }
  const visible = accounts.filter((a) => !a.isManager);
  if (visible.length === 0) {
    return (
      <EmptyState title="No ad accounts yet">
        An admin links ad accounts through a platform connection. In local development, run{" "}
        <code>npm run dev:seed</code>.
      </EmptyState>
    );
  }
  const coverage = new Map<string, Coverage["accounts"][number]>(
    (breakdown?.coverage.accounts ?? []).map((c) => [c.accountId, c]),
  );
  const groups = new Map<string, BreakdownGroup>(
    (breakdown?.groups ?? []).map((g) => [g.accountId ?? g.key, g]),
  );
  const connection = new Map((connections ?? []).map((c) => [c.id, c]));
  return (
    <div className="flex flex-col gap-3">
      <UpdatingIndicator active={isUpdating} />
      {breakdown && <FxNotice fx={breakdown.fx} />}
      <div className={cn("overflow-x-auto rounded-md border", isUpdating && "opacity-60")}>
        <Table>
          <TableCaption className="sr-only">Ad accounts, sync coverage and KPIs</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead scope="col" className="sticky left-0 z-10 bg-background">
                Account
              </TableHead>
              <TableHead scope="col">Platform</TableHead>
              <TableHead scope="col">Currency / time zone</TableHead>
              <TableHead scope="col">Status</TableHead>
              <TableHead scope="col">Synced through</TableHead>
              <TableHead scope="col">Last sync</TableHead>
              <TableHead scope="col" className="text-right">
                Unsynced days
              </TableHead>
              {KPI_COLUMNS.map((key) => (
                <TableHead key={key} scope="col" className="text-right">
                  {VALUES[key].label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((account) => {
              const cov = coverage.get(account.id);
              const group = groups.get(account.id);
              const conn = account.connectionId ? connection.get(account.connectionId) : undefined;
              return (
                <TableRow key={account.id} data-account-id={account.id}>
                  <TableCell className="sticky left-0 z-10 bg-background whitespace-normal">
                    <div className="font-medium">{account.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {account.externalId}
                    </div>
                  </TableCell>
                  <TableCell>{humanize(account.platform)}</TableCell>
                  <TableCell>
                    {account.currency} · {account.timezone}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <span>{humanize(account.status)}</span>
                      {!account.linked ? (
                        <Badge variant="outline">Unlinked</Badge>
                      ) : conn?.status === "needs_reauth" ? (
                        <Badge variant="destructive">Reconnect required</Badge>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {cov?.coveredThrough ? formatDateKey(cov.coveredThrough) : "—"}
                  </TableCell>
                  <TableCell>
                    {cov?.lastSyncedAt ? formatInstant(cov.lastSyncedAt, org.timezone) : "Never"}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {cov === undefined ? "—" : cov.supported ? cov.daysUncovered : "Not supported"}
                  </TableCell>
                  {KPI_COLUMNS.map((key) => (
                    <TableCell key={key} className="text-right">
                      {group ? <ValueText view={valueView(key, group)} /> : "—"}
                    </TableCell>
                  ))}
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** Ad accounts with KPIs, connection health and sync coverage (read-only, D17). */
export function AccountsView() {
  const scope = useAnalyticsScope();
  const args: BreakdownArgs = { by: "account", range: scope.range };
  return (
    <>
      <PageHeader
        title="Accounts"
        description="Ad accounts, connection health, sync coverage and KPIs for the selected range."
      />
      <ReauthBanner />
      <FilterBar accounts={false} compare={false} />
      <QueryBoundary resetKey={JSON.stringify(args)} title="Accounts">
        <AccountsTable args={args} />
      </QueryBoundary>
    </>
  );
}
