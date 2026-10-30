import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * System sweep state (IM7.0). GLOBAL table (approved in convex/schema.test.ts): a sweep runs
 * across orgs on behalf of no tenant; its row holds a pagination cursor and run bookkeeping,
 * never tenant data. One row per sweep, found by `name`.
 */
export const maintenanceTables = {
  maintenanceCursors: defineTable({
    name: v.literal("revokedCredentials"),
    /** Where the current pass continues; null at the start of a pass. */
    cursor: v.union(v.string(), v.null()),
    /** The run that owns the sweep, until `leaseUntil`. */
    chainId: v.optional(v.string()),
    leaseUntil: v.optional(v.number()),
    pagesInPass: v.number(),
    passStartedAt: v.optional(v.number()),
    lastPageAt: v.optional(v.number()),
    lastPassCompletedAt: v.optional(v.number()),
    /** Times the stored cursor could not be read and a new pass started. */
    cursorResets: v.number(),
    updatedAt: v.number(),
  }).index("by_name", ["name"]),
};
