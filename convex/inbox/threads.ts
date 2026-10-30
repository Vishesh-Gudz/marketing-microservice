import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalMutation,
  internalQuery,
  type DatabaseReader,
  type DatabaseWriter,
} from "../_generated/server";
import { literalUnion } from "../domain/validators";

/**
 * The unified inbox's thread index (ADR 0018, IM7.2): one `inboxThreads` row per channel
 * conversation, carrying only the conversation's reference and `lastMessageAt`.
 *
 * - `touchThread` / `removeThread` are the ONLY writers on the channels' paths, called in the
 *   same transaction as the conversation write (WhatsApp processing and outbound, Instagram
 *   processing and outbound; Instagram's purge removes the row with the conversation). Rows are
 *   found by (orgId, typed reference): always the conversation's own org.
 * - `backfill` (operator, `npx convex run inbox/threads:backfill`) creates missing rows from
 *   both conversation tables, then deletes orphaned rows; it also repairs a stale
 *   `lastMessageAt` and duplicates. Repeatable; one page per transaction, continuing itself, or
 *   one page at a time (`chain: false`) resuming from the returned cursor.
 * - `check` (operator, read-only, paged) reports conversations without a row, with a stale row
 *   or with several rows, and rows whose conversation is gone, of another org or of the wrong
 *   channel.
 */

export type ThreadRef =
  | { channel: "whatsapp"; conversationId: Id<"whatsappConversations"> }
  | { channel: "instagram"; conversationId: Id<"instagramConversations"> };

type Thread = Doc<"inboxThreads">;

async function threadsOf(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  ref: ThreadRef,
  limit: number,
): Promise<Thread[]> {
  // Only rows of the reference's own channel: a malformed row is never taken for the thread.
  if (ref.channel === "whatsapp") {
    return await db
      .query("inboxThreads")
      .withIndex("by_org_whatsapp_conversation", (q) =>
        q.eq("orgId", orgId).eq("whatsappConversationId", ref.conversationId),
      )
      .filter((q) => q.eq(q.field("channel"), "whatsapp"))
      .take(limit);
  }
  return await db
    .query("inboxThreads")
    .withIndex("by_org_instagram_conversation", (q) =>
      q.eq("orgId", orgId).eq("instagramConversationId", ref.conversationId),
    )
    .filter((q) => q.eq(q.field("channel"), "instagram"))
    .take(limit);
}

/**
 * After a conversation was created or its `lastMessageAt` moved, in the same transaction: its
 * row exists and carries that `lastMessageAt`. Idempotent.
 */
export async function touchThread(
  db: DatabaseWriter,
  orgId: Id<"organizations">,
  ref: ThreadRef,
  lastMessageAt: number,
): Promise<void> {
  const [thread] = await threadsOf(db, orgId, ref, 1);
  const now = Date.now();
  if (thread === undefined) {
    await db.insert("inboxThreads", {
      orgId,
      channel: ref.channel,
      ...(ref.channel === "whatsapp"
        ? { whatsappConversationId: ref.conversationId }
        : { instagramConversationId: ref.conversationId }),
      lastMessageAt,
      createdAt: now,
      updatedAt: now,
    });
  } else if (thread.lastMessageAt !== lastMessageAt) {
    await db.patch(thread._id, { lastMessageAt, updatedAt: now });
  }
}

/** Before a conversation is deleted, in the same transaction (Instagram's purge). */
export async function removeThread(
  db: DatabaseWriter,
  orgId: Id<"organizations">,
  ref: ThreadRef,
): Promise<void> {
  for (const thread of await threadsOf(db, orgId, ref, 10)) await db.delete(thread._id);
}

/** The conversation a row refers to, or null when that is not exactly one of its own org. */
async function conversationOf(
  db: DatabaseReader,
  thread: Thread,
): Promise<Doc<"whatsappConversations"> | Doc<"instagramConversations"> | null> {
  const id =
    thread.channel === "whatsapp" ? thread.whatsappConversationId : thread.instagramConversationId;
  const other =
    thread.channel === "whatsapp" ? thread.instagramConversationId : thread.whatsappConversationId;
  if (id === undefined || other !== undefined) return null;
  const conversation = await db.get(id);
  return conversation !== null && conversation.orgId === thread.orgId ? conversation : null;
}

const PHASES = ["whatsapp", "instagram", "threads"] as const;
type Phase = (typeof PHASES)[number];
const DEFAULT_BATCH = 100;

type Page<T> = { page: T[]; isDone: boolean; continueCursor: string };
type Conversation = Doc<"whatsappConversations"> | Doc<"instagramConversations">;

/** One page of the phase's table (one paginated query per function). */
async function pageOf(
  db: DatabaseReader,
  phase: Phase,
  numItems: number,
  cursor: string | null,
): Promise<
  { conversations: Page<{ doc: Conversation; ref: ThreadRef }> } | { threads: Page<Thread> }
> {
  const options = { numItems, cursor };
  if (phase === "whatsapp") {
    const result = await db.query("whatsappConversations").paginate(options);
    return {
      conversations: {
        ...result,
        page: result.page.map((doc) => ({
          doc,
          ref: { channel: "whatsapp" as const, conversationId: doc._id },
        })),
      },
    };
  }
  if (phase === "instagram") {
    const result = await db.query("instagramConversations").paginate(options);
    return {
      conversations: {
        ...result,
        page: result.page.map((doc) => ({
          doc,
          ref: { channel: "instagram" as const, conversationId: doc._id },
        })),
      },
    };
  }
  return { threads: await db.query("inboxThreads").paginate(options) };
}

const phaseArgs = {
  phase: v.optional(literalUnion(PHASES)),
  cursor: v.optional(v.string()),
  batch: v.optional(v.number()),
};

/** Creates, repairs and cleans up thread rows, a page per transaction (see the module comment). */
export const backfill = internalMutation({
  args: { ...phaseArgs, chain: v.optional(v.boolean()) },
  returns: v.object({
    phase: literalUnion(PHASES),
    created: v.number(),
    updated: v.number(),
    removed: v.number(),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const phase = args.phase ?? "whatsapp";
    const batch = args.batch ?? DEFAULT_BATCH;
    const counts = { created: 0, updated: 0, removed: 0 };
    const result = await pageOf(ctx.db, phase, batch, args.cursor ?? null);
    let page: { isDone: boolean; continueCursor: string };

    if ("conversations" in result) {
      page = result.conversations;
      for (const { doc, ref } of result.conversations.page) {
        const threads = await threadsOf(ctx.db, doc.orgId, ref, 10);
        for (const duplicate of threads.slice(1)) {
          await ctx.db.delete(duplicate._id);
          counts.removed++;
        }
        if (threads.length === 0) counts.created++;
        else if (threads[0]!.lastMessageAt !== doc.lastMessageAt) counts.updated++;
        await touchThread(ctx.db, doc.orgId, ref, doc.lastMessageAt);
      }
    } else {
      page = result.threads;
      for (const thread of result.threads.page) {
        const conversation = await conversationOf(ctx.db, thread);
        if (conversation === null) {
          await ctx.db.delete(thread._id);
          counts.removed++;
        } else if (thread.lastMessageAt !== conversation.lastMessageAt) {
          await ctx.db.patch(thread._id, {
            lastMessageAt: conversation.lastMessageAt,
            updatedAt: Date.now(),
          });
          counts.updated++;
        }
      }
    }

    const nextPhase = PHASES[PHASES.indexOf(phase) + 1];
    const next = !page.isDone
      ? { phase, cursor: page.continueCursor }
      : nextPhase !== undefined
        ? { phase: nextPhase }
        : null;
    if (next !== null && args.chain !== false) {
      await ctx.scheduler.runAfter(0, internal.inbox.threads.backfill, { ...next, batch });
    }
    return { phase, ...counts, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});

/** Read-only consistency report for one page of the phase's table (operator; follow cursors). */
export const check = internalQuery({
  args: phaseArgs,
  returns: v.object({
    phase: literalUnion(PHASES),
    /** Conversations (ids) without a row, with a stale row, or with several rows. */
    missing: v.array(v.string()),
    stale: v.array(v.string()),
    duplicated: v.array(v.string()),
    /** Rows whose conversation is gone, of another org or of the wrong channel. */
    orphaned: v.array(v.id("inboxThreads")),
    isDone: v.boolean(),
    continueCursor: v.string(),
  }),
  handler: async (ctx, args) => {
    const phase = args.phase ?? "whatsapp";
    const report = {
      missing: [] as string[],
      stale: [] as string[],
      duplicated: [] as string[],
      orphaned: [] as Id<"inboxThreads">[],
    };
    const result = await pageOf(ctx.db, phase, args.batch ?? DEFAULT_BATCH, args.cursor ?? null);
    let page: { isDone: boolean; continueCursor: string };
    if ("conversations" in result) {
      page = result.conversations;
      for (const { doc, ref } of result.conversations.page) {
        const threads = await threadsOf(ctx.db, doc.orgId, ref, 2);
        if (threads.length === 0) report.missing.push(doc._id);
        else if (threads.length > 1) report.duplicated.push(doc._id);
        else if (threads[0]!.lastMessageAt !== doc.lastMessageAt) report.stale.push(doc._id);
      }
    } else {
      page = result.threads;
      for (const thread of result.threads.page) {
        if ((await conversationOf(ctx.db, thread)) === null) report.orphaned.push(thread._id);
      }
    }
    return { phase, ...report, isDone: page.isDone, continueCursor: page.continueCursor };
  },
});
