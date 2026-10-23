import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type DatabaseReader } from "../_generated/server";
import { AUDIT_ACTIONS, writeAudit } from "../lib/audit";
import { apiError } from "../lib/errors";
import {
  MAX_RECOVERY_ATTEMPTS,
  OPERATOR_SUBJECT,
  RECOVERY_BATCH_SIZE,
  RETRY_GIVE_UP_AFTER_MS,
  STUCK_EVENT_AFTER_MS,
} from "./config";

/**
 * Stuck-event recovery (cron, convex/crons.ts).
 *
 * Processing runs up to PROCESS_BATCH_SIZE events in one transaction, so a single event that
 * keeps throwing rolls the whole batch back and leaves every event in it `pending`. This
 * sweep finds events still pending STUCK_EVENT_AFTER_MS after receipt and retries each one ON
 * ITS OWN: healthy events then succeed, and only the failing one keeps failing.
 *
 * Each retry's scheduled job id is stored on the event. While that job is still queued the
 * retry is neither counted nor scheduled again, so a scheduler backlog cannot use up the
 * event's retries. Once the job is no longer queued and the event is still pending, the retry
 * is over without having processed the event, whatever Convex says about the job (failed,
 * canceled, succeeded, or its record already gone: Convex keeps finished jobs for 7 days only),
 * and it counts. So every event is `failed` after at most MAX_RECOVERY_ATTEMPTS finished
 * retries, without relying on job records being kept. A retry still queued
 * RETRY_GIVE_UP_AFTER_MS after it was scheduled is canceled and the event marked `failed`, so a
 * job that never leaves the queue cannot keep an event pending forever. `failed` events keep
 * their body for an operator to requeue once the cause is fixed, until retention deletes them
 * (EVENT_RETENTION_MS after receipt, convex/whatsapp/retention.ts). Processing itself is
 * idempotent, so a retry that runs beside the original batch, or after it succeeded, changes
 * nothing.
 */

/**
 * Where the event's latest retry stands. Retention uses it too: it never deletes the event of a
 * queued retry.
 */
export async function retryOf(
  db: DatabaseReader,
  row: Doc<"whatsappWebhookEvents">,
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
      .query("whatsappWebhookEvents")
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
        // Never run in time: cancel it, so it cannot run after the event is marked failed.
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
        internal.whatsapp.processing.processEvents,
        { eventIds: [row._id] },
      );
      // Writing the job id is the claim: a concurrent sweep conflicts on this row, re-runs,
      // and then sees the queued job.
      await ctx.db.patch(row._id, { attempts, retryJobId, lastAttemptAt: now });
      retried++;
    }
    return { retried, failed, waiting };
  },
});

/**
 * Operator requeue of a `failed` event once its cause is fixed: back to `pending` with fresh
 * retries, processed on its own, and recorded in the event's org audit log. Anything not
 * `failed` is left alone, and an event that retention has already deleted returns false.
 *
 * Internal function: only someone with admin access to the deployment can run it (Convex
 * dashboard function runner, or `npx convex run` with a deploy key). `actorSubject` is supplied
 * by that operator and is NOT verified by this application; it must be `operator:<name>` so the
 * audit log never presents it as an authenticated user (JWT subjects) or a system job.
 */
export const requeueFailedEvent = internalMutation({
  args: { eventId: v.id("whatsappWebhookEvents"), actorSubject: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { eventId, actorSubject }) => {
    if (!OPERATOR_SUBJECT.test(actorSubject)) {
      throw apiError("INVALID_ARGUMENT", "actorSubject must be operator:<name>.", {
        field: "actorSubject",
      });
    }
    const row = await ctx.db.get(eventId);
    if (row === null || row.status !== "failed" || row.event === undefined) return false;
    const now = Date.now();
    const retryJobId = await ctx.scheduler.runAfter(0, internal.whatsapp.processing.processEvents, {
      eventIds: [row._id],
    });
    await ctx.db.patch(row._id, {
      status: "pending",
      attempts: 0,
      retryJobId,
      lastAttemptAt: now,
      failedAt: undefined,
    });
    const org = await ctx.db.get(row.orgId);
    await writeAudit(
      ctx.db,
      { orgId: row.orgId, issuer: org?.issuer ?? "", subject: actorSubject },
      {
        action: AUDIT_ACTIONS.whatsappEventRequeued,
        targetType: "whatsappWebhookEvent",
        targetId: row._id,
        changes: {
          status: { from: "failed", to: "pending" },
          attempts: { from: row.attempts ?? 0, to: 0 },
        },
      },
    );
    return true;
  },
});
