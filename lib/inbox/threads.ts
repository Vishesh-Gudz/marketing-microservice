import type { FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";
import { isReplyWindowOpen } from "@/lib/whatsapp/inbox";

// The unified inbox (ADR 0018, IM7.4), derived from the PUBLIC v1 API only (type-only imports,
// D23).

export type InboxThread = FunctionReturnType<typeof api.v1.inbox.listThreads>["page"][number];
export type InboxChannel = InboxThread["channel"];
export type ReplyState = InboxThread["replyState"];

export const CHANNEL_LABELS: Readonly<Record<InboxChannel, string>> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
};

/** The channel's own conversation page, where its history and composer are. */
export function threadHref(thread: Pick<InboxThread, "channel" | "conversationId">): string {
  return thread.channel === "whatsapp"
    ? `/whatsapp/conversations/${thread.conversationId}`
    : `/instagram/messages/conversations/${thread.conversationId}`;
}

/**
 * The reply state at `now`. The server's state was evaluated when its query ran: an `open`
 * thread stays open only while its window has not expired on this clock; nothing is ever
 * upgraded (`closed` and `unavailable` stay). The channel's send endpoint decides again.
 */
export function replyStateAt(
  thread: Pick<InboxThread, "replyState" | "replyWindowExpiresAt">,
  now: number,
): ReplyState {
  if (thread.replyState !== "open") return thread.replyState;
  return isReplyWindowOpen(thread.replyWindowExpiresAt, now) ? "open" : "closed";
}

export const REPLY_STATE_LABELS: Readonly<Record<ReplyState, string>> = {
  open: "Reply window open",
  closed: "Reply window closed",
  unavailable: "Replies unavailable",
};
