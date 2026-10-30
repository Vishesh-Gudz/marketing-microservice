import { v, type Infer } from "convex/values";

/**
 * The unified inbox's thread DTO (ADR 0018, IM7.3). Labels only, resolved per channel from the
 * channel's own rows: never an Instagram customer id, a Meta message or number id, a token or a
 * platform error. `replyState` is evaluated when the query runs; a client compares
 * `replyWindowExpiresAt` with its own clock, and the channel's send endpoint decides again.
 */
export const inboxThreadDto = v.object({
  /** The thread (index row). */
  id: v.string(),
  channel: v.union(v.literal("whatsapp"), v.literal("instagram")),
  /** The channel's conversation, for its own pages and APIs. */
  conversationId: v.string(),
  /** WhatsApp: the business number as displayed. Instagram: the business account. */
  accountLabel: v.string(),
  /** WhatsApp: the contact's name, else its phone number. Instagram: @username, else name. */
  contactLabel: v.string(),
  lastMessageAt: v.string(),
  lastInboundAt: v.optional(v.string()),
  /**
   * `unavailable`: the channel's sender check refuses (whatever the window); `open`: a free-form
   * reply is allowed now; `closed`: the 24-hour window is closed or never opened (WhatsApp: an
   * approved template only).
   */
  replyState: v.union(v.literal("open"), v.literal("closed"), v.literal("unavailable")),
  replyWindowExpiresAt: v.optional(v.string()),
});
export type InboxThreadDto = Infer<typeof inboxThreadDto>;
