import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import type { DatabaseReader } from "../_generated/server";
import { apiError } from "../lib/errors";
import { getOwned, orgMutation, orgQuery } from "../lib/tenancy";
import {
  checkSavedReply,
  MAX_SAVED_REPLIES,
  savedReplyChannelValidator,
  savedReplyInputValidator,
  type SavedReplyInput,
} from "../messaging/savedReplies";
import { savedReplyDto, toSavedReplyDto as toDto } from "./dto/savedReplies";

/**
 * Saved replies (ADR 0021): the org's reusable inbox answers, for WhatsApp and Instagram. Every
 * member may read them; editors and admins (who reply) create, change and delete them. Tenant-
 * scoped through the verified JWT: an org-first index with ctx.tenant.orgId, and client ids
 * through getOwned (another org's reply is NOT_FOUND). Refusals are INVALID_ARGUMENT with
 * `field` and `reason` (convex/messaging/savedReplies.ts), or CONFLICT (`title_in_use`,
 * `limit_reached`).
 */

async function repliesOf(db: DatabaseReader, orgId: Id<"organizations">) {
  return await db
    .query("savedReplies")
    .withIndex("by_org_title", (q) => q.eq("orgId", orgId))
    .take(MAX_SAVED_REPLIES + 1);
}

function checked(input: SavedReplyInput) {
  const result = checkSavedReply(input);
  if (!result.ok) {
    throw apiError("INVALID_ARGUMENT", "The saved reply is not valid.", {
      field: result.field,
      reason: result.reason,
    });
  }
  return result.value;
}

function titleInUse() {
  return apiError("CONFLICT", "Another saved reply has this title.", { reason: "title_in_use" });
}

/** Every member: the org's saved replies by title, optionally only those for one channel. */
export const list = orgQuery({
  args: { channel: v.optional(savedReplyChannelValidator) },
  returns: v.array(savedReplyDto),
  handler: async (ctx, { channel }) => {
    const replies = await repliesOf(ctx.db, ctx.tenant.orgId);
    return replies
      .slice(0, MAX_SAVED_REPLIES)
      .filter((reply) => channel === undefined || reply.channels.includes(channel))
      .map(toDto);
  },
});

/** Editors and admins: adds a saved reply (at most MAX_SAVED_REPLIES per org). */
export const create = orgMutation({
  args: savedReplyInputValidator,
  returns: savedReplyDto,
  handler: async (ctx, args) => {
    const value = checked(args);
    const existing = await repliesOf(ctx.db, ctx.tenant.orgId);
    if (existing.length >= MAX_SAVED_REPLIES) {
      throw apiError("CONFLICT", `At most ${MAX_SAVED_REPLIES} saved replies.`, {
        reason: "limit_reached",
      });
    }
    if (existing.some((reply) => reply.title === value.title)) throw titleInUse();
    const now = Date.now();
    const id = await ctx.db.insert("savedReplies", {
      orgId: ctx.tenant.orgId,
      ...value,
      createdBySubject: ctx.tenant.subject,
      updatedBySubject: ctx.tenant.subject,
      createdAt: now,
      updatedAt: now,
    });
    return toDto((await ctx.db.get(id))!);
  },
});

/** Editors and admins: replaces one of the org's saved replies. */
export const update = orgMutation({
  args: { savedReplyId: v.string(), ...savedReplyInputValidator },
  returns: savedReplyDto,
  handler: async (ctx, { savedReplyId, ...input }) => {
    const reply = await getOwned(ctx, "savedReplies", savedReplyId);
    const value = checked(input);
    const clash = await ctx.db
      .query("savedReplies")
      .withIndex("by_org_title", (q) => q.eq("orgId", ctx.tenant.orgId).eq("title", value.title))
      .first();
    if (clash !== null && clash._id !== reply._id) throw titleInUse();
    await ctx.db.replace(reply._id, {
      orgId: reply.orgId,
      ...value,
      createdBySubject: reply.createdBySubject,
      updatedBySubject: ctx.tenant.subject,
      createdAt: reply.createdAt,
      updatedAt: Date.now(),
    });
    return toDto((await ctx.db.get(reply._id))!);
  },
});

/** Editors and admins: deletes one of the org's saved replies. */
export const remove = orgMutation({
  args: { savedReplyId: v.string() },
  returns: v.null(),
  handler: async (ctx, { savedReplyId }) => {
    const reply = await getOwned(ctx, "savedReplies", savedReplyId);
    await ctx.db.delete(reply._id);
    return null;
  },
});
