import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation } from "../../_generated/server";
import { messagingHolder } from "./accounts";
import { PROCESS_BATCH_SIZE } from "./config";
import { webhookEntryValidator, type WebhookEventInput } from "./validators";

/**
 * Instagram webhook ingestion: the single, fast transaction behind a verified delivery.
 *
 * 1. Each entry is routed ONLY through the org holding its Instagram account
 *    (`messagingHolder`: exactly one `active` or `action_required` row, re-verified). No holder,
 *    or more than one: its events are counted and dropped; the delivery is still acknowledged
 *    so Meta does not retry it for 36 hours.
 * 2. Events timestamped before the holder's `activatedAt` are dropped: they happened before
 *    this org's current hold (a previous holder's late retries, or messages sent while
 *    messaging was off).
 * 3. Each event is stored once per org under its dedupe key; retried or duplicated deliveries
 *    find the key and change nothing. Processing is scheduled in bounded batches.
 */

export function dedupeKeyOf(event: WebhookEventInput): string {
  switch (event.kind) {
    case "message":
    case "echo":
      return `message:${event.mid}`;
    case "read":
      return `read:${event.mid}`;
    case "edit":
      return `edit:${event.mid}:${event.editCount}`;
    case "delete":
      return `delete:${event.mid}`;
  }
}

export const recordDelivery = internalMutation({
  args: { entries: v.array(webhookEntryValidator) },
  returns: v.object({
    accepted: v.number(),
    duplicates: v.number(),
    unrouted: v.number(),
    beforeActivation: v.number(),
  }),
  handler: async (ctx, { entries }) => {
    const now = Date.now();
    const counts = { accepted: 0, duplicates: 0, unrouted: 0, beforeActivation: 0 };
    const stored: Id<"instagramWebhookEvents">[] = [];
    const holders = new Map<string, Doc<"instagramMessagingAccounts"> | null>();

    for (const entry of entries) {
      let holder = holders.get(entry.igAccountId);
      if (holder === undefined) {
        holder = await messagingHolder(ctx.db, entry.igAccountId);
        holders.set(entry.igAccountId, holder);
      }
      if (holder === null) {
        counts.unrouted += entry.events.length;
        continue;
      }
      for (const event of entry.events) {
        if (event.timestampMs < holder.activatedAt) {
          counts.beforeActivation++;
          continue;
        }
        const dedupeKey = dedupeKeyOf(event);
        const existing = await ctx.db
          .query("instagramWebhookEvents")
          .withIndex("by_org_dedupe", (q) => q.eq("orgId", holder.orgId).eq("dedupeKey", dedupeKey))
          .first();
        if (existing !== null) {
          counts.duplicates++;
          continue;
        }
        stored.push(
          await ctx.db.insert("instagramWebhookEvents", {
            orgId: holder.orgId,
            messagingAccountId: holder._id,
            dedupeKey,
            kind: event.kind,
            mid: event.mid,
            event,
            status: "pending",
            receivedAt: now,
          }),
        );
        counts.accepted++;
      }
    }

    for (let i = 0; i < stored.length; i += PROCESS_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.instagram.messaging.processing.processEvents, {
        eventIds: stored.slice(i, i + PROCESS_BATCH_SIZE),
      });
    }
    return counts;
  },
});
