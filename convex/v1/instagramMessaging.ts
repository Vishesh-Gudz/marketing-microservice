import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { disableMessaging, enableCheck, type EnableRefusal } from "../instagram/messaging/accounts";
import { instagramMessagingEnabled } from "../instagram/messaging/config";
import { subscribeIfNeeded } from "../instagram/messaging/lifecycle";
import { queueText, replyBlockerOf, type SenderRefusal } from "../instagram/messaging/outbound";
import { clampPagination, mapPage, paginatedDto, toIso } from "../lib/dto";
import { apiError } from "../lib/errors";
import { getOwned, orgAdminAction, orgAdminMutation, orgMutation, orgQuery } from "../lib/tenancy";
import {
  instagramConversationDto,
  instagramMessageDto,
  instagramMessagingAccountDto,
  instagramMessagingAvailabilityDto,
  instagramMessagingSetupResultDto,
  toInstagramConversationDto,
  toInstagramMessageDto,
  toInstagramMessagingAccountDto,
  toSetupResultDto,
  type InstagramMessagingAvailabilityDto,
  type InstagramMessagingSetupResultDto,
} from "./dto/instagramMessaging";

/**
 * Instagram direct messages (ADR 0017). Tenant-scoped through the verified JWT only: every
 * lookup uses an org-first index with ctx.tenant.orgId, and client-supplied ids go through
 * getOwned (another org's conversation is NOT_FOUND). Every member (viewer and up) may read, as
 * for WhatsApp; editors and admins send replies (sendText); only admins turn messaging on and
 * off.
 */

const MAX_ACCOUNTS = 50;

/** The business account's Instagram profile row (for its username), checked against the org. */
async function socialAccountOf(
  db: DatabaseReader,
  messagingAccountId: Id<"instagramMessagingAccounts">,
  orgId: Id<"organizations">,
): Promise<Doc<"socialAccounts"> | null> {
  const account = await db.get(messagingAccountId);
  if (account === null || account.orgId !== orgId) {
    throw apiError("INTERNAL", "Conversation has no messaging account.");
  }
  const social = await db.get(account.socialAccountId);
  return social !== null && social.orgId === orgId ? social : null;
}

/** The caller's Instagram accounts with messaging (any status). */
export const listAccounts = orgQuery({
  args: {},
  returns: v.array(instagramMessagingAccountDto),
  handler: async (ctx) => {
    const accounts = await ctx.db
      .query("instagramMessagingAccounts")
      .withIndex("by_org_social_account", (q) => q.eq("orgId", ctx.tenant.orgId))
      .take(MAX_ACCOUNTS);
    const result = [];
    for (const account of accounts) {
      const social = await ctx.db.get(account.socialAccountId);
      result.push(
        toInstagramMessagingAccountDto(
          account,
          social !== null && social.orgId === ctx.tenant.orgId ? social : null,
        ),
      );
    }
    return result;
  },
});

/** The caller's conversations, most recent activity first. */
export const listConversations = orgQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginatedDto(instagramConversationDto),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("instagramConversations")
      .withIndex("by_org_last_message", (q) => q.eq("orgId", ctx.tenant.orgId))
      .order("desc")
      .paginate(clampPagination(args.paginationOpts));
    // Per account (every conversation of an account shares both).
    const socials = new Map<string, Doc<"socialAccounts"> | null>();
    const blockers = new Map<string, SenderRefusal | undefined>();
    for (const conversation of result.page) {
      if (!socials.has(conversation.messagingAccountId)) {
        socials.set(
          conversation.messagingAccountId,
          await socialAccountOf(ctx.db, conversation.messagingAccountId, ctx.tenant.orgId),
        );
        blockers.set(conversation.messagingAccountId, await replyBlockerOf(ctx.db, conversation));
      }
    }
    return mapPage(result, (conversation) =>
      toInstagramConversationDto(
        conversation,
        socials.get(conversation.messagingAccountId)!,
        blockers.get(conversation.messagingAccountId),
      ),
    );
  },
});

export const getConversation = orgQuery({
  args: { conversationId: v.string() },
  returns: instagramConversationDto,
  handler: async (ctx, { conversationId }) => {
    const conversation = await getOwned(ctx, "instagramConversations", conversationId);
    return toInstagramConversationDto(
      conversation,
      await socialAccountOf(ctx.db, conversation.messagingAccountId, ctx.tenant.orgId),
      await replyBlockerOf(ctx.db, conversation),
    );
  },
});

/** Messages of one of the caller's conversations, newest first. */
export const listMessages = orgQuery({
  args: { conversationId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginatedDto(instagramMessageDto),
  handler: async (ctx, args) => {
    const conversation = await getOwned(ctx, "instagramConversations", args.conversationId);
    const result = await ctx.db
      .query("instagramMessages")
      .withIndex("by_org_conversation_platform", (q) =>
        q.eq("orgId", ctx.tenant.orgId).eq("conversationId", conversation._id),
      )
      .order("desc")
      .paginate(clampPagination(args.paginationOpts));
    return mapPage(result, toInstagramMessageDto);
  },
});

// ---------------------------------------------------------------------------
// Turning messaging on and off (ADR 0017, IM3). Admins only; the org and actor come from the
// verified JWT. Enabling stays closed on cloud deployments until INSTAGRAM_MESSAGING_ENABLED.
// ---------------------------------------------------------------------------

const REFUSALS: Readonly<Record<Exclude<EnableRefusal, "not_found">, string>> = {
  not_linked: "Link this Instagram account through its own connection first.",
  connection_inactive: "Reconnect Instagram first.",
  scope_missing: "Reconnect Instagram and allow direct messages first.",
  in_use: "Another organization receives this account's direct messages.",
  purge_in_progress: "This account's earlier messages are being deleted. Try again shortly.",
};

function refusal(reason: EnableRefusal): Error {
  return reason === "not_found"
    ? apiError("NOT_FOUND", "No socialAccounts record with this id.", { table: "socialAccounts" })
    : apiError("CONFLICT", REFUSALS[reason], { reason });
}

function requireMessagingAvailable(): void {
  if (!instagramMessagingEnabled()) {
    throw apiError("INVALID_ARGUMENT", "Instagram direct messages are not available yet.", {
      reason: "messaging_unavailable",
    });
  }
}

/**
 * Admin: turns direct messages on for a linked Instagram account (its connection must have the
 * messaging permission: beginConnect with `instagramMessaging`), then subscribes it to Meta's
 * webhooks. `action_required` (with `setupReason`): the subscription failed; `retrySetup`.
 * Refused (CONFLICT, `reason`) per `REFUSALS`; another org's account is NOT_FOUND.
 */
export const enable = orgAdminAction({
  args: { socialAccountId: v.string() },
  returns: instagramMessagingSetupResultDto,
  handler: async (ctx, { socialAccountId }): Promise<InstagramMessagingSetupResultDto> => {
    requireMessagingAvailable();
    const result = await ctx.runMutation(internal.instagram.messaging.lifecycle.enable, {
      orgId: ctx.tenant.orgId,
      issuer: ctx.tenant.issuer,
      subject: ctx.tenant.subject,
      socialAccountId,
    });
    if (!result.ok) throw refusal(result.reason);
    const state = await subscribeIfNeeded(ctx, ctx.tenant, result.accountId);
    if (state === null) throw apiError("CONFLICT", "Messaging was turned off meanwhile.");
    return toSetupResultDto(state);
  },
});

/** Admin: retries the webhook subscription of an account waiting for action. */
export const retrySetup = orgAdminAction({
  args: { accountId: v.string() },
  returns: instagramMessagingSetupResultDto,
  handler: async (ctx, { accountId }): Promise<InstagramMessagingSetupResultDto> => {
    requireMessagingAvailable();
    const state = await subscribeIfNeeded(ctx, ctx.tenant, accountId);
    if (state === null) {
      throw apiError("NOT_FOUND", "No instagramMessagingAccounts record with this id.", {
        table: "instagramMessagingAccounts",
      });
    }
    return toSetupResultDto(state);
  },
});

/**
 * Admin: turns direct messages off. Webhook events reach no org from now on, any org may turn
 * them on, and the stored conversations are deleted after the grace period (`purgeAfter`)
 * unless messaging is turned on again before. Idempotent; never closed by the flag.
 */
export const disable = orgAdminMutation({
  args: { accountId: v.string() },
  returns: instagramMessagingAccountDto,
  handler: async (ctx, { accountId }) => {
    const account = await getOwned(ctx, "instagramMessagingAccounts", accountId);
    await disableMessaging(ctx.db, ctx.tenant, account._id, "turned_off");
    const after = (await ctx.db.get(account._id))!;
    const social = await ctx.db.get(after.socialAccountId);
    return toInstagramMessagingAccountDto(
      after,
      social !== null && social.orgId === ctx.tenant.orgId ? social : null,
    );
  },
});

/** Whether direct messages can be turned on for a linked Instagram account, or how they stand. */
export const getAvailability = orgQuery({
  args: { socialAccountId: v.string() },
  returns: instagramMessagingAvailabilityDto,
  handler: async (ctx, { socialAccountId }): Promise<InstagramMessagingAvailabilityDto> => {
    const id = ctx.db.normalizeId("socialAccounts", socialAccountId);
    if (id === null) return { availability: "not_found" };
    const check = await enableCheck(ctx.db, ctx.tenant.orgId, id);
    const existing = check.existing;
    const known = {
      ...(existing !== null ? { accountId: existing._id } : {}),
      ...(existing?.purgeAfter !== undefined ? { purgeAfter: toIso(existing.purgeAfter) } : {}),
    };
    if (!check.ok && check.reason === "not_found") return { availability: "not_found" };
    if (existing !== null && existing.status !== "disabled") {
      return { availability: existing.status, ...known };
    }
    if (!instagramMessagingEnabled()) return { availability: "unavailable", ...known };
    if (!check.ok) return { availability: check.reason, ...known };
    return { availability: "ready", ...known };
  },
});

/**
 * Editors and admins: sends a text reply (1-1000 UTF-8 bytes [doc]) in one of the caller's
 * conversations, from the conversation's own messaging account (`accountId` must be it; another
 * org's conversation is NOT_FOUND). Refused (CONFLICT, `reason`) when the customer's 24-hour
 * window is closed (`window_closed`: Instagram allows no reply until they write again) or the
 * account cannot send (`messaging_unavailable`, `setup_incomplete`, `reconnect_required`,
 * `scope_missing`). Returns the stored message, `pending` until Meta answers: then `submitted`,
 * `failed` (with `errorCode` / `failureReason`) or `unknown` (may have been sent; never resent
 * automatically). Repeating a call with the same `clientMessageId` returns the same message and
 * sends nothing more. Closed on cloud deployments until INSTAGRAM_MESSAGING_ENABLED is set.
 */
export const sendText = orgMutation({
  args: {
    accountId: v.string(),
    conversationId: v.string(),
    text: v.string(),
    clientMessageId: v.string(),
  },
  returns: instagramMessageDto,
  handler: async (ctx, args) => {
    requireMessagingAvailable();
    const conversation = await getOwned(ctx, "instagramConversations", args.conversationId);
    return toInstagramMessageDto(await queueText(ctx, ctx.tenant, conversation, args));
  },
});
