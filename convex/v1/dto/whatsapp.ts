import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { toIso } from "../../lib/dto";
import type { SetupProgress } from "../../whatsapp/accounts";
import type { ParsedTemplate } from "../../whatsapp/templates";
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
  /**
   * Outbound, failed or unknown: a sanitized reason code, e.g. "meta_131047" (Meta refused),
   * "timeout" (unknown: may have been sent, never resent automatically), "number_unavailable".
   */
  failureReason: v.optional(v.string()),
  /** Outbound templates: which approved template was sent (`text` is it filled in). */
  template: v.optional(v.object({ name: v.string(), language: v.string() })),
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
    ...(message.failureReason !== undefined ? { failureReason: message.failureReason } : {}),
    ...(message.template !== undefined
      ? { template: { name: message.template.name, language: message.template.language } }
      : {}),
    at: toIso(message.platformAt),
    ...optionalIso("sentAt", message.sentAt),
    ...optionalIso("deliveredAt", message.deliveredAt),
    ...optionalIso("readAt", message.readAt),
    ...optionalIso("failedAt", message.failedAt),
  };
}

/**
 * An APPROVED message template of the conversation's WhatsApp Business Account, as the template
 * picker needs it. `supported` false: it cannot be sent from here yet (`unsupportedReason`).
 * `variables` are the values to fill in, in order (`name`: the placeholder, or a URL button's
 * index), with Meta's example when the template has one.
 */
export const whatsappTemplateDto = v.object({
  name: v.string(),
  language: v.string(),
  category: v.string(),
  parameterFormat: v.union(v.literal("POSITIONAL"), v.literal("NAMED")),
  header: v.optional(v.string()),
  body: v.string(),
  footer: v.optional(v.string()),
  buttons: v.array(v.object({ type: v.string(), text: v.string() })),
  variables: v.array(
    v.object({
      component: v.union(v.literal("header"), v.literal("body"), v.literal("button")),
      name: v.string(),
      example: v.optional(v.string()),
    }),
  ),
  supported: v.boolean(),
  unsupportedReason: v.optional(v.string()),
});
export type WhatsappTemplateDto = Infer<typeof whatsappTemplateDto>;

/** listTemplates: `complete` is false when Meta had more templates than one listing reads. */
export const whatsappTemplateListDto = v.object({
  templates: v.array(whatsappTemplateDto),
  complete: v.boolean(),
});

export function toWhatsappTemplateDto(template: ParsedTemplate): WhatsappTemplateDto {
  return {
    name: template.name,
    language: template.language,
    category: template.category,
    parameterFormat: template.parameterFormat,
    ...(template.header !== undefined ? { header: template.header } : {}),
    body: template.body,
    ...(template.footer !== undefined ? { footer: template.footer } : {}),
    buttons: template.buttons,
    variables: template.variables,
    supported: template.unsupported === undefined,
    ...(template.unsupported !== undefined ? { unsupportedReason: template.unsupported } : {}),
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

const cleanupStatusValidator = v.union(
  v.literal("pending"),
  v.literal("done"),
  v.literal("failed"),
);

/**
 * A disconnected account's Meta cleanup: unsubscribing our app from the WABA's webhooks, then
 * deleting the stored token. `pending` while it retries, `done` when finished (unsubscribed, or
 * not needed), `failed` when it gave up (the token is deleted anyway). How it finished is kept
 * in the audit log, not here (it could reveal that another org uses the WABA).
 */
export const whatsappCleanupDto = v.object({
  status: cleanupStatusValidator,
  /** When the next automatic attempt runs (pending only). */
  retryAfter: v.optional(v.string()),
});

/** Outcome of disconnectAccount. */
export const whatsappDisconnectResultDto = v.object({
  accountId: v.string(),
  cleanup: cleanupStatusValidator,
  retryAfter: v.optional(v.string()),
});
export type WhatsappDisconnectResultDto = Infer<typeof whatsappDisconnectResultDto>;

export function toWhatsappDisconnectResultDto(
  accountId: string,
  cleanup: { status: "pending" | "done" | "failed"; nextAttemptAt?: number } | null,
): WhatsappDisconnectResultDto {
  return {
    accountId,
    cleanup: cleanup?.status ?? "done",
    ...optionalIso("retryAfter", cleanup?.status === "pending" ? cleanup.nextAttemptAt : undefined),
  };
}

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
  /** After a disconnect: the Meta cleanup (ADR 0014 B4). */
  cleanup: v.optional(whatsappCleanupDto),
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
    ...(account.offboarding !== undefined
      ? {
          cleanup: {
            status: account.offboarding.status,
            ...optionalIso(
              "retryAfter",
              account.offboarding.status === "pending"
                ? account.offboarding.nextAttemptAt
                : undefined,
            ),
          },
        }
      : {}),
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
