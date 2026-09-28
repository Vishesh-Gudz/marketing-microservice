import { fingerprint } from "../hash";
import type { ProviderOperation } from "../types";
import { INSTAGRAM_PROVIDER_ID } from "./config";
import { instagramError } from "./errors";

/**
 * Instagram provider cursor (Phase 10). Opaque to every caller:
 *
 *   "ig1." + base64url(UTF-8 JSON { v: 1, fp, op, c }) + "." + check
 *
 * - `fp`  fingerprints the REQUEST (provider id incl. Graph version, operation, account and
 *         request parameters): a cursor is valid only for the request that produced it, and
 *         a Graph version change invalidates it (invalid_request -> the engine's one restart).
 * - `op`  the provider operation that issued it.
 * - `c`   the inner platform/SDK paging position (social-sdk's own cursor or a Graph
 *         `after`), printable ASCII, bounded. It never leaves the Instagram provider in
 *         clear form and is never a URL (Graph `paging.next` URLs are never followed).
 * - `check` = first 128 bits of SHA-256 over the prefix and body, hex. Tamper-EVIDENT:
 *         any edit, truncation or splice fails closed. It is not a keyed MAC — cursors live
 *         only in internal sync tables (never in a public response), so the threat is
 *         corruption or a foreign cursor, not an attacker holding the cursor.
 * Size is capped (MAX_CURSOR_LENGTH); anything malformed is invalid_request / cursor_invalid.
 */

const PREFIX = "ig1.";
export const MAX_CURSOR_LENGTH = 8_192;
const MAX_INNER_LENGTH = 4_096;
const INNER = /^[\x21-\x7e]+$/;
const CHECK = /^[0-9a-f]{32}$/;

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function checksum(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The request fingerprint every cursor of that request is bound to. */
export function instagramRequestFingerprint(
  operation: ProviderOperation,
  parts: readonly unknown[],
): string {
  return fingerprint([INSTAGRAM_PROVIDER_ID, operation, ...parts]);
}

function invalid(operation: ProviderOperation) {
  return instagramError(
    "invalid_request",
    operation,
    "cursor_invalid",
    "Cursor is malformed or belongs to a different request.",
  );
}

export async function encodeInstagramCursor(
  fp: string,
  operation: ProviderOperation,
  inner: string,
): Promise<string> {
  if (inner.length === 0 || inner.length > MAX_INNER_LENGTH || !INNER.test(inner)) {
    // A platform/SDK position we cannot carry safely: fail closed as a data error.
    throw instagramError("data", operation, "cursor_unexpected", "Unexpected paging position");
  }
  const body = base64UrlEncode(JSON.stringify({ v: 1, fp, op: operation, c: inner }));
  const cursor = `${PREFIX}${body}.${await checksum(PREFIX + body)}`;
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw instagramError("data", operation, "cursor_too_large", "Paging position too large");
  }
  return cursor;
}

/** The inner position of a cursor issued for THIS request fingerprint and operation. */
export async function decodeInstagramCursor(
  cursor: string,
  fp: string,
  operation: ProviderOperation,
): Promise<string> {
  if (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH) throw invalid(operation);
  if (!cursor.startsWith(PREFIX)) throw invalid(operation);
  const rest = cursor.slice(PREFIX.length);
  const dot = rest.lastIndexOf(".");
  if (dot <= 0) throw invalid(operation);
  const body = rest.slice(0, dot);
  const check = rest.slice(dot + 1);
  if (!CHECK.test(check) || check !== (await checksum(PREFIX + body))) throw invalid(operation);
  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(body));
  } catch {
    throw invalid(operation);
  }
  const p = payload as { v?: unknown; fp?: unknown; op?: unknown; c?: unknown } | null;
  if (
    p === null ||
    typeof p !== "object" ||
    Object.keys(p).sort().join(",") !== "c,fp,op,v" ||
    p.v !== 1 ||
    p.fp !== fp ||
    p.op !== operation ||
    typeof p.c !== "string" ||
    p.c.length === 0 ||
    p.c.length > MAX_INNER_LENGTH ||
    !INNER.test(p.c)
  ) {
    throw invalid(operation);
  }
  return p.c;
}
