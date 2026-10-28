import type { Notice } from "./types";

/**
 * YouTube connection texts (ADR 0016, Checkpoint 5). Disconnecting YouTube revokes this
 * service's Google access (best effort, through the existing flow) and HARD-deletes the
 * channel's stored data on the server (bounded steps; a channel row is deleted last). The
 * dashboard claims a deletion only once the server confirms it: the channel's row is gone
 * from v1/socialAccounts:list. It never claims that Google confirmed the revocation.
 */

/** The confirmation's list (DisconnectButton `consequences`). */
export const YOUTUBE_DISCONNECT_CONSEQUENCES: readonly string[] = [
  "The channel's stored YouTube data — daily metrics, video statistics and sync history — is deleted. This cannot be undone.",
  "This service's Google access for YouTube is revoked and the stored access is deleted.",
  "Afterwards, connect again to start fresh: the channel's history is synced again from YouTube.",
];

/** A disconnect this page started: the channels it was deleting at that moment. */
export type YouTubeDeletion = { channelIds: readonly string[] };

/**
 * Progress of a disconnect started on this page. `channels` is the current
 * v1/socialAccounts:list page (YouTube rows); a channel being deleted keeps its row (status
 * "disconnected") until the server has deleted everything else.
 */
export function youtubeDeletionNotice(
  deletion: YouTubeDeletion | null,
  channels: readonly { id: string }[],
): Notice | null {
  if (deletion === null) return null;
  if (deletion.channelIds.length === 0) {
    return {
      tone: "success",
      title: "YouTube disconnected",
      message:
        "No channel data was stored for this connection. Revoking this service's Google access was requested.",
    };
  }
  const remaining = channels.filter((channel) => deletion.channelIds.includes(channel.id));
  if (remaining.length > 0) {
    return {
      tone: "info",
      title: "Deleting stored YouTube data…",
      message:
        "YouTube is disconnected and revoking this service's Google access was requested. The channel's stored data is being deleted; this page confirms when the server has finished.",
    };
  }
  return {
    tone: "success",
    title: "Stored YouTube data deleted",
    message:
      "The server confirmed that the channel's stored data (daily metrics, video statistics and sync history) was deleted.",
  };
}

/** Channels being deleted that this page did not start (another admin, an unlink, a check). */
export function youtubeOtherDeletionNotice(count: number): Notice | null {
  if (count === 0) return null;
  return {
    tone: "info",
    title: "Deleting stored YouTube data…",
    message: `The stored data of ${count === 1 ? "1 channel" : `${count} channels`} is being deleted after a disconnect or unlink. The channel disappears from this page once the server has finished.`,
  };
}

/** Shown after linking the channel. */
export const YOUTUBE_LINKED_NOTICE: Notice = {
  tone: "success",
  title: "Channel linked",
  message:
    "Its first sync starts automatically. Daily channel metrics appear about 3 days late (YouTube's reporting delay).",
};
