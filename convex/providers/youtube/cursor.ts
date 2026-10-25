import { fingerprint } from "../hash";
import type { ProviderOperation } from "../types";
import { isYouTubePlaylistId, YOUTUBE_PROVIDER_ID } from "./config";
import { youtubeError } from "./errors";

/**
 * YouTube provider cursor (ADR 0016). Opaque to every caller:
 *
 *   "yt1." + base64url(UTF-8 JSON { v: 1, fp, p, t })
 *
 * - `fp` fingerprints the REQUEST (provider id, operation, channel and request parameters):
 *        a cursor is valid only for the request that produced it (anything else is
 *        invalid_request / cursor_invalid -> the engine's single restart).
 * - `p`  the uploads playlist id the first page resolved (later pages skip that request).
 * - `t`  the Data API `nextPageToken`, printable ASCII, bounded. It never leaves the provider
 *        in clear form and is never a URL.
 * The exact key set is required. Cursors live only in internal sync tables and never carry a
 * token, secret or URL.
 */

const PREFIX = "yt1.";
export const MAX_CURSOR_LENGTH = 8_192;
const PAGE_TOKEN = /^[\x21-\x7e]{1,4096}$/;

export type YouTubeCursorPosition = { playlistId: string; pageToken: string };

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

/** The request fingerprint every cursor of that request is bound to. */
export function youtubeRequestFingerprint(
  operation: ProviderOperation,
  parts: readonly unknown[],
): string {
  return fingerprint([YOUTUBE_PROVIDER_ID, operation, ...parts]);
}

export function encodeYouTubeCursor(
  fp: string,
  operation: ProviderOperation,
  position: YouTubeCursorPosition,
): string {
  if (!isYouTubePlaylistId(position.playlistId) || !PAGE_TOKEN.test(position.pageToken)) {
    // A platform position we cannot carry safely: fail closed as a data error.
    throw youtubeError("data", operation, "cursor_unexpected", "Unexpected paging position");
  }
  const cursor =
    PREFIX +
    base64UrlEncode(JSON.stringify({ v: 1, fp, p: position.playlistId, t: position.pageToken }));
  if (cursor.length > MAX_CURSOR_LENGTH) {
    throw youtubeError("data", operation, "cursor_too_large", "Paging position too large");
  }
  return cursor;
}

/** The position of a cursor issued for THIS request fingerprint. */
export function decodeYouTubeCursor(
  cursor: string,
  fp: string,
  operation: ProviderOperation,
): YouTubeCursorPosition {
  const invalid = () =>
    youtubeError(
      "invalid_request",
      operation,
      "cursor_invalid",
      "Cursor is malformed or belongs to a different request.",
    );
  if (typeof cursor !== "string" || cursor.length > MAX_CURSOR_LENGTH) throw invalid();
  if (!cursor.startsWith(PREFIX)) throw invalid();
  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(cursor.slice(PREFIX.length)));
  } catch {
    throw invalid();
  }
  const p = payload as { v?: unknown; fp?: unknown; p?: unknown; t?: unknown } | null;
  if (
    p === null ||
    typeof p !== "object" ||
    Array.isArray(p) ||
    Object.keys(p).sort().join(",") !== "fp,p,t,v" ||
    p.v !== 1 ||
    p.fp !== fp ||
    !isYouTubePlaylistId(p.p) ||
    typeof p.t !== "string" ||
    !PAGE_TOKEN.test(p.t)
  ) {
    throw invalid();
  }
  return { playlistId: p.p, pageToken: p.t };
}
