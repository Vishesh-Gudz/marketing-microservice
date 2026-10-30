import { MAX_FUTURE_SKEW_MS } from "../../messaging/window";
import { EARLIEST_EVENT_MS, MAX_EVENTS_PER_DELIVERY, MAX_TEXT_CHARS } from "./config";
import { ATTACHMENT_TYPES, type MessageType, type WebhookEventInput } from "./validators";

/**
 * Strict parser for Instagram messaging webhook deliveries (pure; no Convex runtime). Runs only
 * after the signature has been verified.
 *
 * Shape [doc, Instagram webhooks examples]: `{object:"instagram", entry:[{id, time, messaging:[
 * {sender:{id}, recipient:{id}, timestamp, message | read | message_edit | …}]}]}`, where
 * `entry[].id` is the professional account id (`/me.user_id`) and, for a customer's message,
 * `sender.id` is the customer (IGSID) and `recipient.id` the account; echoes are reversed.
 *
 * - A wrong envelope (object, entry, entry id, messaging list, too many events) rejects the
 *   whole delivery (400). Inside it, an event that fails validation is skipped and counted, so
 *   one odd item never blocks a batch through Meta's retries.
 * - Only allowlisted fields are copied. Never: URLs (attachments, stories), quick replies,
 *   referrals, or anything that could name an org. The tenant comes only from the account id.
 * - Read: customer messages, echoes, deletions (`is_deleted`), "seen" (`read.mid`) and edits
 *   (`message_edit`). Ignored: reactions, postbacks, referrals, opt-ins, handover, `standby`,
 *   `changes` (comments and other fields), self-messaging tests (`is_self`).
 * - Ids keep full precision: strings of digits, or JSON numbers only when exact. Professional
 *   account ids have 17 digits and lose precision as numbers. [assume] IGSIDs are digits too.
 * - Times come from each event's `timestamp`, never `entry[].time` (when the notification was
 *   sent, which a retry may change). [assume] Epoch milliseconds; anything outside 2020-01-01 to
 *   receipt + 5 minutes is skipped.
 */

export const PARSE_FAILURES = [
  "not_object",
  "wrong_object",
  "invalid_entry",
  "too_many_events",
] as const;
export type ParseFailure = (typeof PARSE_FAILURES)[number];

export type ParsedEntry = { igAccountId: string; events: WebhookEventInput[] };

export type ParseResult =
  | { ok: true; entries: ParsedEntry[]; skipped: number; ignored: number }
  | { ok: false; reason: ParseFailure };

type Json = Record<string, unknown>;

const NUMERIC_ID = /^\d{1,32}$/;
/** Meta message ids are opaque printable-ASCII tokens. */
const MID = /^[\x21-\x7e]{1,512}$/;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A Meta id as a string of digits; a JSON number only when it is an exact integer. */
export function metaId(value: unknown): string | null {
  if (typeof value === "string") return NUMERIC_ID.test(value) ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  return null;
}

function mid(value: unknown): string | null {
  return typeof value === "string" && MID.test(value) ? value : null;
}

function idOf(party: unknown): string | null {
  return isObject(party) ? metaId(party.id) : null;
}

/** The event time in epoch ms, or null when not plausible (see the module comment). */
function eventTime(value: unknown, receivedAt: number): number | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) return null;
  return value >= EARLIEST_EVENT_MS && value <= receivedAt + MAX_FUTURE_SKEW_MS ? value : null;
}

function attachmentType(attachments: unknown): MessageType | null {
  if (!Array.isArray(attachments) || !isObject(attachments[0])) return null;
  const type = attachments[0].type;
  return (ATTACHMENT_TYPES as readonly unknown[]).includes(type)
    ? (type as MessageType)
    : "unsupported";
}

type Parties = { sender: string; recipient: string; account: string };

/** The customer's side of an event the account sent (`outgoing`) or received, else null. */
function customerOf({ sender, recipient, account }: Parties, outgoing: boolean): string | null {
  if (sender === recipient) return null;
  if (outgoing) return sender === account ? recipient : null;
  return recipient === account ? sender : null;
}

type ItemResult = WebhookEventInput | "skip" | "ignore";

function parseMessage(message: Json, parties: Parties, timestampMs: number): ItemResult {
  const id = mid(message.mid);
  if (id === null) return "skip";
  if (message.is_self === true) return "ignore";
  const echo = message.is_echo === true;
  const customerIgsid = customerOf(parties, echo);
  if (customerIgsid === null) return "skip";
  const base = { mid: id, customerIgsid, timestampMs };
  if (message.is_deleted === true) return { kind: "delete", ...base };

  let text: string | undefined;
  if (message.text !== undefined) {
    if (typeof message.text !== "string" || message.text.length > MAX_TEXT_CHARS) return "skip";
    if (message.text !== "") text = message.text;
  }
  const replyTo = isObject(message.reply_to) ? message.reply_to : undefined;
  const storyReply = replyTo !== undefined && isObject(replyTo.story);
  let messageType: MessageType | null;
  if (message.is_unsupported === true) messageType = "unsupported";
  else if (storyReply) messageType = "story_reply";
  else if (text !== undefined) messageType = "text";
  else messageType = attachmentType(message.attachments);
  if (messageType === null) return "skip";

  const replyToMid = replyTo !== undefined ? mid(replyTo.mid) : null;
  return {
    kind: echo ? "echo" : "message",
    ...base,
    messageType,
    ...(text !== undefined ? { text } : {}),
    ...(replyToMid !== null ? { replyToMid } : {}),
  };
}

function parseItem(item: unknown, account: string, receivedAt: number): ItemResult {
  if (!isObject(item)) return "skip";
  const sender = idOf(item.sender);
  const recipient = idOf(item.recipient);
  const timestampMs = eventTime(item.timestamp, receivedAt);
  if (sender === null || recipient === null || timestampMs === null) return "skip";
  const parties = { sender, recipient, account };

  if (isObject(item.message)) return parseMessage(item.message, parties, timestampMs);
  if (isObject(item.read)) {
    // The customer saw the account's messages up to `read.mid`.
    const id = mid(item.read.mid);
    const customerIgsid = customerOf(parties, false);
    if (id === null || customerIgsid === null) return "skip";
    return { kind: "read", mid: id, customerIgsid, timestampMs };
  }
  if (isObject(item.message_edit)) {
    const edit = item.message_edit;
    const id = mid(edit.mid);
    // Either side may edit its own message.
    const customerIgsid = customerOf(parties, false) ?? customerOf(parties, true);
    const editCount = edit.num_edit;
    if (id === null || customerIgsid === null) return "skip";
    if (typeof edit.text !== "string" || edit.text === "" || edit.text.length > MAX_TEXT_CHARS) {
      return "skip";
    }
    if (typeof editCount !== "number" || !Number.isSafeInteger(editCount) || editCount < 0) {
      return "skip";
    }
    return { kind: "edit", mid: id, customerIgsid, timestampMs, text: edit.text, editCount };
  }
  return "ignore";
}

/** Parses an already JSON-decoded, signature-verified delivery received at `receivedAt`. */
export function parseWebhookPayload(body: unknown, receivedAt: number): ParseResult {
  if (!isObject(body)) return { ok: false, reason: "not_object" };
  if (body.object !== "instagram") return { ok: false, reason: "wrong_object" };
  if (!Array.isArray(body.entry) || body.entry.length > MAX_EVENTS_PER_DELIVERY) {
    return { ok: false, reason: "invalid_entry" };
  }

  const entries: ParsedEntry[] = [];
  let skipped = 0;
  let ignored = 0;
  let total = 0;
  for (const entry of body.entry) {
    if (!isObject(entry)) return { ok: false, reason: "invalid_entry" };
    const igAccountId = metaId(entry.id);
    if (igAccountId === null) return { ok: false, reason: "invalid_entry" };
    if (entry.messaging === undefined) {
      ignored++; // `changes` (comments, mentions, …) or `standby`: not read here.
      continue;
    }
    if (!Array.isArray(entry.messaging)) return { ok: false, reason: "invalid_entry" };
    total += entry.messaging.length;
    if (total > MAX_EVENTS_PER_DELIVERY) return { ok: false, reason: "too_many_events" };

    const events: WebhookEventInput[] = [];
    for (const item of entry.messaging) {
      const result = parseItem(item, igAccountId, receivedAt);
      if (result === "skip") skipped++;
      else if (result === "ignore") ignored++;
      else events.push(result);
    }
    if (events.length > 0) entries.push({ igAccountId, events });
  }
  return { ok: true, entries, skipped, ignored };
}
