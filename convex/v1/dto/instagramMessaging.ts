import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import {
  messageOriginValidator,
  messageStatusValidator,
  messageTypeValidator,
  messagingAccountStatusValidator,
} from "../../instagram/messaging/validators";
import type { SetupState } from "../../instagram/messaging/lifecycle";
import { toIso } from "../../lib/dto";
import { messageDirectionValidator } from "../../messaging/validators";
import { serviceWindowExpiresAt } from "../../messaging/window";

/**
 * Instagram messaging DTOs (ADR 0017). Never: credentials, webhook event bodies, internal row
 * ids other than opaque ids, customer IGSIDs, Meta message ids, or platform error details
 * beyond the numeric code. The 24-hour reply window is exposed only as
 * `replyWindowExpiresAt`; clients compare it with their clock.
 */

function optionalIso<K extends string>(key: K, value: number | undefined) {
  return value === undefined ? {} : ({ [key]: toIso(value) } as Record<K, string>);
}

function optional<K extends string, T>(key: K, value: T | undefined) {
  return value === undefined ? {} : ({ [key]: value } as Record<K, T>);
}

export const instagramMessagingAccountDto = v.object({
  id: v.string(),
  socialAccountId: v.string(),
  /** The business account's Instagram username, when known. */
  username: v.optional(v.string()),
  status: messagingAccountStatusValidator,
  /** When the current hold began; messages from before it are not in the inbox. */
  activatedAt: v.string(),
  /** When Meta accepted the webhook subscription (absent: not subscribed yet). */
  subscribedAt: v.optional(v.string()),
  /** action_required: the sanitized reason the setup failed (e.g. "meta_10", "timeout"). */
  setupReason: v.optional(v.string()),
  /** Turned off: when its stored conversations will be deleted (absent: not planned). */
  purgeAfter: v.optional(v.string()),
});
export type InstagramMessagingAccountDto = Infer<typeof instagramMessagingAccountDto>;

export function toInstagramMessagingAccountDto(
  account: Doc<"instagramMessagingAccounts">,
  social: Doc<"socialAccounts"> | null,
): InstagramMessagingAccountDto {
  return {
    id: account._id,
    socialAccountId: account.socialAccountId,
    ...optional("username", social?.username),
    status: account.status,
    activatedAt: toIso(account.activatedAt),
    ...optionalIso("subscribedAt", account.subscribedAt),
    ...optional(
      "setupReason",
      account.status === "action_required" ? account.setupError?.reason : undefined,
    ),
    ...optionalIso("purgeAfter", account.purgeAfter),
  };
}

/** The outcome of turning messaging on or retrying its setup. */
export const instagramMessagingSetupResultDto = v.object({
  accountId: v.string(),
  status: v.union(v.literal("active"), v.literal("action_required")),
  /** action_required: the sanitized reason the subscription failed. */
  setupReason: v.optional(v.string()),
});
export type InstagramMessagingSetupResultDto = Infer<typeof instagramMessagingSetupResultDto>;

export function toSetupResultDto(state: SetupState): InstagramMessagingSetupResultDto {
  return {
    accountId: state.accountId,
    status: state.status,
    ...optional("setupReason", state.setupReason),
  };
}

/**
 * Whether direct messages can be turned on for a linked Instagram account, or how they stand
 * `unavailable` (closed on this deployment), the enable refusals, `ready`, or the status.
 */
export const instagramMessagingAvailabilityDto = v.object({
  availability: v.union(
    v.literal("unavailable"),
    v.literal("not_found"),
    v.literal("not_linked"),
    v.literal("connection_inactive"),
    v.literal("scope_missing"),
    v.literal("in_use"),
    v.literal("purge_in_progress"),
    v.literal("ready"),
    messagingAccountStatusValidator,
  ),
  /** The account's messaging row, when it has one (also `disabled`). */
  accountId: v.optional(v.string()),
  /** Turned off within its grace period: history kept until then. */
  purgeAfter: v.optional(v.string()),
});
export type InstagramMessagingAvailabilityDto = Infer<typeof instagramMessagingAvailabilityDto>;

export const instagramConversationDto = v.object({
  id: v.string(),
  messagingAccountId: v.string(),
  /** The business account's Instagram username, when known. */
  accountUsername: v.optional(v.string()),
  contactUsername: v.optional(v.string()),
  contactName: v.optional(v.string()),
  lastMessageAt: v.string(),
  lastInboundAt: v.optional(v.string()),
  replyWindowExpiresAt: v.optional(v.string()),
  /**
   * Why no reply can be sent now whatever the window (the same check as sendText; IM5): the
   * account's messaging is off or not available here, its setup needs attention, its connection
   * needs reconnecting, or the messaging permission is missing. Absent: the window decides.
   */
  replyBlocker: v.optional(
    v.union(
      v.literal("messaging_unavailable"),
      v.literal("setup_incomplete"),
      v.literal("reconnect_required"),
      v.literal("scope_missing"),
    ),
  ),
});
export type InstagramConversationDto = Infer<typeof instagramConversationDto>;

export function toInstagramConversationDto(
  conversation: Doc<"instagramConversations">,
  social: Doc<"socialAccounts"> | null,
  replyBlocker: InstagramConversationDto["replyBlocker"],
): InstagramConversationDto {
  return {
    id: conversation._id,
    messagingAccountId: conversation.messagingAccountId,
    ...optional("accountUsername", social?.username),
    ...optional("contactUsername", conversation.contactUsername),
    ...optional("contactName", conversation.contactName),
    lastMessageAt: toIso(conversation.lastMessageAt),
    ...optionalIso("lastInboundAt", conversation.lastInboundAt),
    ...optionalIso("replyWindowExpiresAt", serviceWindowExpiresAt(conversation.lastInboundAt)),
    ...optional("replyBlocker", replyBlocker),
  };
}

export const instagramMessageDto = v.object({
  id: v.string(),
  conversationId: v.string(),
  direction: messageDirectionValidator,
  /** customer, app (sent from here), or instagram (sent from Instagram itself). */
  origin: messageOriginValidator,
  /** Attachments are placeholders: only their type is known. */
  type: messageTypeValidator,
  /** Absent for attachments and for messages the customer deleted. */
  text: v.optional(v.string()),
  status: messageStatusValidator,
  errorCode: v.optional(v.number()),
  failureReason: v.optional(v.string()),
  /** When the message happened. */
  at: v.string(),
  sentAt: v.optional(v.string()),
  readAt: v.optional(v.string()),
  failedAt: v.optional(v.string()),
  editedAt: v.optional(v.string()),
  deletedAt: v.optional(v.string()),
});
export type InstagramMessageDto = Infer<typeof instagramMessageDto>;

export function toInstagramMessageDto(message: Doc<"instagramMessages">): InstagramMessageDto {
  return {
    id: message._id,
    conversationId: message.conversationId,
    direction: message.direction,
    origin: message.origin,
    type: message.messageType,
    ...optional("text", message.text),
    status: message.status,
    ...optional("errorCode", message.errorCode),
    ...optional("failureReason", message.failureReason),
    at: toIso(message.platformAt),
    ...optionalIso("sentAt", message.sentAt),
    ...optionalIso("readAt", message.readAt),
    ...optionalIso("failedAt", message.failedAt),
    ...optionalIso("editedAt", message.editedAt),
    ...optionalIso("deletedAt", message.deletedAt),
  };
}
