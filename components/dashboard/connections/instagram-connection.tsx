"use client";

import { useMutation } from "convex/react";
import Link from "next/link";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { useOrg } from "@/lib/analytics/org-context";
import type { SocialAccount } from "@/lib/analytics/organic-types";
import type { Connection } from "@/lib/analytics/types";
import { useAnalyticsQuery } from "@/lib/analytics/use-analytics-query";
import {
  connectionActionNotice,
  connectionStatusNotice,
  discoveryErrorNotice,
} from "@/lib/connections/messages";
import { adConnections, pickConnection } from "@/lib/connections/navigation";
import { PROVIDERS } from "@/lib/connections/providers";
import type { Notice } from "@/lib/connections/types";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { ConnectButton } from "./connect-button";
import { ConnectionNotice } from "./connection-notice";
import { DisconnectButton } from "./disconnect-button";

const PAGE = { paginationOpts: { numItems: 100, cursor: null } };
const MESSAGES_SETTINGS_HREF = "/instagram/messages/settings";

/** What disconnecting Instagram does (ADR 0017: D14 retention; no platform revoke). */
export const INSTAGRAM_DISCONNECT_CONSEQUENCES: readonly string[] = [
  "Direct messages for the linked Instagram account stop at once.",
  "Its stored conversations and messages are deleted after 30 days.",
  "This service's stored access is deleted. To remove the app on Meta's side too, remove it in Meta Business Settings > Integrations > Connected apps.",
  "Afterwards, connect again to start fresh.",
];

const LINKED_NOTICE: Notice = {
  tone: "success",
  title: "Account linked",
  message: "Turn on direct messages for it in the Instagram messages settings.",
};

function accountLabel(account: { username?: string; externalId: string }): string {
  return account.username !== undefined ? `@${account.username}` : "Instagram account";
}

/** Admin-only: the account this connection discovered, and "Link account". */
function DiscoveredAccount({ connection }: { connection: Connection }) {
  const { data: discovered } = useAnalyticsQuery(api.v1.connections.listDiscoveredSocialAccounts, {
    connectionId: connection.id,
  });
  const linkSocialAccounts = useMutation(api.v1.connections.linkSocialAccounts);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [linking, setLinking] = useState(false);
  const inFlight = useRef(false);
  const headingId = "instagram-discovered-account";

  async function link(externalId: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setLinking(true);
    setNotice(null);
    try {
      await linkSocialAccounts({ connectionId: connection.id, externalIds: [externalId] });
      setNotice(LINKED_NOTICE);
    } catch (caught) {
      setNotice(connectionActionNotice(caught, "instagram"));
    } finally {
      inFlight.current = false;
      setLinking(false);
    }
  }

  const accounts = discovered?.filter((row) => row.platform === "instagram");
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-semibold">
        Account to link
      </h3>
      {notice && <ConnectionNotice notice={notice} />}
      {accounts === undefined ? (
        <Skeleton
          className="h-16 w-full"
          role="status"
          aria-label="Loading the Instagram account"
        />
      ) : accounts.length === 0 ? (
        connection.lastError === undefined && (
          <EmptyState title="No Instagram account found">
            This connection found no Instagram account. Reconnect Instagram and choose the account
            when Meta asks.
          </EmptyState>
        )
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => (
            <li
              key={account.externalId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              data-external-id={account.externalId}
            >
              <div className="flex flex-col">
                <span className="font-medium">{accountLabel(account)}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {account.externalId}
                </span>
              </div>
              {account.linked ? (
                <Badge variant="secondary">Linked</Badge>
              ) : (
                <Button
                  type="button"
                  disabled={linking || connection.status !== "active"}
                  onClick={() => void link(account.externalId)}
                  aria-label={`Link Instagram account ${account.externalId}`}
                >
                  {linking ? "Linking…" : "Link account"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The connection's linked account, with the way to its direct messages (every role). */
function LinkedAccounts({ accounts }: { accounts: readonly SocialAccount[] }) {
  const headingId = "instagram-linked-account";
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-semibold">
        Linked account
      </h3>
      {accounts.length === 0 ? (
        <EmptyState title="No Instagram account linked yet">
          Connect Instagram and link its account to receive direct messages.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              data-account-id={account.id}
            >
              <div className="flex flex-col gap-0.5 text-sm">
                <span className="font-medium">{accountLabel(account)}</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {account.externalId}
                </span>
              </div>
              <Link
                href={MESSAGES_SETTINGS_HREF}
                className="text-sm font-medium underline underline-offset-4"
                aria-label={`Direct messages settings for ${accountLabel(account)}`}
              >
                Direct messages settings
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Instagram for direct messages (ADR 0017): the connection's status (every role), Connect /
 * Reconnect / Disconnect and the account to link (admins; the server enforces the role), and
 * the linked account with the way to turn its direct messages on. The connect goes through
 * the backend's Instagram setup (Unified Login on new Meta apps). No credential, token or
 * permission string is shown.
 */
export function InstagramConnection({
  preferredConnectionId,
}: {
  /** The connection the OAuth callback just reported, shown first if it is an Instagram one. */
  preferredConnectionId: string | undefined;
}) {
  const org = useOrg();
  const isAdmin = org.role === "admin";
  const info = PROVIDERS.instagram;
  const { data: connections } = useAnalyticsQuery(api.v1.connections.list, {});
  const { data: accounts } = useAnalyticsQuery(api.v1.socialAccounts.list, PAGE);
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);

  if (connections === undefined || accounts === undefined) {
    return (
      <Skeleton
        className="h-24 w-full"
        role="status"
        aria-label="Loading the Instagram connection"
      />
    );
  }
  const candidates = adConnections(connections, "instagram");
  const connection = pickConnection(candidates, chosenId ?? preferredConnectionId);
  const linked =
    connection === undefined
      ? []
      : accounts.page.filter(
          (a) =>
            a.platform === "instagram" &&
            a.connectionId === connection.id &&
            a.status !== "disconnected",
        );
  const discoveryError =
    connection?.status === "active"
      ? discoveryErrorNotice(connection.lastError, "instagram")
      : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        {connection === undefined ? (
          <p className="text-sm">{info.name} is not connected.</p>
        ) : (
          <>
            <ConnectionNotice notice={connectionStatusNotice(connection, "instagram")} />
            <p className="text-sm text-muted-foreground">
              Connected {formatInstant(connection.connectedAt, org.timezone)}.
            </p>
            {discoveryError && <ConnectionNotice notice={discoveryError} />}
          </>
        )}
        {isAdmin ? (
          <div className="flex flex-wrap items-start gap-2">
            <ConnectButton provider="instagram" connection={connection} />
            {connection !== undefined && (
              <DisconnectButton
                key={connection.id}
                provider="instagram"
                connection={connection}
                consequences={INSTAGRAM_DISCONNECT_CONSEQUENCES}
                onDisconnected={() => setChosenId(undefined)}
              />
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only organization admins can connect or disconnect Instagram.
          </p>
        )}
      </div>
      {connection !== undefined && isAdmin && (
        <DiscoveredAccount key={connection.id} connection={connection} />
      )}
      {connection !== undefined && <LinkedAccounts accounts={linked} />}
    </div>
  );
}
