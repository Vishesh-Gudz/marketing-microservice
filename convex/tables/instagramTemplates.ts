import { defineTable } from "convex/server";
import { v } from "convex/values";
import { templateContentValidator } from "../instagram/messaging/templates";
import { orgIdField } from "./common";

// Instagram templates (ADR 0022): an org's reusable rich messages for Instagram DMs (button
// messages and cards). Tenant-owned; business content only, never customer data. Stored here
// only: Instagram has no Meta-approved templates.

export const instagramTemplateTables = {
  instagramTemplates: defineTable({
    orgId: orgIdField,
    /** Unique per org; only the team sees it. */
    name: v.string(),
    content: templateContentValidator,
    createdBySubject: v.string(),
    updatedBySubject: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_org_name", ["orgId", "name"]),
};
