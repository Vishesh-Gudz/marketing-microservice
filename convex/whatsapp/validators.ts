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

/** Processing state of a stored webhook event. */
export const webhookEventStatusValidator = v.union(
  /** Stored, waiting for the scheduled processor. */
  v.literal("pending"),
  /** Applied to conversations / messages; the event body has been cleared. */
  v.literal("processed"),
  /**
   * A status for a message this org has no record of (yet). The body is kept so a later
   * outbound-send result can still apply it (out-of-order delivery).
   */
  v.literal("unmatched"),
  /** Valid but nothing to apply (e.g. a status that would move a message backwards). */
  v.literal("ignored"),
  /**
   * Processing kept failing: still pending after every recovery retry
   * (convex/whatsapp/recovery.ts). The body is kept so an admin can requeue it after a fix,
   * until retention deletes the event 30 days after receipt (convex/whatsapp/retention.ts).
   */
  v.literal("failed"),
);

export const messageDirectionValidator = v.union(v.literal("inbound"), v.literal("outbound"));

/**
 * Message lifecycle. Inbound messages are `received`. Outbound: `pending` (stored, not yet
 * accepted by Meta) -> `submitted` (accepted, wamid known) -> `sent` -> `delivered` -> `read`,
 * or `failed`. Webhook statuses only ever move a message forward (convex/whatsapp/status.ts).
 */
export const MESSAGE_STATUSES = [
  "received",
  "pending",
  "submitted",
  "sent",
  "delivered",
  "read",
  "failed",
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];
export const messageStatusValidator = literalUnion(MESSAGE_STATUSES);

/** Stored message types: every inbound type, plus outbound templates. */
export const MESSAGE_TYPES = [...INBOUND_MESSAGE_TYPES, "template"] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];
export const messageTypeValidator = literalUnion(MESSAGE_TYPES);
