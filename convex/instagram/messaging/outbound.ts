import { v, type Infer } from "convex/values";
import { internal } from "../../_generated/api";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  type ActionCtx,
  type DatabaseReader,
  type DatabaseWriter,
  type MutationCtx,
} from "../../_generated/server";
import {
  CredentialUnavailableError,
  withConnectionCredential,
} from "../../connections/credentialStore";
import { markConnectionNeedsReauth } from "../../connections/lifecycle";
import { touchThread } from "../../inbox/threads";
import { apiError } from "../../lib/errors";
import { isServiceWindowOpen } from "../../messaging/window";
import {
  GRAPH_ORIGIN,
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_MESSAGING_SCOPE,
} from "../../providers/instagram/config";
import { isInstagramCredential } from "../../providers/instagram/credential";
import { classifyInstagramFailure } from "../../providers/instagram/errors";
import { RequestBudget, sendInstagram } from "../../providers/instagram/transport";
import { messagingHolder } from "./accounts";
import {
  CLIENT_MESSAGE_ID,
  MAX_OUTBOUND_TEXT_BYTES,
  SEND_TIMEOUT_MS,
  instagramMessagingEnabled,
  STUCK_SEND_AFTER_MS,
} from "./config";
import { earlyEvent, findMessage } from "./processing";

/**
 * Outbound Instagram text replies (ADR 0017, IM4), the WhatsApp pattern (convex/whatsapp/
 * outbound.ts) where its meaning matches:
 *
 * 1. `queueText` (v1/instagramMessaging:sendText, editors and admins, org from the verified
 *    JWT), one transaction: the browser's `clientMessageId` makes a repeated submit return the
 *    same message; the conversation must be the named messaging account's; the account must be
 *    able to send (`senderOf`); the customer's 24-hour window must be open [doc]; the text is
 *    1-1000 UTF-8 bytes [doc]. The message is stored `pending` and ONE delivery is scheduled,
 *    with a watchdog.
 * 2. `deliver` claims the message (`claimDelivery`: once only, re-checking the sender and the
 *    window), makes ONE call `POST graph.instagram.com/v25.0/{account}/messages` with the
 *    account's own token in `Authorization: Bearer` and `{recipient:{id}, message:{text}}`
 *    [doc], and records the outcome (`recordSendResult`): accepted -> `submitted` with Meta's
 *    `message_id` as the mid; refused (4xx) -> `failed` with Meta's code (a refused token also
 *    moves the connection to `needs_reauth`, if it still has the refused credential); no usable
 *    answer (timeout, network, 5xx, unreadable, no message_id) -> `unknown`, NEVER retried:
 *    Meta documents no idempotency key and the message may have gone out.
 * 3. `settleStuckSend` (STUCK_SEND_AFTER_MS later): still pending and claimed -> `unknown`
 *    (`no_result`); never claimed -> `failed` (`not_sent`). A late real result still replaces
 *    the watchdog's `unknown`.
 *
 * Echoes are matched by mid only, never by text. An echo processed before the send result
 * (processing.ts stored it as origin `instagram`) is merged into the reply when the result is
 * recorded, with any "seen" or deletion that came early; an echo after it just confirms
 * `sent` (processing.ts). A send left `unknown` has no mid, so its echo (if Meta did send it)
 * stays a separate `instagram` row: it cannot be matched reliably.
 *
 * A refused send changes only that message (decided for IM4): Meta's codes do not reliably
 * tell a lost permission from a closed window, so the account's state is never changed here.
 * Nothing logs; the token travels only in the header; failures keep only codes.
 */

const NO_RESULT = "no_result";

export type SendRefusal =
  | "messaging_unavailable"
  | "setup_incomplete"
  | "reconnect_required"
  | "scope_missing"
  | "window_closed";

/** Why the account cannot send at all (whatever the window): also shown before sending. */
export type SenderRefusal = Exclude<SendRefusal, "window_closed">;

const REFUSAL_MESSAGES: Readonly<Record<SendRefusal, string>> = {
  messaging_unavailable: "Direct messages are not on for this Instagram account.",
  setup_incomplete: "Direct messages for this account need attention. Retry their setup first.",
  reconnect_required: "Instagram no longer accepts this connection. Reconnect Instagram.",
  scope_missing: "Reconnect Instagram and allow direct messages first.",
  window_closed:
    "The customer last wrote more than 24 hours ago. Instagram allows no reply until they write again.",
};

type Sender = { connectionId: Id<"connections">; igAccountId: string; recipient: string };

/**
 * Whether the conversation's messaging account can send now, through which connection and to
 * whom. Every row is checked against the conversation's org; the account must still be the one
 * holding its Instagram account (the routing rule), `active`, on an active connection that has
 * the messaging permission.
 */
export async function senderOf(
  db: DatabaseReader,
  conversation: Doc<"instagramConversations">,
): Promise<{ ok: true; sender: Sender } | { ok: false; reason: SenderRefusal }> {
  const refuse = (reason: SenderRefusal) => ({ ok: false as const, reason });
  const account = await db.get(conversation.messagingAccountId);
  if (account === null || account.orgId !== conversation.orgId || account.status === "disabled") {
    return refuse("messaging_unavailable");
  }
  const holder = await messagingHolder(db, account.igAccountId);
  if (holder === null || holder._id !== account._id) return refuse("messaging_unavailable");
  if (account.status === "action_required") return refuse("setup_incomplete");
  const connection = await db.get(account.connectionId);
  if (connection === null || connection.orgId !== account.orgId) {
    return refuse("messaging_unavailable");
  }
  if (connection.status !== "active") return refuse("reconnect_required");
  if (!connection.grantedScopes.includes(INSTAGRAM_MESSAGING_SCOPE)) return refuse("scope_missing");
  return {
    ok: true,
    sender: {
      connectionId: connection._id,
      igAccountId: account.igAccountId,
      recipient: conversation.contactIgsid,
    },
  };
}

/**
 * Why no reply can be sent from this conversation's account now, whatever the window: the same
 * checks as sendText (the flag, then senderOf), so no client is offered a reply the server would
 * refuse. Undefined: the reply window decides. (v1 conversations and the unified inbox.)
 */
export async function replyBlockerOf(
  db: DatabaseReader,
  conversation: Doc<"instagramConversations">,
): Promise<SenderRefusal | undefined> {
  if (!instagramMessagingEnabled()) return "messaging_unavailable";
  const sendable = await senderOf(db, conversation);
  return sendable.ok ? undefined : sendable.reason;
}

const utf8 = new TextEncoder();

/** [doc] The limit is in UTF-8 bytes, not characters (an emoji takes four). */
export function utf8Length(text: string): number {
  return utf8.encode(text).length;
}

async function repeatedSend(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  conversationId: Id<"instagramConversations">,
  clientMessageId: string,
): Promise<Doc<"instagramMessages"> | null> {
  const repeated = await db
    .query("instagramMessages")
    .withIndex("by_org_client_message", (q) =>
      q.eq("orgId", orgId).eq("clientMessageId", clientMessageId),
    )
    .first();
  if (repeated === null) return null;
  if (repeated.conversationId !== conversationId || repeated.origin !== "app") {
    throw apiError("CONFLICT", "This clientMessageId was already used for another message.", {
      reason: "client_message_id_reused",
    });
  }
  return repeated;
}

/** Step 1 (see the module comment). Returns the stored message (new, or the repeated one). */
export async function queueText(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  tenant: { orgId: Id<"organizations">; subject: string },
  conversation: Doc<"instagramConversations">,
  args: { accountId: string; text: string; clientMessageId: string },
): Promise<Doc<"instagramMessages">> {
  if (!CLIENT_MESSAGE_ID.test(args.clientMessageId)) {
    throw apiError("INVALID_ARGUMENT", "clientMessageId must be 8-64 letters, digits, - or _.", {
      field: "clientMessageId",
    });
  }
  // The conversation must be the named account's (both are the caller's org's: getOwned).
  if (args.accountId !== conversation.messagingAccountId) {
    throw apiError("NOT_FOUND", "No instagramConversations record with this id.", {
      table: "instagramConversations",
    });
  }
  if (args.text.trim() === "" || utf8Length(args.text) > MAX_OUTBOUND_TEXT_BYTES) {
    throw apiError(
      "INVALID_ARGUMENT",
      `text must be 1-${MAX_OUTBOUND_TEXT_BYTES} bytes of UTF-8 and not blank.`,
      { field: "text" },
    );
  }
  const repeated = await repeatedSend(ctx.db, tenant.orgId, conversation._id, args.clientMessageId);
  if (repeated !== null) return repeated;
  const sendable = await senderOf(ctx.db, conversation);
  if (!sendable.ok) {
    throw apiError("CONFLICT", REFUSAL_MESSAGES[sendable.reason], { reason: sendable.reason });
  }
  const now = Date.now();
  if (!isServiceWindowOpen(conversation.lastInboundAt, now)) {
    throw apiError("CONFLICT", REFUSAL_MESSAGES.window_closed, { reason: "window_closed" });
  }

  const messageId = await ctx.db.insert("instagramMessages", {
    orgId: tenant.orgId,
    conversationId: conversation._id,
    messagingAccountId: conversation.messagingAccountId,
    direction: "outbound",
    origin: "app",
    messageType: "text",
    text: args.text,
    status: "pending",
    platformAt: now,
    clientMessageId: args.clientMessageId,
    sentBySubject: tenant.subject,
    createdAt: now,
    updatedAt: now,
  });
  const lastMessageAt = Math.max(conversation.lastMessageAt, now);
  await ctx.db.patch(conversation._id, { lastMessageAt, updatedAt: now });
  // ADR 0018: the unified inbox's thread row follows the conversation (same transaction).
  await touchThread(
    ctx.db,
    conversation.orgId,
    { channel: "instagram", conversationId: conversation._id },
    lastMessageAt,
  );
  const ids = { orgId: tenant.orgId, messageId };
  await ctx.scheduler.runAfter(0, internal.instagram.messaging.outbound.deliver, ids);
  await ctx.scheduler.runAfter(
    STUCK_SEND_AFTER_MS,
    internal.instagram.messaging.outbound.settleStuckSend,
    ids,
  );
  return (await ctx.db.get(messageId))!;
}

const claimValidator = v.object({
  connectionId: v.id("connections"),
  igAccountId: v.string(),
  recipient: v.string(),
  text: v.string(),
});

const messageArgs = { orgId: v.id("organizations"), messageId: v.id("instagramMessages") };

async function failUnsent(
  db: DatabaseWriter,
  message: Doc<"instagramMessages">,
  reason: string,
  now: number,
) {
  await db.patch(message._id, {
    status: "failed",
    failedAt: now,
    failureReason: reason,
    updatedAt: now,
  });
}

/**
 * Claims the one Meta call for a pending message; the ONLY way to get it. Null if the message
 * is not pending or already claimed. The sender and the window are checked again: if either no
 * longer allows it, the message fails here without any Meta call.
 */
export const claimDelivery = internalMutation({
  args: messageArgs,
  returns: v.union(v.null(), claimValidator),
  handler: async (ctx, { orgId, messageId }) => {
    const message = await ctx.db.get(messageId);
    if (
      message === null ||
      message.orgId !== orgId ||
      message.origin !== "app" ||
      message.status !== "pending" ||
      message.sendAttemptedAt !== undefined
    ) {
      return null;
    }
    const now = Date.now();
    const conversation = await ctx.db.get(message.conversationId);
    if (conversation === null || conversation.orgId !== orgId || message.text === undefined) {
      await failUnsent(ctx.db, message, "invalid_message", now);
      return null;
    }
    const sendable = await senderOf(ctx.db, conversation);
    if (!sendable.ok) {
      await failUnsent(ctx.db, message, sendable.reason, now);
      return null;
    }
    if (!isServiceWindowOpen(conversation.lastInboundAt, now)) {
      await failUnsent(ctx.db, message, "window_closed", now);
      return null;
    }
    await ctx.db.patch(message._id, { sendAttemptedAt: now, updatedAt: now });
    return { ...sendable.sender, text: message.text };
  },
});

const MID = /^[\x21-\x7e]{1,512}$/;

const outcomeValidator = v.union(
  v.object({ kind: v.literal("accepted"), mid: v.string() }),
  v.object({
    kind: v.literal("refused"),
    reason: v.string(),
    metaCode: v.optional(v.number()),
    tokenRefused: v.boolean(),
    /** The credential the refused call used (a reconnect since then replaced it). */
    credentialVersion: v.optional(v.number()),
  }),
  v.object({ kind: v.literal("unknown"), reason: v.string() }),
);
type Outcome = Infer<typeof outcomeValidator>;

/** The one Meta call. Never throws; nothing is called when the token cannot be used. */
async function send(ctx: ActionCtx, claim: Infer<typeof claimValidator>): Promise<Outcome> {
  try {
    return await withConnectionCredential(ctx, claim.connectionId, async (credential, binding) => {
      if (!isInstagramCredential(credential) || credential.userId !== claim.igAccountId) {
        return { kind: "refused", reason: "credential_invalid", tokenRefused: false };
      }
      const result = await sendInstagram(
        "messaging",
        new URL(`${GRAPH_ORIGIN}/${INSTAGRAM_GRAPH_VERSION}/${claim.igAccountId}/messages`),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            recipient: { id: claim.recipient },
            message: { text: claim.text },
          }),
        },
        { timeoutMs: SEND_TIMEOUT_MS, budget: new RequestBudget(1) },
      );
      if (result.ok) {
        const mid = (result.body as { message_id?: unknown } | null)?.message_id;
        // Accepted without a usable id: it may have been sent, but nothing can match it.
        return typeof mid === "string" && MID.test(mid)
          ? { kind: "accepted", mid }
          : { kind: "unknown", reason: "unexpected_response" };
      }
      const failure = result.failure;
      switch (failure.type) {
        case "blocked":
          return { kind: "refused", reason: "transport_blocked", tokenRefused: false };
        case "budget_exceeded":
          return { kind: "refused", reason: "request_budget_exceeded", tokenRefused: false };
        case "network":
        case "timeout":
          return { kind: "unknown", reason: failure.type };
        case "invalid_json":
          return { kind: "unknown", reason: "unexpected_response" };
        case "http":
          if (failure.status >= 500) return { kind: "unknown", reason: `http_${failure.status}` };
          return {
            kind: "refused",
            reason:
              failure.error?.code !== undefined
                ? `meta_${failure.error.code}`
                : `http_${failure.status}`,
            ...(failure.error?.code !== undefined ? { metaCode: failure.error.code } : {}),
            tokenRefused: classifyInstagramFailure(failure).kind === "auth",
            credentialVersion: binding.credentialVersion,
          };
      }
    });
  } catch (error) {
    // No stored credential, the connection is no longer active, or it could not be decrypted:
    // no call was made.
    if (error instanceof CredentialUnavailableError) {
      return { kind: "refused", reason: "credential_unavailable", tokenRefused: false };
    }
    throw error;
  }
}

/**
 * The reply is accepted with `mid`: an echo that came first (stored as origin `instagram` in
 * the same thread) is merged into it, and a "seen" or deletion that came first is applied.
 */
async function acceptWithMid(
  db: DatabaseWriter,
  message: Doc<"instagramMessages">,
  mid: string,
  now: number,
): Promise<void> {
  const conversation = (await db.get(message.conversationId))!;
  const customer = conversation.contactIgsid;
  const echo = await findMessage(db, message, mid);
  const merge =
    echo !== null &&
    echo._id !== message._id &&
    echo.origin === "instagram" &&
    echo.conversationId === message.conversationId;
  const seen = await earlyEvent(db, message, `read:${mid}`, customer);
  const deletion = await earlyEvent(db, message, `delete:${mid}`, customer);
  const readAt = seen?.at ?? (merge ? echo.readAt : undefined);
  const deletedAt = deletion?.at ?? (merge ? echo.deletedAt : undefined);

  await db.patch(message._id, {
    mid,
    status: readAt !== undefined ? "read" : merge ? "sent" : "submitted",
    ...(merge ? { sentAt: echo.sentAt ?? echo.platformAt } : {}),
    ...(readAt !== undefined ? { readAt } : {}),
    ...(deletedAt !== undefined ? { deletedAt, text: undefined } : {}),
    failureReason: undefined,
    updatedAt: now,
  });
  if (merge) await db.delete(echo._id);
  for (const early of [seen, deletion]) {
    if (early !== null) {
      await db.patch(early.id, { status: "processed", processedAt: now, event: undefined });
    }
  }
}

/**
 * Records the claimed call's outcome (step 2). Only a pending reply changes, or one the
 * watchdog already marked `unknown` (`no_result`) because this result came late.
 */
export const recordSendResult = internalMutation({
  args: { ...messageArgs, connectionId: v.id("connections"), outcome: outcomeValidator },
  returns: v.null(),
  handler: async (ctx, { orgId, messageId, connectionId, outcome }) => {
    const message = await ctx.db.get(messageId);
    if (
      message === null ||
      message.orgId !== orgId ||
      message.origin !== "app" ||
      !(
        message.status === "pending" ||
        (message.status === "unknown" && message.failureReason === NO_RESULT)
      )
    ) {
      return null;
    }
    const now = Date.now();
    if (outcome.kind === "accepted") {
      await acceptWithMid(ctx.db, message, outcome.mid, now);
      return null;
    }
    if (outcome.kind === "unknown") {
      await ctx.db.patch(message._id, {
        status: "unknown",
        failureReason: outcome.reason,
        updatedAt: now,
      });
      return null;
    }
    await ctx.db.patch(message._id, {
      status: "failed",
      failedAt: now,
      failureReason: outcome.reason,
      ...(outcome.metaCode !== undefined ? { errorCode: outcome.metaCode } : {}),
      updatedAt: now,
    });
    // A refused token can send nothing more: the connection needs a reconnect, unless a
    // reconnect already replaced the credential that was refused.
    const connection = await ctx.db.get(connectionId);
    if (
      outcome.tokenRefused &&
      message.sentBySubject !== undefined &&
      connection !== null &&
      connection.orgId === orgId &&
      connection.credentialVersion === outcome.credentialVersion
    ) {
      await markConnectionNeedsReauth(
        ctx.db,
        connectionId,
        "instagram_token_invalid",
        message.sentBySubject,
      );
    }
    return null;
  },
});

/** Step 3: settles a reply still `pending` STUCK_SEND_AFTER_MS after it was queued. */
export const settleStuckSend = internalMutation({
  args: messageArgs,
  returns: v.null(),
  handler: async (ctx, { orgId, messageId }) => {
    const message = await ctx.db.get(messageId);
    const now = Date.now();
    if (
      message === null ||
      message.orgId !== orgId ||
      message.origin !== "app" ||
      message.status !== "pending" ||
      now < message.createdAt + STUCK_SEND_AFTER_MS
    ) {
      return null;
    }
    await ctx.db.patch(
      message._id,
      message.sendAttemptedAt !== undefined
        ? { status: "unknown", failureReason: NO_RESULT, updatedAt: now }
        : { status: "failed", failedAt: now, failureReason: "not_sent", updatedAt: now },
    );
    return null;
  },
});

/** Step 2: the scheduled delivery of one queued reply (at most one Meta call). */
export const deliver = internalAction({
  args: messageArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.runMutation(internal.instagram.messaging.outbound.claimDelivery, args);
    if (claim === null) return null;
    const outcome = await send(ctx, claim);
    await ctx.runMutation(internal.instagram.messaging.outbound.recordSendResult, {
      ...args,
      connectionId: claim.connectionId,
      outcome,
    });
    return null;
  },
});
