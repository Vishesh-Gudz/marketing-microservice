import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { replyBlockerOf } from "../instagram/messaging/outbound";
import { clampPagination, paginatedDto, toIso } from "../lib/dto";
import { orgQuery } from "../lib/tenancy";
import { isServiceWindowOpen, serviceWindowExpiresAt } from "../messaging/window";
import { senderOf as whatsappSenderOf } from "../whatsapp/outbound";
import { inboxThreadDto, type InboxThreadDto } from "./dto/inbox";

/**
 * Unified inbox (ADR 0018, IM7.3): every channel's conversations of the caller's org, newest
 * activity first, from the thread index (convex/inbox/threads.ts). Read-only: detail, history
 * and sending stay on each channel's own API, with its own role checks.
 *
 * Each row's conversation and account are read under the caller's org; a row whose
 * conversation is gone, of another org or malformed is skipped. Labels and reply state follow
 * each channel's own rules: the same sender checks as its sendText (WhatsApp `senderOf`;
 * Instagram the flag and `senderOf`) and the shared 24-hour window.
 */

/** Per account: its label, and whether its sender check refuses (whatever the window). */
type AccountView = { label: string; blocked: boolean };

function replyState(
  blocked: boolean,
  lastInboundAt: number | undefined,
  now: number,
): InboxThreadDto["replyState"] {
  if (blocked) return "unavailable";
  return isServiceWindowOpen(lastInboundAt, now) ? "open" : "closed";
}

function times(conversation: { lastMessageAt: number; lastInboundAt?: number }) {
  const expiresAt = serviceWindowExpiresAt(conversation.lastInboundAt);
  return {
    lastMessageAt: toIso(conversation.lastMessageAt),
    ...(conversation.lastInboundAt !== undefined
      ? { lastInboundAt: toIso(conversation.lastInboundAt) }
      : {}),
    ...(expiresAt !== undefined ? { replyWindowExpiresAt: toIso(expiresAt) } : {}),
  };
}

async function whatsappAccount(
  db: DatabaseReader,
  conversation: Doc<"whatsappConversations">,
): Promise<AccountView> {
  const number = await db.get(conversation.numberId);
  const label =
    number !== null && number.orgId === conversation.orgId && number.displayPhoneNumber
      ? number.displayPhoneNumber
      : "WhatsApp number";
  return { label, blocked: !(await whatsappSenderOf(db, conversation)).ok };
}

async function instagramAccount(
  db: DatabaseReader,
  conversation: Doc<"instagramConversations">,
): Promise<AccountView> {
  const account = await db.get(conversation.messagingAccountId);
  const social =
    account !== null && account.orgId === conversation.orgId
      ? await db.get(account.socialAccountId)
      : null;
  const known = social !== null && social.orgId === conversation.orgId ? social : null;
  const label = known?.username
    ? `@${known.username}`
    : known?.name
      ? known.name
      : "Instagram account";
  return { label, blocked: (await replyBlockerOf(db, conversation)) !== undefined };
}

/** The DTO of one index row, or null when its conversation is not one of the caller's org. */
async function threadView(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  thread: Doc<"inboxThreads">,
  accounts: Map<string, AccountView>,
  now: number,
): Promise<InboxThreadDto | null> {
  if (thread.channel === "whatsapp") {
    if (thread.whatsappConversationId === undefined) return null;
    const conversation = await db.get(thread.whatsappConversationId);
    if (conversation === null || conversation.orgId !== orgId) return null;
    let account = accounts.get(conversation.numberId);
    if (account === undefined) {
      account = await whatsappAccount(db, conversation);
      accounts.set(conversation.numberId, account);
    }
    return {
      id: thread._id,
      channel: "whatsapp",
      conversationId: conversation._id,
      accountLabel: account.label,
      contactLabel: conversation.contactName ?? `+${conversation.contactWaId}`,
      ...times(conversation),
      replyState: replyState(account.blocked, conversation.lastInboundAt, now),
    };
  }
  if (thread.instagramConversationId === undefined) return null;
  const conversation = await db.get(thread.instagramConversationId);
  if (conversation === null || conversation.orgId !== orgId) return null;
  let account = accounts.get(conversation.messagingAccountId);
  if (account === undefined) {
    account = await instagramAccount(db, conversation);
    accounts.set(conversation.messagingAccountId, account);
  }
  return {
    id: thread._id,
    channel: "instagram",
    conversationId: conversation._id,
    accountLabel: account.label,
    contactLabel: conversation.contactUsername
      ? `@${conversation.contactUsername}`
      : (conversation.contactName ?? "Instagram user"),
    ...times(conversation),
    replyState: replyState(account.blocked, conversation.lastInboundAt, now),
  };
}

/** The caller's conversations across channels, most recent activity first; viewer and up. */
export const listThreads = orgQuery({
  args: {
    paginationOpts: paginationOptsValidator,
    channel: v.optional(v.union(v.literal("whatsapp"), v.literal("instagram"))),
  },
  returns: paginatedDto(inboxThreadDto),
  handler: async (ctx, { paginationOpts, channel }) => {
    const orgId = ctx.tenant.orgId;
    const query =
      channel === undefined
        ? ctx.db.query("inboxThreads").withIndex("by_org_last_message", (q) => q.eq("orgId", orgId))
        : ctx.db
            .query("inboxThreads")
            .withIndex("by_org_channel_last_message", (q) =>
              q.eq("orgId", orgId).eq("channel", channel),
            );
    const result = await query.order("desc").paginate(clampPagination(paginationOpts));
    const now = Date.now();
    const accounts = new Map<string, AccountView>();
    const page: InboxThreadDto[] = [];
    for (const thread of result.page) {
      const view = await threadView(ctx.db, orgId, thread, accounts, now);
      if (view !== null) page.push(view);
    }
    return { page, isDone: result.isDone, continueCursor: result.continueCursor };
  },
});
