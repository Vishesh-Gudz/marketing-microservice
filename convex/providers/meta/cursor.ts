import type { ProviderOperation } from "../types";
import { metaError } from "./errors";

/**
 * Request-bound composite cursor (Phase 8, D15/D16, R9):
 *   "m1." + base64url(UTF-8 JSON { v: 1, fp, s?, after?, l?, f?, c? })
 * `fp` fingerprints the request INCLUDING the effective API version and its Graph request
 * plans, so a cursor produced under one Graph version is rejected under another
 * (invalid_request → the sync engine's single restart), and pages of two versions never mix.
 * - `s`: stage of a staged insights request (0 = rows without breakdown, 1 = the
 *   publisher_platform breakdown); omitted for stage 0.
 * - `after`: Meta's opaque `paging.cursors.after` within the stage. Only a later stage's
 *   start or a flush omits it.
 * - `l`: Graph rows to request for the next page of the stage, when fewer than the page size
 *   had to be requested so that a page fits one sync page (rows that expand into many action
 *   records). Only together with `after`.
 * - `c`: the carry — records accumulated across Graph pages of the stage (carry.ts).
 * - `f`: flush — the stage has no more Graph pages; the next calls emit the carry.
 * The sync engine commits the cursor atomically with the page, so the carry is exactly-once.
 * The cursor never carries a token or a URL.
 */

const PREFIX = "m1.";
/** Room for a carry of several hundred accumulated rows (the sync stores it as a string). */
export const MAX_CURSOR_LENGTH = 262_144;
const MAX_STAGE = 7;
/** Meta's opaque paging cursor: printable ASCII, bounded. */
const AFTER = /^[\x21-\x7e]{1,2048}$/;
/** Graph's largest page size. */
const MAX_ROWS = 5000;

const validRows = (rows: unknown): rows is number =>
  typeof rows === "number" && Number.isInteger(rows) && rows >= 1 && rows <= MAX_ROWS;

export type MetaCursorPosition = {
  stage: number;
  after?: string;
  /** Graph rows to request for the next page (only with `after`). */
  rows?: number;
  /** Emit the carry (no Graph request). */
  flush?: true;
  /** Encoded carry entries (carry.ts). */
  carry?: unknown[];
};

/** A carry that no longer fits the cursor (fail closed: the caller reports a data error). */
export class CursorTooLargeError extends Error {}

function base64UrlEncode(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("not base64url");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Cursor for a position of THIS request fingerprint. */
export function encodeMetaPosition(fp: string, position: MetaCursorPosition): string {
  const { stage, after, rows, flush, carry } = position;
  if (!Number.isInteger(stage) || stage < 0 || stage > MAX_STAGE) {
    throw new Error("Invalid cursor stage");
  }
  if (after !== undefined && !AFTER.test(after)) throw new Error("Unexpected Meta paging cursor");
  if (rows !== undefined && (!validRows(rows) || after === undefined)) {
    throw new Error("A row count needs a valid count and a paging cursor");
  }
  if (flush === true && (after !== undefined || carry === undefined || carry.length === 0)) {
    throw new Error("A flush cursor carries records and no paging cursor");
  }
  if (flush !== true && after === undefined && (stage === 0 || carry !== undefined)) {
    throw new Error("Only a later stage may start without a paging cursor");
  }
  const payload = {
    v: 1,
    fp,
    ...(stage > 0 ? { s: stage } : {}),
    ...(after !== undefined ? { after } : {}),
    ...(rows !== undefined ? { l: rows } : {}),
    ...(flush === true ? { f: 1 } : {}),
    ...(carry !== undefined && carry.length > 0 ? { c: carry } : {}),
  };
  const cursor = PREFIX + base64UrlEncode(JSON.stringify(payload));
  if (cursor.length > MAX_CURSOR_LENGTH) throw new CursorTooLargeError("cursor too large");
  return cursor;
}

/** Cursor for `after` within `stage` (or the start of `stage` when `after` is undefined). */
export function encodeMetaCursor(fp: string, after: string | undefined, stage = 0): string {
  return encodeMetaPosition(fp, { stage, ...(after !== undefined ? { after } : {}) });
}

/** The position of a cursor issued for THIS request fingerprint. */
export function decodeMetaCursorPosition(
  cursor: string,
  fp: string,
  operation: ProviderOperation,
): MetaCursorPosition {
  const invalid = () =>
    metaError(
      "invalid_request",
      operation,
      "cursor_invalid",
      "Cursor is malformed or belongs to a different request.",
    );
  if (cursor.length > MAX_CURSOR_LENGTH || !cursor.startsWith(PREFIX)) throw invalid();
  let payload: unknown;
  try {
    payload = JSON.parse(base64UrlDecode(cursor.slice(PREFIX.length)));
  } catch {
    throw invalid();
  }
  const p = payload as {
    v?: unknown;
    fp?: unknown;
    s?: unknown;
    after?: unknown;
    l?: unknown;
    f?: unknown;
    c?: unknown;
  } | null;
  if (p === null || typeof p !== "object" || p.v !== 1 || p.fp !== fp) throw invalid();
  // Stage 0 is encoded by omitting `s`; an explicit s: 0 is not a cursor we issued.
  const stage = p.s === undefined ? 0 : p.s;
  if (typeof stage !== "number" || !Number.isInteger(stage) || stage > MAX_STAGE) throw invalid();
  if (p.s !== undefined && stage < 1) throw invalid();
  if (p.after !== undefined && (typeof p.after !== "string" || !AFTER.test(p.after))) {
    throw invalid();
  }
  if (p.l !== undefined && (!validRows(p.l) || p.after === undefined)) throw invalid();
  if (p.f !== undefined && p.f !== 1) throw invalid();
  if (p.c !== undefined && (!Array.isArray(p.c) || p.c.length === 0)) throw invalid();
  const flush = p.f === 1;
  if (flush && (p.after !== undefined || p.c === undefined)) throw invalid();
  if (!flush && p.after === undefined && (stage === 0 || p.c !== undefined)) throw invalid();
  return {
    stage,
    ...(p.after !== undefined ? { after: p.after as string } : {}),
    ...(p.l !== undefined ? { rows: p.l as number } : {}),
    ...(flush ? { flush: true as const } : {}),
    ...(p.c !== undefined ? { carry: p.c as unknown[] } : {}),
  };
}

/** The Meta `after` value of a (stage 0, carry-free) cursor issued for THIS fingerprint. */
export function decodeMetaCursor(cursor: string, fp: string, operation: ProviderOperation): string {
  const position = decodeMetaCursorPosition(cursor, fp, operation);
  if (
    position.stage !== 0 ||
    position.after === undefined ||
    position.flush !== undefined ||
    position.carry !== undefined ||
    position.rows !== undefined
  ) {
    throw metaError(
      "invalid_request",
      operation,
      "cursor_invalid",
      "Cursor is malformed or belongs to a different request.",
    );
  }
  return position.after;
}
