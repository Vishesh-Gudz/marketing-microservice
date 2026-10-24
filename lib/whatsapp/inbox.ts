import { useEffect, useState } from "react";
import type { MessageStatus, MessageType, WhatsAppConversation, WhatsAppMessage } from "./types";

/**
 * WhatsApp inbox display rules (ADR 0013). Only public v1 fields are read; message texts are the
 * customer's and the business's own words and are shown as plain text, never as HTML.
 */

/** Longest text reply (Meta's limit, enforced again by v1/whatsapp:sendText). */
export const MAX_REPLY_CHARS = 4096;

/**
 * A new id for one message the user is about to send (v1/whatsapp `clientMessageId`): sending
 * the same draft again with it, after an error, can never send it twice.
 */
export function newClientMessageId(): string {
  return crypto.randomUUID();
}

/** Who a conversation is with: the customer's WhatsApp profile name, else their number. */
export function contactLabel(
  conversation: Pick<WhatsAppConversation, "contactName" | "contactWaId">,
): string {
  return conversation.contactName ?? `+${conversation.contactWaId}`;
}

/** The business number a conversation runs on. */
export function businessNumberLabel(
  conversation: Pick<WhatsAppConversation, "displayPhoneNumber" | "phoneNumberId">,
): string {
  return conversation.displayPhoneNumber ?? conversation.phoneNumberId;
}

/**
 * Whether free-form replies are allowed at `now`: the 24-hour window opened by the customer's
 * latest message is still open. The server decides again when a reply is sent.
 */
export function isReplyWindowOpen(expiresAt: string | undefined, now: number): boolean {
  return expiresAt !== undefined && now < Date.parse(expiresAt);
}

/** How far an outbound message got, in words (inbound messages have none). */
export const OUTBOUND_STATUS_LABELS: Readonly<Record<Exclude<MessageStatus, "received">, string>> =
  {
    pending: "Sending",
    submitted: "Accepted by WhatsApp",
    sent: "Sent",
    delivered: "Delivered",
    read: "Read",
    failed: "Not delivered",
    unknown: "Not confirmed",
  };

export function outboundStatusLabel(status: MessageStatus): string | undefined {
  return status === "received" ? undefined : OUTBOUND_STATUS_LABELS[status];
}

const TYPE_LABELS: Readonly<Partial<Record<MessageType, string>>> = {
  image: "Photo",
  audio: "Audio",
  video: "Video",
  document: "Document",
  sticker: "Sticker",
  location: "Location",
  contacts: "Contact card",
  interactive: "Interactive reply",
  button: "Button reply",
  reaction: "Reaction",
  order: "Order",
  system: "System message",
  unsupported: "Unsupported message",
};

/**
 * What a message bubble shows: its text, or for a message without one (a photo, a location, …)
 * a fixed placeholder, since this inbox stores no media.
 */
export function messageContent(
  message: Pick<WhatsAppMessage, "text" | "type">,
): { kind: "text"; text: string } | { kind: "placeholder"; text: string } {
  if (message.text !== undefined) return { kind: "text", text: message.text };
  const label = TYPE_LABELS[message.type] ?? "Message";
  return { kind: "placeholder", text: `${label} (not shown in this inbox)` };
}

/** The time now, refreshed every 30 seconds (re-checks the reply window while a page is open). */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(currentTime);
  useEffect(() => {
    const timer = setInterval(() => setNow(currentTime()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function currentTime(): number {
  return Date.now();
}
