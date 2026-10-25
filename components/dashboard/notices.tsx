"use client";

import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { Coverage, Fx } from "@/lib/analytics/types";
import { AD_CONNECTION_PROVIDERS, PROVIDERS as AD_PROVIDERS } from "@/lib/connections/providers";
import { cn } from "@/lib/utils";

const NOTICE_TONES = {
  info: { Icon: Info, role: undefined, className: "bg-muted/40 text-muted-foreground" },
  warning: {
    Icon: AlertTriangle,
    role: "status",
    className:
      "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100",
  },
  success: {
    Icon: CheckCircle2,
    role: "status",
    className:
      "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100",
  },
  error: {
    Icon: XCircle,
    role: "alert",
    className: "border-destructive/40 bg-destructive/5 text-foreground",
  },
} as const;

export function Notice({
  tone,
  children,
  label,
}: {
  tone: keyof typeof NOTICE_TONES;
  children: ReactNode;
  label: string;
}) {
  const { Icon, role, className } = NOTICE_TONES[tone];
  return (
    <div
      role={role}
      aria-label={label}
      className={cn("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", className)}
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

const PROVIDER_LABEL = {
  meta: "Meta",
  google_ads: "Google Ads",
  instagram: "Instagram",
  youtube: "YouTube",
  whatsapp: "WhatsApp",
} as const;

/**
 * Connections whose credentials stopped working (needs_reauth). Google Ads and Meta Ads are
 * reconnected on the Connections page, WhatsApp on the WhatsApp page (Embedded Signup, ADR
 * 0014); Instagram stays read-only here (D17), and so does YouTube until its Connections section
 * exists (ADR 0016).
 */
export function ReauthBanner() {
  const { data: connections } = useAnalyticsQuery(api.v1.connections.list, {});
  const broken = (connections ?? []).filter((c) => c.status === "needs_reauth");
  if (broken.length === 0) return null;
  const names = broken.map((c) => c.displayName ?? PROVIDER_LABEL[c.provider]).join(", ");
  return (
    <Notice tone="warning" label="Reconnect required">
      {broken.length === 1 ? "A connection needs" : "Some connections need"} to be reconnected (
      {names}). Their accounts stop updating until an admin reconnects them.
      {AD_CONNECTION_PROVIDERS.filter((provider) =>
        broken.some((c) => c.provider === provider),
      ).map((provider) => (
        <Fragment key={provider}>
          {" "}
          <Link href="/connections" className="font-medium underline underline-offset-4">
            Reconnect {AD_PROVIDERS[provider].name}
          </Link>
        </Fragment>
      ))}
      {broken.some((c) => c.provider === "whatsapp") && (
        <>
          {" "}
          <Link href="/whatsapp/settings" className="font-medium underline underline-offset-4">
            Reconnect WhatsApp
          </Link>
        </>
      )}
    </Notice>
  );
}
