import { CONFIRMATION_CODE_ALPHABET, CONFIRMATION_CODE_LENGTH } from "./config";

/**
 * Meta's `signed_request` (Web Crypto only; default Convex runtime), as documented for the
 * data-deletion callback [doc: developers.facebook.com/docs/development/create-an-app/
 * app-dashboard/data-deletion-callback]:
 *
 *   signed_request = <encoded signature> "." <encoded payload>      (base64url)
 *   signature      = HMAC-SHA256(<encoded payload> as sent, app secret)
 *   payload        = { "algorithm": "HMAC-SHA256", "expires", "issued_at", "user_id" }
 *
 * The signature is checked (constant time, `crypto.subtle.verify`) BEFORE the payload is
 * decoded. Then `algorithm` must be HMAC-SHA256 and `user_id` a decimal string.
 *
 * [assume] Instagram Login's deauthorize and data-deletion callbacks use this format (Meta
 * documents it for Facebook Login; the Instagram docs only name the two URL settings). RI14:
 * which id `user_id` is (the Instagram-scoped user id or the professional account id; both are
 * matched) and which secret signs it (see config.ts).
 */

const SEGMENT = /^[A-Za-z0-9_-]+={0,2}$/;
const MAX_SIGNED_REQUEST_LENGTH = 4096;
/** [assume] Instagram user ids are decimal strings (as every Instagram id we receive). */
const USER_ID = /^[0-9]{1,64}$/;
/** HMAC-SHA256 output. */
const SIGNATURE_BYTES = 32;

const encoder = new TextEncoder();
const utf8 = new TextDecoder("utf-8", { fatal: true });

export type SignedRequest = {
  userId: string;
  /** `issued_at` in ms, when present (seconds in the payload [doc example]). */
  issuedAtMs?: number;
  /** The payload segment exactly as received (keyed into the request's idempotency key). */
  payloadSegment: string;
};

export type SignedRequestResult =
  | { ok: true; request: SignedRequest }
  | { ok: false; reason: "malformed" | "signature" | "payload" };

function base64UrlDecode(segment: string): Uint8Array<ArrayBuffer> | null {
  const base64 = segment.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  if (base64.length % 4 === 1) return null;
  try {
    const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/** Verifies and decodes a `signed_request`; never throws. */
export async function verifySignedRequest(
  value: string,
  appSecret: string,
): Promise<SignedRequestResult> {
  if (value.length === 0 || value.length > MAX_SIGNED_REQUEST_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const dot = value.indexOf(".");
  const signatureSegment = value.slice(0, dot);
  const payloadSegment = value.slice(dot + 1);
  if (dot <= 0 || !SEGMENT.test(signatureSegment) || !SEGMENT.test(payloadSegment)) {
    return { ok: false, reason: "malformed" };
  }
  const signature = base64UrlDecode(signatureSegment);
  if (signature === null || signature.length !== SIGNATURE_BYTES) {
    return { ok: false, reason: "malformed" };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  if (!(await crypto.subtle.verify("HMAC", key, signature, encoder.encode(payloadSegment)))) {
    return { ok: false, reason: "signature" };
  }

  const bytes = base64UrlDecode(payloadSegment);
  let payload: unknown;
  try {
    payload = bytes === null ? null : JSON.parse(utf8.decode(bytes));
  } catch {
    payload = null;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { ok: false, reason: "payload" };
  }
  const { algorithm, user_id: userId, issued_at: issuedAt } = payload as Record<string, unknown>;
  if (typeof algorithm !== "string" || algorithm.toUpperCase() !== "HMAC-SHA256") {
    return { ok: false, reason: "payload" };
  }
  if (typeof userId !== "string" || !USER_ID.test(userId)) {
    return { ok: false, reason: "payload" };
  }
  if (
    issuedAt !== undefined &&
    (typeof issuedAt !== "number" || !Number.isSafeInteger(issuedAt) || issuedAt <= 0)
  ) {
    return { ok: false, reason: "payload" };
  }
  return {
    ok: true,
    request: {
      userId,
      ...(typeof issuedAt === "number" ? { issuedAtMs: issuedAt * 1000 } : {}),
      payloadSegment,
    },
  };
}

/**
 * The idempotency key of a callback: HMAC-SHA256 (lowercase hex) of `<kind>:<payload segment>`
 * under the callback secret. Keyed, so the Instagram user id cannot be recovered from it by
 * trying ids; namespaced by the callback kind.
 */
export async function requestKeyOf(
  secret: string,
  kind: "data_deletion",
  payloadSegment: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${kind}:${payloadSegment}`)),
  );
  return Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A random confirmation code (32-symbol alphabet: every byte maps without bias). */
export function newConfirmationCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CONFIRMATION_CODE_LENGTH));
  return Array.from(bytes, (byte) => CONFIRMATION_CODE_ALPHABET[byte % 32]).join("");
}
