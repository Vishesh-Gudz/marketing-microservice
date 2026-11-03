import { vi } from "vitest";
import { WHATSAPP_ENV, WHATSAPP_WEBHOOK_PATH } from "./config";

/**
 * Signed fake WhatsApp webhook deliveries (test harness; two dots in the file name: never
 * deployed). Payloads follow Meta's DOCUMENTED `whatsapp_business_account` shape; they are not
 * recordings and not evidence of real Meta behavior (docs/whatsapp.md, "Real-account
 * validation"). All ids, numbers and secrets are fake.
 */

export const FAKE_WA_APP_SECRET = "test-whatsapp-app-secret";
export const FAKE_WA_VERIFY_TOKEN = "test-whatsapp-verify-token";

export const WABA_A = "100000000000001";
export const PHONE_A = "200000000000001";
export const WABA_B = "100000000000002";
export const PHONE_B = "200000000000002";
export const CUSTOMER_1 = "15550001111";
export const CUSTOMER_2 = "15550002222";

export function stubWhatsAppEnv(): void {
  vi.stubEnv(WHATSAPP_ENV.appSecret, FAKE_WA_APP_SECRET);
  vi.stubEnv(WHATSAPP_ENV.verifyToken, FAKE_WA_VERIFY_TOKEN);
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** `sha256=<hex>` HMAC of the exact bytes, as Meta would send it. */
export async function signBytes(
  bytes: Uint8Array<ArrayBuffer>,
  secret = FAKE_WA_APP_SECRET,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `sha256=${toHex(await crypto.subtle.sign("HMAC", key, bytes))}`;
}

export async function signBody(body: string, secret = FAKE_WA_APP_SECRET): Promise<string> {
  return await signBytes(encoder.encode(body), secret);
}

export type MessageInput = {
  id: string;
  from?: string;
  /** Unix seconds. */
  timestamp?: number;
  type?: string;
  text?: string;
  name?: string;
};

export type StatusInput = {
  id: string;
  status: string;
  timestamp?: number;
  recipient?: string;
  errorCode?: number;
};

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function message(input: MessageInput): Record<string, unknown> {
  const type = input.type ?? "text";
  return {
    from: input.from ?? CUSTOMER_1,
    id: input.id,
    timestamp: String(input.timestamp ?? nowSeconds()),
    type,
    ...(type === "text" ? { text: { body: input.text ?? "hello" } } : {}),
  };
}

export function status(input: StatusInput): Record<string, unknown> {
  return {
    id: input.id,
    status: input.status,
    timestamp: String(input.timestamp ?? nowSeconds()),
    recipient_id: input.recipient ?? CUSTOMER_1,
    ...(input.errorCode !== undefined
      ? {
          errors: [
            {
              code: input.errorCode,
              title: "Fake error title",
              error_data: { details: "fake details" },
            },
          ],
        }
      : {}),
  };
}

/** One `entry` with a single `messages` change for a business number. */
export function entry(options: {
  wabaId?: string;
  phoneNumberId?: string;
  messages?: MessageInput[];
  statuses?: StatusInput[];
  extraValue?: Record<string, unknown>;
}): Record<string, unknown> {
  const messages = options.messages ?? [];
  const contacts = [...new Map(messages.map((m) => [m.from ?? CUSTOMER_1, m.name])).entries()]
    .filter(([, name]) => name !== undefined)
    .map(([waId, name]) => ({ profile: { name }, wa_id: waId }));
  return {
    id: options.wabaId ?? WABA_A,
    changes: [
      {
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: {
            display_phone_number: "15550009999",
            phone_number_id: options.phoneNumberId ?? PHONE_A,
          },
          ...(contacts.length > 0 ? { contacts } : {}),
          ...(messages.length > 0 ? { messages: messages.map(message) } : {}),
          ...(options.statuses ? { statuses: options.statuses.map(status) } : {}),
          ...options.extraValue,
        },
      },
    ],
  };
}

/** `entry[].id` of Meta's documented PARTNER_REMOVED example: a business, not the WABA. */
export const PARTNER_BUSINESS_ID = "300000000000001";

/**
 * An `account_update` `PARTNER_REMOVED` entry in Meta's documented shape (webhooks reference,
 * account_update, 2026-10-24); `extraValue` adds to or overrides its `value`.
 */
export function partnerRemovedEntry(
  wabaId: string,
  extraValue: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: PARTNER_BUSINESS_ID,
    time: nowSeconds(),
    changes: [
      {
        value: {
          event: "PARTNER_REMOVED",
          waba_info: { waba_id: wabaId, owner_business_id: "400000000000001" },
          ...extraValue,
        },
        field: "account_update",
      },
    ],
  };
}

/** The `value` envelope Meta documents for the coexistence fields (ADR 0019). */
function coexistenceValue(phoneNumberId: string, items: Record<string, unknown>) {
  return {
    messaging_product: "whatsapp",
    metadata: { display_phone_number: "15550009999", phone_number_id: phoneNumberId },
    ...items,
  };
}

/** One change of a coexistence field for a business number. */
export function coexistenceEntry(
  field: "smb_message_echoes" | "history" | "smb_app_state_sync",
  items: Record<string, unknown>,
  options: { wabaId?: string; phoneNumberId?: string } = {},
): Record<string, unknown> {
  return {
    id: options.wabaId ?? WABA_A,
    changes: [{ field, value: coexistenceValue(options.phoneNumberId ?? PHONE_A, items) }],
  };
}

/** Messages the business sent from the WhatsApp Business app (`smb_message_echoes`). */
export function echoEntry(
  echoes: { id: string; to?: string; timestamp?: number; text?: string }[],
  options: { wabaId?: string; phoneNumberId?: string } = {},
): Record<string, unknown> {
  return coexistenceEntry(
    "smb_message_echoes",
    {
      message_echoes: echoes.map((echo) => ({
        from: "15550009999",
        to: echo.to ?? CUSTOMER_1,
        id: echo.id,
        timestamp: String(echo.timestamp ?? nowSeconds()),
        type: "text",
        text: { body: echo.text ?? "sent from the app" },
      })),
    },
    options,
  );
}

/** One imported history thread: the customer's messages and the business's (with `to`). */
export type HistoryMessageInput = {
  id: string;
  fromBusiness?: boolean;
  timestamp: number;
  text?: string;
  status?: string;
};

export function historyEntry(
  threads: { contact: string; messages: HistoryMessageInput[] }[],
  options: { wabaId?: string; phoneNumberId?: string } = {},
): Record<string, unknown> {
  return coexistenceEntry(
    "history",
    {
      history: [
        {
          metadata: { phase: 0, chunk_order: 1, progress: 100 },
          threads: threads.map((thread) => ({
            id: thread.contact,
            messages: thread.messages.map((m) => ({
              from: m.fromBusiness ? "15550009999" : thread.contact,
              ...(m.fromBusiness ? { to: thread.contact } : {}),
              id: m.id,
              timestamp: String(m.timestamp),
              type: "text",
              text: { body: m.text ?? "old message" },
              history_context: { status: m.status ?? (m.fromBusiness ? "READ" : "DELIVERED") },
            })),
          })),
        },
      ],
    },
    options,
  );
}

/** Contacts saved in (or removed from) the WhatsApp Business app (`smb_app_state_sync`). */
export function contactsEntry(
  contacts: { phone: string; name?: string; action?: "add" | "remove"; timestamp?: number }[],
  options: { wabaId?: string; phoneNumberId?: string } = {},
): Record<string, unknown> {
  return coexistenceEntry(
    "smb_app_state_sync",
    {
      state_sync: contacts.map((c) => ({
        type: "contact",
        contact: {
          phone_number: c.phone,
          ...(c.name !== undefined ? { full_name: c.name, first_name: c.name.split(" ")[0] } : {}),
        },
        action: c.action ?? "add",
        metadata: { timestamp: String(c.timestamp ?? nowSeconds()) },
      })),
    },
    options,
  );
}

export function delivery(...entries: Record<string, unknown>[]): Record<string, unknown> {
  return { object: "whatsapp_business_account", entry: entries };
}

type FetchBackend = {
  fetch: (path: string, init?: RequestInit) => Promise<Response>;
};

/** POSTs a delivery signed over its exact serialized bytes (or with an explicit header). */
export async function postDelivery(
  t: FetchBackend,
  payload: unknown,
  options: { secret?: string; signature?: string | null; rawBody?: string } = {},
): Promise<Response> {
  const body = options.rawBody ?? JSON.stringify(payload);
  const signature =
    options.signature === undefined ? await signBody(body, options.secret) : options.signature;
  return await t.fetch(WHATSAPP_WEBHOOK_PATH, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(signature !== null ? { "x-hub-signature-256": signature } : {}),
    },
    body,
  });
}
