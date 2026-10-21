"use client";

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import {
  connectionStatusNotice,
  disconnectedNotice,
  discoveryErrorNotice,
} from "@/lib/connections/messages";
import { adConnections, pickConnection } from "@/lib/connections/navigation";
import { PROVIDERS, type AdConnectionProvider } from "@/lib/connections/providers";
import type { Notice } from "@/lib/connections/types";
import { formatInstant } from "../freshness-note";
import { ConnectButton } from "./connect-button";
import { ConnectionNotice } from "./connection-notice";
import { DisconnectButton } from "./disconnect-button";
import { DiscoveredAccounts } from "./discovered-accounts";
import { LinkedAccounts } from "./linked-accounts";

/**
 * One ad platform's connection (Google Ads or Meta Ads): status (every role), Connect /
 * Reconnect / Disconnect and account choice (admins; the server enforces the role), and the
 * linked accounts' sync status (every role). Only this provider's connections and accounts
 * are shown, in this provider's words.
 */
export function AdConnection({
  provider,
  preferredConnectionId,
}: {
  provider: AdConnectionProvider;
  /** The connection the OAuth callback just reported, shown first if it is one of this provider's. */
  preferredConnectionId: string | undefined;
}) {
  const org = useOrg();
  const isAdmin = org.role === "admin";
  const info = PROVIDERS[provider];
  const { data: connections } = useAnalyticsQuery(api.v1.connections.list, {});
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const [disconnected, setDisconnected] = useState<Notice | null>(null);

  if (connections === undefined) {
    return <Skeleton className="h-24 w-full" aria-label={`Loading the ${info.name} connection`} />;
  }
  const candidates = adConnections(connections, provider);
  const connection = pickConnection(candidates, chosenId ?? preferredConnectionId);
  const discoveryError =
    connection?.status === "active" ? discoveryErrorNotice(connection.lastError, provider) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        {disconnected && <ConnectionNotice notice={disconnected} />}
        {connection === undefined ? (
          <p className="text-sm">{info.name} is not connected.</p>
        ) : (
          <>
            <ConnectionNotice notice={connectionStatusNotice(connection, provider)} />
            {candidates.length > 1 && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{info.platform} connection</span>
                <select
                  className="h-9 w-fit max-w-full rounded-md border bg-background px-2"
                  value={connection.id}
                  onChange={(event) => setChosenId(event.target.value)}
                >
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {(c.displayName ?? info.identity) +
                        ` · connected ${formatInstant(c.connectedAt, org.timezone)}` +
                        (c.status === "active" ? "" : " · reconnect required")}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <p className="text-sm text-muted-foreground">
              Connected {formatInstant(connection.connectedAt, org.timezone)}.
            </p>
            {discoveryError && <ConnectionNotice notice={discoveryError} />}
          </>
        )}
        {isAdmin ? (
          <div className="flex flex-wrap items-start gap-2">
            <ConnectButton provider={provider} connection={connection} />
            {connection !== undefined && (
              <DisconnectButton
                key={connection.id}
                provider={provider}
                connection={connection}
                onDisconnected={() => {
                  setChosenId(undefined);
                  setDisconnected(disconnectedNotice(provider));
                }}
              />
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only organization admins can connect {info.name} or choose the account to sync.
          </p>
        )}
      </div>
      {connection !== undefined && isAdmin && (
        <DiscoveredAccounts key={connection.id} provider={provider} connection={connection} />
      )}
      <LinkedAccounts provider={provider} />
    </div>
  );
}
