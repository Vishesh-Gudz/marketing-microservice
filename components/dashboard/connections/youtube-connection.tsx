"use client";

import { useMutation } from "convex/react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/convex/_generated/api";
import { formatDateKey } from "@/lib/analytics/chart-data";
import { filterParamsOnly } from "@/lib/analytics/filters";
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
import {
  YOUTUBE_DISCONNECT_CONSEQUENCES,
  YOUTUBE_LINKED_NOTICE,
  youtubeDeletionNotice,
  youtubeOtherDeletionNotice,
  type YouTubeDeletion,
} from "@/lib/connections/youtube";
import { EmptyState } from "../empty-state";
import { formatInstant } from "../freshness-note";
import { ConnectButton } from "./connect-button";
import { ConnectionNotice } from "./connection-notice";
import { DisconnectButton } from "./disconnect-button";

const PAGE = { paginationOpts: { numItems: 100, cursor: null } };

/** /social's YouTube view of one channel, keeping the dashboard filters. */
function channelAnalyticsHref(channelId: string, current: URLSearchParams): string {
  const params = filterParamsOnly(current);
  params.set("platform", "youtube");
  params.set("account", channelId);
  return `/social?${params.toString()}`;
}

/** Admin-only: the channel this connection discovered, and "Link channel". */
function DiscoveredChannel({ connection }: { connection: Connection }) {
  const { data: discovered } = useAnalyticsQuery(api.v1.connections.listDiscoveredSocialAccounts, {
    connectionId: connection.id,
  });
  const linkSocialAccounts = useMutation(api.v1.connections.linkSocialAccounts);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [linking, setLinking] = useState(false);
  const inFlight = useRef(false);
  const headingId = "youtube-discovered-channel";

  async function link(externalId: string) {
    if (inFlight.current) return;
    inFlight.current = true;
    setLinking(true);
    setNotice(null);
    try {
      await linkSocialAccounts({ connectionId: connection.id, externalIds: [externalId] });
      setNotice(YOUTUBE_LINKED_NOTICE);
    } catch (caught) {
      setNotice(connectionActionNotice(caught, "youtube"));
    } finally {
      inFlight.current = false;
      setLinking(false);
    }
  }

  const channels = discovered?.filter((row) => row.platform === "youtube");
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-semibold">
        Channel to sync
      </h3>
      {notice && <ConnectionNotice notice={notice} />}
      {channels === undefined ? (
        <Skeleton className="h-16 w-full" role="status" aria-label="Loading the YouTube channel" />
      ) : channels.length === 0 ? (
        connection.lastError === undefined && (
          <EmptyState title="No YouTube channel found">
            This connection found no channel. Reconnect YouTube and choose the channel when Google
            asks.
          </EmptyState>
        )
      ) : (
        <ul className="flex flex-col gap-2">
          {channels.map((channel) => (
            <li
              key={channel.externalId}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
              data-external-id={channel.externalId}
            >
              <div className="flex flex-col">
                <span className="font-medium">YouTube channel</span>
                <span className="font-mono text-xs text-muted-foreground">
                  {channel.externalId}
                </span>
              </div>
              {channel.linked ? (
                <Badge variant="secondary">Linked</Badge>
              ) : (
                <Button
                  type="button"
                  disabled={linking || connection.status !== "active"}
                  onClick={() => void link(channel.externalId)}
                  aria-label={`Link YouTube channel ${channel.externalId}`}
                >
                  {linking ? "Linking…" : "Link channel"}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** The connection's linked channels with their freshness (every role). */
function LinkedChannels({ channels }: { channels: readonly SocialAccount[] }) {
  const { timezone } = useOrg();
  const searchParams = useSearchParams();
  const params = new URLSearchParams(searchParams.toString());
  const headingId = "youtube-linked-channels";
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h3 id={headingId} className="text-base font-semibold">
        Linked channel
      </h3>
      {channels.length === 0 ? (
        <EmptyState title="No YouTube channel linked yet">
          Connect YouTube and link its channel to start syncing.
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">
          {channels.map((channel) => (
            <li
              key={channel.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"
              data-channel-id={channel.id}
            >
              <div className="flex flex-col gap-0.5 text-sm">
                <span className="font-medium">
                  {channel.name}
                  {channel.username !== undefined && (
                    <span className="font-normal text-muted-foreground"> @{channel.username}</span>
                  )}
                </span>
                <span className="font-mono text-xs text-muted-foreground">
                  {channel.externalId}
                </span>
                <span className="text-xs text-muted-foreground">
                  {channel.lastSyncedAt === undefined
                    ? "First sync scheduled."
                    : `Last synced ${formatInstant(channel.lastSyncedAt, timezone)}`}
                  {channel.coverage &&
                    ` · channel days through ${formatDateKey(channel.coverage.through)} (Pacific Time)`}
                </span>
              </div>
              <Link
                href={channelAnalyticsHref(channel.id, params)}
                className="text-sm font-medium underline underline-offset-4"
                aria-label={`View YouTube analytics for ${channel.name}`}
              >
                View analytics
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * YouTube organic (ADR 0016, Checkpoint 5): the connection's status (every role), Connect /
 * Reconnect / Disconnect and the channel to link (admins; the server enforces the role), and
 * the linked channel. Disconnect revokes Google access and deletes the channel's stored data
 * on the server; this card reports the deletion as complete only once the server confirms it
 * (lib/connections/youtube.ts). No credential, token or scope string is shown.
 */
export function YouTubeConnection({
  preferredConnectionId,
}: {
  /** The connection the OAuth callback just reported, shown first if it is a YouTube one. */
  preferredConnectionId: string | undefined;
}) {
  const org = useOrg();
  const isAdmin = org.role === "admin";
  const info = PROVIDERS.youtube;
  const { data: connections } = useAnalyticsQuery(api.v1.connections.list, {});
  const { data: accounts } = useAnalyticsQuery(api.v1.socialAccounts.list, PAGE);
  const [chosenId, setChosenId] = useState<string | undefined>(undefined);
  const [deletion, setDeletion] = useState<YouTubeDeletion | null>(null);

  if (connections === undefined || accounts === undefined) {
    return (
      <Skeleton className="h-24 w-full" role="status" aria-label="Loading the YouTube connection" />
    );
  }
  const candidates = adConnections(connections, "youtube");
  const connection = pickConnection(candidates, chosenId ?? preferredConnectionId);
  const channels = accounts.page.filter((account) => account.platform === "youtube");
  const linked =
    connection === undefined
      ? []
      : channels.filter((c) => c.connectionId === connection.id && c.status !== "disconnected");
  const progress = youtubeDeletionNotice(deletion, channels);
  const others = youtubeOtherDeletionNotice(
    channels.filter((c) => c.status === "disconnected" && !deletion?.channelIds.includes(c.id))
      .length,
  );
  const discoveryError =
    connection?.status === "active" ? discoveryErrorNotice(connection.lastError, "youtube") : null;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        {progress && (
          <div role="status" data-testid="youtube-deletion-status">
            <ConnectionNotice notice={progress} />
          </div>
        )}
        {others && (
          <div role="status">
            <ConnectionNotice notice={others} />
          </div>
        )}
        {connection === undefined ? (
          <p className="text-sm">{info.name} is not connected.</p>
        ) : (
          <>
            <ConnectionNotice notice={connectionStatusNotice(connection, "youtube")} />
            {connection.status === "active" && connection.missingScopes.length > 0 && (
              <p className="text-sm text-muted-foreground">
                Known limitation: until YouTube Analytics access is granted, the channel&apos;s
                video statistics may stop updating as well.
              </p>
            )}
            {candidates.length > 1 && (
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">YouTube connection</span>
                <select
                  className="h-9 w-fit max-w-full rounded-md border bg-background px-2"
                  value={connection.id}
                  onChange={(event) => setChosenId(event.target.value)}
                >
                  {candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {`YouTube · connected ${formatInstant(c.connectedAt, org.timezone)}` +
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
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap items-start gap-2">
              <ConnectButton provider="youtube" connection={connection} />
              {connection !== undefined && (
                <DisconnectButton
                  key={connection.id}
                  provider="youtube"
                  connection={connection}
                  consequences={YOUTUBE_DISCONNECT_CONSEQUENCES}
                  confirmLabel="Disconnect and delete data"
                  onDisconnected={() => {
                    setChosenId(undefined);
                    setDeletion({ channelIds: linked.map((c) => c.id) });
                  }}
                />
              )}
            </div>
            {connection !== undefined && (
              <p className="text-xs text-muted-foreground">
                Disconnecting YouTube revokes this service&apos;s Google access and deletes the
                channel&apos;s stored YouTube data (daily metrics, video statistics and sync
                history).
              </p>
            )}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Only organization admins can connect or disconnect YouTube.
          </p>
        )}
      </div>
      {connection !== undefined && isAdmin && (
        <DiscoveredChannel key={connection.id} connection={connection} />
      )}
      {connection !== undefined && <LinkedChannels channels={linked} />}
    </div>
  );
}
