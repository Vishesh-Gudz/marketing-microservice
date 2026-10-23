import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  messageDirectionValidator,
  messageStatusValidator,
  messageTypeValidator,
  phoneNumberStatusValidator,
  webhookEventStatusValidator,
  webhookEventValidator,
} from "../whatsapp/validators";
import { orgIdField } from "./common";

// WhatsApp inbox (ADR 0013). Every table is tenant-owned. The only global indexes are the
// webhook's tenant lookup by Meta phone_number_id and the event recovery sweep (both approved
// in convex/schema.test.ts). Message bodies are stored for the inbox but never logged.

export const whatsappTables = {
  /**
   * A WhatsApp business phone number registered to exactly one org. The ONLY source of tenant
   * identity for webhook deliveries: at most one `active` row per Meta phone_number_id across
   * all orgs (enforced by convex/whatsapp/phoneNumbers.ts on register).
   */
  whatsappPhoneNumbers: defineTable({
    orgId: orgIdField,
    /** WhatsApp Business Account id (webhook `entry[].id`; must match on every delivery). */
    wabaId: v.string(),
    /** Meta phone_number_id (webhook `metadata.phone_number_id`). */
    phoneNumberId: v.string(),
    displayPhoneNumber: v.optional(v.string()),
    status: phoneNumberStatusValidator,
    registeredBySubject: v.string(),
    /**
     * When this org's current ownership began (registration or re-activation). Webhook events
     * timestamped before it are dropped, so a moved number's late retries never reach the new
     * owner. Absent on rows registered before it existed: `createdAt` is used instead.
     */
    activatedAt: v.optional(v.number()),
    disconnectedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_phone_number", ["orgId", "phoneNumberId"])
    // GLOBAL (approved exception): webhook deliveries are authenticated as Meta, not as a
    // tenant; the org is resolved from phone_number_id and the row is re-verified (active,
    // WABA match, unique) before anything is written.
    .index("by_phone_number_status", ["phoneNumberId", "status"]),

  /**
   * One webhook event (message or status) as received, keyed for idempotency. Meta retries and
   * duplicates deliveries; a second copy of an event finds its dedupe key and is not stored or
   * processed again. The event body is cleared once processed.
   */
  whatsappWebhookEvents: defineTable({
    orgId: orgIdField,
    numberId: v.id("whatsappPhoneNumbers"),
    /** "message:<wamid>" or "status:<wamid>:<status>". */
    dedupeKey: v.string(),
    kind: v.union(v.literal("message"), v.literal("status")),
    wamid: v.string(),
    event: v.optional(webhookEventValidator),
    status: webhookEventStatusValidator,
    receivedAt: v.number(),
    processedAt: v.optional(v.number()),
    /** Recovery retries that finished without processing the event (absent = none). */
    attempts: v.optional(v.number()),
    /** Scheduled job of the latest recovery retry; its state decides what the sweep does. */
    retryJobId: v.optional(v.id("_scheduled_functions")),
    /** When the latest recovery retry was scheduled; bounds how long a queued retry is awaited. */
    lastAttemptAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
  })
    .index("by_org_dedupe", ["orgId", "dedupeKey"])
    // GLOBAL (approved exception): the system recovery sweep finds events still pending long
    // after receipt, across orgs. It checks each row it reads (and its retry job's state)
    // before acting; the retry it schedules re-reads the row and processes it under its own
    // orgId.
    .index("by_status_received", ["status", "receivedAt"]),

  /** One customer thread per (business number, customer WhatsApp id). */
  whatsappConversations: defineTable({
    orgId: orgIdField,
    numberId: v.id("whatsappPhoneNumbers"),
    /** Customer's WhatsApp id. */
    contactWaId: v.string(),
    contactName: v.optional(v.string()),
    /** Latest inbound customer message (platform time): opens the 24-hour service window. */
    lastInboundAt: v.optional(v.number()),
    lastMessageAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_number_contact", ["orgId", "numberId", "contactWaId"])
    .index("by_org_last_message", ["orgId", "lastMessageAt"]),

  /** Inbound and outbound messages. `wamid` is Meta's message id (absent until accepted). */
  whatsappMessages: defineTable({
    orgId: orgIdField,
    conversationId: v.id("whatsappConversations"),
    numberId: v.id("whatsappPhoneNumbers"),
    direction: messageDirectionValidator,
    wamid: v.optional(v.string()),
    messageType: messageTypeValidator,
    text: v.optional(v.string()),
    status: messageStatusValidator,
    /** First platform error code of a failed message (never titles or details). */
    errorCode: v.optional(v.number()),
    /** When the message happened: platform time for inbound, creation time for outbound. */
    platformAt: v.number(),
    sentAt: v.optional(v.number()),
    deliveredAt: v.optional(v.number()),
    readAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_wamid", ["orgId", "wamid"])
    .index("by_org_conversation_platform", ["orgId", "conversationId", "platformAt"]),
};
