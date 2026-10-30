import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import { EVENT_RETENTION_MS, MAX_RETENTION_CONTINUATIONS, RETENTION_BATCH_SIZE } from "./config";
import { retryOf } from "./recovery";

/**
 * Instagram webhook-event retention (hourly cron, convex/crons.ts), the same rules as WhatsApp's
 * (convex/whatsapp/retention.ts): events no longer pending are deleted EVENT_RETENTION_MS after
 * receipt, in bounded batches with at most MAX_RETENTION_CONTINUATIONS follow-up runs. Never
 * deleted: `pending` events, and events whose recovery retry is still queued. Conversations and
 * messages are never touched (their retention is decided with D14, ADR 0017).
 */

type EventStatus = Doc<"instagramWebhookEvents">["status"];

const EXPIRING_STATUSES: readonly Exclude<EventStatus, "pending">[] = [
  "processed",
  "ignored",
  "unmatched",
  "failed",
];

export const purgeExpiredEvents = internalMutation({
  args: { continuation: v.optional(v.number()) },
  returns: v.object({ deleted: v.number(), waiting: v.number(), continued: v.boolean() }),
  handler: async (ctx, args) => {
    const cutoff = Date.now() - EVENT_RETENTION_MS;
    let examined = 0;
    let deleted = 0;
    let waiting = 0;
    for (const status of EXPIRING_STATUSES) {
      const budget = RETENTION_BATCH_SIZE - examined;
      if (budget === 0) break;
      // Approved global index: expired events of this status, across orgs, oldest first.
      const expired = await ctx.db
        .query("instagramWebhookEvents")
        .withIndex("by_status_received", (q) => q.eq("status", status).lte("receivedAt", cutoff))
        .take(budget);
      examined += expired.length;
      for (const row of expired) {
        if ((await retryOf(ctx.db, row)) === "queued") {
          waiting++;
          continue;
        }
        await ctx.db.delete(row._id);
        deleted++;
      }
    }

    const continuation = args.continuation ?? 0;
    const continued =
      deleted === RETENTION_BATCH_SIZE && continuation < MAX_RETENTION_CONTINUATIONS;
    if (continued) {
      await ctx.scheduler.runAfter(0, internal.instagram.messaging.retention.purgeExpiredEvents, {
        continuation: continuation + 1,
      });
    }
    return { deleted, waiting, continued };
  },
});
