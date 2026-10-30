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

export const webhookEventValidator = v.union(messageEventValidator, statusEventValidator);
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
 * How the WABA's numbers were onboarded: a number new to the Cloud API, or one already used in
 * the WhatsApp Business app (coexistence; not supported by the first release).
 */
export const onboardingTypeValidator = v.union(v.literal("cloud_api"), v.literal("coexistence"));

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
