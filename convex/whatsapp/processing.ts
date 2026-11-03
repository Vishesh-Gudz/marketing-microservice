import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internalMutation, type DatabaseWriter } from "../_generated/server";
import { touchThread } from "../inbox/threads";
import { applyDeliveryStatus } from "./status";
import type { WebhookEventInput } from "./validators";
import { effectiveInboundAt } from "../messaging/window";

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
 *
 * Coexistence (ADR 0019): an echo (a message the business sent from the WhatsApp Business app)
 * is stored as an outbound `sent` message with origin `business_app`; imported history as
 * received or outbound messages with origin `history`. Neither opens or extends the 24-hour
 * reply window (Meta: only customer messages after the signup do). A contact saved in the app
 * names the customer's conversation (`savedName`); removing it in the app removes the name.
 */

type EventOutcome = "processed" | "unmatched" | "ignored";

type MessageEvent = Extract<WebhookEventInput, { kind: "message" }>;
type StatusEvent = Extract<WebhookEventInput, { kind: "status" }>;
type EchoEvent = Extract<WebhookEventInput, { kind: "echo" }>;
type HistoryEvent = Extract<WebhookEventInput, { kind: "history" }>;
type ContactEvent = Extract<WebhookEventInput, { kind: "contact" }>;

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

/** The name the business saved for this contact in the WhatsApp Business app, if any. */
async function savedNameOf(
  db: DatabaseWriter,
  number: Doc<"whatsappPhoneNumbers">,
  waId: string,
): Promise<string | undefined> {
  if (number.coexistence === undefined) return undefined;
  const contact = await db
    .query("whatsappContacts")
    .withIndex("by_org_number_contact", (q) =>
      q.eq("orgId", number.orgId).eq("numberId", number._id).eq("waId", waId),
    )
    .unique();
  return contact?.name;
}

function optionalSavedName(name: string | undefined): { savedName?: string } {
  return name !== undefined ? { savedName: name } : {};
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
  let lastMessageAt;
  if (existing === null) {
    lastMessageAt = at;
    conversationId = await db.insert("whatsappConversations", {
      orgId: row.orgId,
      numberId: number._id,
      contactWaId: event.from,
      ...(event.contactName !== undefined
        ? { contactName: event.contactName, contactNameAt: at }
        : {}),
      ...optionalSavedName(await savedNameOf(db, number, event.from)),
      lastInboundAt: at,
      lastMessageAt,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    conversationId = existing._id;
    lastMessageAt = Math.max(existing.lastMessageAt, at);
    const name =
      event.contactName !== undefined && replacesContactName(existing, at)
        ? event.contactName
        : undefined;
    await db.patch(existing._id, {
      ...(name !== undefined ? { contactName: name, contactNameAt: at } : {}),
      lastInboundAt: Math.max(existing.lastInboundAt ?? 0, at),
      lastMessageAt,
      updatedAt: now,
    });
  }
  // ADR 0018: the unified inbox's thread row follows the conversation (same transaction).
  await touchThread(db, row.orgId, { channel: "whatsapp", conversationId }, lastMessageAt);

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

/**
 * The conversation of a coexistence message (echo or history): found or created, its
 * `lastMessageAt` moved forward, and the unified inbox's thread row following it. Never touches
 * `lastInboundAt` (the reply window) or the customer's profile name.
 */
async function conversationForImport(
  db: DatabaseWriter,
  row: Doc<"whatsappWebhookEvents">,
  number: Doc<"whatsappPhoneNumbers">,
  contactWaId: string,
  at: number,
  now: number,
): Promise<Id<"whatsappConversations">> {
  const existing = await db
    .query("whatsappConversations")
    .withIndex("by_org_number_contact", (q) =>
      q.eq("orgId", row.orgId).eq("numberId", number._id).eq("contactWaId", contactWaId),
    )
    .unique();
  let conversationId;
  let lastMessageAt;
  if (existing === null) {
    lastMessageAt = at;
    conversationId = await db.insert("whatsappConversations", {
      orgId: row.orgId,
      numberId: number._id,
      contactWaId,
      ...optionalSavedName(await savedNameOf(db, number, contactWaId)),
      lastMessageAt,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    conversationId = existing._id;
    lastMessageAt = Math.max(existing.lastMessageAt, at);
    if (lastMessageAt !== existing.lastMessageAt) {
      await db.patch(existing._id, { lastMessageAt, updatedAt: now });
    }
  }
  await touchThread(db, row.orgId, { channel: "whatsapp", conversationId }, lastMessageAt);
  return conversationId;
}

/** A message the business sent from the WhatsApp Business app (ADR 0019). */
async function applyEcho(
  db: DatabaseWriter,
  row: Doc<"whatsappWebhookEvents">,
  event: EchoEvent,
  now: number,
): Promise<EventOutcome> {
  const number = await db.get(row.numberId);
  if (number === null || number.orgId !== row.orgId) return "ignored";
  if ((await findMessage(db, row)) !== null) return "ignored";
  const at = effectiveInboundAt(event.timestampMs, row.receivedAt);
  const conversationId = await conversationForImport(db, row, number, event.to, at, now);
  await db.insert("whatsappMessages", {
    orgId: row.orgId,
    conversationId,
    numberId: number._id,
    direction: "outbound",
    wamid: event.wamid,
    messageType: event.messageType,
    ...(event.text !== undefined ? { text: event.text } : {}),
    status: "sent",
    platformAt: at,
    sentAt: at,
    origin: "business_app",
    createdAt: now,
    updatedAt: now,
  });
  return "processed";
}

/** One message of the imported chat history (ADR 0019). */
async function applyHistory(
  db: DatabaseWriter,
  row: Doc<"whatsappWebhookEvents">,
  event: HistoryEvent,
  now: number,
): Promise<EventOutcome> {
  const number = await db.get(row.numberId);
  if (number === null || number.orgId !== row.orgId) return "ignored";
  // Already stored (seen live, or imported twice): the stored copy is kept.
  if ((await findMessage(db, row)) !== null) return "ignored";
  const at = effectiveInboundAt(event.timestampMs, row.receivedAt);
  const conversationId = await conversationForImport(db, row, number, event.contactWaId, at, now);
  const status = event.fromBusiness ? (event.deliveryStatus ?? "sent") : "received";
  await db.insert("whatsappMessages", {
    orgId: row.orgId,
    conversationId,
    numberId: number._id,
    direction: event.fromBusiness ? "outbound" : "inbound",
    wamid: event.wamid,
    messageType: event.messageType,
    ...(event.text !== undefined ? { text: event.text } : {}),
    status,
    platformAt: at,
    ...(status === "failed" ? { failedAt: at } : event.fromBusiness ? { sentAt: at } : {}),
    origin: "history",
    createdAt: now,
    updatedAt: now,
  });
  return "processed";
}

/**
 * A contact saved in, or removed from, the WhatsApp Business app (ADR 0019): its name, and the
 * name shown for the customer's conversation. Changes older than the one applied are ignored.
 */
async function applyContact(
  db: DatabaseWriter,
  row: Doc<"whatsappWebhookEvents">,
  event: ContactEvent,
  now: number,
): Promise<EventOutcome> {
  const number = await db.get(row.numberId);
  if (number === null || number.orgId !== row.orgId) return "ignored";
  const stored = await db
    .query("whatsappContacts")
    .withIndex("by_org_number_contact", (q) =>
      q.eq("orgId", row.orgId).eq("numberId", number._id).eq("waId", event.waId),
    )
    .unique();
  if (stored !== null && event.timestampMs < stored.changedAt) return "ignored";
  const name = event.action === "add" ? event.name : undefined;
  if (name === undefined) {
    if (stored === null) return "ignored";
    await db.delete(stored._id);
  } else if (stored === null) {
    await db.insert("whatsappContacts", {
      orgId: row.orgId,
      numberId: number._id,
      waId: event.waId,
      name,
      changedAt: event.timestampMs,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    await db.patch(stored._id, { name, changedAt: event.timestampMs, updatedAt: now });
  }
  const conversation = await db
    .query("whatsappConversations")
    .withIndex("by_org_number_contact", (q) =>
      q.eq("orgId", row.orgId).eq("numberId", number._id).eq("contactWaId", event.waId),
    )
    .unique();
  if (conversation !== null && conversation.savedName !== name) {
    await db.patch(conversation._id, { savedName: name, updatedAt: now });
  }
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

async function apply(
  db: DatabaseWriter,
  row: Doc<"whatsappWebhookEvents">,
  event: WebhookEventInput,
  now: number,
): Promise<EventOutcome> {
  switch (event.kind) {
    case "message":
      return await applyInboundMessage(db, row, event, now);
    case "status":
      return await applyStatus(db, row, event, now);
    case "echo":
      return await applyEcho(db, row, event, now);
    case "history":
      return await applyHistory(db, row, event, now);
    case "contact":
      return await applyContact(db, row, event, now);
  }
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
      const outcome = await apply(ctx.db, row, row.event, now);
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
