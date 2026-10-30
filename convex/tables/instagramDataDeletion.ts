import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Meta data-deletion requests for the Instagram Login app (ADR 0017, IM6/IM7.0).
 *
 * GLOBAL table (approved in convex/schema.test.ts): a request is addressed to the app by an
 * Instagram user, not by a tenant, and may cover several orgs. It stores no platform data: no
 * Instagram id, username or content, only the confirmation code Meta shows the user, a keyed
 * hash of the signed payload (to answer a repeated delivery with the same code) and the Convex
 * ids of what each org deletes. Every deletion step re-reads its rows under the target's own
 * orgId.
 *
 * Status: `pending` (deletion running) -> `completed` ONLY when every target is verified done
 * AND no older (pre-IM6) Instagram connection remains anywhere; else `review`. An operator may
 * close a review as `closed_unverified` (never `completed`); a later verification still moves it
 * to `completed`.
 */
export const DELETION_REQUEST_STATUSES = [
  "pending",
  "review",
  "completed",
  "closed_unverified",
] as const;

export const instagramDataDeletionTables = {
  instagramDataDeletionRequests: defineTable({
    /** Alphanumeric code returned to Meta and shown on the status page. */
    confirmationCode: v.string(),
    /** HMAC-SHA256 (hex) of the signed payload under the callback secret, or an operator key. */
    requestKey: v.string(),
    /** `meta`: Meta's callback; `operator`: an operator erased an older connection (IM7.0). */
    origin: v.union(v.literal("meta"), v.literal("operator")),
    operatorReason: v.optional(v.string()),
    status: v.union(
      v.literal("pending"),
      v.literal("review"),
      v.literal("completed"),
      v.literal("closed_unverified"),
    ),
    targets: v.array(
      v.object({
        orgId: v.id("organizations"),
        connectionId: v.id("connections"),
        /** Set when the org's part started (the connection was disconnected and marked). */
        begun: v.boolean(),
        socialAccountId: v.optional(v.id("socialAccounts")),
        /** The messaging accounts recorded when the part started: only these are deleted. */
        messagingAccountIds: v.array(v.id("instagramMessagingAccounts")),
        done: v.boolean(),
      }),
    ),
    receivedAt: v.number(),
    /** The hourly sweep resumes a pending request once this has passed. */
    nextAttemptAt: v.number(),
    attempts: v.number(),
    updatedAt: v.number(),
    completedAt: v.optional(v.number()),
    closedAt: v.optional(v.number()),
    closeReason: v.optional(v.string()),
    closedBy: v.optional(v.string()),
  })
    .index("by_confirmation_code", ["confirmationCode"])
    .index("by_request_key", ["requestKey"])
    .index("by_status_next_attempt", ["status", "nextAttemptAt"]),
};
