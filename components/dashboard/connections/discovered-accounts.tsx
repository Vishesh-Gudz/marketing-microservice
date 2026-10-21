"use client";

import { useMutation } from "convex/react";
import { useState, type FormEvent } from "react";
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
import { formatCustomerId } from "@/lib/connections/customer-id";
import {
  accountStatusLabel,
  assetLinkability,
  linkBlockMessage,
  managerStatusLabel,
  testAccountLabel,
} from "@/lib/connections/linkability";
import { connectionActionNotice } from "@/lib/connections/messages";
import type { Notice } from "@/lib/connections/types";
import { EmptyState } from "../empty-state";
import { ConnectionNotice } from "./connection-notice";

/**
 * Admin-only: the accounts this connection discovered, one radio choice among the accounts
 * the UI may offer (lib/connections/linkability), "Link selected account" and "Retry
 * discovery". The server re-checks every rule and links only discovered accounts; the UI
 * sends exactly one id.
 */
export function DiscoveredAccounts({ connection }: { connection: Connection }) {
  const { data: assets } = useAnalyticsQuery(api.v1.connections.listDiscoveredAssets, {
    connectionId: connection.id,
  });
  const linkAdAccounts = useMutation(api.v1.connections.linkAdAccounts);
  const refreshAssets = useMutation(api.v1.connections.refreshAssets);
  const [choice, setChoice] = useState<string | null>(null);
  const [linking, setLinking] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  // Discovery runs in the background; it is done once the connection changes again.
  const [refreshFrom, setRefreshFrom] = useState<string | null>(null);
  const refreshing = refreshFrom !== null && refreshFrom === connection.updatedAt;
  const active = connection.status === "active";

  const selected = assets?.find(
    (asset) => asset.externalId === choice && assetLinkability(asset, connection.status).selectable,
  );

  async function link(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selected === undefined) return;
    setLinking(true);
    setNotice(null);
    try {
      await linkAdAccounts({ connectionId: connection.id, externalIds: [selected.externalId] });
      setNotice({
        tone: "success",
        title: "Account linked",
        message: `${selected.name} (${formatCustomerId(selected.externalId)}) is linked. Its first sync starts automatically.`,
      });
      setChoice(null);
    } catch (caught) {
      setNotice(connectionActionNotice(caught));
    } finally {
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
      setNotice(connectionActionNotice(caught));
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
    <section aria-labelledby="discovered-accounts" className="flex flex-col gap-3">
      <h3 id="discovered-accounts" className="text-base font-semibold">
        Choose the account to sync
      </h3>
      {refreshing && (
        <p role="status" className="text-sm text-muted-foreground">
          Refreshing the account list…
        </p>
      )}
      {notice && <ConnectionNotice notice={notice} />}
      {assets === undefined ? (
        <Skeleton className="h-32 w-full" aria-label="Loading discovered accounts" />
      ) : assets.length === 0 ? (
        <>
          {connection.lastError === undefined && (
            <EmptyState title="No Google Ads accounts found">
              This Google account cannot access any Google Ads account. Retry discovery, or connect
              a Google account that has Google Ads access.
            </EmptyState>
          )}
          <div>{retry}</div>
        </>
      ) : (
        <form onSubmit={(event) => void link(event)} className="flex flex-col gap-3">
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm text-muted-foreground">
              Select one client account. Manager accounts and accounts whose type Google did not
              report cannot be linked.
            </legend>
            <div className="overflow-x-auto rounded-md border">
              <Table>
                <TableCaption className="sr-only">Discovered Google Ads accounts</TableCaption>
                <TableHeader>
                  <TableRow>
                    <TableHead scope="col">
                      <span className="sr-only">Select</span>
                    </TableHead>
                    <TableHead scope="col">Account</TableHead>
                    <TableHead scope="col">Type</TableHead>
                    <TableHead scope="col">Test account</TableHead>
                    <TableHead scope="col">Currency / time zone</TableHead>
                    <TableHead scope="col">Status</TableHead>
                    <TableHead scope="col">Manager</TableHead>
                    <TableHead scope="col">Availability</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {assets.map((asset) => {
                    const linkability = assetLinkability(asset, connection.status);
                    const inputId = `discovered-${asset.externalId}`;
                    const reasonId = `${inputId}-reason`;
                    return (
                      <TableRow key={asset.externalId} data-external-id={asset.externalId}>
                        <TableCell>
                          <input
                            type="radio"
                            id={inputId}
                            name="google-ads-account"
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
                              {formatCustomerId(asset.externalId)}
                            </span>
                          </label>
                        </TableCell>
                        <TableCell>{managerStatusLabel(asset.managerStatus)}</TableCell>
                        <TableCell>{testAccountLabel(asset.testAccountStatus).label}</TableCell>
                        <TableCell>
                          {asset.currency} · {asset.timezone}
                        </TableCell>
                        <TableCell>{accountStatusLabel(asset.status)}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {asset.parentExternalId !== undefined
                            ? formatCustomerId(asset.parentExternalId)
                            : "Direct access"}
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
                              {linkBlockMessage(linkability.blockedBy)}
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
              Selected: {selected.name} ({formatCustomerId(selected.externalId)}).{" "}
              {testAccountLabel(selected.testAccountStatus).hint}
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
