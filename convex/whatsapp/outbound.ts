import { v, type Infer } from "convex/values";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  internalAction,
  internalMutation,
  internalQuery,
  type ActionCtx,
  type DatabaseReader,
  type DatabaseWriter,
  type MutationCtx,
} from "../_generated/server";
import { withConnectionCredential } from "../connections/credentialStore";
import { markConnectionNeedsReauth } from "../connections/lifecycle";
import { touchThread } from "../inbox/threads";
import { apiError } from "../lib/errors";
import { configuredSecret } from "../messaging/signature";
import { isServiceWindowOpen } from "../messaging/window";
import { whatsappTables } from "../tables/whatsapp";
import {
  CLIENT_MESSAGE_ID,
  MAX_OUTBOUND_TEXT_CHARS,
  requireUserSubject,
  STUCK_SEND_AFTER_MS,
  WHATSAPP_ENV,
} from "./config";
import { listMessageTemplates, sendMessage, type OutboundMessage, type SendOutcome } from "./graph";
import { statusDedupeKey } from "./ingest";
import { STATUS_VALUES } from "./payload";
import { failureReason, parseCredential, tokenRefused } from "./signup";
import { applyDeliveryStatus, type DeliveryPatch, type DeliveryState } from "./status";
import { checkValues, parseTemplate, type ParsedTemplate, type TemplateValue } from "./templates";
import { outboundTemplateValidator } from "./validators";

/**
 * Outbound WhatsApp messages (ADR 0013 stage 5) in an existing conversation: text replies and
 * approved templates.
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
 * Templates (`listTemplatesFor`, `sendTemplateFor`; v1 actions, editors and admins): the WABA's
 * APPROVED templates are read from Meta with the number's own token; sending checks the filled-in
 * values against the template just read (convex/whatsapp/templates.ts) BEFORE anything is stored,
 * then `queueTemplate` stores and schedules it exactly like a text reply. Templates may be sent
 * whether or not the 24-hour window is open (Meta's rule); the window applies to text only.
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

type Sender = { connectionId: Id<"connections">; phoneNumberId: string; wabaId: string };

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
    sender: {
      connectionId: connection._id,
      phoneNumberId: number.phoneNumberId,
      wabaId: account.wabaId,
    },
  };
}

function requireClientMessageId(clientMessageId: string): void {
  if (!CLIENT_MESSAGE_ID.test(clientMessageId)) {
    throw apiError("INVALID_ARGUMENT", "clientMessageId must be 8-64 letters, digits, - or _.", {
      field: "clientMessageId",
    });
  }
}

/**
 * The org's earlier message with this `clientMessageId`: returned again for the same conversation
 * (a repeated submit sends nothing more), refused for any other message.
 */
async function repeatedSend(
  db: DatabaseReader,
  orgId: Id<"organizations">,
  conversationId: Id<"whatsappConversations">,
  clientMessageId: string,
): Promise<Doc<"whatsappMessages"> | null> {
  const repeated = await db
    .query("whatsappMessages")
    .withIndex("by_org_client_message", (q) =>
      q.eq("orgId", orgId).eq("clientMessageId", clientMessageId),
    )
    .first();
  if (repeated === null) return null;
  if (repeated.conversationId !== conversationId || repeated.direction !== "outbound") {
    throw apiError("CONFLICT", "This clientMessageId was already used for another message.", {
      reason: "client_message_id_reused",
    });
  }
  return repeated;
}

async function requireSender(
  db: DatabaseReader,
  conversation: Doc<"whatsappConversations">,
): Promise<Sender> {
  const sendable = await senderOf(db, conversation);
  if (!sendable.ok) {
    throw apiError("CONFLICT", REFUSAL_MESSAGES[sendable.reason], { reason: sendable.reason });
  }
  return sendable.sender;
}

/** Stores a pending outbound message and schedules its one delivery and its watchdog. */
async function storePending(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  tenant: { orgId: Id<"organizations">; subject: string },
  conversation: Doc<"whatsappConversations">,
  clientMessageId: string,
  content:
    | { messageType: "text"; text: string }
    | { messageType: "template"; text: string; template: Infer<typeof outboundTemplateValidator> },
  now: number,
): Promise<Doc<"whatsappMessages">> {
  const messageId = await ctx.db.insert("whatsappMessages", {
    orgId: tenant.orgId,
    conversationId: conversation._id,
    numberId: conversation.numberId,
    direction: "outbound",
    ...content,
    status: "pending",
    platformAt: now,
    clientMessageId,
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
    { channel: "whatsapp", conversationId: conversation._id },
    lastMessageAt,
  );
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

/** Step 1 (see the module comment). Returns the stored message (new, or the repeated one). */
export async function queueText(
  ctx: Pick<MutationCtx, "db" | "scheduler">,
  tenant: { orgId: Id<"organizations">; subject: string },
  conversation: Doc<"whatsappConversations">,
  args: { text: string; clientMessageId: string },
): Promise<Doc<"whatsappMessages">> {
  requireClientMessageId(args.clientMessageId);
  if (args.text.trim() === "" || args.text.length > MAX_OUTBOUND_TEXT_CHARS) {
    throw apiError("INVALID_ARGUMENT", `text must be 1-${MAX_OUTBOUND_TEXT_CHARS} characters.`, {
      field: "text",
    });
  }
  const repeated = await repeatedSend(ctx.db, tenant.orgId, conversation._id, args.clientMessageId);
  if (repeated !== null) return repeated;
  await requireSender(ctx.db, conversation);
  const now = Date.now();
  if (!isServiceWindowOpen(conversation.lastInboundAt, now)) {
    throw apiError(
      "CONFLICT",
      "The customer last wrote more than 24 hours ago. Send an approved template instead.",
      { reason: "service_window_closed" },
    );
  }

  return await storePending(
    ctx,
    tenant,
    conversation,
    args.clientMessageId,
    { messageType: "text", text: args.text },
    now,
  );
}

const claimValidator = v.object({
  connectionId: v.id("connections"),
  phoneNumberId: v.string(),
  /** The recipient: "+" and the customer's WhatsApp id (which carries the country code). */
  to: v.string(),
  content: v.union(
    v.object({ kind: v.literal("text"), text: v.string() }),
    v.object({ kind: v.literal("template"), template: outboundTemplateValidator }),
  ),
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
    const content =
      message.messageType === "template"
        ? message.template !== undefined
          ? { kind: "template" as const, template: message.template }
          : null
        : message.messageType === "text" && message.text !== undefined
          ? { kind: "text" as const, text: message.text }
          : null;
    if (!sendable.ok || conversation === null || content === null) {
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
      content,
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
      const message: OutboundMessage =
        claim.content.kind === "text"
          ? { to: claim.to, type: "text", text: { body: claim.content.text } }
          : {
              to: claim.to,
              type: "template",
              template: {
                name: claim.content.template.name,
                language: { code: claim.content.template.language },
                components: claim.content.template.components,
              },
            };
      return outcomeOf(
        await sendMessage(claim.phoneNumberId, message, {
          accessToken: parsed.accessToken,
          appSecret,
        }),
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

// ---------------------------------------------------------------------------
// Templates (see the module comment)
// ---------------------------------------------------------------------------

/** A template's name and language as Meta uses them ("order_update", "en_US"). */
const TEMPLATE_NAME = /^[a-z0-9_]{1,512}$/;
const TEMPLATE_LANGUAGE = /^[a-z]{2,3}(_[A-Za-z0-9]{2,4})?$/;
/** Most values one template send may carry. */
const MAX_TEMPLATE_VALUES = 50;

/** A stored outbound message, as the internal functions below return it. */
const messageDocValidator = v.object({
  _id: v.id("whatsappMessages"),
  _creationTime: v.number(),
  ...whatsappTables.whatsappMessages.validator.fields,
});

const refusalValidator = v.union(
  v.literal("number_unavailable"),
  v.literal("number_cannot_send"),
  v.literal("reconnect_required"),
  v.literal("number_not_ready"),
);

/**
 * One of the org's conversations by an untrusted id (null: not in this org) and, when its
 * number can send, the connection and WABA to use.
 */
export const conversationSender = internalQuery({
  args: { orgId: v.id("organizations"), conversationId: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      conversationId: v.id("whatsappConversations"),
      sender: v.union(
        v.null(),
        v.object({ connectionId: v.id("connections"), wabaId: v.string() }),
      ),
      reason: v.optional(refusalValidator),
    }),
  ),
  handler: async (ctx, { orgId, conversationId }) => {
    const id = ctx.db.normalizeId("whatsappConversations", conversationId);
    const conversation = id === null ? null : await ctx.db.get(id);
    if (conversation === null || conversation.orgId !== orgId) return null;
    const sendable = await senderOf(ctx.db, conversation);
    return sendable.ok
      ? {
          conversationId: conversation._id,
          sender: { connectionId: sendable.sender.connectionId, wabaId: sendable.sender.wabaId },
        }
      : { conversationId: conversation._id, sender: null, reason: sendable.reason };
  },
});

/** The org's message already queued under this clientMessageId, if any (repeated submits). */
export const repeatedMessage = internalQuery({
  args: {
    orgId: v.id("organizations"),
    conversationId: v.id("whatsappConversations"),
    clientMessageId: v.string(),
  },
  returns: v.union(v.null(), messageDocValidator),
  handler: async (ctx, args) =>
    await repeatedSend(ctx.db, args.orgId, args.conversationId, args.clientMessageId),
});

/** Meta refused the token while reading templates: the connection needs a new signup. */
export const markTokenRefused = internalMutation({
  args: {
    orgId: v.id("organizations"),
    connectionId: v.id("connections"),
    actorSubject: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { orgId, connectionId, actorSubject }) => {
    requireUserSubject(actorSubject);
    const connection = await ctx.db.get(connectionId);
    if (connection !== null && connection.orgId === orgId) {
      await markConnectionNeedsReauth(ctx.db, connectionId, "whatsapp_token_invalid", actorSubject);
    }
    return null;
  },
});

/**
 * Stores a template message checked by sendTemplateFor and schedules it like a text reply. The
 * conversation, a repeated submit and the number are checked again in this transaction; the
 * service window is not (templates may be sent at any time).
 */
export const queueTemplate = internalMutation({
  args: {
    orgId: v.id("organizations"),
    subject: v.string(),
    conversationId: v.id("whatsappConversations"),
    clientMessageId: v.string(),
    template: outboundTemplateValidator,
    /** What the customer reads: the template filled in. */
    text: v.string(),
  },
  returns: messageDocValidator,
  handler: async (ctx, args) => {
    requireUserSubject(args.subject);
    requireClientMessageId(args.clientMessageId);
    const conversation = await ctx.db.get(args.conversationId);
    if (conversation === null || conversation.orgId !== args.orgId) {
      throw apiError("NOT_FOUND", "No whatsappConversations record with this id.", {
        table: "whatsappConversations",
      });
    }
    const repeated = await repeatedSend(ctx.db, args.orgId, conversation._id, args.clientMessageId);
    if (repeated !== null) return repeated;
    await requireSender(ctx.db, conversation);
    return await storePending(
      ctx,
      { orgId: args.orgId, subject: args.subject },
      conversation,
      args.clientMessageId,
      { messageType: "template", text: args.text, template: args.template },
      Date.now(),
    );
  },
});

type Tenantish = { orgId: Id<"organizations">; subject: string };

async function findConversation(ctx: ActionCtx, tenant: Tenantish, conversationId: string) {
  const found = await ctx.runQuery(internal.whatsapp.outbound.conversationSender, {
    orgId: tenant.orgId,
    conversationId,
  });
  if (found === null) {
    throw apiError("NOT_FOUND", "No whatsappConversations record with this id.", {
      table: "whatsappConversations",
    });
  }
  return found;
}

function requireConversationSender(found: {
  sender: { connectionId: Id<"connections">; wabaId: string } | null;
  reason?: SendRefusal;
}) {
  if (found.sender === null) {
    const reason = found.reason ?? "number_unavailable";
    throw apiError("CONFLICT", REFUSAL_MESSAGES[reason], { reason });
  }
  return found.sender;
}

/**
 * The WABA's APPROVED templates, read from Meta with the number's own token (parsed; unsupported
 * ones are kept with their reason). A refused token marks the connection needs_reauth.
 */
async function approvedTemplates(
  ctx: ActionCtx,
  tenant: Tenantish,
  sender: { connectionId: Id<"connections">; wabaId: string },
): Promise<{ templates: ParsedTemplate[]; complete: boolean }> {
  const appSecret = configuredSecret(process.env[WHATSAPP_ENV.appSecret]);
  if (appSecret === null) {
    throw apiError("PROVIDER_ERROR", "WhatsApp is not set up on this service.", {
      reason: "not_configured",
    });
  }
  let result: Awaited<ReturnType<typeof listMessageTemplates>> | null;
  try {
    result = await withConnectionCredential(ctx, sender.connectionId, async (credential) => {
      const parsed = parseCredential(credential);
      return parsed === null
        ? null
        : await listMessageTemplates(sender.wabaId, { accessToken: parsed.accessToken, appSecret });
    });
  } catch {
    result = null;
  }
  if (result === null) {
    throw apiError("INTERNAL", "The stored WhatsApp connection could not be read.", {
      reason: "credential_unavailable",
    });
  }
  if (!result.ok) {
    if (tokenRefused(result.failure)) {
      await ctx.runMutation(internal.whatsapp.outbound.markTokenRefused, {
        orgId: tenant.orgId,
        connectionId: sender.connectionId,
        actorSubject: tenant.subject,
      });
      throw apiError("CONFLICT", REFUSAL_MESSAGES.reconnect_required, {
        reason: "reconnect_required",
      });
    }
    throw apiError("PROVIDER_ERROR", "Meta did not return the templates. Try again.", {
      reason: failureReason(result.failure),
    });
  }
  const templates = result.templates
    .map(parseTemplate)
    .filter((t): t is ParsedTemplate => t !== null && t.status === "APPROVED");
  return { templates, complete: result.complete };
}

/** v1/whatsapp:listTemplates. The approved templates usable in one of the caller's threads. */
export async function listTemplatesFor(
  ctx: ActionCtx,
  tenant: Tenantish,
  conversationId: string,
): Promise<{ templates: ParsedTemplate[]; complete: boolean }> {
  const found = await findConversation(ctx, tenant, conversationId);
  return await approvedTemplates(ctx, tenant, requireConversationSender(found));
}

/**
 * v1/whatsapp:sendTemplate. Checks the request, returns a repeated submit's message as it is,
 * reads the template from Meta and checks the values against it, then queues the message
 * (queueTemplate). Nothing is stored when any check fails.
 */
export async function sendTemplateFor(
  ctx: ActionCtx,
  tenant: Tenantish,
  args: {
    conversationId: string;
    templateName: string;
    language: string;
    variables: TemplateValue[];
    clientMessageId: string;
  },
): Promise<Doc<"whatsappMessages">> {
  requireClientMessageId(args.clientMessageId);
  if (!TEMPLATE_NAME.test(args.templateName)) {
    throw apiError("INVALID_ARGUMENT", "templateName is not a template name.", {
      field: "templateName",
    });
  }
  if (!TEMPLATE_LANGUAGE.test(args.language)) {
    throw apiError("INVALID_ARGUMENT", "language is not a template language code.", {
      field: "language",
    });
  }
  if (args.variables.length > MAX_TEMPLATE_VALUES) {
    throw apiError("INVALID_ARGUMENT", `At most ${MAX_TEMPLATE_VALUES} values.`, {
      field: "variables",
    });
  }
  const found = await findConversation(ctx, tenant, args.conversationId);
  const repeated = await ctx.runQuery(internal.whatsapp.outbound.repeatedMessage, {
    orgId: tenant.orgId,
    conversationId: found.conversationId,
    clientMessageId: args.clientMessageId,
  });
  if (repeated !== null) return repeated;

  const { templates } = await approvedTemplates(ctx, tenant, requireConversationSender(found));
  const template = templates.find(
    (t) => t.name === args.templateName && t.language === args.language,
  );
  if (template === undefined) {
    throw apiError("CONFLICT", "This template is not approved for this number's account.", {
      reason: "template_unavailable",
    });
  }
  if (template.unsupported !== undefined) {
    throw apiError("CONFLICT", "This template cannot be sent from here yet.", {
      reason: "template_unsupported",
      unsupported: template.unsupported,
    });
  }
  const checked = checkValues(template, args.variables);
  if (!checked.ok) {
    throw apiError("INVALID_ARGUMENT", "The template's values are not complete or not valid.", {
      field: `variables.${checked.field}`,
      reason: checked.reason,
    });
  }
  return await ctx.runMutation(internal.whatsapp.outbound.queueTemplate, {
    orgId: tenant.orgId,
    subject: tenant.subject,
    conversationId: found.conversationId,
    clientMessageId: args.clientMessageId,
    template: { name: template.name, language: template.language, components: checked.components },
    text: checked.text,
  });
}
