import { vi } from "vitest";
import { INSTAGRAM_CALLBACK_SECRET_ENV } from "./config";

// Test-only signed requests in Meta's documented format (see signedRequest.ts): never a real
// secret, user or payload.

export const FAKE_CALLBACK_SECRET = "test-instagram-callback-secret";

export function stubCallbackSecret(secret = FAKE_CALLBACK_SECRET): void {
  vi.stubEnv(INSTAGRAM_CALLBACK_SECRET_ENV, secret);
}

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** `<base64url(HMAC-SHA256(payload segment))>.<base64url(JSON payload)>`. */
export async function signRequest(
  payload: unknown,
  secret = FAKE_CALLBACK_SECRET,
): Promise<string> {
  const segment = base64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(segment)));
  return `${base64Url(signature)}.${segment}`;
}

/** The payload Meta documents for the data-deletion callback (issued now by default). */
export function payloadFor(
  userId: string,
  issuedAt = Math.floor(Date.now() / 1000),
): Record<string, unknown> {
  return {
    algorithm: "HMAC-SHA256",
    expires: issuedAt + 3600,
    issued_at: issuedAt,
    user_id: userId,
  };
}

type FetchBackend = { fetch: (path: string, init?: RequestInit) => Promise<Response> };

/** POSTs a form with `signed_request` (or a raw body / content type). */
export async function postCallback(
  t: FetchBackend,
  path: string,
  signedRequest: string,
  options: { contentType?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  return await t.fetch(path, {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/x-www-form-urlencoded",
      ...options.headers,
    },
    body: options.body ?? new URLSearchParams({ signed_request: signedRequest }).toString(),
  });
}
