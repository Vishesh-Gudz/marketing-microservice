import type { FunctionReturnType } from "convex/server";
import { isMarketingError } from "@/convex/lib/errors";
import type { api } from "@/convex/_generated/api";
import type { Notice } from "@/lib/connections/types";

/**
 * Saved replies in the dashboard (ADR 0021): types from the public v1 API, the limits the forms
 * count with (the server checks every rule again, convex/messaging/savedReplies.ts), filling in
 * `{{customer_name}}`, and fixed texts.
 */

export type SavedReply = FunctionReturnType<typeof api.v1.savedReplies.list>[number];
export type SavedReplyChannel = SavedReply["channels"][number];

export const LIMITS = {
  title: 60,
  whatsappChars: 4096,
  instagramBytes: 1000,
  quickReplies: 13,
  quickReplyChars: 20,
} as const;

export const CHANNEL_LABELS: Readonly<Record<SavedReplyChannel, string>> = {
  whatsapp: "WhatsApp",
  instagram: "Instagram",
};

export const CUSTOMER_NAME = "{{customer_name}}";

const utf8 = new TextEncoder();
export function utf8Bytes(text: string): number {
  return utf8.encode(text).length;
}

/**
 * The reply's text for this customer: `{{customer_name}}` becomes their first name, or is left
 * out with the comma and space before it when the name is unknown ("Thank you, {{customer_name}}!"
 * -> "Thank you!", "Hi {{customer_name}}, thanks" -> "Hi, thanks").
 */
export function fillSavedReply(text: string, contactName: string | undefined): string {
  const first = contactName?.trim().split(/\s+/)[0];
  if (first) return text.split(CUSTOMER_NAME).join(first);
  return text.replace(/,?\s?\{\{customer_name\}\}/g, "");
}

/** Whether a reply fits Instagram's limit (1000 UTF-8 bytes) when offered there. */
export function textTooLong(text: string, channels: SavedReplyChannel[]): boolean {
  return (
    text.length > LIMITS.whatsappChars ||
    (channels.includes("instagram") && utf8Bytes(text) > LIMITS.instagramBytes)
  );
}

/** Saved-reply refusals by `reason` (convex/messaging/savedReplies.ts, convex/v1/savedReplies.ts). */
export const SAVED_REPLY_ERRORS: Readonly<Record<string, string>> = {
  title_missing: "Give the saved reply a title.",
  title_too_long: "Titles are 60 characters at most.",
  text_missing: "Write the reply.",
  text_too_long: "The reply is too long: 1000 bytes for Instagram, 4096 characters for WhatsApp.",
  no_channel: "Choose WhatsApp, Instagram or both.",
  quick_replies_instagram_only: "Quick-reply buttons are for Instagram only.",
  too_many_quick_replies: "Use at most 13 quick-reply buttons.",
  quick_reply_text: "Every quick-reply button needs a label of up to 20 characters.",
  duplicate_quick_reply: "Every quick-reply button needs a different label.",
  title_in_use: "Another saved reply has this title. Choose another one.",
  limit_reached: "Your organization has 200 saved replies, the most allowed. Delete one first.",
};

export function savedReplyErrorNotice(error: unknown): Notice {
  if (isMarketingError(error)) {
    const reason = error.data.details?.reason;
    const known = typeof reason === "string" ? SAVED_REPLY_ERRORS[reason] : undefined;
    if (known) return { tone: "error", title: "Saved reply not saved", message: known };
    switch (error.data.code) {
      case "FORBIDDEN":
        return {
          tone: "error",
          title: "Editors and admins only",
          message: "Only editors and admins can change saved replies.",
        };
      case "NOT_FOUND":
        return {
          tone: "error",
          title: "Saved reply not found",
          message: "It was deleted meanwhile. Reload the page.",
        };
      case "UNAUTHENTICATED":
        return { tone: "error", title: "Signed out", message: "Sign in again, then retry." };
    }
  }
  return {
    tone: "error",
    title: "Saved reply not saved",
    message: "Something went wrong. Try again.",
  };
}
