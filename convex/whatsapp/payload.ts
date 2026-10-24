import { MAX_CONTACT_NAME_CHARS, MAX_EVENTS_PER_DELIVERY, MAX_TEXT_BODY_CHARS } from "./config";

/**
 * Strict parser for WhatsApp Cloud API webhook deliveries (pure; no Convex runtime).
 *
 * Shapes follow Meta's documented `whatsapp_business_account` webhook and are PROVISIONAL until
 * checked against a real account (docs/whatsapp.md, "Real-account validation"). Rules:
 * - The envelope is validated strictly: a delivery whose structure (object, entry, changes,
 *   metadata) is wrong is rejected as a whole (`ok: false`, HTTP 400).
 * - Inside a valid envelope, an individual message or status that fails validation is skipped
 *   and counted, so one unexpected item cannot block the rest of the batch forever.
 * - Only allowlisted fields are copied out. Everything else in the payload, including any
 *   organization identifier, is ignored: the tenant comes only from the server-side
 *   `phone_number_id` mapping (convex/whatsapp/ingest.ts).
 * - Only `field: "messages"` changes are read; other subscribed fields are counted and ignored
 *   whatever their `value` holds (their shapes are not validated, so a change to one of them
 *   can never reject the messages delivered beside it).
 */

export const STATUS_VALUES = ["sent", "delivered", "read", "failed"] as const;
export type DeliveryStatus = (typeof STATUS_VALUES)[number];

/**
 * Inbound message types recorded by type. Only `text` keeps a body in this slice; other types
 * are stored as a typed placeholder (no media is downloaded).
 */
export const INBOUND_MESSAGE_TYPES = [
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location",
  "contacts",
  "interactive",
  "button",
  "reaction",
  "order",
  "system",
  "unsupported",
] as const;
export type InboundMessageType = (typeof INBOUND_MESSAGE_TYPES)[number];

export type InboundMessageEvent = {
  kind: "message";
  wamid: string;
  /** Customer's WhatsApp id (`from`). */
  from: string;
  contactName?: string;
  /** Platform timestamp (epoch ms). */
  timestampMs: number;
  messageType: InboundMessageType;
  text?: string;
};

export type StatusEvent = {
  kind: "status";
  wamid: string;
  status: DeliveryStatus;
  timestampMs: number;
  recipientWaId: string;
  /** First platform error code of a failed status. Titles and details are never kept. */
  errorCode?: number;
};

export type WebhookEvent = InboundMessageEvent | StatusEvent;

export type WebhookChange = {
  /** `entry[].id`: the WhatsApp Business Account the change belongs to. */
  wabaId: string;
  /** `value.metadata.phone_number_id`: the business number that received / sent. */
  phoneNumberId: string;
  events: WebhookEvent[];
};

export type ParsedDelivery = {
  changes: WebhookChange[];
  /** Message / status items that failed validation and were dropped. */
  skipped: number;
  /** Changes for fields other than `messages`. */
  ignoredFields: number;
};

export const PARSE_FAILURES = [
  "not_object",
  "wrong_object",
  "invalid_entry",
  "invalid_change",
  "invalid_metadata",
  "too_many_events",
] as const;
export type ParseFailure = (typeof PARSE_FAILURES)[number];

export type ParseResult =
  { ok: true; delivery: ParsedDelivery } | { ok: false; reason: ParseFailure };

const NUMERIC_ID = /^\d{1,32}$/;
/** wamid values are opaque printable-ASCII tokens (e.g. "wamid.HBgL..."). */
const WAMID = /^[\x21-\x7e]{1,256}$/;
const UNIX_SECONDS = /^\d{1,12}$/;
const MESSAGE_TYPE = /^[a-z_]{1,32}$/;

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalArray(value: unknown): unknown[] | null | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : null;
}

/** Meta numeric ids (WABA, phone_number_id, wa_id): 1-32 digits. */
export function isNumericId(value: unknown): value is string {
  return typeof value === "string" && NUMERIC_ID.test(value);
}

function numericId(value: unknown): string | null {
  return isNumericId(value) ? value : null;
}

function wamid(value: unknown): string | null {
  return typeof value === "string" && WAMID.test(value) ? value : null;
}

/** Unix seconds (string, as Meta sends it, or integer) to epoch ms. */
function timestampMs(value: unknown): number | null {
  if (typeof value === "string" && UNIX_SECONDS.test(value)) return Number(value) * 1000;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value * 1000;
  return null;
}

function contactNames(contacts: unknown[] | undefined): Map<string, string> {
  const names = new Map<string, string>();
  for (const contact of contacts ?? []) {
    if (!isObject(contact)) continue;
    const waId = numericId(contact.wa_id);
    const profile = contact.profile;
    if (waId === null || !isObject(profile) || typeof profile.name !== "string") continue;
    const name = profile.name.trim().slice(0, MAX_CONTACT_NAME_CHARS);
    if (name !== "") names.set(waId, name);
  }
  return names;
}

function inboundType(type: string): InboundMessageType {
  return (INBOUND_MESSAGE_TYPES as readonly string[]).includes(type)
    ? (type as InboundMessageType)
    : "unsupported";
}

function parseMessage(item: unknown, names: Map<string, string>): InboundMessageEvent | null {
  if (!isObject(item)) return null;
  const id = wamid(item.id);
  const from = numericId(item.from);
  const at = timestampMs(item.timestamp);
  if (id === null || from === null || at === null) return null;
  if (typeof item.type !== "string" || !MESSAGE_TYPE.test(item.type)) return null;
  const messageType = inboundType(item.type);

  let text: string | undefined;
  if (messageType === "text") {
    const body = isObject(item.text) ? item.text.body : undefined;
    if (typeof body !== "string" || body.length === 0 || body.length > MAX_TEXT_BODY_CHARS) {
      return null;
    }
    text = body;
  }
  const contactName = names.get(from);
  return {
    kind: "message",
    wamid: id,
    from,
    ...(contactName !== undefined ? { contactName } : {}),
    timestampMs: at,
    messageType,
    ...(text !== undefined ? { text } : {}),
  };
}

function parseStatus(item: unknown): StatusEvent | null {
  if (!isObject(item)) return null;
  const id = wamid(item.id);
  const recipient = numericId(item.recipient_id);
  const at = timestampMs(item.timestamp);
  const status = item.status;
  if (id === null || recipient === null || at === null) return null;
  if (typeof status !== "string" || !(STATUS_VALUES as readonly string[]).includes(status)) {
    return null;
  }
  let errorCode: number | undefined;
  if (status === "failed" && Array.isArray(item.errors) && isObject(item.errors[0])) {
    const code = item.errors[0].code;
    if (typeof code === "number" && Number.isSafeInteger(code)) errorCode = code;
  }
  return {
    kind: "status",
    wamid: id,
    status: status as DeliveryStatus,
    timestampMs: at,
    recipientWaId: recipient,
    ...(errorCode !== undefined ? { errorCode } : {}),
  };
}

/** Parses an already JSON-decoded, signature-verified delivery. Never throws. */
export function parseWebhookPayload(body: unknown): ParseResult {
  if (!isObject(body)) return { ok: false, reason: "not_object" };
  if (body.object !== "whatsapp_business_account") return { ok: false, reason: "wrong_object" };
  if (!Array.isArray(body.entry) || body.entry.length > MAX_EVENTS_PER_DELIVERY) {
    return { ok: false, reason: "invalid_entry" };
  }

  const changes: WebhookChange[] = [];
  let skipped = 0;
  let ignoredFields = 0;
  let total = 0;

  for (const entry of body.entry) {
    if (!isObject(entry)) return { ok: false, reason: "invalid_entry" };
    const wabaId = numericId(entry.id);
    if (wabaId === null || !Array.isArray(entry.changes)) {
      return { ok: false, reason: "invalid_entry" };
    }
    for (const change of entry.changes) {
      if (!isObject(change) || typeof change.field !== "string") {
        return { ok: false, reason: "invalid_change" };
      }
      if (change.field !== "messages") {
        ignoredFields++;
        continue;
      }
      const value = change.value;
      if (!isObject(value)) return { ok: false, reason: "invalid_change" };
      const metadata = value.metadata;
      const phoneNumberId = isObject(metadata) ? numericId(metadata.phone_number_id) : null;
      if (value.messaging_product !== "whatsapp" || phoneNumberId === null) {
        return { ok: false, reason: "invalid_metadata" };
      }
      const messages = optionalArray(value.messages);
      const statuses = optionalArray(value.statuses);
      const contacts = optionalArray(value.contacts);
      if (messages === null || statuses === null || contacts === null) {
        return { ok: false, reason: "invalid_change" };
      }
      total += (messages?.length ?? 0) + (statuses?.length ?? 0);
      if (total > MAX_EVENTS_PER_DELIVERY) return { ok: false, reason: "too_many_events" };

      const names = contactNames(contacts);
      const events: WebhookEvent[] = [];
      for (const item of messages ?? []) {
        const event = parseMessage(item, names);
        if (event === null) skipped++;
        else events.push(event);
      }
      for (const item of statuses ?? []) {
        const event = parseStatus(item);
        if (event === null) skipped++;
        else events.push(event);
      }
      if (events.length > 0) changes.push({ wabaId, phoneNumberId, events });
    }
  }
  return { ok: true, delivery: { changes, skipped, ignoredFields } };
}
