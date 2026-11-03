import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { toIso } from "../../lib/dto";
import { savedReplyChannelValidator } from "../../messaging/savedReplies";

/** A saved reply (ADR 0021): business text only. */
export const savedReplyDto = v.object({
  id: v.string(),
  title: v.string(),
  text: v.string(),
  channels: v.array(savedReplyChannelValidator),
  quickReplies: v.optional(v.array(v.string())),
  updatedAt: v.string(),
});
export type SavedReplyDto = Infer<typeof savedReplyDto>;

export function toSavedReplyDto(reply: Doc<"savedReplies">): SavedReplyDto {
  return {
    id: reply._id,
    title: reply.title,
    text: reply.text,
    channels: reply.channels,
    ...(reply.quickReplies !== undefined ? { quickReplies: reply.quickReplies } : {}),
    updatedAt: toIso(reply.updatedAt),
  };
}
