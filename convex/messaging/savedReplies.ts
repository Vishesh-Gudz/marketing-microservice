import { v } from "convex/values";

/**
 * Saved replies (ADR 0021; pure, no Convex runtime): an org's library of reusable answers for
 * the inbox, shared by WhatsApp and Instagram. Each reply names the channels it is for; an
 * Instagram one may carry quick-reply buttons (Instagram only, [doc] up to 13 of 20 characters).
 * They are inserted into the reply box and edited there before sending: sending checks the text
 * again (and the reply window) like any typed reply.
 *
 * `{{customer_name}}` is the only placeholder; the dashboard fills it with the contact's name
 * when inserting. Saved replies are business text, never customer data.
 */

export const SAVED_REPLY_CHANNELS = ["whatsapp", "instagram"] as const;
export type SavedReplyChannel = (typeof SAVED_REPLY_CHANNELS)[number];
export const savedReplyChannelValidator = v.union(v.literal("whatsapp"), v.literal("instagram"));

export const MAX_SAVED_REPLIES = 200;
export const MAX_TITLE_CHARS = 60;
/** WhatsApp text replies: 4096 characters ([doc] "Send messages"). */
export const MAX_WHATSAPP_TEXT_CHARS = 4096;
/** Instagram text replies: 1000 UTF-8 bytes ([doc]). */
export const MAX_INSTAGRAM_TEXT_BYTES = 1000;
/** Instagram quick replies ([doc] "Quick replies"): up to 13, 20 characters each. */
export const MAX_QUICK_REPLIES = 13;
export const MAX_QUICK_REPLY_CHARS = 20;

export const savedReplyInputValidator = {
  title: v.string(),
  text: v.string(),
  channels: v.array(savedReplyChannelValidator),
  quickReplies: v.optional(v.array(v.string())),
};
export type SavedReplyInput = {
  title: string;
  text: string;
  channels: SavedReplyChannel[];
  quickReplies?: string[];
};

export const SAVED_REPLY_REFUSALS = [
  "title_missing",
  "title_too_long",
  "text_missing",
  "text_too_long",
  "no_channel",
  "quick_replies_instagram_only",
  "too_many_quick_replies",
  "quick_reply_text",
  "duplicate_quick_reply",
] as const;
export type SavedReplyRefusal = (typeof SAVED_REPLY_REFUSALS)[number];

const utf8 = new TextEncoder();

/** UTF-8 bytes of a text (Instagram's limit is in bytes). */
export function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

/**
 * Checks quick-reply titles (Instagram [doc]: plain text, up to 13, 20 characters each); trims
 * them. Shared with sending (convex/instagram/messaging/outbound.ts).
 */
export function checkQuickReplies(
  titles: string[],
): { ok: true; titles: string[] } | { ok: false; reason: SavedReplyRefusal; index?: number } {
  if (titles.length > MAX_QUICK_REPLIES) return { ok: false, reason: "too_many_quick_replies" };
  const trimmed: string[] = [];
  for (const [index, title] of titles.entries()) {
    const value = title.trim();
    if (value === "" || value.length > MAX_QUICK_REPLY_CHARS || /[\r\n]/.test(value)) {
      return { ok: false, reason: "quick_reply_text", index };
    }
    if (trimmed.includes(value)) return { ok: false, reason: "duplicate_quick_reply", index };
    trimmed.push(value);
  }
  return { ok: true, titles: trimmed };
}

/** A checked saved reply: trimmed, channels unique and in a fixed order. */
export type CheckedSavedReply = {
  title: string;
  text: string;
  channels: SavedReplyChannel[];
  quickReplies?: string[];
};

export function checkSavedReply(
  input: SavedReplyInput,
):
  { ok: true; value: CheckedSavedReply } | { ok: false; reason: SavedReplyRefusal; field: string } {
  const title = input.title.trim();
  if (title === "") return { ok: false, reason: "title_missing", field: "title" };
  if (title.length > MAX_TITLE_CHARS)
    return { ok: false, reason: "title_too_long", field: "title" };
  const channels = SAVED_REPLY_CHANNELS.filter((c) => input.channels.includes(c));
  if (channels.length === 0) return { ok: false, reason: "no_channel", field: "channels" };
  const text = input.text.trim();
  if (text === "") return { ok: false, reason: "text_missing", field: "text" };
  if (
    (channels.includes("instagram") && utf8Bytes(text) > MAX_INSTAGRAM_TEXT_BYTES) ||
    text.length > MAX_WHATSAPP_TEXT_CHARS
  ) {
    return { ok: false, reason: "text_too_long", field: "text" };
  }
  const titles = input.quickReplies ?? [];
  if (titles.length > 0 && !channels.includes("instagram")) {
    return { ok: false, reason: "quick_replies_instagram_only", field: "quickReplies" };
  }
  const checked = checkQuickReplies(titles);
  if (!checked.ok) {
    return {
      ok: false,
      reason: checked.reason,
      field: checked.index === undefined ? "quickReplies" : `quickReplies.${checked.index}`,
    };
  }
  return {
    ok: true,
    value: {
      title,
      text,
      channels,
      ...(checked.titles.length > 0 ? { quickReplies: checked.titles } : {}),
    },
  };
}
