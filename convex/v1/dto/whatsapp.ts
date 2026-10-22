import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { toIso } from "../../lib/dto";
import {
  messageDirectionValidator,
  messageStatusValidator,
  messageTypeValidator,
} from "../../whatsapp/validators";
import { serviceWindowExpiresAt } from "../../whatsapp/window";

/**
 * WhatsApp inbox DTOs (ADR 0013). Never: credentials, webhook event bodies, internal row ids
 * other than opaque ids, or platform error details beyond the numeric code.
 *
 * The 24-hour customer-service window is exposed only as `serviceWindowExpiresAt`; clients
 * compare it with their clock (a cached query must never claim an expired window is open).
 * Sending enforces the window server-side.
 */

export const whatsappConversationDto = v.object({
  id: v.string(),
  /** Meta phone_number_id of the business number this thread belongs to. */
  phoneNumberId: v.string(),
  displayPhoneNumber: v.optional(v.string()),
  /** Customer's WhatsApp id. */
  contactWaId: v.string(),
  contactName: v.optional(v.string()),
  lastMessageAt: v.string(),
  lastInboundAt: v.optional(v.string()),
  serviceWindowExpiresAt: v.optional(v.string()),
});
export type WhatsappConversationDto = Infer<typeof whatsappConversationDto>;

export function toWhatsappConversationDto(
  conversation: Doc<"whatsappConversations">,
  number: Doc<"whatsappPhoneNumbers">,
): WhatsappConversationDto {
  const expiresAt = serviceWindowExpiresAt(conversation.lastInboundAt);
  return {
    id: conversation._id,
    phoneNumberId: number.phoneNumberId,
    ...(number.displayPhoneNumber !== undefined
      ? { displayPhoneNumber: number.displayPhoneNumber }
      : {}),
    contactWaId: conversation.contactWaId,
    ...(conversation.contactName !== undefined ? { contactName: conversation.contactName } : {}),
    lastMessageAt: toIso(conversation.lastMessageAt),
    ...(conversation.lastInboundAt !== undefined
      ? { lastInboundAt: toIso(conversation.lastInboundAt) }
      : {}),
    ...(expiresAt !== undefined ? { serviceWindowExpiresAt: toIso(expiresAt) } : {}),
  };
}

export const whatsappMessageDto = v.object({
  id: v.string(),
  conversationId: v.string(),
  direction: messageDirectionValidator,
  type: messageTypeValidator,
  /** Text body (text messages only). */
  text: v.optional(v.string()),
  status: messageStatusValidator,
  /** Platform error code of a failed message. */
  errorCode: v.optional(v.number()),
  /** When the message happened. */
  at: v.string(),
  sentAt: v.optional(v.string()),
  deliveredAt: v.optional(v.string()),
  readAt: v.optional(v.string()),
  failedAt: v.optional(v.string()),
});
export type WhatsappMessageDto = Infer<typeof whatsappMessageDto>;

function optionalIso<K extends string>(key: K, value: number | undefined) {
  return value === undefined ? {} : ({ [key]: toIso(value) } as Record<K, string>);
}

export function toWhatsappMessageDto(message: Doc<"whatsappMessages">): WhatsappMessageDto {
  return {
    id: message._id,
    conversationId: message.conversationId,
    direction: message.direction,
    type: message.messageType,
    ...(message.text !== undefined ? { text: message.text } : {}),
    status: message.status,
    ...(message.errorCode !== undefined ? { errorCode: message.errorCode } : {}),
    at: toIso(message.platformAt),
    ...optionalIso("sentAt", message.sentAt),
    ...optionalIso("deliveredAt", message.deliveredAt),
    ...optionalIso("readAt", message.readAt),
    ...optionalIso("failedAt", message.failedAt),
  };
}
