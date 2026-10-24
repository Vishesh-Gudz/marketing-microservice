import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  type ActionCtx,
  type DatabaseReader,
  type DatabaseWriter,
  type MutationCtx,
} from "../_generated/server";
import { withConnectionCredential } from "../connections/credentialStore";
import { markConnectionNeedsReauth } from "../connections/lifecycle";
import { apiError } from "../lib/errors";
import {
  CLIENT_MESSAGE_ID,
  configuredSecret,
  MAX_OUTBOUND_TEXT_CHARS,
  STUCK_SEND_AFTER_MS,
  WHATSAPP_ENV,
} from "./config";
import { sendMessage, type SendOutcome } from "./graph";
import { statusDedupeKey } from "./ingest";
import { STATUS_VALUES } from "./payload";
import { failureReason, parseCredential, tokenRefused } from "./signup";
import { applyDeliveryStatus, type DeliveryPatch, type DeliveryState } from "./status";
import { isServiceWindowOpen } from "./window";

/**
 * Outbound WhatsApp messages (ADR 0013 stage 5): text replies in an existing conversation.
 *
 * 1. `queueText` (v1/whatsapp:sendText, editors and admins, org from the verified JWT), one
 *    transaction: the browser's `clientMessageId` makes a repeated submit return the same
 *    message; the conversation's number must be able to send (`senderOf`: connected through
 *    Embedded Signup, active and registered); the 24-hour customer-service window must be open.
 *    The message is stored `pending` and ONE delivery is scheduled.
 * 2. `deliver` claims the message (`claimDelivery`: once only, re-checking the number), calls
 *    Meta with the org's own token from the number's own connection, and records the outcome
 *    (`recordSendResult`): accepted -> `submitted` with Meta's wamid, then any status webhooks
 *    that arrived before it (stored `unmatched`) are applied; refused -> `failed` with Meta's code
 *    (a refused token also marks the connection needs_reauth); no usable answer (timeout,
 *    network, 5xx, unreadable) -> `unknown`, never retried: Meta has no idempotency key and the
 *    message may have gone out.
 * 3. A watchdog (`settleStuckSend`), scheduled with the delivery, settles a message still
 *    `pending` STUCK_SEND_AFTER_MS later (Convex does not retry a failed action): claimed but no
 *    result recorded (the action failed after the claim; Meta may have it) -> `unknown`
 *    (`no_result`); never claimed (no Meta call was made) -> `failed` (`not_sent`), and a late
 *    delivery finds it no longer pending. A real result recorded after the watchdog's `unknown`
 *    still replaces it.
 *
 * Statuses then arrive through the webhook (processing.ts, status.ts). Nothing here logs; a
 * failure keeps only a sanitized reason code and Meta's numeric code.
 */

/** The watchdog's reason for a claimed send whose result never came. */
const NO_RESULT = "no_result";

export type SendRefusal =
  "number_unavailable" | "number_cannot_send" | "reconnect_required" | "number_not_ready";

const REFUSAL_MESSAGES: Readonly<Record<SendRefusal, string>> = {
  number_unavailable: "This WhatsApp number is no longer connected.",
  number_cannot_send: "This number was set up by support and cannot send from here.",
  reconnect_required: "Meta no longer accepts this connection. Connect WhatsApp again.",
  number_not_ready: "This number is not registered for messaging yet. Finish its setup first.",
};

type Sender = { connectionId: Id<"connections">; phoneNumberId: string };

/**
 * Whether the conversation's business number can send now, and through which connection. Only
 * numbers connected through Embedded Signup can: an operator-managed number has no stored
 * token. Every row is checked against the conversation's org.
 */
export async function senderOf(
  db: DatabaseReader,
  conversation: Doc<"whatsappConversations">,
): Promise<{ ok: true; sender: Sender } | { ok: false; reason: SendRefusal }> {
  const orgId = conversation.orgId;
  const number = await db.get(conversation.numberId);
  if (number === null || number.orgId !== orgId || number.status !== "active") {
    return { ok: false, reason: "number_unavailable" };
  }
  if (number.accountId === undefined) return { ok: false, reason: "number_cannot_send" };
  const account = await db.get(number.accountId);
  if (account === null || account.orgId !== orgId || account.status !== "active") {
    return { ok: false, reason: "number_unavailable" };
  }
  const connection = await db.get(account.connectionId);
  if (connection === null || connection.orgId !== orgId) {
    return { ok: false, reason: "number_unavailable" };
  }
  if (connection.status !== "active") return { ok: false, reason: "reconnect_required" };
  if (number.platformRegisteredAt === undefined) return { ok: false, reason: "number_not_ready" };
  return {
    ok: true,
    sender: { connectionId: connection._id, phoneNumberId: number.phoneNumberId },
  };
}

/** Step 1 (see the module comment). Returns the stored message (new, or the repeated one). */
export async function queueText(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  tenant: { orgId: Id<"organizations">; subject: string },
  conversation: Doc<"whatsappConversations">,
  args: { text: string; clientMessageId: string },
): Promise<Doc<"whatsappMessages">> {
  if (!CLIENT_MESSAGE_ID.test(args.clientMessageId)) {
    throw apiError("INVALID_ARGUMENT", "clientMessageId must be 8-64 letters, digits, - or _.", {
      field: "clientMessageId",
    });
  }
  if (args.text.trim() === "" || args.text.length > MAX_OUTBOUND_TEXT_CHARS) {
    throw apiError("INVALID_ARGUMENT", `text must be 1-${MAX_OUTBOUND_TEXT_CHARS} characters.`, {
      field: "text",
    });
  }
  const repeated = await ctx.db
    .query("whatsappMessages")
    .withIndex("by_org_client_message", (q) =>
      q.eq("orgId", tenant.orgId).eq("clientMessageId", args.clientMessageId),
    )
    .first();
  if (repeated !== null) {
    if (repeated.conversationId !== conversation._id || repeated.direction !== "outbound") {
      throw apiError("CONFLICT", "This clientMessageId was already used for another message.", {
        reason: "client_message_id_reused",
      });
    }
    return repeated;
  }

  const sendable = await senderOf(ctx.db, conversation);
  if (!sendable.ok) {
    throw apiError("CONFLICT", REFUSAL_MESSAGES[sendable.reason], { reason: sendable.reason });
  }
  const now = Date.now();
  if (!isServiceWindowOpen(conversation.lastInboundAt, now)) {
    throw apiError(
      "CONFLICT",
      "The customer last wrote more than 24 hours ago. Send an approved template instead.",
      { reason: "service_window_closed" },
    );
  }

  const messageId = await ctx.db.insert("whatsappMessages", {
    orgId: tenant.orgId,
    conversationId: conversation._id,
    numberId: conversation.numberId,
    direction: "outbound",
    messageType: "text",
    text: args.text,
    status: "pending",
    platformAt: now,
    clientMessageId: args.clientMessageId,
    sentBySubject: tenant.subject,
    createdAt: now,
    updatedAt: now,
  });
  await ctx.db.patch(conversation._id, {
    lastMessageAt: Math.max(conversation.lastMessageAt, now),
    updatedAt: now,
  });
  await ctx.scheduler.runAfter(0, internal.whatsapp.outbound.deliver, {
    orgId: tenant.orgId,
    messageId,
  });
  await ctx.scheduler.runAfter(STUCK_SEND_AFTER_MS, internal.whatsapp.outbound.settleStuckSend, {
    orgId: tenant.orgId,
    messageId,
  });
  return (await ctx.db.get(messageId))!;
}

const claimValidator = v.object({
  connectionId: v.id("connections"),
  phoneNumberId: v.string(),
  /** The recipient: "+" and the customer's WhatsApp id (which carries the country code). */
  to: v.string(),
  text: v.string(),
});

/**
 * Claims the one Meta call for a pending message; the ONLY way to get it. Refused (null) if the
 * message is not pending or already claimed. The number is checked again: if it can no longer
 * send, the message fails here without any Meta call.
 */
export const claimDelivery = internalMutation({
  args: { orgId: v.id("organizations"), messageId: v.id("whatsappMessages") },
  returns: v.union(v.null(), claimValidator),
  handler: async (ctx, { orgId, messageId }) => {
    const message = await ctx.db.get(messageId);
    if (
      message === null ||
      message.orgId !== orgId ||
      message.direction !== "outbound" ||
      message.status !== "pending" ||
      message.sendAttemptedAt !== undefined
    ) {
      return null;
    }
    const now = Date.now();
    const conversation = await ctx.db.get(message.conversationId);
    const sendable =
      conversation === null || conversation.orgId !== orgId
        ? ({ ok: false, reason: "number_unavailable" } as const)
        : await senderOf(ctx.db, conversation);
    if (!sendable.ok || conversation === null || message.text === undefined) {
      await ctx.db.patch(message._id, {
        status: "failed",
        failedAt: now,
        failureReason: sendable.ok ? "invalid_message" : sendable.reason,
        updatedAt: now,
      });
      return null;
    }
    await ctx.db.patch(message._id, { sendAttemptedAt: now, updatedAt: now });
    return {
      connectionId: sendable.sender.connectionId,
      phoneNumberId: sendable.sender.phoneNumberId,
      to: `+${conversation.contactWaId}`,
      text: message.text,
    };
  },
});

const outcomeValidator = v.union(
  v.object({ kind: v.literal("accepted"), wamid: v.string() }),
  v.object({
    kind: v.literal("refused"),
    reason: v.string(),
    metaCode: v.optional(v.number()),
    tokenRefused: v.boolean(),
  }),
  v.object({ kind: v.literal("unknown"), reason: v.string() }),
);
type Outcome = Infer<typeof outcomeValidator>;

/** Meta's answer as an outcome. Only a 4xx with an answer is a definite refusal. */
function outcomeOf(result: SendOutcome): Outcome {
  if (result.ok) return { kind: "accepted", wamid: result.wamid };
  const failure = result.failure;
  // No answer, an unreadable one, or a server error: the message may have gone out.
  if (failure.kind !== "http" || (failure.status ?? 0) >= 500) {
    return { kind: "unknown", reason: failureReason(failure) };
  }
  return {
    kind: "refused",
    reason: failureReason(failure),
    ...(failure.metaCode !== undefined ? { metaCode: failure.metaCode } : {}),
    tokenRefused: tokenRefused(failure),
  };
}

/** The one Meta call. Never throws; nothing is called when the token cannot be read. */
async function send(ctx: ActionCtx, claim: Infer<typeof claimValidator>): Promise<Outcome> {
  const appSecret = configuredSecret(process.env[WHATSAPP_ENV.appSecret]);
  if (appSecret === null) return { kind: "refused", reason: "not_configured", tokenRefused: false };
  try {
    return await withConnectionCredential(ctx, claim.connectionId, async (credential) => {
      const parsed = parseCredential(credential);
      if (parsed === null) {
        return { kind: "refused", reason: "credential_unavailable", tokenRefused: false };
      }
      return outcomeOf(
        await sendMessage(
          claim.phoneNumberId,
          { to: claim.to, type: "text", text: { body: claim.text } },
          { accessToken: parsed.accessToken, appSecret },
        ),
      );
    });
  } catch {
    // No stored credential, the connection is no longer active, or the credential could not be
    // decrypted: no call was made.
    return { kind: "refused", reason: "credential_unavailable", tokenRefused: false };
  }
}

/**
 * Applies the status webhooks for this wamid that arrived before the send result (stored
 * `unmatched`, keyed `status:<wamid>:<status>` in the message's org), in the same transaction.
 */
async function applyEarlyStatuses(
  db: DatabaseWriter,
  message: Doc<"whatsappMessages">,
  wamid: string,
  now: number,
): Promise<void> {
  let current: DeliveryState = message;
  const patch: DeliveryPatch = {};
  for (const status of STATUS_VALUES) {
    const event = await db
      .query("whatsappWebhookEvents")
      .withIndex("by_org_dedupe", (q) =>
        q.eq("orgId", message.orgId).eq("dedupeKey", statusDedupeKey(wamid, status)),
      )
      .first();
    if (event === null || event.status !== "unmatched" || event.event?.kind !== "status") continue;
    const change = applyDeliveryStatus(current, event.event);
    if (change !== null) {
      Object.assign(patch, change);
      current = { ...current, ...change };
    }
    await db.patch(event._id, {
      status: change === null ? "ignored" : "processed",
      processedAt: now,
      event: undefined,
    });
  }
  if (Object.keys(patch).length > 0) await db.patch(message._id, { ...patch, updatedAt: now });
}

/**
 * Records the claimed call's outcome (step 2). Only a pending message changes, or one the
 * watchdog already marked `unknown` (`no_result`) because this result came late: the real answer
 * replaces the guess.
 */
export const recordSendResult = internalMutation({
  args: {
    orgId: v.id("organizations"),
    messageId: v.id("whatsappMessages"),
    connectionId: v.id("connections"),
    outcome: outcomeValidator,
  },
  returns: v.null(),
  handler: async (ctx, { orgId, messageId, connectionId, outcome }) => {
    const message = await ctx.db.get(messageId);
    if (
      message === null ||
      message.orgId !== orgId ||
      message.direction !== "outbound" ||
      !(
        message.status === "pending" ||
        (message.status === "unknown" && message.failureReason === NO_RESULT)
      )
    ) {
      return null;
    }
    const now = Date.now();
    if (outcome.kind === "accepted") {
      await ctx.db.patch(message._id, {
        status: "submitted",
        wamid: outcome.wamid,
        failureReason: undefined,
        updatedAt: now,
      });
      await applyEarlyStatuses(
        ctx.db,
        { ...message, status: "submitted", wamid: outcome.wamid },
        outcome.wamid,
        now,
      );
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
    // A refused token can send nothing more: the connection needs a new signup, audited as the
    // sender whose message found it.
    const connection = await ctx.db.get(connectionId);
    if (
      outcome.tokenRefused &&
      message.sentBySubject !== undefined &&
      connection !== null &&
      connection.orgId === orgId
    ) {
      await markConnectionNeedsReauth(
        ctx.db,
        connectionId,
        "whatsapp_token_invalid",
        message.sentBySubject,
      );
    }
    return null;
  },
});

/**
 * Step 3: settles a send still `pending` STUCK_SEND_AFTER_MS after it was queued (scheduled by
 * queueText; never earlier). Claimed: the Meta call may have happened, so `unknown`. Not
 * claimed: no call was made, so `failed`; a late delivery then finds it no longer pending.
 */
export const settleStuckSend = internalMutation({
  args: { orgId: v.id("organizations"), messageId: v.id("whatsappMessages") },
  returns: v.null(),
  handler: async (ctx, { orgId, messageId }) => {
    const message = await ctx.db.get(messageId);
    const now = Date.now();
    if (
      message === null ||
      message.orgId !== orgId ||
      message.direction !== "outbound" ||
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

/** Step 2: the scheduled delivery of one queued message (at most one Meta call). */
export const deliver = internalAction({
  args: { orgId: v.id("organizations"), messageId: v.id("whatsappMessages") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const claim = await ctx.runMutation(internal.whatsapp.outbound.claimDelivery, args);
    if (claim === null) return null;
    const outcome = await send(ctx, claim);
    await ctx.runMutation(internal.whatsapp.outbound.recordSendResult, {
      ...args,
      connectionId: claim.connectionId,
      outcome,
    });
    return null;
  },
});
