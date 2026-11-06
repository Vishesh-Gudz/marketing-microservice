"use client";

import { AlertTriangle, CheckCircle2, Info, XCircle } from "lucide-react";
import Link from "next/link";
import { createContext, Fragment, useContext, type ReactNode } from "react";
import { api } from "@/convex/_generated/api";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import type { Connection, Coverage, Fx } from "@/lib/analytics/types";
import { AD_CONNECTION_PROVIDERS, PROVIDERS as AD_PROVIDERS } from "@/lib/connections/providers";
import { cn } from "@/lib/utils";

// Gudz status tones: tinted surface + hairline in the tone, coloured icon, ink text (4.5:1+).
const NOTICE_TONES = {
  info: {
    Icon: Info,
    role: undefined,
    className: "border-line bg-canvas text-ink-2",
    iconClassName: "text-muted-foreground",
  },
  warning: {
    Icon: AlertTriangle,
    role: "status",
    className: "border-amber-line bg-amber-tint text-ink",
    iconClassName: "text-amber",
  },
  success: {
    Icon: CheckCircle2,
    role: "status",
    className: "border-ok-line bg-ok-tint text-ink",
    iconClassName: "text-ok",
  },
  error: {
    Icon: XCircle,
    role: "alert",
    className: "border-danger-line bg-danger-tint text-ink",
    iconClassName: "text-danger",
  },
} as const;

/** Inside a NoticeList, notices drop their own box and render as rows of the list. */
const InNoticeList = createContext(false);

export function Notice({
  tone,
  children,
  label,
}: {
  tone: keyof typeof NOTICE_TONES;
  children: ReactNode;
  label: string;
}) {
  const { Icon, role, className, iconClassName } = NOTICE_TONES[tone];
  const asRow = useContext(InNoticeList);
  return (
    <div
      role={role}
      aria-label={label}
      className={cn(
        "flex items-start text-sm",
        asRow ? "gap-3 px-4 py-3 text-ink" : "gap-2 rounded-[10px] border px-3 py-2",
        !asRow && className,
      )}
    >
      <Icon className={cn("mt-0.5 size-4 shrink-0", iconClassName)} aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}

/** Notices as rows of one list, separated by hairlines (the Overview's attention panel). */
export function NoticeList({ children }: { children: ReactNode }) {
  return (
    <InNoticeList value={true}>
      <div className="divide-y divide-line">{children}</div>
    </InNoticeList>
  );
}

/** Whether CoverageNotice has anything to say about this coverage. */
export function coverageNeedsNotice(coverage: Coverage): boolean {
  return (
    coverage.dataState === "unknown" ||
    coverage.accounts.some((a) => !a.supported || a.daysUncovered > 0)
  );
}

/** Connections whose credentials stopped working (what ReauthBanner reports). */
export function connectionsNeedingReauth(connections: readonly Connection[]): Connection[] {
  return connections.filter((c) => c.status === "needs_reauth");
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
  if (!coverageNeedsNotice(coverage)) return null;
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
  const broken = connectionsNeedingReauth(connections ?? []);
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
