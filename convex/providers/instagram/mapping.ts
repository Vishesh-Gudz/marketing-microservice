import type { ProviderOperation } from "../types";
import { instagramError } from "./errors";

/**
 * The semantic seam of the Instagram provider (Phase 10).
 *
 * Stage A status: NO semantic mapping exists yet. Account metadata (preflight), post
 * listing, post metric snapshots and account metrics all fail CLOSED with ProviderError
 * "unknown" / "instagram_mapping_pending" BEFORE any network call — never "unsupported"
 * (which would skip the task and could later advance coverage over missing data). Stage B
 * adds the mapping here (with [doc] / [PROVISIONAL IRn] tags) and flips the capabilities.
 */
export const INSTAGRAM_MAPPING_PENDING = "instagram_mapping_pending";

export function instagramMappingPending(operation: ProviderOperation) {
  return instagramError(
    "unknown",
    operation,
    INSTAGRAM_MAPPING_PENDING,
    "Instagram data mapping is not implemented yet",
  );
}
