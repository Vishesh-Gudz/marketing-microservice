import { v, type Infer } from "convex/values";
import { literalUnion } from "../domain/validators";
import { INBOUND_MESSAGE_TYPES, STATUS_VALUES } from "./payload";

/** Validators shared by the WhatsApp tables and internal functions (ADR 0013). */

export const deliveryStatusValidator = literalUnion(STATUS_VALUES);

export const inboundMessageTypeValidator = literalUnion(INBOUND_MESSAGE_TYPES);

/** A parsed inbound message event (convex/whatsapp/payload.ts `InboundMessageEvent`). */
export const messageEventValidator = v.object({
  kind: v.literal("message"),
  wamid: v.string(),
  from: v.string(),
  contactName: v.optional(v.string()),
  timestampMs: v.number(),
  messageType: inboundMessageTypeValidator,
  text: v.optional(v.string()),
});

/** A parsed delivery-status event (convex/whatsapp/payload.ts `StatusEvent`). */
export const statusEventValidator = v.object({
  kind: v.literal("status"),
  wamid: v.string(),
  status: deliveryStatusValidator,
  timestampMs: v.number(),
  recipientWaId: v.string(),
  errorCode: v.optional(v.number()),
});

/**
 * Coexistence (ADR 0019): a message the business sent from the WhatsApp Business app
 * (`smb_message_echoes`; convex/whatsapp/payload.ts `EchoEvent`).
 */
export const echoEventValidator = v.object({
  kind: v.literal("echo"),
  wamid: v.string(),
  /** The customer's WhatsApp id. */
  to: v.string(),
  timestampMs: v.number(),
  messageType: inboundMessageTypeValidator,
  text: v.optional(v.string()),
});

/** Coexistence: one message of the imported chat history (`history`; payload.ts `HistoryEvent`). */
export const historyEventValidator = v.object({
  kind: v.literal("history"),
  wamid: v.string(),
  /** The customer's WhatsApp id (the history thread's id). */
  contactWaId: v.string(),
  /** Sent by the business (true) or by the customer. */
  fromBusiness: v.boolean(),
  timestampMs: v.number(),
  messageType: inboundMessageTypeValidator,
  text: v.optional(v.string()),
  /** The business's messages only: how far it got, as Meta reports it. */
  deliveryStatus: v.optional(deliveryStatusValidator),
});

/**
 * Coexistence: a contact saved in the WhatsApp Business app was added or removed
 * (`smb_app_state_sync`; payload.ts `ContactEvent`). Only the name is kept.
 */
export const contactEventValidator = v.object({
  kind: v.literal("contact"),
  /** The contact's WhatsApp id (their phone number's digits). */
  waId: v.string(),
  action: v.union(v.literal("add"), v.literal("remove")),
  name: v.optional(v.string()),
  timestampMs: v.number(),
});

export const webhookEventValidator = v.union(
  messageEventValidator,
  statusEventValidator,
  echoEventValidator,
  historyEventValidator,
  contactEventValidator,
);
export type WebhookEventInput = Infer<typeof webhookEventValidator>;

export const webhookChangeValidator = v.object({
  wabaId: v.string(),
  phoneNumberId: v.string(),
  events: v.array(webhookEventValidator),
});

export const phoneNumberStatusValidator = v.union(v.literal("active"), v.literal("disconnected"));

/** How a number was registered (ADR 0014). Absent on rows from before it existed: operator. */
export const phoneNumberSourceValidator = v.union(
  v.literal("operator"),
  v.literal("embedded_signup"),
);

/** A WhatsApp Business Account connected by an org (ADR 0014). */
export const businessAccountStatusValidator = v.union(
  v.literal("active"),
  v.literal("disconnected"),
);

/**
 * How the WABA's numbers were onboarded: a number new to the Cloud API, or one the business keeps
 * using in the WhatsApp Business app (coexistence, ADR 0019).
 */
export const onboardingTypeValidator = v.union(v.literal("cloud_api"), v.literal("coexistence"));
export type OnboardingType = Infer<typeof onboardingTypeValidator>;

/**
 * A coexistence number's imports (ADR 0019): when it was onboarded (the 24-hour import window
 * starts then), and when Meta accepted each import request, with its `request_id` (kept for
 * support). A claim holds the imports while one call runs; attempts are capped.
 */
export const coexistenceStateValidator = v.object({
  onboardedAt: v.number(),
  contactsImportedAt: v.optional(v.number()),
  contactsRequestId: v.optional(v.string()),
  historyImportedAt: v.optional(v.number()),
  historyRequestId: v.optional(v.string()),
  importAttempts: v.optional(v.number()),
  importClaimedUntil: v.optional(v.number()),
});

/**
 * Where a stored message came from, when not this app: sent from the WhatsApp Business app
 * (an echo), or imported with the chat history. Absent: received here or sent from here.
 */
export const messageOriginValidator = v.union(v.literal("business_app"), v.literal("history"));

/**
 * Message lifecycle. Inbound messages are `received`. Outbound: `pending` (stored, not yet
 * accepted by Meta) -> `submitted` (accepted, wamid known) -> `sent` -> `delivered` -> `read`,
 * or `failed`. Webhook statuses only ever move a message forward (convex/whatsapp/status.ts).
 * `unknown`: Meta's answer to the send never arrived or could not be read (timeout, network,
 * 5xx), so the message may or may not have gone out. Meta has no idempotency key, so it is
 * never sent again automatically, and without a wamid no status can reach it (final).
 */
export const MESSAGE_STATUSES = [
  "received",
  "pending",
  "submitted",
  "sent",
  "delivered",
  "read",
  "failed",
  "unknown",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export const messageStatusValidator = literalUnion(MESSAGE_STATUSES);

/** Stored message types: every inbound type, plus outbound templates. */
export const MESSAGE_TYPES = [...INBOUND_MESSAGE_TYPES, "template"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export const messageTypeValidator = literalUnion(MESSAGE_TYPES);

/**
 * A new template as the dashboard submits it (ADR 0020; convex/whatsapp/templateDrafts.ts
 * TemplateDraft, which checks every rule).
 */
export const templateDraftValidator = v.object({
  name: v.string(),
  language: v.string(),
  category: v.union(v.literal("MARKETING"), v.literal("UTILITY")),
  header: v.optional(v.string()),
  body: v.string(),
  footer: v.optional(v.string()),
  buttons: v.array(
    v.union(
      v.object({ type: v.literal("QUICK_REPLY"), text: v.string() }),
      v.object({
        type: v.literal("URL"),
        text: v.string(),
        url: v.string(),
        example: v.optional(v.string()),
      }),
      v.object({ type: v.literal("PHONE_NUMBER"), text: v.string(), phoneNumber: v.string() }),
    ),
  ),
  examples: v.array(
    v.object({
      component: v.union(v.literal("header"), v.literal("body")),
      name: v.string(),
      value: v.string(),
    }),
  ),
});

/** One text value sent for a template placeholder (convex/whatsapp/graph.ts TemplateParameter). */
const templateParameterValidator = v.object({
  type: v.literal("text"),
  text: v.string(),
  parameter_name: v.optional(v.string()),
});

/**
 * An outbound template message as sent (convex/whatsapp/templates.ts checkValues): its name,
 * language and the exact `components` values, checked against the approved template when the
 * user sent it.
 */
export const outboundTemplateValidator = v.object({
  name: v.string(),
  language: v.string(),
  components: v.array(
    v.union(
      v.object({
        type: v.union(v.literal("header"), v.literal("body")),
        parameters: v.array(templateParameterValidator),
      }),
      v.object({
        type: v.literal("button"),
        sub_type: v.literal("url"),
        index: v.string(),
        parameters: v.array(templateParameterValidator),
      }),
    ),
  ),
});
