import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { clampPagination, mapPage, paginatedDto } from "../lib/dto";
import { apiError } from "../lib/errors";
import { getOwned, orgAdminAction, orgMutation, orgQuery } from "../lib/tenancy";
import { setupProgress } from "../whatsapp/accounts";
import { runCleanup } from "../whatsapp/offboarding";
import { queueText } from "../whatsapp/outbound";
import {
  EMBEDDED_SIGNUP_VERSION,
  signupAppConfig,
  WHATSAPP_GRAPH_API_VERSION,
  whatsappConnectionsEnabled,
} from "../whatsapp/config";
import { completeSignup as runSignup, retrySetup as runRetry } from "../whatsapp/signup";
import {
  toWhatsappAccountDto,
  toWhatsappConversationDto,
  toWhatsappDisconnectResultDto,
  toWhatsappMessageDto,
  whatsappAccountDto,
  whatsappConversationDto,
  whatsappDisconnectResultDto,
  whatsappMessageDto,
  whatsappSetupResultDto,
  whatsappSignupConfigDto,
  type WhatsappDisconnectResultDto,
  type WhatsappSetupResultDto,
} from "./dto/whatsapp";

/**
 * WhatsApp inbox (ADR 0013). Tenant-scoped through the verified JWT only: every lookup uses an
 * org-first index with ctx.tenant.orgId, and client-supplied ids go through getOwned (another
 * org's conversation is NOT_FOUND). Viewers may read; sending (sendText) requires editor, and
 * only through the conversation's own number and its org's own connection
 * (convex/whatsapp/outbound.ts).
 *
 * WhatsApp connections (ADR 0014): admins connect a WhatsApp Business Account through Meta's
 * Embedded Signup (getSignupConfig, completeSignup, retrySetup); viewers may list accounts.
 * The org and actor always come from the verified JWT; every Meta asset the browser reports
 * is verified with Meta server-side (convex/whatsapp/signup.ts). Separate from the generic
 * OAuth connection functions in connections.ts, which refuse provider "whatsapp".
 */

const MAX_ACCOUNTS = 50;
const MAX_NUMBERS_PER_ACCOUNT = 100;

/** Admin only: the public values the browser needs to open Embedded Signup. */
export const getSignupConfig = orgQuery({
  minRole: "admin",
  args: {},
  returns: whatsappSignupConfigDto,
  handler: async () => {
    const app = whatsappConnectionsEnabled() ? signupAppConfig() : null;
    return {
      available: app !== null,
      ...(app !== null ? { appId: app.appId, configId: app.configId } : {}),
      graphApiVersion: WHATSAPP_GRAPH_API_VERSION,
      embeddedSignupVersion: EMBEDDED_SIGNUP_VERSION,
    };
  },
});

/**
 * Admin only: completes Embedded Signup. `code` is the 30-second, single-use code from FB.login
 * (exchanged server-side, never stored or logged); `wabaId` and `phoneNumberId` come from Meta's
 * WA_EMBEDDED_SIGNUP message and are verified with Meta before anything is stored. Then the
 * app is subscribed to the WABA and the number registered; a failed step leaves the account
 * `action_required` (retrySetup resumes it).
 */
export const completeSignup = orgAdminAction({
  args: { code: v.string(), wabaId: v.string(), phoneNumberId: v.string() },
  returns: whatsappSetupResultDto,
  handler: async (ctx, args): Promise<WhatsappSetupResultDto> => {
    return await runSignup(ctx, ctx.tenant, args);
  },
});

/** Admin only: retries the missing setup steps of one of the caller's accounts. */
export const retrySetup = orgAdminAction({
  args: { accountId: v.string() },
  returns: whatsappSetupResultDto,
  handler: async (ctx, { accountId }): Promise<WhatsappSetupResultDto> => {
    return await runRetry(ctx, ctx.tenant, { accountId });
  },
});

/**
 * Admin only: disconnects one of the caller's WhatsApp Business Accounts (ADR 0014 B4). Its
 * numbers stop routing and its connection is revoked at once (one transaction); then our app is
 * unsubscribed from the WABA's webhooks at Meta (skipped while another org or an
 * operator-managed number still uses the WABA), retried on a schedule if Meta fails, and the
 * stored token is deleted when that ends. Conversations and messages are kept. Repeating it is
 * harmless; another org's account is NOT_FOUND. Works whatever the connection gate says.
 */
export const disconnectAccount = orgAdminAction({
  args: { accountId: v.string() },
  returns: whatsappDisconnectResultDto,
  handler: async (ctx, { accountId }): Promise<WhatsappDisconnectResultDto> => {
    const begun = await ctx.runMutation(internal.whatsapp.offboarding.beginDisconnect, {
      orgId: ctx.tenant.orgId,
      issuer: ctx.tenant.issuer,
      actorSubject: ctx.tenant.subject,
      accountId,
    });
    if (begun === null) throw apiError("NOT_FOUND", "No WhatsApp account with this id.");
    await runCleanup(ctx, ctx.tenant.orgId, begun.accountId, ctx.tenant.subject);
    const cleanup = await ctx.runQuery(internal.whatsapp.offboarding.cleanupOf, {
      orgId: ctx.tenant.orgId,
      accountId: begun.accountId,
    });
    return toWhatsappDisconnectResultDto(begun.accountId, cleanup);
  },
});

/** The caller's WhatsApp Business Accounts (any status) with their numbers and setup status. */
export const listAccounts = orgQuery({
  args: {},
  returns: v.array(whatsappAccountDto),
  handler: async (ctx) => {
    const accounts = await ctx.db
      .query("whatsappBusinessAccounts")
      .withIndex("by_org_waba", (q) => q.eq("orgId", ctx.tenant.orgId))
      .take(MAX_ACCOUNTS);
    const result = [];
    for (const account of accounts) {
      const numbers = await ctx.db
        .query("whatsappPhoneNumbers")
        .withIndex("by_org_account", (q) =>
          q.eq("orgId", ctx.tenant.orgId).eq("accountId", account._id),
        )
        .take(MAX_NUMBERS_PER_ACCOUNT);
      const active = numbers.filter((n) => n.status === "active");
      const connection = await ctx.db.get(account.connectionId);
      const progress = setupProgress({
        active: account.status === "active",
        connectionActive:
          connection !== null &&
          connection.orgId === ctx.tenant.orgId &&
          connection.status === "active",
        subscribed: account.subscribedAt !== undefined,
        numbersRegistered: active.map((n) => n.platformRegisteredAt !== undefined),
      });
      result.push(toWhatsappAccountDto(account, numbers, progress));
    }
    return result;
  },
});

async function numberOf(
  ctx: { db: DatabaseReader },
  conversation: Doc<"whatsappConversations">,
  orgId: Id<"organizations">,
): Promise<Doc<"whatsappPhoneNumbers">> {
  const number = await ctx.db.get(conversation.numberId);
  if (number === null || number.orgId !== orgId) {
    throw apiError("INTERNAL", "Conversation has no business number.");
  }
  return number;
}

/** The caller's conversations, most recent activity first. */
export const listConversations = orgQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: paginatedDto(whatsappConversationDto),
  handler: async (ctx, args) => {
    const result = await ctx.db
      .query("whatsappConversations")
      .withIndex("by_org_last_message", (q) => q.eq("orgId", ctx.tenant.orgId))
      .order("desc")
      .paginate(clampPagination(args.paginationOpts));
    const numbers = new Map<string, Doc<"whatsappPhoneNumbers">>();
    for (const conversation of result.page) {
      if (!numbers.has(conversation.numberId)) {
        numbers.set(conversation.numberId, await numberOf(ctx, conversation, ctx.tenant.orgId));
      }
    }
    return mapPage(result, (conversation) =>
      toWhatsappConversationDto(conversation, numbers.get(conversation.numberId)!),
    );
  },
});

export const getConversation = orgQuery({
  args: { conversationId: v.string() },
  returns: whatsappConversationDto,
  handler: async (ctx, { conversationId }) => {
    const conversation = await getOwned(ctx, "whatsappConversations", conversationId);
    return toWhatsappConversationDto(
      conversation,
      await numberOf(ctx, conversation, ctx.tenant.orgId),
    );
  },
});

/**
 * Editors and admins: sends a free-form text reply (1-4096 characters) in one of the caller's
 * conversations, from that conversation's business number. Refused (CONFLICT, `reason`) when the
 * customer's 24-hour service window is closed (`service_window_closed`: send a template) or the
 * number cannot send (`number_unavailable`, `number_cannot_send`, `reconnect_required`,
 * `number_not_ready`). Returns the stored message, `pending` until Meta answers: then
 * `submitted`, `failed` (with `errorCode` / `failureReason`) or `unknown` (may have been sent;
 * never resent automatically). `clientMessageId` (8-64 letters, digits, - or _) is chosen by the
 * browser: repeating a call with it returns the same message and sends nothing more.
 */
export const sendText = orgMutation({
  args: { conversationId: v.string(), text: v.string(), clientMessageId: v.string() },
  returns: whatsappMessageDto,
  handler: async (ctx, args) => {
    const conversation = await getOwned(ctx, "whatsappConversations", args.conversationId);
    return toWhatsappMessageDto(await queueText(ctx, ctx.tenant, conversation, args));
  },
});

/** Messages of one of the caller's conversations, newest first. */
export const listMessages = orgQuery({
  args: { conversationId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginatedDto(whatsappMessageDto),
  handler: async (ctx, args) => {
    const conversation = await getOwned(ctx, "whatsappConversations", args.conversationId);
    const result = await ctx.db
      .query("whatsappMessages")
      .withIndex("by_org_conversation_platform", (q) =>
        q.eq("orgId", ctx.tenant.orgId).eq("conversationId", conversation._id),
      )
      .order("desc")
      .paginate(clampPagination(args.paginationOpts));
    return mapPage(result, toWhatsappMessageDto);
  },
});
