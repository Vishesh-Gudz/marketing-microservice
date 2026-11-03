import {
  MAX_CONTACT_NAME_CHARS,
  MAX_EVENTS_PER_DELIVERY,
  MAX_IMPORT_EVENTS_PER_DELIVERY,
  MAX_TEXT_BODY_CHARS,
} from "./config";

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
 * - Only `field: "messages"` changes are read, plus the WABA id of an `account_update`
 *   `PARTNER_REMOVED` or `ACCOUNT_OFFBOARDED` change (ADR 0014 B4b, ADR 0019). Other changes,
 *   including malformed `account_update` ones, are counted and ignored whatever their `value`
 *   holds (their shapes are not validated, so a change to one of them can never reject the
 *   messages beside it).
 * - Coexistence (ADR 0019, Meta "Onboarding WhatsApp Business app users", 2026-11-03):
 *   `smb_message_echoes` (messages the business sent from the WhatsApp Business app), `history`
 *   (the imported chat history) and `smb_app_state_sync` (contacts saved in the app) are read
 *   too. A change of one of them with an unexpected envelope is ignored like another field (their
 *   shapes are PROVISIONAL until a real coexistence signup), never rejecting the delivery; a
 *   declined history import (error 2593109) carries nothing to store.
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

/** Coexistence: a message the business sent from the WhatsApp Business app. */
export type EchoEvent = {
  kind: "echo";
  wamid: string;
  /** The customer's WhatsApp id (`to`). */
  to: string;
  timestampMs: number;
  messageType: InboundMessageType;
  text?: string;
};

/** Coexistence: one message of the imported chat history. */
export type HistoryEvent = {
  kind: "history";
  wamid: string;
  /** The customer's WhatsApp id (the thread's `id`). */
  contactWaId: string;
  /** Sent by the business; otherwise by the customer. */
  fromBusiness: boolean;
  timestampMs: number;
  messageType: InboundMessageType;
  text?: string;
  /** The business's messages: how far it got (`history_context.status`). */
  deliveryStatus?: DeliveryStatus;
};

/** Coexistence: a contact saved in the WhatsApp Business app was added or removed. */
export type ContactEvent = {
  kind: "contact";
  waId: string;
  action: "add" | "remove";
  /** The saved name (`full_name`, else `first_name`); absent on removal. */
  name?: string;
  timestampMs: number;
};

export type WebhookEvent =
  InboundMessageEvent | StatusEvent | EchoEvent | HistoryEvent | ContactEvent;

export type WebhookChange = {
  /** `entry[].id`: the WhatsApp Business Account the change belongs to. */
  wabaId: string;
  /** `value.metadata.phone_number_id`: the business number that received / sent. */
  phoneNumberId: string;
  events: WebhookEvent[];
};

export type ParsedDelivery = {
  changes: WebhookChange[];
  /**
   * WABA ids (`value.waba_info.waba_id`) of `account_update` `PARTNER_REMOVED` changes, each
   * once. Meta documents the event as the WABA being unshared with a Solution Partner, not
   * necessarily us: the webhook confirms with Meta before acting
   * (convex/whatsapp/partnerRemoval.ts).
   */
  partnerRemovals: string[];
  /** Message / status items that failed validation and were dropped. */
  skipped: number;
  /** Changes not read: other fields, and `account_update` changes that are not read above. */
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

/**
 * A message item's type and text (text messages only), or null when either is unusable. Shared
 * by inbound messages, echoes and imported history.
 */
function contentOf(item: Json): { messageType: InboundMessageType; text?: string } | null {
  if (typeof item.type !== "string" || !MESSAGE_TYPE.test(item.type)) return null;
  const messageType = inboundType(item.type);
  if (messageType !== "text") return { messageType };
  const body = isObject(item.text) ? item.text.body : undefined;
  if (typeof body !== "string" || body.length === 0 || body.length > MAX_TEXT_BODY_CHARS) {
    return null;
  }
  return { messageType, text: body };
}

function parseMessage(item: unknown, names: Map<string, string>): InboundMessageEvent | null {
  if (!isObject(item)) return null;
  const id = wamid(item.id);
  const from = numericId(item.from);
  const at = timestampMs(item.timestamp);
  if (id === null || from === null || at === null) return null;
  const content = contentOf(item);
  if (content === null) return null;
  const { messageType, text } = content;
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

function parseEcho(item: unknown): EchoEvent | null {
  if (!isObject(item)) return null;
  const id = wamid(item.id);
  const to = numericId(item.to);
  const at = timestampMs(item.timestamp);
  if (id === null || to === null || at === null) return null;
  const content = contentOf(item);
  if (content === null) return null;
  return { kind: "echo", wamid: id, to, timestampMs: at, ...content };
}

/** `history_context.status` of the business's message, as a delivery status (PROVISIONAL). */
function historyStatus(value: unknown): DeliveryStatus | undefined {
  const status = isObject(value) && typeof value.status === "string" ? value.status : "";
  switch (status.toLowerCase()) {
    case "read":
    case "played":
      return "read";
    case "delivered":
      return "delivered";
    case "error":
    case "failed":
      return "failed";
    default:
      return "sent";
  }
}

/** The messages of one `history` item's threads, each thread being one customer. */
function parseHistory(item: unknown): { events: HistoryEvent[]; skipped: number } | null {
  if (!isObject(item)) return null;
  const threads = optionalArray(item.threads);
  if (threads === null) return null;
  const events: HistoryEvent[] = [];
  let skipped = 0;
  for (const thread of threads ?? []) {
    const contactWaId = isObject(thread) ? numericId(thread.id) : null;
    const messages = isObject(thread) ? optionalArray(thread.messages) : null;
    if (contactWaId === null || messages === null) {
      skipped++;
      continue;
    }
    for (const message of messages ?? []) {
      const event = isObject(message) ? historyMessage(message, contactWaId) : null;
      if (event === null) skipped++;
      else events.push(event);
    }
  }
  return { events, skipped };
}

function historyMessage(item: Json, contactWaId: string): HistoryEvent | null {
  const id = wamid(item.id);
  const from = numericId(item.from);
  const at = timestampMs(item.timestamp);
  if (id === null || from === null || at === null) return null;
  const content = contentOf(item);
  if (content === null) return null;
  // Meta sends `to` only on the business's own messages; `from` is the customer otherwise.
  const fromBusiness = item.to !== undefined || from !== contactWaId;
  return {
    kind: "history",
    wamid: id,
    contactWaId,
    fromBusiness,
    timestampMs: at,
    ...content,
    ...(fromBusiness ? { deliveryStatus: historyStatus(item.history_context) } : {}),
  };
}

/** A contact's number as a WhatsApp id: its digits ("+1 555-000-1111" -> "15550001111"). */
function contactWaId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[+\d\s().-]{1,40}$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  return /^\d{6,15}$/.test(digits) ? digits : null;
}

function parseContact(item: unknown): ContactEvent | null {
  if (!isObject(item) || item.type !== "contact") return null;
  const contact = item.contact;
  if (!isObject(contact) || (item.action !== "add" && item.action !== "remove")) return null;
  const waId = contactWaId(contact.phone_number);
  const at = isObject(item.metadata) ? timestampMs(item.metadata.timestamp) : null;
  if (waId === null || at === null) return null;
  const raw = typeof contact.full_name === "string" ? contact.full_name : contact.first_name;
  const name = typeof raw === "string" ? raw.trim().slice(0, MAX_CONTACT_NAME_CHARS) : "";
  return {
    kind: "contact",
    waId,
    action: item.action,
    ...(item.action === "add" && name !== "" ? { name } : {}),
    timestampMs: at,
  };
}

/** The business number of a coexistence change, or null when its envelope is not as expected. */
function importEnvelope(value: unknown): { value: Json; phoneNumberId: string } | null {
  if (!isObject(value) || value.messaging_product !== "whatsapp") return null;
  const phoneNumberId = isObject(value.metadata) ? numericId(value.metadata.phone_number_id) : null;
  return phoneNumberId === null ? null : { value, phoneNumberId };
}

/** The coexistence fields this parser reads (ADR 0019). */
const IMPORT_FIELDS = new Set(["smb_message_echoes", "history", "smb_app_state_sync"]);

/** `account_update` events that may mean our access to a WABA (or its number) ended. */
const REMOVAL_EVENTS = new Set(["PARTNER_REMOVED", "ACCOUNT_OFFBOARDED"]);

/**
 * The customer WABA of an `account_update` `PARTNER_REMOVED` change, or of a coexistence
 * `ACCOUNT_OFFBOARDED` one (ADR 0019), or null. Meta's documented examples carry it in
 * `waba_info.waba_id`; `entry[].id` there is not the WABA and is never read. A variant without
 * `waba_info` is not read.
 */
function partnerRemovedWaba(value: unknown): string | null {
  if (!isObject(value) || typeof value.event !== "string" || !REMOVAL_EVENTS.has(value.event)) {
    return null;
  }
  return isObject(value.waba_info) ? numericId(value.waba_info.waba_id) : null;
}

/**
 * The events of one coexistence change (its envelope already checked), or null when its item
 * list is not as expected. Items that fail validation are counted as skipped.
 */
function readImportChange(
  field: string,
  value: Json,
): { events: WebhookEvent[]; skipped: number } | null {
  const events: WebhookEvent[] = [];
  let skipped = 0;
  const each = <T extends WebhookEvent>(list: unknown, parse: (item: unknown) => T | null) => {
    const items = optionalArray(list);
    if (items === null) return false;
    for (const item of items ?? []) {
      const event = parse(item);
      if (event === null) skipped++;
      else events.push(event);
    }
    return true;
  };
  if (field === "smb_message_echoes") {
    return each(value.message_echoes, parseEcho) ? { events, skipped } : null;
  }
  if (field === "smb_app_state_sync") {
    return each(value.state_sync, parseContact) ? { events, skipped } : null;
  }
  const items = optionalArray(value.history);
  if (items === null) return null;
  for (const item of items ?? []) {
    // A declined import (`errors`, code 2593109) carries no threads: nothing to store.
    const read = parseHistory(item);
    if (read === null) {
      skipped++;
      continue;
    }
    events.push(...read.events);
    skipped += read.skipped;
  }
  return { events, skipped };
}

/** Parses an already JSON-decoded, signature-verified delivery. Never throws. */
export function parseWebhookPayload(body: unknown): ParseResult {
  if (!isObject(body)) return { ok: false, reason: "not_object" };
  if (body.object !== "whatsapp_business_account") return { ok: false, reason: "wrong_object" };
  if (!Array.isArray(body.entry) || body.entry.length > MAX_EVENTS_PER_DELIVERY) {
    return { ok: false, reason: "invalid_entry" };
  }

  const changes: WebhookChange[] = [];
  const partnerRemovals = new Set<string>();
  let skipped = 0;
  let ignoredFields = 0;
  let total = 0;
  let imported = 0;

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
      if (change.field === "account_update") {
        const wabaId = partnerRemovedWaba(change.value);
        if (wabaId !== null) partnerRemovals.add(wabaId);
        else ignoredFields++;
        continue;
      }
      if (IMPORT_FIELDS.has(change.field)) {
        const envelope = importEnvelope(change.value);
        if (envelope === null) {
          ignoredFields++;
          continue;
        }
        const read = readImportChange(change.field, envelope.value);
        if (read === null) {
          ignoredFields++;
          continue;
        }
        skipped += read.skipped;
        // Echoes are live messages; imports may come in large chunks.
        if (change.field === "smb_message_echoes") total += read.events.length + read.skipped;
        else imported += read.events.length + read.skipped;
        if (total > MAX_EVENTS_PER_DELIVERY || imported > MAX_IMPORT_EVENTS_PER_DELIVERY) {
          return { ok: false, reason: "too_many_events" };
        }
        if (read.events.length > 0) {
          changes.push({ wabaId, phoneNumberId: envelope.phoneNumberId, events: read.events });
        }
        continue;
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
  return {
    ok: true,
    delivery: { changes, partnerRemovals: [...partnerRemovals], skipped, ignoredFields },
  };
}
