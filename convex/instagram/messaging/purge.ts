import { v } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import { internalMutation, type DatabaseWriter, type MutationCtx } from "../../_generated/server";
import { removeThread } from "../../inbox/threads";
import { AUDIT_ACTIONS, SYSTEM_INSTAGRAM_MESSAGING_SUBJECT, writeAudit } from "../../lib/audit";
import { disableMessaging } from "./accounts";
import { MAX_PURGE_STEPS, PURGE_ACCOUNTS_PER_SWEEP, PURGE_STEP_DELETES } from "./config";

/**
 * D14 retention of stored Instagram messaging data (ADR 0017; an engineering policy, not a
 * legal conclusion).
 *
 * WHAT: one messaging account's webhook events, messages and conversations are HARD-deleted.
 * Never: another account's or another org's rows, the account row itself (it stays `disabled`
 * as the record of the hold), the Instagram connection or social account, audit entries.
 *
 * WHEN: messaging stopped (accounts.ts `disableMessaging`) sets `purgeAfter`: the end of the
 * 30-day grace period, or now for a data-deletion request (`requestAccountDataDeletion`, which
 * Meta's verified callback calls, IM6). The hourly sweep starts every purge that is
 * due and resumes interrupted ones. A re-enable within the grace period clears `purgeAfter`
 * and keeps the history; once a purge has started, re-enabling waits until it is done.
 *
 * HOW: each step deletes at most PURGE_STEP_DELETES rows and schedules its continuation (at
 * most MAX_PURGE_STEPS in a chain; the sweep resumes the rest). Events go first, so a pending
 * event can no longer be processed into a message the purge has passed. Every step re-reads
 * the account and what is left (only through org-first indexes for this account), so a
 * retried, repeated or overlapping step never deletes anything twice or anything that no
 * longer qualifies; Convex runs mutations serializably.
 */

type Counts = { events: number; messages: number; conversations: number };
const NO_COUNTS: Counts = { events: 0, messages: 0, conversations: 0 };
const countsValidator = v.object({
  events: v.number(),
  messages: v.number(),
  conversations: v.number(),
});

async function systemActor(db: DatabaseWriter, orgId: Id<"organizations">) {
  const org = await db.get(orgId);
  return { orgId, issuer: org?.issuer ?? "", subject: SYSTEM_INSTAGRAM_MESSAGING_SUBJECT };
}

function isDue(account: Doc<"instagramMessagingAccounts">, now: number): boolean {
  return (
    account.status === "disabled" && account.purgeAfter !== undefined && account.purgeAfter <= now
  );
}

async function schedulePurge(
  ctx: Pick<MutationCtx, "scheduler">,
  account: Doc<"instagramMessagingAccounts">,
) {
  await ctx.scheduler.runAfter(0, internal.instagram.messaging.purge.purgeMessagingAccount, {
    orgId: account.orgId,
    accountId: account._id,
  });
}

/** Deletes up to PURGE_STEP_DELETES of the account's rows; true when none is left. */
async function deleteAccountRows(
  db: DatabaseWriter,
  account: Doc<"instagramMessagingAccounts">,
  counts: Counts,
): Promise<boolean> {
  let left = PURGE_STEP_DELETES;
  const events = await db
    .query("instagramWebhookEvents")
    .withIndex("by_org_account", (q) =>
      q.eq("orgId", account.orgId).eq("messagingAccountId", account._id),
    )
    .take(left);
  for (const event of events) {
    await db.delete(event._id);
    counts.events++;
    left--;
  }
  if (left === 0) return false;

  const conversations = await db
    .query("instagramConversations")
    .withIndex("by_org_account_contact", (q) =>
      q.eq("orgId", account.orgId).eq("messagingAccountId", account._id),
    )
    .take(10);
  for (const conversation of conversations) {
    const messages = await db
      .query("instagramMessages")
      .withIndex("by_org_conversation_platform", (q) =>
        q.eq("orgId", account.orgId).eq("conversationId", conversation._id),
      )
      .take(left);
    for (const message of messages) {
      // The thread was found through this account; its messages are this account's.
      await db.delete(message._id);
      counts.messages++;
      left--;
    }
    if (left === 0) return false;
    // ADR 0018: the unified inbox's thread row goes with its conversation.
    await removeThread(db, account.orgId, {
      channel: "instagram",
      conversationId: conversation._id,
    });
    await db.delete(conversation._id);
    counts.conversations++;
    left--;
    if (left === 0) return false;
  }
  return conversations.length === 0;
}

/** One purge step for one account (scheduled; see the module comment). */
export const purgeMessagingAccount = internalMutation({
  args: {
    orgId: v.id("organizations"),
    accountId: v.id("instagramMessagingAccounts"),
    step: v.optional(v.number()),
    deleted: v.optional(countsValidator),
  },
  returns: v.union(
    v.literal("skipped"),
    v.literal("continued"),
    v.literal("paused"),
    v.literal("done"),
  ),
  handler: async (ctx, args) => {
    const now = Date.now();
    const account = await ctx.db.get(args.accountId);
    if (account === null || account.orgId !== args.orgId || !isDue(account, now)) {
      return "skipped" as const;
    }
    const counts: Counts = { ...(args.deleted ?? NO_COUNTS) };
    if (account.purgeStartedAt === undefined) {
      await ctx.db.patch(account._id, { purgeStartedAt: now, updatedAt: now });
      await writeAudit(ctx.db, await systemActor(ctx.db, account.orgId), {
        action: AUDIT_ACTIONS.instagramMessagingPurgeStarted,
        targetType: "instagramMessagingAccount",
        targetId: account._id,
      });
    }

    if (!(await deleteAccountRows(ctx.db, account, counts))) {
      const step = (args.step ?? 0) + 1;
      if (step >= MAX_PURGE_STEPS) return "paused" as const; // the hourly sweep resumes it
      await ctx.scheduler.runAfter(0, internal.instagram.messaging.purge.purgeMessagingAccount, {
        orgId: account.orgId,
        accountId: account._id,
        step,
        deleted: counts,
      });
      return "continued" as const;
    }

    await ctx.db.patch(account._id, {
      purgeAfter: undefined,
      purgeStartedAt: undefined,
      updatedAt: now,
    });
    await writeAudit(ctx.db, await systemActor(ctx.db, account.orgId), {
      action: AUDIT_ACTIONS.instagramMessagingPurged,
      targetType: "instagramMessagingAccount",
      targetId: account._id,
      changes: {
        events: { from: null, to: counts.events },
        messages: { from: null, to: counts.messages },
        conversations: { from: null, to: counts.conversations },
      },
    });
    return "done" as const;
  },
});

/** Hourly (convex/crons.ts): starts or resumes every purge whose grace period ended. */
export const sweepMessagingPurges = internalMutation({
  args: {},
  returns: v.object({ scheduled: v.number() }),
  handler: async (ctx) => {
    const now = Date.now();
    // Approved global index: turned-off accounts whose purge is due, across orgs.
    const due = await ctx.db
      .query("instagramMessagingAccounts")
      .withIndex("by_status_purge_after", (q) =>
        q.eq("status", "disabled").gte("purgeAfter", 0).lte("purgeAfter", now),
      )
      .take(PURGE_ACCOUNTS_PER_SWEEP);
    for (const account of due) await schedulePurge(ctx, account);
    return { scheduled: due.length };
  },
});

/**
 * A verified data-deletion request for one org's messaging account (the Meta callback,
 * convex/instagram/dataDeletion, calls this after checking Meta's signed request): messaging
 * stops if it was on, and the purge starts now instead of after the grace period. Only that
 * org's account is touched. False when the account is not that org's.
 */
export async function requestAccountDataDeletion(
  ctx: MutationCtx,
  orgId: Id<"organizations">,
  accountId: Id<"instagramMessagingAccounts">,
): Promise<boolean> {
  const account = await ctx.db.get(accountId);
  if (account === null || account.orgId !== orgId) return false;
  const actor = await systemActor(ctx.db, orgId);
  if (account.status !== "disabled") {
    await disableMessaging(ctx.db, actor, accountId, "data_deletion_request");
  } else if (account.purgeAfter === undefined || account.purgeAfter > Date.now()) {
    await ctx.db.patch(accountId, { purgeAfter: Date.now(), updatedAt: Date.now() });
    await writeAudit(ctx.db, actor, {
      action: AUDIT_ACTIONS.instagramMessagingDisabled,
      targetType: "instagramMessagingAccount",
      targetId: accountId,
      changes: { reason: { from: null, to: "data_deletion_request" } },
    });
  }
  await schedulePurge(ctx, (await ctx.db.get(accountId))!);
  return true;
}

export const requestMessagingDataDeletion = internalMutation({
  args: { orgId: v.id("organizations"), accountId: v.id("instagramMessagingAccounts") },
  returns: v.boolean(),
  handler: async (ctx, { orgId, accountId }) =>
    await requestAccountDataDeletion(ctx, orgId, accountId),
});
