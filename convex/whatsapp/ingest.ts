import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation } from "../_generated/server";
import { PROCESS_BATCH_SIZE } from "./config";
import { resolveWebhookNumber } from "./phoneNumbers";
import { webhookChangeValidator, type WebhookEventInput } from "./validators";

/**
 * Webhook ingestion: the single, fast transaction behind a verified delivery.
 *
 * 1. Each change is routed ONLY through the registered phone_number_id (+ matching WABA id).
 *    Unknown, ambiguous or mismatched numbers are counted and dropped; the delivery is still
 *    acknowledged so Meta does not retry it forever.
 * 2. Each event is stored once per org under its dedupe key. Retried or duplicated deliveries
 *    (and duplicates inside one delivery) find the key and are not stored or scheduled again.
 * 3. Processing (conversations, messages, statuses) is scheduled asynchronously in bounded
 *    batches, so the HTTP response returns as soon as this mutation commits.
 */

export function dedupeKeyOf(event: WebhookEventInput): string {
  return event.kind === "message"
    ? `message:${event.wamid}`
    : `status:${event.wamid}:${event.status}`;
}

export const recordDelivery = internalMutation({
  args: { changes: v.array(webhookChangeValidator) },
  returns: v.object({ accepted: v.number(), duplicates: v.number(), unrouted: v.number() }),
  handler: async (ctx, { changes }) => {
    const now = Date.now();
    let accepted = 0;
    let duplicates = 0;
    let unrouted = 0;
    const stored: Id<"whatsappWebhookEvents">[] = [];
    const routes = new Map<string, Doc<"whatsappPhoneNumbers"> | null>();

    for (const change of changes) {
      const routeKey = `${change.phoneNumberId}|${change.wabaId}`;
      let number = routes.get(routeKey);
      if (number === undefined) {
        number = await resolveWebhookNumber(ctx.db, change);
        routes.set(routeKey, number);
      }
      if (number === null) {
        unrouted += change.events.length;
        continue;
      }
      for (const event of change.events) {
        const dedupeKey = dedupeKeyOf(event);
        const existing = await ctx.db
          .query("whatsappWebhookEvents")
          .withIndex("by_org_dedupe", (q) => q.eq("orgId", number.orgId).eq("dedupeKey", dedupeKey))
          .first();
        if (existing !== null) {
          duplicates++;
          continue;
        }
        stored.push(
          await ctx.db.insert("whatsappWebhookEvents", {
            orgId: number.orgId,
            numberId: number._id,
            dedupeKey,
            kind: event.kind,
            wamid: event.wamid,
            event,
            status: "pending",
            receivedAt: now,
          }),
        );
        accepted++;
      }
    }

    for (let i = 0; i < stored.length; i += PROCESS_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.whatsapp.processing.processEvents, {
        eventIds: stored.slice(i, i + PROCESS_BATCH_SIZE),
      });
    }
    return { accepted, duplicates, unrouted };
  },
});
