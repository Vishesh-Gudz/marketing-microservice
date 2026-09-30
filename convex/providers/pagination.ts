import type { AdPlatform } from "../domain/types";
import { ProviderError } from "./errors";
import type { PageRequest, ProviderOperation, ProviderPage } from "./types";

/**
 * Pagination semantics (docs/providers/architecture.md):
 * - Cursors are opaque, serializable strings, valid only for the request that produced them.
 * - The same request + cursor always returns the same page (deterministic, retry-safe).
 * - Absent nextCursor = done. Empty pages with a nextCursor are allowed.
 * - Page size is clamped to 1..maxPageSize.
 *
 * Offset cursors below are what the mock uses; real providers wrap their
 * platform cursors (Meta "after", Google pageToken) in the same opaque string.
 */
const CURSOR = /^v1\.(\d+)\.([0-9a-z]+)$/;

export function clampPageSize(requested: number | undefined, defaultSize: number, maxSize: number) {
  if (requested === undefined || !Number.isFinite(requested)) return defaultSize;
  return Math.max(1, Math.min(Math.floor(requested), maxSize));
}

export function encodeOffsetCursor(offset: number, requestFingerprint: string): string {
  return `v1.${offset}.${requestFingerprint}`;
}

export function decodeOffsetCursor(
  cursor: string,
  requestFingerprint: string,
  platform: AdPlatform,
  operation: ProviderOperation,
): number {
  const match = CURSOR.exec(cursor);
  if (!match || match[2] !== requestFingerprint) {
    throw new ProviderError({
      kind: "invalid_request",
      platform,
      operation,
      message: "Cursor is malformed or belongs to a different request.",
    });
  }
  return Number(match[1]);
}

/** Slices a fully materialized, stably ordered result into one page. */
export function paginateArray<T>(
  all: readonly T[],
  request: PageRequest,
  options: {
    requestFingerprint: string;
    defaultPageSize: number;
    maxPageSize: number;
    platform: AdPlatform;
    operation: ProviderOperation;
  },
): ProviderPage<T> {
  const size = clampPageSize(request.pageSize, options.defaultPageSize, options.maxPageSize);
  const offset =
    request.cursor === undefined
      ? 0
      : decodeOffsetCursor(
          request.cursor,
          options.requestFingerprint,
          options.platform,
          options.operation,
        );
  if (offset > all.length) {
    throw new ProviderError({
      kind: "invalid_request",
      platform: options.platform,
      operation: options.operation,
      message: "Cursor is past the end of the result set.",
    });
  }
  const end = offset + size;
  const page: ProviderPage<T> = { items: all.slice(offset, end) };
  if (end < all.length) page.nextCursor = encodeOffsetCursor(end, options.requestFingerprint);
  return page;
}

/**
 * Test/tooling helper: follows cursors to completion. Sync (Phase 5) does NOT
 * use this; it processes one page per action and persists the cursor.
 */
export async function collectAll<T>(
  fetchPage: (cursor: string | undefined) => Promise<ProviderPage<T>>,
  options: { maxPages?: number } = {},
): Promise<{ items: T[]; pages: number }> {
  const maxPages = options.maxPages ?? 10_000;
  const items: T[] = [];
  let cursor: string | undefined;
  for (let pages = 1; pages <= maxPages; pages++) {
    const page = await fetchPage(cursor);
    items.push(...page.items);
    if (page.nextCursor === undefined) return { items, pages };
    cursor = page.nextCursor;
  }
  throw new Error(`Pagination did not terminate within ${maxPages} pages`);
}
