import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, type DatabaseWriter } from "../_generated/server";
import { applyDeliveryStatus } from "./status";
import type { WebhookEventInput } from "./validators";
import { effectiveInboundAt } from "./window";

/**
 * Asynchronous webhook processing (scheduled by convex/whatsapp/ingest.ts).
 *
 * Idempotent by construction: only `pending` events are applied, each in the same transaction
 * that marks it done, and inbound messages are additionally unique per (org, wamid). Running a
 * batch twice, or re-scheduling an already processed event, changes nothing. Scheduled
 * mutations are retried by Convex on transient failure and run exactly once.
 *
 * Every write stays inside the event's org: rows are looked up only through org-first indexes
 * with the event's own orgId.
 */

type EventOutcome = "processed" | "unmatched" | "ignored";

type MessageEvent = Extract<WebhookEventInput, { kind: "message" }>;
type StatusEvent = Extract<WebhookEventInput, { kind: "status" }>;

async function findMessage(db: DatabaseWriter, row: Doc<"whatsappWebhookEvents">) {
  return await db
    .query("whatsappMessages")
    .withIndex("by_org_wamid", (q) => q.eq("orgId", row.orgId).eq("wamid", row.wamid))
    .first();
}

/**
 * Whether a message's contact name replaces the stored one. Meta does not guarantee delivery
 * order, so a name is replaced only by one from a message at the same platform time or later
 * (`at`, the same instant used for the service window). A message from the same second wins: its
 * order cannot be known. Rows from before `contactNameAt` existed date their name by their latest
 * inbound message.
 */
function replacesContactName(conversation: Doc<"whatsappConversations">, at: number): boolean {
  if (conversation.contactName === undefined) return true;
  return at >= (conversation.contactNameAt ?? conversation.lastInboundAt ?? 0);
}

async function applyInboundMessage(
  db: DatabaseWriter,
  row: Doc<"whatsappWebhookEvents">,
  event: MessageEvent,
  now: number,
): Promise<EventOutcome> {
  const number = await db.get(row.numberId);
  if (number === null || number.orgId !== row.orgId) return "ignored";
  if ((await findMessage(db, row)) !== null) return "ignored";

  const at = effectiveInboundAt(event.timestampMs, row.receivedAt);
  const existing = await db
    .query("whatsappConversations")
    .withIndex("by_org_number_contact", (q) =>
      q.eq("orgId", row.orgId).eq("numberId", number._id).eq("contactWaId", event.from),
    )
    .unique();

  let conversationId;
  if (existing === null) {
    conversationId = await db.insert("whatsappConversations", {
      orgId: row.orgId,
      numberId: number._id,
      contactWaId: event.from,
      ...(event.contactName !== undefined
        ? { contactName: event.contactName, contactNameAt: at }
        : {}),
      lastInboundAt: at,
      lastMessageAt: at,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    conversationId = existing._id;
    const name =
      event.contactName !== undefined && replacesContactName(existing, at)
        ? event.contactName
        : undefined;
    await db.patch(existing._id, {
      ...(name !== undefined ? { contactName: name, contactNameAt: at } : {}),
      lastInboundAt: Math.max(existing.lastInboundAt ?? 0, at),
      lastMessageAt: Math.max(existing.lastMessageAt, at),
      updatedAt: now,
    });
  }

  await db.insert("whatsappMessages", {
    orgId: row.orgId,
    conversationId,
    numberId: number._id,
    direction: "inbound",
    wamid: event.wamid,
    messageType: event.messageType,
    ...(event.text !== undefined ? { text: event.text } : {}),
    status: "received",
    platformAt: at,
    createdAt: now,
    updatedAt: now,
  });
  return "processed";
}

async function applyStatus(
  db: DatabaseWriter,
  row: Doc<"whatsappWebhookEvents">,
  event: StatusEvent,
  now: number,
): Promise<EventOutcome> {
  const message = await findMessage(db, row);
  // Not (yet) known to this org: kept so a later send result can still apply it.
  if (message === null) return "unmatched";
  if (message.direction !== "outbound") return "ignored";
  const patch = applyDeliveryStatus(message, event);
  if (patch === null) return "ignored";
  await db.patch(message._id, { ...patch, updatedAt: now });
  return "processed";
}

export const processEvents = internalMutation({
  args: { eventIds: v.array(v.id("whatsappWebhookEvents")) },
  returns: v.object({
    processed: v.number(),
    unmatched: v.number(),
    ignored: v.number(),
    skipped: v.number(),
  }),
  handler: async (ctx, { eventIds }) => {
    const now = Date.now();
    const counts = { processed: 0, unmatched: 0, ignored: 0, skipped: 0 };
    for (const id of eventIds) {
      const row = await ctx.db.get(id);
      if (row === null || row.status !== "pending" || row.event === undefined) {
        counts.skipped++;
        continue;
      }
      const outcome =
        row.event.kind === "message"
          ? await applyInboundMessage(ctx.db, row, row.event, now)
          : await applyStatus(ctx.db, row, row.event, now);
      counts[outcome]++;
      // The event body (which may hold message text) is dropped once applied; an unmatched
      // status keeps it for the send path to apply later.
      await ctx.db.patch(row._id, {
        status: outcome,
        processedAt: now,
        ...(outcome === "unmatched" ? {} : { event: undefined }),
      });
    }
    return counts;
  },
});
