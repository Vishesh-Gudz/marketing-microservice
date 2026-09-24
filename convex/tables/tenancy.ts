import { defineTable } from "convex/server";
import { v } from "convex/values";
import { auditChangesValidator } from "../lib/validation";

// Phase 1 tables (moved here unchanged from schema.ts).

export const tenancyTables = {
  /** Parent applications allowed to call this service (one per trusted JWT issuer). GLOBAL. */
  integrationApps: defineTable({
    issuer: v.string(),
    slug: v.string(),
    name: v.string(),
    status: v.union(v.literal("active"), v.literal("disabled")),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_issuer", ["issuer"])
    .index("by_slug", ["slug"]),

  /** A tenant. Identity = (issuer, externalOrgId) from the verified JWT. GLOBAL. */
  organizations: defineTable({
    issuer: v.string(),
    externalOrgId: v.string(),
    appId: v.id("integrationApps"),
    displayName: v.string(),
    reportingCurrency: v.string(),
    timezone: v.string(),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index("by_issuer_external", ["issuer", "externalOrgId"]),

  /** Successful state changes, written in the same transaction as the change. */
  auditLog: defineTable({
    orgId: v.id("organizations"),
    issuer: v.string(),
    subject: v.string(),
    action: v.string(),
    targetType: v.optional(v.string()),
    targetId: v.optional(v.string()),
    changes: v.optional(auditChangesValidator),
    at: v.number(),
  }).index("by_org_at", ["orgId", "at"]),
};
