import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { EVENT_RETENTION_MS, MAX_RETENTION_CONTINUATIONS, RETENTION_BATCH_SIZE } from "./config";
import { retryOf } from "./recovery";

/**
 * Webhook-event retention (hourly cron, convex/crons.ts).
 *
 * Deletes `whatsappWebhookEvents` rows that are no longer pending once at least
 * EVENT_RETENTION_MS old (from `receivedAt`): `processed`, `ignored`, `unmatched` and `failed`.
 * Deleting a row removes its dedupe key; a later redelivery of the same event is stored again
 * but changes nothing (inbound messages are unique per org and wamid, delivery statuses only
 * move forward). A `failed` event can be requeued until it is deleted; afterwards there is
 * nothing left to requeue. There is no hold mechanism.
 *
 * Never deleted here, however old:
 * - `pending` events: the stuck-event recovery still owns them.
 * - any event whose recovery retry is still queued, so a queued retry never loses its event.
 *   A retry still queued 30 days after receipt would take a scheduler stall of weeks, so this
 *   is a guard rather than a policy.
 * Messages and conversations are never touched. A processing job that runs after its event was
 * deleted finds no row and skips it.
 *
 * Each run examines at most RETENTION_BATCH_SIZE rows. A run that deletes a full batch schedules
 * a follow-up run, at most MAX_RETENTION_CONTINUATIONS in a chain; the next hourly run continues
 * after that. Rows are read and deleted in the same transaction, so a retried or overlapping
 * run cannot delete anything twice or anything that no longer qualifies: Convex runs mutations
 * serializably and re-runs one whose reads conflict with another's writes.
 */

type EventStatus = Doc<"whatsappWebhookEvents">["status"];

/** Statuses that expire. Excluding `pending` is enforced by the type. */
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
        .query("whatsappWebhookEvents")
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
      await ctx.scheduler.runAfter(0, internal.whatsapp.retention.purgeExpiredEvents, {
        continuation: continuation + 1,
      });
    }
    return { deleted, waiting, continued };
  },
});
