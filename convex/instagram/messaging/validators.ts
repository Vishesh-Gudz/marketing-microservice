import { v, type Infer } from "convex/values";
import { literalUnion } from "../../domain/validators";

/** Validators of the Instagram messaging tables (ADR 0017). */

/**
 * Messaging state of one org's Instagram account.
 * - `active`: webhook events for the account are routed to this org.
 * - `action_required`: setup or a send was refused (e.g. the webhook subscription failed or the
 *   messaging permission is gone); still holds the account, and its customers' messages are
 *   still routed here so none is lost.
 * - `disabled`: turned off; nothing is routed and the account is free for any org.
 */
export const MESSAGING_ACCOUNT_STATUSES = ["active", "action_required", "disabled"] as const;
export type MessagingAccountStatus = (typeof MESSAGING_ACCOUNT_STATUSES)[number];
export const messagingAccountStatusValidator = literalUnion(MESSAGING_ACCOUNT_STATUSES);

/**
 * Attachment types recorded by type [doc: webhook `attachments[].type`]. Only the type is kept,
 * as a placeholder: no media URL is ever stored and no media is fetched. Any other type is
 * stored as `unsupported`. PROVISIONAL until checked against real payloads.
 */
export const ATTACHMENT_TYPES = [
  "image",
  "video",
  "audio",
  "file",
  "share",
  "ig_post",
  "ig_reel",
  "reel",
  "story_mention",
] as const;

/** Stored message types: text, attachment placeholders, and `story_reply` (`reply_to.story`). */
export const MESSAGE_TYPES = ["text", ...ATTACHMENT_TYPES, "story_reply", "unsupported"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export const messageTypeValidator = literalUnion(MESSAGE_TYPES);

/**
 * Message lifecycle. Inbound messages are `received`. Outbound: `pending` (stored, not yet
 * accepted) -> `submitted` (accepted, mid known) -> `sent` (Meta echoed it) -> `read` (the
 * customer saw it), or `failed`. Instagram sends no delivery receipts [doc], so there is no
 * `delivered`. `unknown`: the send's answer never arrived or could not be read (final).
 */
export const MESSAGE_STATUSES = [
  "received",
  "pending",
  "submitted",
  "sent",
  "read",
  "failed",
  "unknown",
] as const;
export const messageStatusValidator = literalUnion(MESSAGE_STATUSES);

/**
 * Who wrote a message: the customer, a member through this app, or the business through
 * Instagram itself (an echo of a message sent from the Instagram app or another tool).
 */
export const messageOriginValidator = v.union(
  v.literal("customer"),
  v.literal("app"),
  v.literal("instagram"),
);

/** Kinds of stored webhook events; each has its own dedupe key (see the events table). */
export const WEBHOOK_EVENT_KINDS = ["message", "echo", "read", "edit", "delete"] as const;
export const webhookEventKindValidator = literalUnion(WEBHOOK_EVENT_KINDS);

/** What every stored event carries: Meta's message id, the customer's IGSID and its time. */
const eventBase = { mid: v.string(), customerIgsid: v.string(), timestampMs: v.number() };

const messageContent = {
  messageType: messageTypeValidator,
  text: v.optional(v.string()),
  replyToMid: v.optional(v.string()),
};

/**
 * A parsed webhook event as stored until processed (allowlisted fields only; see
 * convex/instagram/messaging/payload.ts). `customerIgsid` is the customer's side of the thread
 * whichever way the event went.
 */
export const webhookEventValidator = v.union(
  v.object({ kind: v.literal("message"), ...eventBase, ...messageContent }),
  v.object({ kind: v.literal("echo"), ...eventBase, ...messageContent }),
  v.object({ kind: v.literal("read"), ...eventBase }),
  v.object({ kind: v.literal("edit"), ...eventBase, text: v.string(), editCount: v.number() }),
  v.object({ kind: v.literal("delete"), ...eventBase }),
);
export type WebhookEventInput = Infer<typeof webhookEventValidator>;

/** The events of one webhook `entry`, for the Instagram account it names. */
export const webhookEntryValidator = v.object({
  igAccountId: v.string(),
  events: v.array(webhookEventValidator),
});
