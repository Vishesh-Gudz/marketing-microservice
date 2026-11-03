import { defineTable } from "convex/server";
import { v } from "convex/values";
import { savedReplyChannelValidator } from "../messaging/savedReplies";
import { orgIdField } from "./common";

// Saved replies (ADR 0021): an org's reusable inbox answers, shared by WhatsApp and Instagram.
// Tenant-owned; business text only, never customer data.

export const savedReplyTables = {
  savedReplies: defineTable({
    orgId: orgIdField,
    title: v.string(),
    text: v.string(),
    /** The channels it is offered in (at least one). */
    channels: v.array(savedReplyChannelValidator),
    /** Instagram only: quick-reply buttons sent with it. */
    quickReplies: v.optional(v.array(v.string())),
    createdBySubject: v.string(),
    updatedBySubject: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_org_title", ["orgId", "title"]),
};
