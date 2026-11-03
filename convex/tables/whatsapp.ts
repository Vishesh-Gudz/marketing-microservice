import { defineTable } from "convex/server";
import { v } from "convex/values";
import { messageDirectionValidator, webhookEventStatusValidator } from "../messaging/validators";
import {
  businessAccountStatusValidator,
  coexistenceStateValidator,
  messageOriginValidator,
  messageStatusValidator,
  messageTypeValidator,
  onboardingTypeValidator,
  outboundTemplateValidator,
  phoneNumberSourceValidator,
  phoneNumberStatusValidator,
  webhookEventValidator,
} from "../whatsapp/validators";
import { orgIdField } from "./common";

// WhatsApp inbox (ADR 0013) and connections (ADR 0014). Every table is tenant-owned. The only
// global indexes are the webhook's tenant lookup by Meta phone_number_id, the event recovery
// sweep and the WABA ownership check (all approved in convex/schema.test.ts). Message bodies
// are stored for the inbox but never logged.

export const whatsappTables = {
  /**
   * A WhatsApp Business Account an org connected through Embedded Signup (ADR 0014). Its
   * business token is the credential of `connectionId` (provider "whatsapp", keyed by the WABA
   * id, which is verified with Meta; no documented API verifies the owning business). At most
   * one `active` row per WABA across all orgs (enforced by convex/whatsapp/accounts.ts).
   */
  whatsappBusinessAccounts: defineTable({
    orgId: orgIdField,
    connectionId: v.id("connections"),
    wabaId: v.string(),
    onboardingType: onboardingTypeValidator,
    status: businessAccountStatusValidator,
    connectedBySubject: v.string(),
    /** When the app was subscribed to the WABA's webhooks. */
    subscribedAt: v.optional(v.number()),
    /** Latest failed setup step (sanitized reason code only); cleared when it succeeds. */
    setupError: v.optional(
      v.object({
        step: v.union(v.literal("subscribe"), v.literal("register"), v.literal("import")),
        reason: v.string(),
        at: v.number(),
      }),
    ),
    disconnectedAt: v.optional(v.number()),
    /**
     * Who disconnected the account: the signed-in admin (ADR 0014 B4), or
     * `system:whatsapp-webhook` when Meta confirmed a partner removal (B4b).
     */
    disconnectedBySubject: v.optional(v.string()),
    /**
     * Meta cleanup after a disconnect (convex/whatsapp/offboarding.ts): unsubscribing our app
     * from the WABA's webhooks with the stored token, then deleting the credential. `pending`
     * until it is done or gives up (`failed`); a new signup for the WABA waits until then.
     */
    offboarding: v.optional(
      v.object({
        status: v.union(v.literal("pending"), v.literal("done"), v.literal("failed")),
        /** How it finished (done): unsubscribed, skipped (WABA still used), token refused, or no token. */
        result: v.optional(
          v.union(
            v.literal("unsubscribed"),
            v.literal("skipped_shared"),
            v.literal("token_invalid"),
            v.literal("credential_missing"),
          ),
        ),
        /** Sanitized reason code of the latest failed attempt. */
        lastFailure: v.optional(v.string()),
        /** Cleanup attempts made (each counted when claimed). */
        attempts: v.number(),
        startedAt: v.number(),
        /** The next scheduled attempt (pending only). */
        nextAttemptAt: v.optional(v.number()),
        /** An attempt holds the cleanup until then (one at a time; expires alone). */
        claimedUntil: v.optional(v.number()),
        finishedAt: v.optional(v.number()),
      }),
    ),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_waba", ["orgId", "wabaId"])
    .index("by_org_connection", ["orgId", "connectionId"])
    // GLOBAL (approved exception): one org per WABA. Connecting must see whether ANOTHER org
    // has the WABA active (its webhook subscription and numbers would be shared otherwise);
    // the row found is only compared there. A PARTNER_REMOVED webhook (B4b, authenticated as
    // Meta, not as a tenant) resolves the one active row for its WABA; that org's account is
    // written only after Meta refuses the org's own token, re-checked in the same transaction.
    .index("by_waba_status", ["wabaId", "status"]),

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
    /** Absent = "operator" (rows registered before ADR 0014). */
    source: v.optional(phoneNumberSourceValidator),
    /** The connected WABA this number belongs to (Embedded Signup numbers only). */
    accountId: v.optional(v.id("whatsappBusinessAccounts")),
    /** When Meta accepted the number's Cloud API registration (Embedded Signup numbers). */
    platformRegisteredAt: v.optional(v.number()),
    /** Registration calls made for this number (capped; Meta allows 10 per 72 hours). */
    registrationAttempts: v.optional(v.number()),
    /** Meta reported its registration rate limit (133016): no registration call before this. */
    registrationBlockedUntil: v.optional(v.number()),
    /** A registration call holds this number until then (one call at a time; expires alone). */
    registrationClaimedUntil: v.optional(v.number()),
    /**
     * Coexistence numbers only (ADR 0019): the number stays in the WhatsApp Business app, needs
     * no Cloud API registration (`platformRegisteredAt` is set at signup) and has its contacts
     * and chat history imported once.
     */
    coexistence: v.optional(coexistenceStateValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_phone_number", ["orgId", "phoneNumberId"])
    .index("by_org_account", ["orgId", "accountId"])
    // GLOBAL (approved exception): webhook deliveries are authenticated as Meta, not as a
    // tenant; the org is resolved from phone_number_id and the row is re-verified (active,
    // WABA match, unique) before anything is written.
    .index("by_phone_number_status", ["phoneNumberId", "status"])
    // GLOBAL (approved exception, ADR 0014 B4): before a disconnected account's WABA is
    // unsubscribed from our app's webhooks, the cleanup checks whether any org still has an
    // active number on that WABA (an operator-managed number, or another org's). Rows found are
    // only counted, never returned or written.
    .index("by_waba_status", ["wabaId", "status"]),

  /**
   * One webhook event (message or status) as received, keyed for idempotency. Meta retries and
   * duplicates deliveries; a second copy of an event finds its dedupe key and is not stored or
   * processed again. The event body is cleared once processed.
   */
  whatsappWebhookEvents: defineTable({
    orgId: orgIdField,
    numberId: v.id("whatsappPhoneNumbers"),
    /**
     * "message:<wamid>" (inbound messages, echoes and imported history), "status:<wamid>:<status>"
     * or "contact:<wa_id>:<action>:<timestamp>" (imported contacts).
     */
    dedupeKey: v.string(),
    kind: v.union(
      v.literal("message"),
      v.literal("status"),
      v.literal("echo"),
      v.literal("history"),
      v.literal("contact"),
    ),
    /** The event's wamid; for a contact event, the contact's wa_id. */
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
    // orgId. The retention sweep reads it too, deleting rows no longer pending once older than
    // EVENT_RETENTION_MS (never pending ones, nor any whose retry is still queued).
    .index("by_status_received", ["status", "receivedAt"]),

  /** One customer thread per (business number, customer WhatsApp id). */
  whatsappConversations: defineTable({
    orgId: orgIdField,
    numberId: v.id("whatsappPhoneNumbers"),
    /** Customer's WhatsApp id. */
    contactWaId: v.string(),
    contactName: v.optional(v.string()),
    /**
     * Coexistence (ADR 0019): the name the business saved for the contact in the WhatsApp
     * Business app (contacts import); shown instead of `contactName` when present.
     */
    savedName: v.optional(v.string()),
    /** Platform time of the message that supplied `contactName`; older ones never replace it. */
    contactNameAt: v.optional(v.number()),
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
    /**
     * Outbound only (convex/whatsapp/outbound.ts): the sender's id for this message, chosen by
     * the browser, so a repeated submit returns the same message instead of sending twice.
     */
    clientMessageId: v.optional(v.string()),
    /** Outbound only: the signed-in user who sent it (verified JWT subject). */
    sentBySubject: v.optional(v.string()),
    /** Outbound only: when the one Meta call was claimed; a message is never sent twice. */
    sendAttemptedAt: v.optional(v.number()),
    /** Outbound only, failed or unknown: a sanitized reason code ("meta_131047", "timeout"). */
    failureReason: v.optional(v.string()),
    /**
     * Outbound templates only: the approved template and the values sent. `text` holds what the
     * customer reads (header, body and footer, filled in).
     */
    template: v.optional(outboundTemplateValidator),
    /**
     * Coexistence (ADR 0019): sent from the WhatsApp Business app (`business_app`, outbound) or
     * imported with the chat history (`history`). Absent for messages received or sent here.
     */
    origin: v.optional(messageOriginValidator),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_wamid", ["orgId", "wamid"])
    .index("by_org_conversation_platform", ["orgId", "conversationId", "platformAt"])
    .index("by_org_client_message", ["orgId", "clientMessageId"]),

  /**
   * Coexistence (ADR 0019): the names the business saved in the WhatsApp Business app, per
   * business number and contact, from the contacts import and its later updates. Used only to
   * name conversations (`whatsappConversations.savedName`); a contact removed in the app is
   * deleted here. `changedAt` is the platform time of the latest change applied.
   */
  whatsappContacts: defineTable({
    orgId: orgIdField,
    numberId: v.id("whatsappPhoneNumbers"),
    waId: v.string(),
    name: v.string(),
    changedAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_org_number_contact", ["orgId", "numberId", "waId"]),
};
