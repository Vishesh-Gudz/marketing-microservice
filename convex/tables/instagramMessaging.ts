import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  messagingAccountStatusValidator,
  messageOriginValidator,
  messageStatusValidator,
  messageTypeValidator,
  webhookEventKindValidator,
  webhookEventValidator,
} from "../instagram/messaging/validators";
import { messageDirectionValidator, webhookEventStatusValidator } from "../messaging/validators";
import { orgIdField } from "./common";

// Instagram direct messages (ADR 0017), separate from the WhatsApp tables. Every table is
// tenant-owned. The only global indexes are the webhook's tenant lookup by Instagram account id
// and the event recovery / retention sweep (both approved in convex/schema.test.ts). Message
// texts are stored for the inbox, never logged.

export const instagramMessagingTables = {
  /**
   * Messaging turned on for one org's linked Instagram account, using the account's own
   * Instagram connection (and token). The ONLY source of tenant identity for Instagram webhook
   * deliveries: at most one org holds an Instagram account (`active` or `action_required`) at a
   * time, enforced by convex/instagram/messaging/accounts.ts. Linking the same account for
   * analytics in several orgs stays allowed.
   */
  instagramMessagingAccounts: defineTable({
    orgId: orgIdField,
    socialAccountId: v.id("socialAccounts"),
    connectionId: v.id("connections"),
    /** Instagram professional account id (`/me.user_id`; webhook `entry[].id` [doc]). */
    igAccountId: v.string(),
    status: messagingAccountStatusValidator,
    /** The signed-in admin who turned messaging on (verified JWT subject). */
    enabledBySubject: v.string(),
    /**
     * When this org's current hold began (enable or re-enable). Webhook events timestamped
     * before it are dropped, so a previous owner's late retries never reach this org.
     */
    activatedAt: v.number(),
    /** When Meta accepted the account's webhook subscription (`subscribed_apps`). */
    subscribedAt: v.optional(v.number()),
    /** The webhook fields that subscription asked for. */
    subscribedFields: v.optional(v.array(v.string())),
    /**
     * Webhook-subscription attempts started on this row (only ever increases). A subscription
     * result is applied only while the row is still on the hold (`activatedAt`) and the attempt
     * that started it (convex/instagram/messaging/lifecycle.ts); anything later wins.
     */
    setupAttempt: v.optional(v.number()),
    /** Latest failed setup step (sanitized reason code only); cleared when it succeeds. */
    setupError: v.optional(
      v.object({ step: v.literal("subscribe"), reason: v.string(), at: v.number() }),
    ),
    disabledAt: v.optional(v.number()),
    disabledBySubject: v.optional(v.string()),
    /**
     * D14 (convex/instagram/messaging/purge.ts): set when messaging stops; this account's
     * conversations, messages and webhook events are purged from then on (the end of the
     * 30-day grace period, or at once for a data-deletion request). Cleared by a re-enable
     * within the grace period (history kept) and when the purge is done.
     */
    purgeAfter: v.optional(v.number()),
    /** When the purge began; a re-enable waits until it is done. */
    purgeStartedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_social_account", ["orgId", "socialAccountId"])
    .index("by_org_connection", ["orgId", "connectionId"])
    // GLOBAL (approved exception): webhook deliveries are authenticated as Meta, not as a
    // tenant, so the org is resolved from the Instagram account id; enabling checks that no
    // other org holds the account. Rows found are re-verified before anything is written.
    .index("by_ig_account_status", ["igAccountId", "status"])
    // GLOBAL (approved exception): the hourly purge sweep (no tenant caller) finds turned-off
    // accounts whose grace period ended, across orgs. Each purge re-reads its account and
    // deletes only rows of that account in its own org.
    .index("by_status_purge_after", ["status", "purgeAfter"]),

  /**
   * One webhook event as received, keyed for idempotency (Meta retries and duplicates
   * deliveries). The event body is cleared once processed.
   */
  instagramWebhookEvents: defineTable({
    orgId: orgIdField,
    messagingAccountId: v.id("instagramMessagingAccounts"),
    /**
     * "message:<mid>" (customer messages and echoes share Meta's mid space), "read:<mid>",
     * "edit:<mid>:<editCount>" or "delete:<mid>" (a deletion reuses the original mid).
     */
    dedupeKey: v.string(),
    kind: webhookEventKindValidator,
    mid: v.string(),
    event: v.optional(webhookEventValidator),
    status: webhookEventStatusValidator,
    receivedAt: v.number(),
    processedAt: v.optional(v.number()),
    /** Recovery retries that finished without processing the event (absent = none). */
    attempts: v.optional(v.number()),
    /** Scheduled job of the latest recovery retry; its state decides what the sweep does. */
    retryJobId: v.optional(v.id("_scheduled_functions")),
    /** When the latest recovery retry was scheduled. */
    lastAttemptAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
  })
    .index("by_org_dedupe", ["orgId", "dedupeKey"])
    // The D14 purge deletes an account's events (pending ones too, before its messages).
    .index("by_org_account", ["orgId", "messagingAccountId"])
    // GLOBAL (approved exception): the system recovery sweep finds events still pending long
    // after receipt, across orgs, and the retention sweep deletes old ones no longer pending.
    // Each row is re-checked and handled under its own orgId.
    .index("by_status_received", ["status", "receivedAt"]),

  /** One thread per (messaging account, customer IGSID). */
  instagramConversations: defineTable({
    orgId: orgIdField,
    messagingAccountId: v.id("instagramMessagingAccounts"),
    /** The customer's Instagram-scoped id (IGSID) for this business account. */
    contactIgsid: v.string(),
    contactUsername: v.optional(v.string()),
    contactName: v.optional(v.string()),
    /** When the customer's username and name were last looked up. */
    profileCheckedAt: v.optional(v.number()),
    /** Latest inbound customer message (platform time): opens the 24-hour reply window. */
    lastInboundAt: v.optional(v.number()),
    lastMessageAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_account_contact", ["orgId", "messagingAccountId", "contactIgsid"])
    .index("by_org_last_message", ["orgId", "lastMessageAt"]),

  /** Inbound and outbound messages. `mid` is Meta's message id (absent until accepted). */
  instagramMessages: defineTable({
    orgId: orgIdField,
    conversationId: v.id("instagramConversations"),
    messagingAccountId: v.id("instagramMessagingAccounts"),
    direction: messageDirectionValidator,
    origin: messageOriginValidator,
    mid: v.optional(v.string()),
    messageType: messageTypeValidator,
    /** Cleared when the customer deletes the message. */
    text: v.optional(v.string()),
    /** The mid this message replies to (an id only, never the quoted content). */
    replyToMid: v.optional(v.string()),
    status: messageStatusValidator,
    /** First platform error code of a failed send (never titles or details). */
    errorCode: v.optional(v.number()),
    /** When the message happened: platform time for inbound and echoes, creation time otherwise. */
    platformAt: v.number(),
    sentAt: v.optional(v.number()),
    readAt: v.optional(v.number()),
    failedAt: v.optional(v.number()),
    editedAt: v.optional(v.number()),
    deletedAt: v.optional(v.number()),
    /** Outbound from this app only: the browser's id, so a repeated submit never sends twice. */
    clientMessageId: v.optional(v.string()),
    /** Outbound from this app only: the signed-in user who sent it (verified JWT subject). */
    sentBySubject: v.optional(v.string()),
    /** Outbound from this app only: when the one Meta call was claimed. */
    sendAttemptedAt: v.optional(v.number()),
    /** Outbound, failed or unknown: a sanitized reason code. */
    failureReason: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_mid", ["orgId", "mid"])
    .index("by_org_conversation_platform", ["orgId", "conversationId", "platformAt"])
    .index("by_org_client_message", ["orgId", "clientMessageId"]),
};
