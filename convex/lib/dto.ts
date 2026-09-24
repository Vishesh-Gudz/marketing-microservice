import type { PaginationOptions, PaginationResult } from "convex/server";
import { v, type Validator } from "convex/values";

/**
 * DTO conventions for the public `v1` contract (see docs/api/conventions.md):
 * - `id` instead of `_id`; no `_creationTime` or internal foreign keys.
 * - Instants are ISO-8601 UTC strings; calendar dates are "YYYY-MM-DD".
 * - Optional fields are omitted, never null.
 * - Every DTO is a Convex validator plus a `toXDto()` mapper.
 */
export function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

export const MAX_PAGE_SIZE = 100;

/** Caps client-requested page size so a single query stays within limits. */
export function clampPagination(opts: PaginationOptions): PaginationOptions {
  const numItems = Math.max(1, Math.min(Math.floor(opts.numItems), MAX_PAGE_SIZE));
  return { ...opts, numItems };
}

/** Return validator for a paginated list of DTOs. */
export function paginatedDto<T>(item: Validator<T, "required", string>) {
  return v.object({
    page: v.array(item),
    isDone: v.boolean(),
    continueCursor: v.string(),
  });
}

export type PaginatedDto<T> = { page: T[]; isDone: boolean; continueCursor: string };

export function mapPage<Doc, Dto>(
  result: PaginationResult<Doc>,
  toDto: (doc: Doc) => Dto,
): PaginatedDto<Dto> {
  return {
    page: result.page.map(toDto),
    isDone: result.isDone,
    continueCursor: result.continueCursor,
  };
}
