import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc } from "../../_generated/dataModel";
import { internalMutation, type DatabaseReader } from "../../_generated/server";
import {
  MAX_RECOVERY_ATTEMPTS,
  RECOVERY_BATCH_SIZE,
  RETRY_GIVE_UP_AFTER_MS,
  STUCK_EVENT_AFTER_MS,
} from "./config";

/**
 * Stuck-event recovery for Instagram webhook events (cron, convex/crons.ts), the same rules as
 * WhatsApp's (convex/whatsapp/recovery.ts, which documents them in full):
 *
 * - Events still `pending` STUCK_EVENT_AFTER_MS after receipt are retried ONE BY ONE, so a
 *   single failing event no longer holds back its batch.
 * - A retry's job id is stored on the event; while that job is queued it is neither counted nor
 *   scheduled again. Once it is no longer queued and the event is still pending, it counts.
 * - After MAX_RECOVERY_ATTEMPTS counted retries, or a retry still queued RETRY_GIVE_UP_AFTER_MS
 *   after it was scheduled (then canceled), the event is `failed`. It keeps its body until
 *   retention deletes it (retention.ts). There is no requeue function yet.
 */

/** Where the event's latest retry stands. Retention uses it too. */
export async function retryOf(
  db: DatabaseReader,
  row: Doc<"instagramWebhookEvents">,
): Promise<"none" | "queued" | "finished"> {
  if (row.retryJobId === undefined) return "none";
  const job = await db.system.get(row.retryJobId);
  if (job !== null && (job.state.kind === "pending" || job.state.kind === "inProgress")) {
    return "queued";
  }
  return "finished";
}

export const recoverStuckEvents = internalMutation({
  args: {},
  returns: v.object({ retried: v.number(), failed: v.number(), waiting: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    // Approved global index: pending events received before the cutoff, across orgs.
    const stale = await ctx.db
      .query("instagramWebhookEvents")
      .withIndex("by_status_received", (q) =>
        q.eq("status", "pending").lt("receivedAt", now - STUCK_EVENT_AFTER_MS),
      )
      .take(RECOVERY_BATCH_SIZE);

    let retried = 0;
    let failed = 0;
    let waiting = 0;
    for (const row of stale) {
      const retry = await retryOf(ctx.db, row);
      if (retry === "queued") {
        if (now - (row.lastAttemptAt ?? row.receivedAt) < RETRY_GIVE_UP_AFTER_MS) {
          waiting++;
          continue;
        }
        await ctx.scheduler.cancel(row.retryJobId!);
        await ctx.db.patch(row._id, { status: "failed", failedAt: now });
        failed++;
        continue;
      }
      const attempts = (row.attempts ?? 0) + (retry === "finished" ? 1 : 0);
      if (attempts >= MAX_RECOVERY_ATTEMPTS) {
        await ctx.db.patch(row._id, { status: "failed", attempts, failedAt: now });
        failed++;
        continue;
      }
      const retryJobId = await ctx.scheduler.runAfter(
        0,
        internal.instagram.messaging.processing.processEvents,
        { eventIds: [row._id] },
      );
      // Writing the job id is the claim: a concurrent sweep conflicts on this row and re-runs.
      await ctx.db.patch(row._id, { attempts, retryJobId, lastAttemptAt: now });
      retried++;
    }
    return { retried, failed, waiting };
  },
});
