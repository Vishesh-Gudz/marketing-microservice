import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import { configuredSecret, MAX_WEBHOOK_BODY_BYTES, WHATSAPP_ENV } from "./config";
import { parseWebhookPayload } from "./payload";
import { SIGNATURE_HEADER, timingSafeEqualString, verifyWebhookSignature } from "./signature";

/**
 * WhatsApp Cloud API webhook endpoint (`/whatsapp/webhook`, convex/http.ts).
 *
 * GET  verification handshake: echoes `hub.challenge` only for `hub.mode=subscribe` and the
 *      configured verify token (constant-time compare). Unconfigured: always 403.
 * POST event delivery, in this order:
 *      app secret configured (else 503, so Meta retries once it is) -> body size (413) ->
 *      HMAC-SHA256 over the raw bytes (401) -> strict UTF-8 + JSON + envelope parse (400) ->
 *      one ingest mutation (500 on failure: Meta retries; ingestion is idempotent) -> 200.
 *
 * Nothing here logs: not bodies, not headers, not signatures, not secrets (ESLint no-console).
 * Responses carry no detail beyond the status, so they reveal nothing about routing.
 */

/** Meta sends a numeric challenge; anything outside this shape is never reflected. */
const CHALLENGE = /^[A-Za-z0-9_-]{1,128}$/;

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function handleWebhookVerification(request: Request): Promise<Response> {
  const expected = configuredSecret(process.env[WHATSAPP_ENV.verifyToken]);
  if (expected === null) return plain(403, "Forbidden");
  const params = new URL(request.url).searchParams;
  const mode = params.get("hub.mode");
  const token = params.get("hub.verify_token");
  const challenge = params.get("hub.challenge");
  if (mode !== "subscribe" || token === null || challenge === null || !CHALLENGE.test(challenge)) {
    return plain(403, "Forbidden");
  }
  if (!(await timingSafeEqualString(token, expected))) return plain(403, "Forbidden");
  return plain(200, challenge);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export async function handleWebhookDelivery(ctx: ActionCtx, request: Request): Promise<Response> {
  const appSecret = configuredSecret(process.env[WHATSAPP_ENV.appSecret]);
  if (appSecret === null) return plain(503, "Unavailable");

  const declared = request.headers.get("content-length");
  if (declared !== null && !(Number(declared) <= MAX_WEBHOOK_BODY_BYTES)) {
    return plain(413, "Payload Too Large");
  }
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_WEBHOOK_BODY_BYTES) return plain(413, "Payload Too Large");

  if (!(await verifyWebhookSignature(raw, request.headers.get(SIGNATURE_HEADER), appSecret))) {
    return plain(401, "Unauthorized");
  }

  let body: unknown;
  try {
    body = JSON.parse(utf8.decode(raw));
  } catch {
    return plain(400, "Bad Request");
  }
  const parsed = parseWebhookPayload(body);
  if (!parsed.ok) return plain(400, "Bad Request");

  if (parsed.delivery.changes.length > 0) {
    try {
      await ctx.runMutation(internal.whatsapp.ingest.recordDelivery, {
        changes: parsed.delivery.changes,
      });
    } catch {
      // Not logged (the error could echo event fields). Meta retries non-200 deliveries and
      // ingestion is idempotent, so a transient failure loses nothing.
      return plain(500, "Error");
    }
  }
  return plain(200, "EVENT_RECEIVED");
}
