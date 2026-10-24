import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { toIso } from "../../lib/dto";
import type { SetupProgress } from "../../whatsapp/accounts";
import {
  businessAccountStatusValidator,
  messageDirectionValidator,
  messageStatusValidator,
  messageTypeValidator,
  phoneNumberStatusValidator,
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

// ---------------------------------------------------------------------------
// WhatsApp connections (ADR 0014): Embedded Signup and setup status. Never: the business
// token, the registration PIN, the signup code, Meta error text or another org's assets.
// ---------------------------------------------------------------------------

/** What the browser needs to start Meta's Embedded Signup (all public values). */
export const whatsappSignupConfigDto = v.object({
  /** False when connections are closed on this deployment or the Meta app is not configured. */
  available: v.boolean(),
  /** Meta app id (FB.init appId). Present only when available. */
  appId: v.optional(v.string()),
  /** Facebook Login for Business configuration id (FB.login config_id). Only when available. */
  configId: v.optional(v.string()),
  /** Graph API version for FB.init. */
  graphApiVersion: v.string(),
  /** Embedded Signup version the login configuration must select. */
  embeddedSignupVersion: v.string(),
});
export type WhatsappSignupConfigDto = Infer<typeof whatsappSignupConfigDto>;

const setupStatusValidator = v.union(
  v.literal("connected"),
  v.literal("action_required"),
  /** The token expired or Meta refused it: the admin signs up again (reconnect). */
  v.literal("reauthorization_required"),
  v.literal("disconnected"),
);
const setupStepValidator = v.union(v.literal("subscribe"), v.literal("register"));

/** Outcome of completeSignup / retrySetup. */
export const whatsappSetupResultDto = v.object({
  accountId: v.string(),
  status: setupStatusValidator,
  /** The step still missing (action_required only); retrySetup resumes it. */
  nextStep: v.optional(setupStepValidator),
  /** Sanitized reason code of the latest failed step, e.g. "meta_133016" or "timeout". */
  reason: v.optional(v.string()),
});
export type WhatsappSetupResultDto = Infer<typeof whatsappSetupResultDto>;

export const whatsappAccountNumberDto = v.object({
  id: v.string(),
  /** Meta phone_number_id. */
  phoneNumberId: v.string(),
  displayPhoneNumber: v.optional(v.string()),
  status: phoneNumberStatusValidator,
  /** Whether Meta accepted the number's Cloud API registration. */
  registered: v.boolean(),
  /** After Meta's registration rate limit: no attempt before this time (compare with now). */
  registrationRetryAfter: v.optional(v.string()),
});

export const whatsappAccountDto = v.object({
  id: v.string(),
  connectionId: v.string(),
  /** Meta WhatsApp Business Account id. */
  wabaId: v.string(),
  status: businessAccountStatusValidator,
  setupStatus: setupStatusValidator,
  nextStep: v.optional(setupStepValidator),
  setupReason: v.optional(v.string()),
  subscribedAt: v.optional(v.string()),
  connectedAt: v.string(),
  disconnectedAt: v.optional(v.string()),
  numbers: v.array(whatsappAccountNumberDto),
});
export type WhatsappAccountDto = Infer<typeof whatsappAccountDto>;

/** The status's own reason (no active number), else the latest failed step's, if any. */
function setupReasonOf(
  account: Doc<"whatsappBusinessAccounts">,
  progress: SetupProgress,
): { setupReason?: string } {
  if (progress.status !== "action_required" && progress.status !== "reauthorization_required") {
    return {};
  }
  const reason = progress.reason ?? account.setupError?.reason;
  return reason !== undefined ? { setupReason: reason } : {};
}

export function toWhatsappAccountDto(
  account: Doc<"whatsappBusinessAccounts">,
  numbers: Doc<"whatsappPhoneNumbers">[],
  progress: SetupProgress,
): WhatsappAccountDto {
  return {
    id: account._id,
    connectionId: account.connectionId,
    wabaId: account.wabaId,
    status: account.status,
    setupStatus: progress.status,
    ...(progress.nextStep !== undefined ? { nextStep: progress.nextStep } : {}),
    ...setupReasonOf(account, progress),
    ...optionalIso("subscribedAt", account.subscribedAt),
    connectedAt: toIso(account.createdAt),
    ...optionalIso("disconnectedAt", account.disconnectedAt),
    numbers: numbers.map((number) => ({
      id: number._id,
      phoneNumberId: number.phoneNumberId,
      ...(number.displayPhoneNumber !== undefined
        ? { displayPhoneNumber: number.displayPhoneNumber }
        : {}),
      status: number.status,
      registered: number.platformRegisteredAt !== undefined,
      ...optionalIso("registrationRetryAfter", number.registrationBlockedUntil),
    })),
  };
}
