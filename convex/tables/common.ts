import { v } from "convex/values";

/** Owner of every tenant table. Always the first field of every index. */
export const orgIdField = v.id("organizations");

/** Lifecycle fields shared by synced entities (epoch ms). */
export const entityLifecycleFields = {
  /** Last time a sync saw this entity on the platform. */
  lastSeenAt: v.optional(v.number()),
  /** Set when the platform no longer returns the entity. Rows are never hard-deleted by sync. */
  removedAt: v.optional(v.number()),
  createdAt: v.number(),
  updatedAt: v.number(),
};
