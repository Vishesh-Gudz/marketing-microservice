import { v } from "convex/values";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation, type DatabaseWriter } from "../../_generated/server";
import { touchThread } from "../../inbox/threads";
import { MAX_READ_MARKS } from "./config";
import type { WebhookEventInput } from "./validators";

/**
 * Asynchronous processing of stored Instagram webhook events (scheduled by ingest.ts).
 *
 * Idempotent: only `pending` events are applied, each in the same transaction that marks it
 * done, and messages are unique per (org, account, mid). Every lookup uses an org-first index
 * with the event's own orgId and must match the event's messaging account; a message an event
 * refers to must also be in the thread with the same customer.
 *
 * - Customer messages and echoes create the message (and the thread if needed). Echoes are
 *   messages the business sent from Instagram itself: outbound, `sent`, origin `instagram`.
 *   An echo of a reply sent from this app (its mid known from the send result, IM4) only
 *   confirms it: `submitted` -> `sent`, never a second row. One that comes before the send
 *   result is merged into the reply when the result is recorded (outbound.ts).
 * - "Seen" marks the account's message and its earlier ones in that thread `read`. One that
 *   comes before its message is kept `unmatched` (it carries no text).
 * - Edits replace the text of a known message only. An edit for an unknown message is ignored
 *   and its text dropped: it can never create content.
 * - Deletions clear a known message's text. One that comes before its message is kept
 *   `unmatched` (it carries only the id), and the message is then stored without its text.
 */

type Outcome = "processed" | "unmatched" | "ignored";
type EventRow = Doc<"instagramWebhookEvents">;
/** Where a lookup may look: one org and one of its messaging accounts. */
type Scope = Pick<EventRow, "orgId" | "messagingAccountId">;
type Event<K extends WebhookEventInput["kind"]> = Extract<WebhookEventInput, { kind: K }>;

/** The account's message with this mid (another account's is never returned). */
export async function findMessage(db: DatabaseWriter, row: Scope, mid: string) {
  const message = await db
    .query("instagramMessages")
    .withIndex("by_org_mid", (q) => q.eq("orgId", row.orgId).eq("mid", mid))
    .first();
  return message !== null && message.messagingAccountId === row.messagingAccountId ? message : null;
}

/** Whether the message belongs to the thread with this customer. */
export async function inThreadWith(
  db: DatabaseWriter,
  message: Doc<"instagramMessages">,
  customerIgsid: string,
): Promise<boolean> {
  const conversation = await db.get(message.conversationId);
  return (
    conversation !== null &&
    conversation.orgId === message.orgId &&
    conversation.contactIgsid === customerIgsid
  );
}

/**
 * An earlier event of the same account with this dedupe key, still `unmatched` because it came
 * before its message, for the same customer; or null.
 */
export async function earlyEvent(
  db: DatabaseWriter,
  row: Scope,
  key: string,
  customerIgsid: string,
) {
  const early = await db
    .query("instagramWebhookEvents")
    .withIndex("by_org_dedupe", (q) => q.eq("orgId", row.orgId).eq("dedupeKey", key))
    .first();
  return early !== null &&
    early.status === "unmatched" &&
    early.messagingAccountId === row.messagingAccountId &&
    early.event?.customerIgsid === customerIgsid
    ? { id: early._id, at: early.event.timestampMs }
    : null;
}

async function conversationFor(
  db: DatabaseWriter,
  row: EventRow,
  customerIgsid: string,
  at: number,
  inbound: boolean,
  now: number,
): Promise<Id<"instagramConversations">> {
  const existing = await db
    .query("instagramConversations")
    .withIndex("by_org_account_contact", (q) =>
      q
        .eq("orgId", row.orgId)
        .eq("messagingAccountId", row.messagingAccountId)
        .eq("contactIgsid", customerIgsid),
    )
    .unique();
  let conversationId: Id<"instagramConversations">;
  let lastMessageAt: number;
  if (existing === null) {
    lastMessageAt = at;
    conversationId = await db.insert("instagramConversations", {
      orgId: row.orgId,
      messagingAccountId: row.messagingAccountId,
      contactIgsid: customerIgsid,
      ...(inbound ? { lastInboundAt: at } : {}),
      lastMessageAt,
      createdAt: now,
      updatedAt: now,
    });
  } else {
    conversationId = existing._id;
    lastMessageAt = Math.max(existing.lastMessageAt, at);
    await db.patch(existing._id, {
      ...(inbound ? { lastInboundAt: Math.max(existing.lastInboundAt ?? 0, at) } : {}),
      lastMessageAt,
      updatedAt: now,
    });
  }
  // ADR 0018: the unified inbox's thread row follows the conversation (same transaction).
  await touchThread(db, row.orgId, { channel: "instagram", conversationId }, lastMessageAt);
  return conversationId;
}

async function applyMessage(
  db: DatabaseWriter,
  row: EventRow,
  event: Event<"message" | "echo">,
  now: number,
): Promise<Outcome> {
  const known = await findMessage(db, row, event.mid);
  if (known !== null) {
    // The echo of a reply sent from this app confirms it was sent; nothing else changes.
    if (
      event.kind === "echo" &&
      known.origin === "app" &&
      known.status === "submitted" &&
      (await inThreadWith(db, known, event.customerIgsid))
    ) {
      await db.patch(known._id, { status: "sent", sentAt: event.timestampMs, updatedAt: now });
      return "processed";
    }
    return "ignored";
  }
  const inbound = event.kind === "message";
  const at = event.timestampMs;
  const conversationId = await conversationFor(db, row, event.customerIgsid, at, inbound, now);
  const deletion = await earlyEvent(db, row, `delete:${event.mid}`, event.customerIgsid);
  const seen = inbound ? null : await earlyEvent(db, row, `read:${event.mid}`, event.customerIgsid);

  await db.insert("instagramMessages", {
    orgId: row.orgId,
    conversationId,
    messagingAccountId: row.messagingAccountId,
    direction: inbound ? "inbound" : "outbound",
    origin: inbound ? "customer" : "instagram",
    mid: event.mid,
    messageType: event.messageType,
    ...(event.text !== undefined && deletion === null ? { text: event.text } : {}),
    ...(event.replyToMid !== undefined ? { replyToMid: event.replyToMid } : {}),
    status: inbound ? "received" : seen !== null ? "read" : "sent",
    platformAt: at,
    ...(inbound ? {} : { sentAt: at }),
    ...(seen !== null ? { readAt: seen.at } : {}),
    ...(deletion !== null ? { deletedAt: deletion.at } : {}),
    createdAt: now,
    updatedAt: now,
  });
  for (const early of [deletion, seen]) {
    if (early !== null) {
      await db.patch(early.id, { status: "processed", processedAt: now, event: undefined });
    }
  }
  return "processed";
}

async function applyRead(
  db: DatabaseWriter,
  row: EventRow,
  event: Event<"read">,
  now: number,
): Promise<Outcome> {
  const message = await findMessage(db, row, event.mid);
  if (message === null) return "unmatched";
  if (message.direction !== "outbound" || !(await inThreadWith(db, message, event.customerIgsid))) {
    return "ignored";
  }
  // The customer saw this message, so also every earlier one the account sent in the thread.
  const earlier = await db
    .query("instagramMessages")
    .withIndex("by_org_conversation_platform", (q) =>
      q
        .eq("orgId", row.orgId)
        .eq("conversationId", message.conversationId)
        .lte("platformAt", message.platformAt),
    )
    .order("desc")
    .take(MAX_READ_MARKS);
  let marked = 0;
  for (const candidate of earlier) {
    if (candidate.direction !== "outbound") continue;
    if (candidate.status !== "submitted" && candidate.status !== "sent") continue;
    await db.patch(candidate._id, {
      status: "read",
      readAt: candidate.readAt ?? event.timestampMs,
      updatedAt: now,
    });
    marked++;
  }
  return marked > 0 ? "processed" : "ignored";
}

async function applyEdit(
  db: DatabaseWriter,
  row: EventRow,
  event: Event<"edit">,
  now: number,
): Promise<Outcome> {
  const message = await findMessage(db, row, event.mid);
  if (message === null || !(await inThreadWith(db, message, event.customerIgsid))) return "ignored";
  // Deleted messages stay empty; an older edit never replaces a newer one.
  if (message.deletedAt !== undefined) return "ignored";
  if (message.editedAt !== undefined && event.timestampMs < message.editedAt) return "ignored";
  await db.patch(message._id, { text: event.text, editedAt: event.timestampMs, updatedAt: now });
  return "processed";
}

async function applyDelete(
  db: DatabaseWriter,
  row: EventRow,
  event: Event<"delete">,
  now: number,
): Promise<Outcome> {
  const message = await findMessage(db, row, event.mid);
  if (message === null) return "unmatched";
  if (!(await inThreadWith(db, message, event.customerIgsid))) return "ignored";
  if (message.deletedAt !== undefined) return "ignored";
  await db.patch(message._id, { text: undefined, deletedAt: event.timestampMs, updatedAt: now });
  return "processed";
}

async function apply(db: DatabaseWriter, row: EventRow, now: number): Promise<Outcome> {
  const event = row.event!;
  const account = await db.get(row.messagingAccountId);
  if (account === null || account.orgId !== row.orgId) return "ignored";
  switch (event.kind) {
    case "message":
    case "echo":
      return await applyMessage(db, row, event, now);
    case "read":
      return await applyRead(db, row, event, now);
    case "edit":
      return await applyEdit(db, row, event, now);
    case "delete":
      return await applyDelete(db, row, event, now);
  }
}

export const processEvents = internalMutation({
  args: { eventIds: v.array(v.id("instagramWebhookEvents")) },
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
      const outcome = await apply(ctx.db, row, now);
      counts[outcome]++;
      // The body (which may hold message text) is dropped once applied. Unmatched events keep
      // theirs: "seen" and deletions carry only ids and times.
      await ctx.db.patch(row._id, {
        status: outcome,
        processedAt: now,
        ...(outcome === "unmatched" ? {} : { event: undefined }),
      });
    }
    return counts;
  },
});
