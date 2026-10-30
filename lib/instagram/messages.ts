import { isMarketingError } from "@/convex/lib/errors";
import type { Notice } from "@/lib/connections/types";
import type {
  AvailabilityState,
  InstagramConversation,
  InstagramMessage,
  MessageStatus,
  MessageType,
  ReplyBlocker,
  SetupResult,
} from "./types";

/**
 * Instagram direct messages in fixed words (ADR 0017, IM5). Only public v1 fields are read; the
 * texts never repeat Meta's or the server's own wording, a token, or a customer's Instagram id.
 * Message texts are the customer's and the business's own words, shown as plain text.
 */

const SETTINGS = "in the Instagram DM settings";
const INTEGRATION = "through the integration that manages your Instagram connection";
const SUPPORT = "If it keeps happening, contact support.";

/** [doc] Instagram accepts at most 1000 bytes of UTF-8 per message (enforced again by sendText). */
export const MAX_REPLY_BYTES = 1000;

const encoder = new TextEncoder();

/** The length Instagram counts: UTF-8 bytes (an emoji takes four, "é" two). */
export function utf8Length(text: string): number {
  return encoder.encode(text).length;
}

/** Who a conversation is with: the customer's @username, their name, or a neutral label. */
export function contactLabel(
  conversation: Pick<InstagramConversation, "contactUsername" | "contactName">,
): string {
  if (conversation.contactUsername !== undefined) return `@${conversation.contactUsername}`;
  return conversation.contactName ?? "Instagram user";
}

/** The business account a conversation runs on. */
export function accountLabel(username: string | undefined): string {
  return username !== undefined ? `@${username}` : "your Instagram account";
}

/** How far a reply got, in words (inbound messages have none). */
export const OUTBOUND_STATUS_LABELS: Readonly<Record<Exclude<MessageStatus, "received">, string>> =
  {
    pending: "Sending",
    submitted: "Accepted by Instagram",
    sent: "Sent",
    read: "Seen",
    failed: "Not sent",
    unknown: "Not confirmed",
  };

export function outboundStatusLabel(status: MessageStatus): string | undefined {
  return status === "received" ? undefined : OUTBOUND_STATUS_LABELS[status];
}

const TYPE_LABELS: Readonly<Partial<Record<MessageType, string>>> = {
  image: "Photo",
  video: "Video",
  audio: "Voice message",
  file: "File",
  share: "Shared post",
  ig_post: "Shared post",
  ig_reel: "Shared reel",
  reel: "Shared reel",
  story_mention: "Mention in their story",
  story_reply: "Reply to your story",
  unsupported: "Unsupported message",
};

/**
 * What a message bubble shows: its text, or a fixed placeholder (this inbox stores no media and
 * keeps no text of a deleted message).
 */
export function messageContent(
  message: Pick<InstagramMessage, "text" | "type" | "deletedAt" | "direction">,
): { kind: "text"; text: string } | { kind: "placeholder"; text: string } {
  if (message.deletedAt !== undefined) {
    return {
      kind: "placeholder",
      text: message.direction === "inbound" ? "The customer deleted this message" : "Deleted",
    };
  }
  if (message.text !== undefined) return { kind: "text", text: message.text };
  const label = TYPE_LABELS[message.type] ?? "Message";
  return { kind: "placeholder", text: `${label} (not shown in this inbox)` };
}

/** Who wrote a message, as the thread shows it. */
export function senderLabel(
  message: Pick<InstagramMessage, "direction" | "origin">,
  contact: string,
): string {
  if (message.direction === "inbound") return contact;
  return message.origin === "instagram" ? "You, in the Instagram app" : "You";
}

/** Small notes under a bubble: a story reply, an edit. */
export function messageNotes(
  message: Pick<InstagramMessage, "type" | "editedAt" | "deletedAt" | "text">,
): string[] {
  const notes: string[] = [];
  if (message.type === "story_reply" && message.text !== undefined) {
    notes.push("Replied to your story");
  }
  if (message.editedAt !== undefined && message.deletedAt === undefined) notes.push("Edited");
  return notes;
}

/** Why a reply failed or is not confirmed (null for any other message). Never Meta's codes. */
export function deliveryProblemText(
  message: Pick<InstagramMessage, "status" | "failureReason">,
): string | null {
  if (message.status === "unknown") {
    return "Instagram did not confirm this reply. It may have been sent: check the conversation in the Instagram app before sending it again.";
  }
  if (message.status !== "failed") return null;
  switch (message.failureReason) {
    case "window_closed":
      return "The customer's 24-hour reply window had closed when it was due.";
    // Never reached Instagram: refused before the call.
    case "not_sent":
    case "transport_blocked":
    case "request_budget_exceeded":
      return "It could not be sent. Try again.";
    case "messaging_unavailable":
    case "setup_incomplete":
    case "scope_missing":
    case "reconnect_required":
      return `This account could no longer send when it was due. Check it ${SETTINGS}.`;
    case "credential_unavailable":
    case "credential_invalid":
    case "meta_190":
    case "meta_102":
      return `Instagram no longer accepts this connection. Reconnect it ${INTEGRATION}.`;
  }
  return "Instagram refused this reply.";
}

/** Why no reply can be sent now (the server's replyBlocker, or the reply window). */
export const REPLY_BLOCKED_TEXT: Readonly<
  Record<ReplyBlocker | "window_closed" | "window_unopened", string>
> = {
  messaging_unavailable: `Direct messages are not on for this account. Check it ${SETTINGS}.`,
  setup_incomplete: `The setup of direct messages for this account did not finish. Retry it ${SETTINGS}.`,
  reconnect_required: `Instagram no longer accepts this connection. Reconnect it ${INTEGRATION}.`,
  scope_missing: `The connection does not allow direct messages. Reconnect Instagram with direct messages allowed, ${INTEGRATION}.`,
  window_closed:
    "The customer last wrote more than 24 hours ago. Instagram allows no reply until they write again.",
  window_unopened: "The customer has not written yet. Instagram allows a reply only after they do.",
};

function detail(error: unknown, key: "reason"): string | undefined {
  if (!isMarketingError(error)) return undefined;
  const value = error.data.details?.[key];
  return typeof value === "string" ? value : undefined;
}

/** Refusals of sendText by `details.reason` (convex/instagram/messaging/outbound.ts). */
const SEND_ERROR_MESSAGES: Readonly<Record<string, Omit<Notice, "tone">>> = {
  window_closed: { title: "Reply window closed", message: REPLY_BLOCKED_TEXT.window_closed },
  messaging_unavailable: {
    title: "Direct messages are off",
    message: REPLY_BLOCKED_TEXT.messaging_unavailable,
  },
  setup_incomplete: { title: "Setup not finished", message: REPLY_BLOCKED_TEXT.setup_incomplete },
  reconnect_required: {
    title: "Reconnect Instagram",
    message: REPLY_BLOCKED_TEXT.reconnect_required,
  },
  scope_missing: {
    title: "Direct messages not allowed",
    message: REPLY_BLOCKED_TEXT.scope_missing,
  },
  client_message_id_reused: {
    title: "Message not sent",
    message: "Write the message again and send it.",
  },
};

/** A refused reply, in fixed words. */
export function sendErrorNotice(error: unknown): Notice {
  const reason = detail(error, "reason");
  const known = reason !== undefined ? SEND_ERROR_MESSAGES[reason] : undefined;
  if (known) return { tone: reason === "window_closed" ? "warning" : "error", ...known };
  if (isMarketingError(error)) {
    switch (error.data.code) {
      case "INVALID_ARGUMENT":
        return {
          tone: "error",
          title: "Message not valid",
          message: `Check the message (1 to ${MAX_REPLY_BYTES.toLocaleString("en")} bytes) and send again.`,
        };
      case "FORBIDDEN":
        return {
          tone: "error",
          title: "Editors and admins only",
          message: "Only editors and admins can send Instagram replies.",
        };
      case "UNAUTHENTICATED":
        return { tone: "error", title: "Signed out", message: "Sign in again, then retry." };
      case "NOT_FOUND":
        return {
          tone: "error",
          title: "Conversation not found",
          message: "This conversation no longer exists. Go back to the inbox.",
        };
    }
  }
  return {
    tone: "error",
    title: "Message not sent",
    message: `Something went wrong. Try again. ${SUPPORT}`,
  };
}

/** How messaging stands for one linked Instagram account (v1 getAvailability), in words. */
export const AVAILABILITY_TEXT: Readonly<
  Record<AvailabilityState, { label: string; text: string }>
> = {
  active: { label: "On", text: "Customers' direct messages arrive in the inbox." },
  action_required: {
    label: "Needs attention",
    text: "The setup of direct messages did not finish.",
  },
  ready: { label: "Off", text: "Direct messages are off for this account." },
  disabled: { label: "Off", text: "Direct messages are off for this account." },
  unavailable: {
    label: "Not available",
    text: "Instagram direct messages are not available on this deployment yet.",
  },
  not_found: { label: "Not found", text: "This Instagram account is no longer linked." },
  not_linked: {
    label: "Not linked",
    text: `Link this Instagram account ${INTEGRATION} first.`,
  },
  connection_inactive: {
    label: "Reconnect needed",
    text: `Reconnect Instagram ${INTEGRATION}, then turn direct messages on here.`,
  },
  scope_missing: {
    label: "Permission missing",
    text: `Reconnect Instagram with direct messages allowed, ${INTEGRATION}, then turn them on here.`,
  },
  in_use: {
    label: "Used by another organization",
    text: "Another organization receives this account's direct messages.",
  },
  purge_in_progress: {
    label: "Deleting old messages",
    text: "Messages kept from an earlier turn-off are being deleted. Direct messages can be turned on again once that is done.",
  },
};

/** Why the setup of direct messages did not finish (a sanitized reason code), in words. */
export function setupReasonText(reason: string | undefined): string {
  switch (reason) {
    case "meta_190":
    case "meta_102":
    case "credential_unavailable":
    case "credential_invalid":
      return `Instagram no longer accepts this connection. Reconnect it ${INTEGRATION}, then retry.`;
    case "timeout":
    case "network":
    case "unexpected_response":
      return "Instagram did not answer as expected. Retry the setup.";
  }
  if (reason?.startsWith("http_5")) return "Instagram did not answer as expected. Retry the setup.";
  return "Instagram refused the setup. Retry it; if it keeps failing, reconnect Instagram with direct messages allowed.";
}

/** The outcome of turning messaging on or retrying its setup. */
export function setupResultNotice(result: SetupResult): Notice {
  if (result.status === "active") {
    return {
      tone: "success",
      title: "Direct messages are on",
      message: "New direct messages to this account now arrive in the inbox.",
    };
  }
  return {
    tone: "warning",
    title: "Setup did not finish",
    message: setupReasonText(result.setupReason),
  };
}

/** Refusals of enable / retrySetup / disable by `details.reason` (v1/instagramMessaging). */
const CONTROL_ERROR_MESSAGES: Readonly<Record<string, Omit<Notice, "tone">>> = {
  messaging_unavailable: {
    title: "Not available",
    message: AVAILABILITY_TEXT.unavailable.text,
  },
  not_linked: { title: "Account not linked", message: AVAILABILITY_TEXT.not_linked.text },
  connection_inactive: {
    title: "Reconnect Instagram",
    message: AVAILABILITY_TEXT.connection_inactive.text,
  },
  scope_missing: {
    title: "Direct messages not allowed",
    message: AVAILABILITY_TEXT.scope_missing.text,
  },
  in_use: { title: "Used by another organization", message: AVAILABILITY_TEXT.in_use.text },
  purge_in_progress: {
    title: "Old messages are being deleted",
    message: AVAILABILITY_TEXT.purge_in_progress.text,
  },
};

/** A refused turn-on, retry or turn-off, in fixed words. */
export function controlErrorNotice(error: unknown): Notice {
  const reason = detail(error, "reason");
  const known = reason !== undefined ? CONTROL_ERROR_MESSAGES[reason] : undefined;
  if (known) return { tone: "error", ...known };
  if (isMarketingError(error)) {
    switch (error.data.code) {
      case "FORBIDDEN":
        return {
          tone: "error",
          title: "Admins only",
          message: "Only organization admins can turn direct messages on or off.",
        };
      case "NOT_FOUND":
        return {
          tone: "error",
          title: "Not found",
          message: "This account changed meanwhile. Reload the page.",
        };
    }
  }
  return {
    tone: "error",
    title: "Nothing changed",
    message: `Something went wrong. Try again. ${SUPPORT}`,
  };
}
