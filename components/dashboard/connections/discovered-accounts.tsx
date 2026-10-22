"use client";

import { useMutation } from "convex/react";
import { useRef, useState, type FormEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import type { Connection } from "@/lib/analytics/types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import {
  accountStatusLabel,
  assetLinkability,
  linkBlockMessage,
  managerStatusLabel,
  testAccountLabel,
} from "@/lib/connections/linkability";
import { connectionActionNotice } from "@/lib/connections/messages";
import { PROVIDERS, type AdConnectionProvider } from "@/lib/connections/providers";
import type { Notice } from "@/lib/connections/types";
import { EmptyState } from "../empty-state";
import { ConnectionNotice } from "./connection-notice";

/** Empty discovery, in the provider's words. */
const NO_ACCOUNTS: Readonly<Record<AdConnectionProvider, { title: string; body: string }>> = {
  google_ads: {
    title: "No Google Ads accounts found",
    body: "This Google account cannot access any Google Ads account. Retry discovery, or connect a Google account that has Google Ads access.",
  },
  meta: {
    title: "No Meta ad accounts found",
    body: "This Facebook account cannot access any Meta ad account. Retry discovery, or connect a Facebook account that has access to an ad account.",
  },
};

/** The selection rule shown above the table. */
const LEGEND: Readonly<Record<AdConnectionProvider, string>> = {
  google_ads:
    "Select one client account. Manager accounts and accounts whose type Google did not report cannot be linked.",
  meta: "Select one ad account.",
};

/**
 * Admin-only: the accounts this connection discovered, one radio choice among the accounts
 * the UI may offer (lib/connections/linkability), "Link selected account" and "Retry
 * discovery". The server re-checks every rule and links only discovered accounts; the UI
 * sends exactly one id. Google reports account type and test status; Meta does not, so its
 * table shows the business an account belongs to instead.
 */
export function DiscoveredAccounts({
  provider,
  connection,
}: {
  provider: AdConnectionProvider;
  connection: Connection;
}) {
  const info = PROVIDERS[provider];
  const { data: assets } = useAnalyticsQuery(api.v1.connections.listDiscoveredAssets, {
    connectionId: connection.id,
  });
  const linkAdAccounts = useMutation(api.v1.connections.linkAdAccounts);
  const refreshAssets = useMutation(api.v1.connections.refreshAssets);
  const [choice, setChoice] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const linkInFlight = useRef(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Discovery runs in the background; it is done once the connection changes again.
  const [refreshFrom, setRefreshFrom] = useState<string | null>(null);
  const refreshing = refreshFrom !== null && refreshFrom === connection.updatedAt;
  const active = connection.status === "active";
  const headingId = `${provider}-discovered-accounts`;

  const selected = assets?.find(
    (asset) => asset.externalId === choice && assetLinkability(asset, connection.status).selectable,
  );

  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected === undefined || linkInFlight.current) return;
    linkInFlight.current = true;
    setLinking(true);
    setNotice(null);
    try {
      await linkAdAccounts({ connectionId: connection.id, externalIds: [selected.externalId] });
      setNotice({
        tone: "success",
        title: "Account linked",
        message: `${selected.name} (${info.formatAccountId(selected.externalId)}) is linked. Its first sync starts automatically.`,
      });
      setChoice(null);
    } catch (caught) {
      setNotice(connectionActionNotice(caught, provider));
    } finally {
      linkInFlight.current = false;
      setLinking(false);
    }
  }

  async function retryDiscovery() {
    const before = connection.updatedAt;
    setNotice(null);
    try {
      await refreshAssets({ connectionId: connection.id });
      setRefreshFrom(before);
    } catch (caught) {
      setNotice(connectionActionNotice(caught, provider));
    }
  }

  const retry = (
    <Button
      type="button"
      variant="outline"
      disabled={!active || refreshing}
      onClick={() => void retryDiscovery()}
    >
      Retry discovery
    </Button>
  );

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-semibold">
        Choose the account to sync
      </h3>
      {refreshing && (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing the account list…
        </p>
      )}
      {notice && <ConnectionNotice notice={notice} />}
      {assets === undefined ? (
        <Skeleton
          className="h-32 w-full"
          role="status"
          aria-label={`Loading discovered ${info.name} accounts`}
        />
      ) : assets.length === 0 ? (
        <>
          {connection.lastError === undefined && (
            <EmptyState title={NO_ACCOUNTS[provider].title}>
              {NO_ACCOUNTS[provider].body}
            </EmptyState>
          )}
          <div>{retry}</div>
        </>
      ) : (
        <form onSubmit={(event) => void link(event)} className="flex flex-col gap-3">
          {/* min-w-0: a fieldset is at least as wide as its content by default, which would
              defeat the table's horizontal scroll on narrow screens. */}
          <fieldset className="flex min-w-0 flex-col gap-2">
            <legend className="text-sm text-muted-foreground">{LEGEND[provider]}</legend>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableCaption className="sr-only">Discovered {info.name} accounts</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">
                      <span className="sr-only">Select</span>
                    </TableHead>
                    <TableHead scope="col">Account</TableHead>
                    {info.reportsAccountType && (
                      <>
                        <TableHead scope="col">Type</TableHead>
                        <TableHead scope="col">Test account</TableHead>
                      </>
                    )}
                    <TableHead scope="col">Currency / time zone</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">{info.parentLabel}</TableHead>
                    <TableHead scope="col">Availability</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assets.map((asset) => {
                    const linkability = assetLinkability(asset, connection.status);
                    const inputId = `${provider}-discovered-${asset.externalId}`;
                    const reasonId = `${inputId}-reason`;
                    return (
                      <TableRow key={asset.externalId} data-external-id={asset.externalId}>
                        <TableCell>
                          <input
                            type="radio"
                            id={inputId}
                            name={`${provider}-account`}
                            value={asset.externalId}
                            className="size-4 accent-primary"
                            checked={choice === asset.externalId}
                            disabled={!linkability.selectable || linking}
                            aria-describedby={linkability.selectable ? undefined : reasonId}
                            onChange={() => setChoice(asset.externalId)}
                          />
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          <label htmlFor={inputId} className="flex flex-col">
                            <span className="font-medium">{asset.name}</span>
                            <span className="font-mono text-xs text-muted-foreground">
                              {info.formatAccountId(asset.externalId)}
                            </span>
                          </label>
                        </TableCell>
                        {info.reportsAccountType && (
                          <>
                            <TableCell>{managerStatusLabel(asset.managerStatus)}</TableCell>
                            <TableCell>{testAccountLabel(asset.testAccountStatus).label}</TableCell>
                          </>
                        )}
                        <TableCell>
                          {asset.currency} · {asset.timezone}
                        </TableCell>
                        <TableCell>{accountStatusLabel(asset.status)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {asset.parentExternalId !== undefined
                            ? info.formatAccountId(asset.parentExternalId)
                            : info.noParent}
                        </TableCell>
                        <TableCell className="whitespace-normal">
                          {linkability.selectable ? (
                            <span className="text-muted-foreground">Can be linked</span>
                          ) : linkability.blockedBy === "already_linked" ? (
                            <Badge id={reasonId} variant="secondary">
                              Linked
                            </Badge>
                          ) : (
                            <span id={reasonId} className="text-muted-foreground">
                              {linkBlockMessage(linkability.blockedBy, provider)}
                            </span>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          </fieldset>
          {selected && (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              Selected: {selected.name} ({info.formatAccountId(selected.externalId)}).
              {info.reportsAccountType && ` ${testAccountLabel(selected.testAccountStatus).hint}`}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={selected === undefined || linking}>
              {linking ? "Linking…" : "Link selected account"}
            </Button>
            {retry}
          </div>
        </form>
      )}
    </section>
  );
}
