"use client";

import { AlertTriangle, Info } from "lucide-react";
import type { ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { Coverage, Fx } from "@/lib/analytics/types";
import { cn } from "@/lib/utils";

function Notice({
  tone,
  children,
  label,
}: {
  tone: "info" | "warning";
  children: ReactNode;
  label: string;
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

/** Reporting-currency conversion status (D11). */
export function FxNotice({ fx }: { fx: Fx }) {
  if (fx.status === "not_needed") return null;
  if (fx.status === "complete") {
    return (
      <Notice tone="info" label="Currency conversion">
        Amounts in other currencies are converted to {fx.reportingCurrency} with daily exchange
        rates.
      </Notice>
    );
  }
  const missing = (fx.missing ?? [])
    .map((m) => `${m.currency} (${m.days} ${m.days === 1 ? "day" : "days"})`)
    .join(", ");
  return (
    <Notice tone="warning" label="Currency conversion incomplete">
      Some amounts cannot be converted to {fx.reportingCurrency}
      {missing ? `: exchange rates are missing for ${missing}` : ""}. Those totals are shown per
      currency and are never added together.
    </Notice>
  );
}

/** Sync coverage of the range (D10), from the API's coverage section. */
export function CoverageNotice({ coverage }: { coverage: Coverage }) {
  const uncovered = coverage.accounts.filter((a) => a.supported && a.daysUncovered > 0);
  const days = uncovered.reduce((sum, a) => sum + a.daysUncovered, 0);
  const unsupported = coverage.accounts.filter((a) => !a.supported).length;
  if (coverage.dataState === "unknown") {
    return (
      <Notice tone="warning" label="Data not synced">
        No data synced for this period yet. Values appear once the accounts finish syncing.
      </Notice>
    );
  }
  if (uncovered.length === 0 && unsupported === 0) return null;
  return (
    <Notice tone="warning" label="Partial data">
      {uncovered.length > 0 && (
        <>
          Partial: {days} {days === 1 ? "day" : "days"} not yet synced
          {uncovered.length > 1 ? ` across ${uncovered.length} accounts` : ""}; values marked *
          cover the synced days only.{" "}
        </>
      )}
      {unsupported > 0 && (
        <>
          {unsupported} {unsupported === 1 ? "account does" : "accounts do"} not report this view.
        </>
      )}
    </Notice>
  );
}

const PROVIDER_LABEL = { meta: "Meta", google_ads: "Google Ads" } as const;

/** Connections whose credentials stopped working (needs_reauth; read-only, D17). */
export function ReauthBanner() {
  const { data: connections } = useAnalyticsQuery(api.v1.connections.list, {});
  const broken = (connections ?? []).filter((c) => c.status === "needs_reauth");
  if (broken.length === 0) return null;
  const names = broken.map((c) => c.displayName ?? PROVIDER_LABEL[c.provider]).join(", ");
  return (
    <Notice tone="warning" label="Reconnect required">
      {broken.length === 1 ? "A connection needs" : "Some connections need"} to be reconnected (
      {names}). Their accounts stop updating until an admin reconnects them.
    </Notice>
  );
}
