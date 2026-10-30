import { v } from "convex/values";

/**
 * Validators shared by the WhatsApp inbox (ADR 0013) and Instagram messaging (ADR 0017): both
 * store webhook events the same way and record messages in both directions.
 */

/** Processing state of a stored webhook event. */
export const webhookEventStatusValidator = v.union(
  /** Stored, waiting for the scheduled processor. */
  v.literal("pending"),
  /** Applied to conversations / messages; the event body has been cleared. */
  v.literal("processed"),
  /**
   * A status for a message this org has no record of (yet). The body is kept so a later
   * outbound-send result can still apply it (out-of-order delivery).
   */
  v.literal("unmatched"),
  /** Valid but nothing to apply (e.g. a status that would move a message backwards). */
  v.literal("ignored"),
  /**
   * Processing kept failing: still pending after every recovery retry
   * (convex/whatsapp/recovery.ts). The body is kept so an admin can requeue it after a fix,
   * until retention deletes the event 30 days after receipt (convex/whatsapp/retention.ts).
   */
  v.literal("failed"),
);

export const messageDirectionValidator = v.union(v.literal("inbound"), v.literal("outbound"));
