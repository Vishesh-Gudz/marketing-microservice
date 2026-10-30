import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import { isLocalDeployment } from "../../providers/mode";
import { configuredSecret } from "../../messaging/signature";
import {
  CONFIRMATION_CODE,
  INSTAGRAM_CALLBACK_SECRET_ENV,
  INSTAGRAM_DATA_DELETION_STATUS_PATH,
  MAX_CALLBACK_BODY_BYTES,
} from "./config";
import {
  newConfirmationCode,
  requestKeyOf,
  verifySignedRequest,
  type SignedRequest,
} from "./signedRequest";

/**
 * Meta's Instagram Login callbacks (ADR 0017, IM6; convex/http.ts):
 *
 * POST /instagram/deauthorize      the user removed the app -> 200 "OK"
 * POST /instagram/data-deletion    the user asked for deletion -> 200
 *                                  `{"url": <status page>, "confirmation_code": <code>}` [doc]
 * GET  /instagram/data-deletion/status?code=<code>   human-readable status [doc]
 *
 * Both POSTs, in order: secret configured (else 503, nothing read) -> (deletion: a public
 * https status origin, else 503) -> well-formed Content-Length (400) and body size (413; the
 * body is read with a byte cap, so an undeclared large body is never buffered whole) ->
 * `signed_request` form field (urlencoded or multipart; [assume] Meta posts a form, as its
 * sample reads `$_POST['signed_request']`) (400) -> signature (401) -> payload (400) -> one
 * mutation (an error is a 500; both mutations are idempotent) -> 200.
 *
 * Nothing here logs (ESLint no-console). Responses never carry an id, account, org, count or
 * reason beyond the status line: the status page shows dates and state only.
 */

const CONTENT_LENGTH = /^\d+$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

function plain(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" },
  });
}

/** The body, read with a byte cap; null as soon as it is larger. */
async function cappedBody(
  request: Request,
  limit: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** The verified signed request of a callback POST, or the response refusing it. */
async function verifiedRequest(
  request: Request,
  secret: string,
): Promise<SignedRequest | Response> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!CONTENT_LENGTH.test(declared)) return plain(400, "Bad Request");
    if (Number(declared) > MAX_CALLBACK_BODY_BYTES) return plain(413, "Payload Too Large");
  }
  const raw = await cappedBody(request, MAX_CALLBACK_BODY_BYTES);
  if (raw === null) return plain(413, "Payload Too Large");

  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";")[0]!.trim().toLowerCase();
  let value: unknown = null;
  try {
    if (mediaType === "application/x-www-form-urlencoded") {
      value = new URLSearchParams(utf8.decode(raw)).get("signed_request");
    } else if (mediaType === "multipart/form-data") {
      const form = await new Response(raw, {
        headers: { "content-type": contentType },
      }).formData();
      value = form.get("signed_request");
    }
  } catch {
    return plain(400, "Bad Request");
  }
  if (typeof value !== "string") return plain(400, "Bad Request");

  const result = await verifySignedRequest(value, secret);
  if (result.ok) return result.request;
  return result.reason === "signature" ? plain(401, "Unauthorized") : plain(400, "Bad Request");
}

/** The deployment's public origin for the status URL: https, or loopback http locally. */
function statusOrigin(): string | null {
  const site = process.env.CONVEX_SITE_URL;
  if (site === undefined) return null;
  try {
    const url = new URL(site);
    const local = url.protocol === "http:" && isLocalDeployment(site);
    return url.protocol === "https:" || local ? url.origin : null;
  } catch {
    return null;
  }
}

export async function handleDeauthorize(ctx: ActionCtx, request: Request): Promise<Response> {
  const secret = configuredSecret(process.env[INSTAGRAM_CALLBACK_SECRET_ENV]);
  if (secret === null) return plain(503, "Unavailable");
  const signed = await verifiedRequest(request, secret);
  if (signed instanceof Response) return signed;
  await ctx.runMutation(internal.instagram.dataDeletion.requests.deauthorize, {
    userId: signed.userId,
    ...(signed.issuedAtMs !== undefined ? { issuedAtMs: signed.issuedAtMs } : {}),
  });
  return plain(200, "OK");
}

export async function handleDataDeletion(ctx: ActionCtx, request: Request): Promise<Response> {
  const secret = configuredSecret(process.env[INSTAGRAM_CALLBACK_SECRET_ENV]);
  const origin = statusOrigin();
  if (secret === null || origin === null) return plain(503, "Unavailable");
  const signed = await verifiedRequest(request, secret);
  if (signed instanceof Response) return signed;
  const { confirmationCode } = await ctx.runMutation(
    internal.instagram.dataDeletion.requests.recordDeletionRequest,
    {
      userId: signed.userId,
      ...(signed.issuedAtMs !== undefined ? { issuedAtMs: signed.issuedAtMs } : {}),
      requestKey: await requestKeyOf(secret, "data_deletion", signed.payloadSegment),
      confirmationCode: newConfirmationCode(),
    },
  );
  const url = new URL(INSTAGRAM_DATA_DELETION_STATUS_PATH, origin);
  url.searchParams.set("code", confirmationCode);
  return new Response(
    JSON.stringify({ url: url.toString(), confirmation_code: confirmationCode }),
    {
      status: 200,
      headers: { ...HEADERS, "content-type": "application/json" },
    },
  );
}

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

type StatusView = { receivedAt: number; completedAt?: number; closedAt?: number };

/**
 * What each state says. Only a VERIFIED deletion says "Completed" (ADR 0017, IM7.0): an
 * operator closing the review is "closed without full verification", never completed.
 */
const STATE_TEXT: Record<
  "pending" | "review" | "completed" | "closed_unverified",
  (status: StatusView) => string
> = {
  pending: () =>
    "In progress. Deletion started when the request was received; it usually finishes within a few hours.",
  review: () =>
    "In progress. Deletion started when the request was received. Some older connections still have to be checked; this page is updated once that is done.",
  closed_unverified: (status) =>
    `Closed without full verification on ${utc(status.closedAt ?? status.receivedAt)}. Deletion of every connection we could identify is complete; some older connections could not be checked, so we cannot confirm that no other data remains.`,
  completed: (status) => `Completed on ${utc(status.completedAt ?? status.receivedAt)}.`,
};

const WHAT_IS_DELETED = [
  "What is deleted: for every organization that connected this Instagram account to the",
  "service, the connection and its access token, the account's stored analytics (posts, their",
  "insights, daily account metrics and sync history) and its direct messages (conversations,",
  "messages and the webhook events they came from). Internal audit entries keep only internal",
  "ids, without Instagram content.",
].join("\n");

export async function handleDeletionStatus(ctx: ActionCtx, request: Request): Promise<Response> {
  const code = new URL(request.url).searchParams.get("code");
  const status =
    code !== null && CONFIRMATION_CODE.test(code)
      ? await ctx.runQuery(internal.instagram.dataDeletion.requests.deletionStatus, {
          confirmationCode: code,
        })
      : null;
  if (code === null || status === null) {
    return plain(404, "No Instagram data deletion request has this confirmation code.\n");
  }
  const state = STATE_TEXT[status.status](status);
  return plain(
    200,
    [
      "Instagram data deletion request",
      "",
      `Confirmation code: ${code}`,
      `Received: ${utc(status.receivedAt)}`,
      `Status: ${state}`,
      "",
      WHAT_IS_DELETED,
      "",
    ].join("\n"),
  );
}
