/**
 * Meta webhook authentication, shared by WhatsApp and Instagram (Web Crypto only; runs in the
 * default Convex runtime).
 *
 * Meta signs every delivery with HMAC-SHA256 over the EXACT request body bytes, keyed with the
 * app secret, and sends `X-Hub-Signature-256: sha256=<64 hex>`. Verification therefore runs on
 * the raw bytes before any decoding or JSON parsing: re-serialized JSON would not match.
 * Comparison is constant-time (`crypto.subtle.verify`).
 */

export const SIGNATURE_HEADER = "x-hub-signature-256";

const MIN_SECRET_LENGTH = 8;
const MAX_SECRET_LENGTH = 512;

/** A configured secret: present, bounded, without whitespace. Anything else fails closed. */
export function configuredSecret(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.length < MIN_SECRET_LENGTH || value.length > MAX_SECRET_LENGTH) return null;
  if (/\s/.test(value)) return null;
  return value;
}

const SIGNATURE_PATTERN = /^sha256=([0-9a-fA-F]{64})$/;

const encoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

/**
 * True only when `header` is a well-formed `sha256=<hex>` signature of `rawBody` under
 * `appSecret`. A missing or malformed header is simply false (never an exception).
 */
export async function verifyWebhookSignature(
  rawBody: ArrayBuffer,
  header: string | null,
  appSecret: string,
): Promise<boolean> {
  if (header === null) return false;
  const match = SIGNATURE_PATTERN.exec(header.trim());
  if (match === null) return false;
  const key = await hmacKey(appSecret, "verify");
  return await crypto.subtle.verify("HMAC", key, hexToBytes(match[1]!), rawBody);
}

/**
 * Constant-time string equality for the webhook verify token: both sides are hashed first, so
 * neither the comparison time nor an early exit depends on where they differ or on length.
 */
export async function timingSafeEqualString(a: string, b: string): Promise<boolean> {
  const [left, right] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(a)),
    crypto.subtle.digest("SHA-256", encoder.encode(b)),
  ]);
  const x = new Uint8Array(left);
  const y = new Uint8Array(right);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}
