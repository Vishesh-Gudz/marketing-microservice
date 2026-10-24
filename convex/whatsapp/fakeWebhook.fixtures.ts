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
