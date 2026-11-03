import { appSecretProof } from "../providers/meta/client";
import { GRAPH_ORIGIN } from "../providers/meta/config";
import { SIGNUP_TIMEOUT_MS, WHATSAPP_GRAPH_API_VERSION } from "./config";

/**
 * Minimal Graph client for WhatsApp onboarding (ADR 0014) and messaging. Same rules as the Meta
 * Ads client (convex/providers/meta/client.ts), kept separate so neither integration changes the
 * other:
 *
 * - Plain `fetch` (the runtime's global, resolved per call; tests stub it), no retries.
 * - Results never carry a URL, header, token or failure body: a failure is only its kind, the
 *   HTTP status and Meta's numeric error code / subcode.
 * - Token-bearing calls send the business token in the Authorization header with
 *   `appsecret_proof`. Only numeric node ids ever reach a path.
 * - The code exchange and token inspection put their parameters in the query string, exactly as
 *   Meta documents them (GET oauth/access_token with client_id, client_secret and code;
 *   GET debug_token?input_token=). Nothing here logs or stores a URL.
 *
 * Endpoints (Meta docs, 2026-10-24): Embedded Signup "Onboarding customers as a Tech Provider"
 * (code exchange, POST /{waba}/subscribed_apps, POST /{phone}/register), "Manage accounts"
 * (debug_token granular_scopes -> shared WABA ids), "Phone numbers" (GET /{waba}/phone_numbers),
 * "Send messages" (POST /{phone}/messages) and "Template management"
 * (GET /{waba}/message_templates). A message's recipient and content travel only in the JSON
 * body, never in a URL.
 *
 * Coexistence (ADR 0019; Meta "Onboarding WhatsApp Business app users", 2026-11-03): GET
 * /{phone}?fields=is_on_biz_app,platform_type, and POST /{phone}/smb_app_data with
 * `sync_type` `smb_app_state_sync` (contacts) or `history` (each accepted once per onboarding).
 */

export type GraphFailure = {
  kind: "network" | "timeout" | "invalid_json" | "http";
  status?: number;
  metaCode?: number;
  metaSubcode?: number;
};

export type GraphOutcome = { ok: true; body: unknown } | { ok: false; failure: GraphFailure };

export type MetaApp = { appId: string; appSecret: string };

const NODE_ID = /^\d{1,32}$/;
const MAX_NUMBER_PAGES = 5;
/** Template pages of 100 followed per listing; `complete` is false when more were left. */
export const MAX_TEMPLATE_PAGES = 5;
/** wamid values are opaque printable-ASCII tokens (same rule as the webhook parser). */
const WAMID = /^[\x21-\x7e]{1,256}$/;

function graphUrl(path: string, params: Record<string, string>): string {
  const query = new URLSearchParams(params).toString();
  return `${GRAPH_ORIGIN}/${WHATSAPP_GRAPH_API_VERSION}/${path}${query ? `?${query}` : ""}`;
}

function nodePath(id: string, edge?: string): string {
  if (!NODE_ID.test(id)) throw new Error("Invalid Graph node id");
  return edge === undefined ? id : `${id}/${edge}`;
}

function metaErrorOf(body: unknown): { metaCode?: number; metaSubcode?: number } | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as { code?: unknown; error_subcode?: unknown };
  return {
    ...(typeof e.code === "number" && Number.isInteger(e.code) ? { metaCode: e.code } : {}),
    ...(typeof e.error_subcode === "number" && Number.isInteger(e.error_subcode)
      ? { metaSubcode: e.error_subcode }
      : {}),
  };
}

async function send(url: string, init: RequestInit): Promise<GraphOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SIGNUP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await globalThis.fetch(url, { ...init, signal: controller.signal });
  } catch {
    // Never propagate the underlying error: it may contain the URL.
    return { ok: false, failure: { kind: controller.signal.aborted ? "timeout" : "network" } };
  } finally {
    clearTimeout(timer);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      failure: { kind: response.ok ? "invalid_json" : "http", status: response.status },
    };
  }
  const error = metaErrorOf(body);
  if (!response.ok || error !== undefined) {
    return { ok: false, failure: { kind: "http", status: response.status, ...error } };
  }
  return { ok: true, body };
}

async function withToken(
  method: "GET" | "POST" | "DELETE",
  path: string,
  params: Record<string, string>,
  auth: { accessToken: string; appSecret: string },
  json?: Record<string, unknown>,
): Promise<GraphOutcome> {
  const proof = await appSecretProof(auth.appSecret, auth.accessToken);
  return await send(graphUrl(path, { ...params, appsecret_proof: proof }), {
    method,
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: "application/json",
      ...(json !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
}

/** Step 1: the 30-second signup code -> the customer's business token. */
export async function exchangeSignupCode(app: MetaApp, code: string): Promise<GraphOutcome> {
  return await send(
    graphUrl("oauth/access_token", {
      client_id: app.appId,
      client_secret: app.appSecret,
      code,
    }),
    { method: "GET", headers: { Accept: "application/json" } },
  );
}

/** Token inspection with the app token: validity, app, scopes and the shared WABA ids. */
export async function inspectToken(app: MetaApp, accessToken: string): Promise<GraphOutcome> {
  return await send(graphUrl("debug_token", { input_token: accessToken }), {
    method: "GET",
    headers: { Authorization: `Bearer ${app.appId}|${app.appSecret}`, Accept: "application/json" },
  });
}

/** Reads the WABA with the business token (proves read access; returns its name). */
export async function readWaba(
  wabaId: string,
  auth: { accessToken: string; appSecret: string },
): Promise<GraphOutcome> {
  return await withToken("GET", nodePath(wabaId), { fields: "id,name" }, auth);
}

export type WabaNumber = { id: string; displayPhoneNumber?: string };

/** The WABA's phone numbers (follows at most MAX_NUMBER_PAGES cursor pages). */
export async function listWabaNumbers(
  wabaId: string,
  auth: { accessToken: string; appSecret: string },
): Promise<{ ok: true; numbers: WabaNumber[] } | { ok: false; failure: GraphFailure }> {
  const numbers: WabaNumber[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_NUMBER_PAGES; page++) {
    const result = await withToken(
      "GET",
      nodePath(wabaId, "phone_numbers"),
      {
        fields: "id,display_phone_number,verified_name",
        limit: "100",
        ...(after !== undefined ? { after } : {}),
      },
      auth,
    );
    if (!result.ok) return result;
    const body = result.body as {
      data?: unknown;
      paging?: { cursors?: { after?: unknown }; next?: unknown };
    };
    if (!Array.isArray(body.data)) {
      return { ok: false, failure: { kind: "invalid_json", status: 200 } };
    }
    for (const item of body.data) {
      const entry = item as { id?: unknown; display_phone_number?: unknown };
      if (typeof entry.id !== "string" || !NODE_ID.test(entry.id)) continue;
      numbers.push({
        id: entry.id,
        ...(typeof entry.display_phone_number === "string" &&
        entry.display_phone_number.length <= 32
          ? { displayPhoneNumber: entry.display_phone_number }
          : {}),
      });
    }
    const next = body.paging?.cursors?.after;
    if (body.paging?.next === undefined || typeof next !== "string") break;
    after = next;
  }
  return { ok: true, numbers };
}

/** Step 2: subscribe our app to the customer's WABA webhooks. */
export async function subscribeApp(
  wabaId: string,
  auth: { accessToken: string; appSecret: string },
): Promise<GraphOutcome> {
  return await withToken("POST", nodePath(wabaId, "subscribed_apps"), {}, auth);
}

/**
 * Disconnect (ADR 0014 B4): unsubscribe our app from the WABA's webhooks (Meta "Managing
 * webhooks": DELETE /{waba}/subscribed_apps, success `{"success": true}`). Not documented:
 * whether repeating it is harmless, and whether it removes only the calling app.
 */
export async function unsubscribeApp(
  wabaId: string,
  auth: { accessToken: string; appSecret: string },
): Promise<GraphOutcome> {
  return await withToken("DELETE", nodePath(wabaId, "subscribed_apps"), {}, auth);
}

/** Step 3: register the number for Cloud API; the 6-digit PIN becomes its two-step PIN. */
export async function registerPhoneNumber(
  phoneNumberId: string,
  pin: string,
  auth: { accessToken: string; appSecret: string },
): Promise<GraphOutcome> {
  return await withToken("POST", nodePath(phoneNumberId, "register"), {}, auth, {
    messaging_product: "whatsapp",
    pin,
  });
}

/** Meta's `request_id` of an import request (opaque; kept for support). */
const REQUEST_ID = /^[\x21-\x7e]{1,256}$/;
const PLATFORM_TYPE = /^[A-Z_]{1,32}$/;

export type NumberPlatform = { onBusinessApp: boolean; platformType?: string };

/**
 * Coexistence (ADR 0019): whether the number is also used in the WhatsApp Business app
 * (`is_on_biz_app`), and the platform serving it (`platform_type`, "CLOUD_API" once onboarded).
 * Meta documents both as the check after a coexistence signup.
 */
export async function readNumberPlatform(
  phoneNumberId: string,
  auth: { accessToken: string; appSecret: string },
): Promise<{ ok: true; platform: NumberPlatform } | { ok: false; failure: GraphFailure }> {
  const result = await withToken(
    "GET",
    nodePath(phoneNumberId),
    { fields: "is_on_biz_app,platform_type" },
    auth,
  );
  if (!result.ok) return result;
  const body = result.body as { is_on_biz_app?: unknown; platform_type?: unknown } | null;
  if (body === null || typeof body !== "object") {
    return { ok: false, failure: { kind: "invalid_json", status: 200 } };
  }
  return {
    ok: true,
    platform: {
      onBusinessApp: body.is_on_biz_app === true,
      ...(typeof body.platform_type === "string" && PLATFORM_TYPE.test(body.platform_type)
        ? { platformType: body.platform_type }
        : {}),
    },
  };
}

/** The two coexistence imports, in Meta's order: contacts first, then the chat history. */
export type AppDataSync = "smb_app_state_sync" | "history";

/**
 * Coexistence (ADR 0019): asks Meta to send the business's WhatsApp Business app contacts or chat
 * history as webhooks (POST /{phone}/smb_app_data). `ok` means Meta accepted the request; the
 * data, or the business's refusal to share its history, arrives later by webhook. Meta accepts
 * each import once per onboarding, so a call whose outcome is unknown is not repeated on its own.
 */
export async function requestAppDataSync(
  phoneNumberId: string,
  syncType: AppDataSync,
  auth: { accessToken: string; appSecret: string },
): Promise<{ ok: true; requestId: string } | { ok: false; failure: GraphFailure }> {
  const result = await withToken("POST", nodePath(phoneNumberId, "smb_app_data"), {}, auth, {
    messaging_product: "whatsapp",
    sync_type: syncType,
  });
  if (!result.ok) return result;
  const requestId = (result.body as { request_id?: unknown } | null)?.request_id;
  return typeof requestId === "string" && REQUEST_ID.test(requestId)
    ? { ok: true, requestId }
    : { ok: false, failure: { kind: "invalid_json", status: 200 } };
}

/** A text value for a template placeholder; `parameter_name` for NAMED templates only. */
export type TemplateParameter = { type: "text"; text: string; parameter_name?: string };

/** The values of one template component (only text parameters are sent by this app). */
export type TemplateComponentValues =
  | { type: "header" | "body"; parameters: TemplateParameter[] }
  | { type: "button"; sub_type: "url"; index: string; parameters: TemplateParameter[] };

/**
 * One outbound message, as Meta documents the request body ("Send messages"; text body up to
 * 4096 characters). `to` is the recipient with "+" and country code: without "+", Meta prepends
 * the business number's own country code. `messaging_product` and `recipient_type` are added
 * by sendMessage.
 */
export type OutboundMessage =
  | { to: string; type: "text"; text: { body: string; preview_url?: boolean } }
  | {
      to: string;
      type: "template";
      template: {
        name: string;
        language: { code: string };
        components?: TemplateComponentValues[];
      };
    };

export type SendOutcome = { ok: true; wamid: string } | { ok: false; failure: GraphFailure };

/**
 * Sends one message from the business number (POST /{phone-number-id}/messages). `ok` means Meta
 * accepted it and returned its wamid; delivery is reported later by status webhooks. A 200
 * without a usable wamid is `invalid_json`. Meta documents no idempotency key: a call whose
 * outcome is unknown (timeout, network, invalid answer) must never be repeated automatically,
 * since the message may have gone out.
 */
export async function sendMessage(
  phoneNumberId: string,
  message: OutboundMessage,
  auth: { accessToken: string; appSecret: string },
): Promise<SendOutcome> {
  const result = await withToken("POST", nodePath(phoneNumberId, "messages"), {}, auth, {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    ...message,
  });
  if (!result.ok) return result;
  const messages = (result.body as { messages?: unknown } | null)?.messages;
  const wamid = Array.isArray(messages)
    ? (messages[0] as { id?: unknown } | null | undefined)?.id
    : undefined;
  return typeof wamid === "string" && WAMID.test(wamid)
    ? { ok: true, wamid }
    : { ok: false, failure: { kind: "invalid_json", status: 200 } };
}

/**
 * The WABA's message templates, of every status, as Meta returns them (objects only; read by
 * convex/whatsapp/templates.ts). Follows at most MAX_TEMPLATE_PAGES cursor pages of 100;
 * `complete` is false when Meta had more.
 */
export async function listMessageTemplates(
  wabaId: string,
  auth: { accessToken: string; appSecret: string },
): Promise<
  | { ok: true; templates: Record<string, unknown>[]; complete: boolean }
  | { ok: false; failure: GraphFailure }
> {
  const templates: Record<string, unknown>[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_TEMPLATE_PAGES; page++) {
    const result = await withToken(
      "GET",
      nodePath(wabaId, "message_templates"),
      {
        fields: "id,name,language,status,category,parameter_format,components,rejected_reason",
        limit: "100",
        ...(after !== undefined ? { after } : {}),
      },
      auth,
    );
    if (!result.ok) return result;
    const body = result.body as {
      data?: unknown;
      paging?: { cursors?: { after?: unknown }; next?: unknown };
    };
    if (!Array.isArray(body.data)) {
      return { ok: false, failure: { kind: "invalid_json", status: 200 } };
    }
    for (const item of body.data) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) {
        templates.push(item as Record<string, unknown>);
      }
    }
    const next = body.paging?.cursors?.after;
    if (body.paging?.next === undefined || typeof next !== "string") {
      return { ok: true, templates, complete: true };
    }
    after = next;
  }
  return { ok: true, templates, complete: false };
}

/** A template id as Meta returns it (numeric). */
const TEMPLATE_ID = /^\d{1,32}$/;
const TEMPLATE_STATE = /^[A-Z_]{1,32}$/;

export type CreatedTemplate = { id: string; status?: string; category?: string };

/**
 * Template management (ADR 0020; Meta "Message templates", "Template management", 2026-11-03):
 * submits a new template for review (POST /{waba}/message_templates; the request is built and
 * checked by convex/whatsapp/templateDrafts.ts). `ok` means Meta accepted it for review and
 * returned its id; its status (usually PENDING) and category may change during review.
 */
export async function createMessageTemplate(
  wabaId: string,
  request: Record<string, unknown>,
  auth: { accessToken: string; appSecret: string },
): Promise<{ ok: true; template: CreatedTemplate } | { ok: false; failure: GraphFailure }> {
  const result = await withToken("POST", nodePath(wabaId, "message_templates"), {}, auth, request);
  if (!result.ok) return result;
  const body = result.body as { id?: unknown; status?: unknown; category?: unknown } | null;
  const id = body?.id;
  if (typeof id !== "string" || !TEMPLATE_ID.test(id)) {
    return { ok: false, failure: { kind: "invalid_json", status: 200 } };
  }
  const state = (value: unknown) =>
    typeof value === "string" && TEMPLATE_STATE.test(value) ? value : undefined;
  const status = state(body?.status);
  const category = state(body?.category);
  return {
    ok: true,
    template: {
      id,
      ...(status !== undefined ? { status } : {}),
      ...(category !== undefined ? { category } : {}),
    },
  };
}

/**
 * Deletes one template in one language (DELETE /{waba}/message_templates with `hsm_id` and
 * `name`; Meta: deleting by name alone would delete every language). Success: `{"success": true}`.
 * The name and id are not secret; they travel in the query string as Meta documents.
 */
export async function deleteMessageTemplate(
  wabaId: string,
  template: { id: string; name: string },
  auth: { accessToken: string; appSecret: string },
): Promise<GraphOutcome> {
  if (!TEMPLATE_ID.test(template.id)) throw new Error("Invalid template id");
  return await withToken(
    "DELETE",
    nodePath(wabaId, "message_templates"),
    { hsm_id: template.id, name: template.name },
    auth,
  );
}

/** Meta's documented success body for subscribe / register: `{"success": true}`. */
export function isSuccess(body: unknown): boolean {
  return (body as { success?: unknown } | null)?.success === true;
}
