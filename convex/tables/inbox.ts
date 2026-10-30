import { defineTable } from "convex/server";
import { v } from "convex/values";
import { orgIdField } from "./common";

/**
 * Unified inbox (ADR 0018, IM7.2): an index over the channels' conversations, never a copy of
 * them. One row per conversation, written in the same transaction as the conversation
 * (convex/inbox/threads.ts). Exactly one typed reference is set, the one of `channel`. No contact
 * name, phone number, username, customer id, message text or preview: labels and reply state
 * are read from the channel's own rows, so its retention and privacy rules stay in one place.
 */
export const inboxTables = {
  inboxThreads: defineTable({
    orgId: orgIdField,
    channel: v.union(v.literal("whatsapp"), v.literal("instagram")),
    whatsappConversationId: v.optional(v.id("whatsappConversations")),
    instagramConversationId: v.optional(v.id("instagramConversations")),
    /** The conversation's own `lastMessageAt` (the sort key). */
    lastMessageAt: v.number(),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_last_message", ["orgId", "lastMessageAt"])
    .index("by_org_channel_last_message", ["orgId", "channel", "lastMessageAt"])
    .index("by_org_whatsapp_conversation", ["orgId", "whatsappConversationId"])
    .index("by_org_instagram_conversation", ["orgId", "instagramConversationId"]),
};
