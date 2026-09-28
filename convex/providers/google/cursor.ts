import type { ProviderOperation } from "../types";
import { GOOGLE_SEARCH_PAGE_ROWS, MAX_HIERARCHY_ACCOUNTS } from "./config";
import { googleError } from "./errors";

/**
 * Request-bound composite cursor (Phase 9):
 *   "g1." + base64url(UTF-8 JSON { v: 1, fp, s?, t?, o?, r?, f?, c?, l?, i?, p?, n? })
 * `fp` fingerprints the request INCLUDING the API version and the GAQL of every stage, so a
 * cursor of another request or version is rejected (invalid_request → the sync engine's
 * single restart). Fields:
 * - `s` stage of a staged request (omitted for 0);
 * - `t` Google `nextPageToken` of the current Google page (absent on the first Google page);
 * - `o` offset inside that Google page: one fixed-size Google page (10,000 rows) is served as
 *   several provider pages of ≤ 500 records and RE-RETRIEVED for each (G-D16);
 * - `r` the resolved login-customer-id route (G-D3), fixed for the rest of the request;
 * - `c` carry (carry.ts) and `f` flush (emit the carry; no Google call);
 * - `l` the request's lookup (Stage B action rows: conversion action ids whose
 *   primary_for_goal is true `y` / false `n`), read once on the first page;
 * - discovery only: `i` accessible-customer index, `p` "c" while listing a manager's
 *   hierarchy, `n` customer ids already listed (listed once).
 * The sync engine commits the cursor atomically with the page. It never carries a token,
 * secret or URL.
 */

const PREFIX = "g1.";
export const MAX_CURSOR_LENGTH = 262_144;
const MAX_STAGE = 7;
const MAX_INDEX = 1_000_000;
const PAGE_TOKEN = /^[\x21-\x7e]{1,4096}$/;
const CUSTOMER_ID = /^\d{10}$/;
const RESOURCE_ID = /^\d{1,20}$/;
/** At most one Google page of lookup rows. */
export const MAX_LOOKUP_ENTRIES = GOOGLE_SEARCH_PAGE_ROWS;

/** A request lookup: ids flagged true / false (ids without a reported flag are omitted). */
export type GoogleCursorLookup = { included: string[]; excluded: string[] };

export type GoogleCursorPosition = {
  stage: number;
  pageToken?: string;
  offset?: number;
  route?: string;
  flush?: true;
  carry?: unknown[];
  lookup?: GoogleCursorLookup;
  /** Discovery: index into the sorted accessible customers. */
  index?: number;
  /** Discovery: listing the current manager's customer_client hierarchy. */
  hierarchy?: true;
  /** Discovery: customer ids already listed. */
  seen?: string[];
};

/** A cursor that no longer fits (fail closed: the caller reports a data error). */
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

const isInt = (v: unknown, max: number): v is number =>
  typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

const isIdList = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((id) => typeof id === "string" && RESOURCE_ID.test(id));

/** True when a lookup is malformed (ids, size, overlap). */
function lookupIssues(lookup: GoogleCursorLookup): boolean {
  if (lookup === null || typeof lookup !== "object") return true;
  const { included, excluded } = lookup;
  if (!isIdList(included) || !isIdList(excluded)) return true;
  const all = new Set([...included, ...excluded]);
  return all.size !== included.length + excluded.length || all.size > MAX_LOOKUP_ENTRIES;
}

/** Problems with a position (empty = valid). The first page never has a cursor. */
function positionIssues(p: GoogleCursorPosition): string[] {
  const issues: string[] = [];
  if (!isInt(p.stage, MAX_STAGE)) issues.push("stage");
  if (p.pageToken !== undefined && !PAGE_TOKEN.test(p.pageToken)) issues.push("pageToken");
  if (p.offset !== undefined && (!isInt(p.offset, GOOGLE_SEARCH_PAGE_ROWS) || p.offset === 0)) {
    issues.push("offset");
  }
  if (p.route !== undefined && !CUSTOMER_ID.test(p.route)) issues.push("route");
  if (p.carry !== undefined && (!Array.isArray(p.carry) || p.carry.length === 0)) {
    issues.push("carry");
  }
  if (p.lookup !== undefined && lookupIssues(p.lookup)) issues.push("lookup");
  if (p.flush !== undefined) {
    if (p.flush !== true || p.carry === undefined) issues.push("flush");
    if (p.pageToken !== undefined || p.offset !== undefined) issues.push("flush with page");
  }
  if (p.index !== undefined && (!isInt(p.index, MAX_INDEX) || p.index === 0)) issues.push("index");
  if (p.hierarchy !== undefined && p.hierarchy !== true) issues.push("hierarchy");
  if (
    p.seen !== undefined &&
    (!Array.isArray(p.seen) ||
      p.seen.length > MAX_HIERARCHY_ACCOUNTS ||
      !p.seen.every((id) => typeof id === "string" && CUSTOMER_ID.test(id)))
  ) {
    issues.push("seen");
  }
  const start =
    p.stage === 0 &&
    p.pageToken === undefined &&
    p.offset === undefined &&
    p.flush === undefined &&
    p.index === undefined &&
    p.hierarchy === undefined;
  if (start) issues.push("a first page has no cursor");
  return issues;
}

export function encodeGoogleCursor(fp: string, position: GoogleCursorPosition): string {
  if (positionIssues(position).length > 0) throw new Error("Invalid cursor position");
  const payload = {
    v: 1,
    fp,
    ...(position.stage > 0 ? { s: position.stage } : {}),
    ...(position.pageToken !== undefined ? { t: position.pageToken } : {}),
    ...(position.offset !== undefined ? { o: position.offset } : {}),
    ...(position.route !== undefined ? { r: position.route } : {}),
    ...(position.flush === true ? { f: 1 } : {}),
    ...(position.carry !== undefined ? { c: position.carry } : {}),
    ...(position.lookup !== undefined
      ? { l: { y: position.lookup.included, n: position.lookup.excluded } }
      : {}),
    ...(position.index !== undefined ? { i: position.index } : {}),
    ...(position.hierarchy === true ? { p: "c" } : {}),
    ...(position.seen !== undefined ? { n: position.seen } : {}),
  };
  const cursor = PREFIX + base64UrlEncode(JSON.stringify(payload));
  if (cursor.length > MAX_CURSOR_LENGTH) throw new CursorTooLargeError("cursor too large");
  return cursor;
}

const KEYS = new Set(["v", "fp", "s", "t", "o", "r", "f", "c", "l", "i", "p", "n"]);

export function decodeGoogleCursor(
  cursor: string,
  fp: string,
  operation: ProviderOperation,
): GoogleCursorPosition {
  const invalid = () =>
    googleError(
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
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) throw invalid();
  const p = payload as Record<string, unknown>;
  if (p.v !== 1 || p.fp !== fp || Object.keys(p).some((k) => !KEYS.has(k))) throw invalid();
  if (p.s !== undefined && (!isInt(p.s, MAX_STAGE) || p.s === 0)) throw invalid();
  if (p.f !== undefined && p.f !== 1) throw invalid();
  if (p.p !== undefined && p.p !== "c") throw invalid();
  let lookup: GoogleCursorLookup | undefined;
  if (p.l !== undefined) {
    const l = p.l as Record<string, unknown> | null;
    if (
      l === null ||
      typeof l !== "object" ||
      Array.isArray(l) ||
      Object.keys(l).some((k) => k !== "y" && k !== "n")
    ) {
      throw invalid();
    }
    lookup = { included: l.y as string[], excluded: l.n as string[] };
  }
  const position: GoogleCursorPosition = {
    stage: (p.s as number | undefined) ?? 0,
    ...(p.t !== undefined ? { pageToken: p.t as string } : {}),
    ...(p.o !== undefined ? { offset: p.o as number } : {}),
    ...(p.r !== undefined ? { route: p.r as string } : {}),
    ...(p.f === 1 ? { flush: true as const } : {}),
    ...(p.c !== undefined ? { carry: p.c as unknown[] } : {}),
    ...(lookup !== undefined ? { lookup } : {}),
    ...(p.i !== undefined ? { index: p.i as number } : {}),
    ...(p.p === "c" ? { hierarchy: true as const } : {}),
    ...(p.n !== undefined ? { seen: p.n as string[] } : {}),
  };
  if (
    (p.t !== undefined && typeof p.t !== "string") ||
    (p.r !== undefined && typeof p.r !== "string") ||
    positionIssues(position).length > 0
  ) {
    throw invalid();
  }
  return position;
}
