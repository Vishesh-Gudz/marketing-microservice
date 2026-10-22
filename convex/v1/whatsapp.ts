import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { clampPagination, mapPage, paginatedDto } from "../lib/dto";
import { apiError } from "../lib/errors";
import { getOwned, orgQuery } from "../lib/tenancy";
import {
  toWhatsappConversationDto,
  toWhatsappMessageDto,
  whatsappConversationDto,
  whatsappMessageDto,
} from "./dto/whatsapp";

/**
 * WhatsApp inbox (ADR 0013), read side. Tenant-scoped through the verified JWT only: every
 * lookup uses an org-first index with ctx.tenant.orgId, and client-supplied ids go through
 * getOwned (another org's conversation is NOT_FOUND). Viewers may read; sending (later stage)
 * requires editor.
 */

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
