"use client";

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import { connectionStatusNotice, discoveryErrorNotice } from "@/lib/connections/messages";
import { googleAdsConnections, pickConnection } from "@/lib/connections/navigation";
import { formatInstant } from "../freshness-note";
import { ConnectButton } from "./connect-button";
import { ConnectionNotice } from "./connection-notice";
import { DiscoveredAccounts } from "./discovered-accounts";
import { LinkedAccounts } from "./linked-accounts";

/**
 * The Google Ads connection: status (every role), Connect / Reconnect and account choice
 * (admins; the server enforces the role), and the linked accounts' sync status (every role).
 */
export function GoogleAdsConnection({
  preferredConnectionId,
}: {
  /** The connection the OAuth callback just reported, shown first if it is a Google one. */
  preferredConnectionId: string | undefined;
}) {
  const org = useOrg();
  const isAdmin = org.role === "admin";
  const { data: connections } = useAnalyticsQuery(api.v1.connections.list, {});
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);

  if (connections === undefined) {
    return <Skeleton className="h-24 w-full" aria-label="Loading the Google Ads connection" />;
  }
  const candidates = googleAdsConnections(connections);
  const connection = pickConnection(candidates, chosenId ?? preferredConnectionId);
  const discoveryError =
    connection?.status === "active" ? discoveryErrorNotice(connection.lastError) : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        {connection === undefined ? (
          <p className="text-sm">Google Ads is not connected.</p>
        ) : (
          <>
            <ConnectionNotice notice={connectionStatusNotice(connection)} />
            {candidates.length > 1 && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">Google connection</span>
                <select
                  className="h-9 w-fit rounded-md border bg-background px-2"
                  value={connection.id}
                  onChange={(event) => setChosenId(event.target.value)}
                >
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {(c.displayName ?? "Google account") +
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
          <ConnectButton connection={connection} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Only organization admins can connect Google Ads or choose the account to sync.
          </p>
        )}
      </div>
      {connection !== undefined && isAdmin && (
        <DiscoveredAccounts key={connection.id} connection={connection} />
      )}
      <LinkedAccounts />
    </div>
  );
}
