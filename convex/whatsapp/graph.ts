import { appSecretProof } from "../providers/meta/client";
import { GRAPH_ORIGIN } from "../providers/meta/config";
import { SIGNUP_TIMEOUT_MS, WHATSAPP_GRAPH_API_VERSION } from "./config";

/**
 * Minimal Graph client for WhatsApp onboarding (ADR 0014). Same rules as the Meta Ads client
 * (convex/providers/meta/client.ts), kept separate so neither integration changes the other:
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
 * (debug_token granular_scopes -> shared WABA ids), "Phone numbers" (GET /{waba}/phone_numbers).
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
  method: "GET" | "POST",
  path: string,
  params: Record<string, string>,
  auth: { accessToken: string; appSecret: string },
  json?: Record<string, string>,
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

/** Meta's documented success body for subscribe / register: `{"success": true}`. */
export function isSuccess(body: unknown): boolean {
  return (body as { success?: unknown } | null)?.success === true;
}
