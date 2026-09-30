import { addDays, compareDateKeys, todayIn } from "../lib/dates";
import type { AdsProviderCapabilities } from "../providers/capabilities";
import type { SocialProviderCapabilities } from "../providers/social/capabilities";
import type { SocialRecordKind } from "../providers/social/types";
import { socialRecordIssues } from "../providers/social/validate";
import type { ProviderRecordByKind, ProviderRecordKind } from "../providers/types";
import { recordIssues } from "../providers/validate";
import { SYNC_LIMITS } from "./config";
import type { GuardFailureKind } from "./policy";
import { allowedPlacements, type SyncOperation } from "./plan";
import type { SocialSyncOperation } from "./subject";

/**
 * Pure page guards. They run BEFORE any canonical write, so a rejected page
 * leaves the database untouched (the failure is recorded instead).
 */

export type PageShapeInput = {
  itemCount: number;
  nextCursor: string | undefined;
  requestCursor: string | undefined;
  previousCursor: string | undefined;
  pagesSoFar: number;
  emptyPagesInRow: number;
  maxPageSize: number;
};

/** Pagination safety: loops, runaway page counts, oversized and endless empty pages. */
export function checkPageShape(input: PageShapeInput): GuardFailureKind | undefined {
  const limit = Math.min(input.maxPageSize, SYNC_LIMITS.hardMaxRecordsPerPage);
  if (input.itemCount > limit) return "page_too_large";
  if (input.nextCursor !== undefined) {
    if (input.nextCursor === input.requestCursor || input.nextCursor === input.previousCursor) {
      return "cursor_loop";
    }
    if (input.pagesSoFar + 1 >= SYNC_LIMITS.maxPagesPerTask) return "page_limit";
    if (
      input.itemCount === 0 &&
      input.emptyPagesInRow + 1 >= SYNC_LIMITS.maxConsecutiveEmptyPages
    ) {
      return "empty_page_limit";
    }
  }
  return undefined;
}

export type RecordScope = {
  operation: SyncOperation;
  platform: string;
  accountExternalId: string;
  currency: string;
  level?: string;
  from?: string;
  to?: string;
  breakdown?: "none" | "placement";
  capabilities: AdsProviderCapabilities;
};

export const OPERATION_RECORD_KIND = {
  getAccount: "adAccount",
  listCampaigns: "campaign",
  listAdGroups: "adGroup",
  listCreatives: "creative",
  listAds: "ad",
  fetchDailyMetrics: "metricRow",
  fetchActionMetrics: "actionRow",
} as const satisfies Record<SyncOperation, ProviderRecordKind>;

function naturalKey(kind: ProviderRecordKind, record: Record<string, unknown>): string {
  switch (kind) {
    case "metricRow":
      return `${String(record.entityExternalId)}|${String(record.placement)}|${String(record.date)}`;
    case "actionRow":
      return [
        record.entityExternalId,
        record.placement,
        record.date,
        record.rawActionType,
        record.attributionWindow,
      ]
        .map(String)
        .join("|");
    default:
      return String(record.externalId);
  }
}

/**
 * Every record must be valid, belong to the requested platform/account, and
 * (metrics) match the requested level, window and breakdown placements.
 * Duplicate natural keys within one page are rejected (ambiguous replace).
 */
export function checkRecordsInScope(
  kind: ProviderRecordKind,
  records: readonly unknown[],
  scope: RecordScope,
): GuardFailureKind | undefined {
  const keys = new Set<string>();
  for (const raw of records) {
    if (recordIssues(kind, raw).length > 0) return "invalid_record";
    const record = raw as Record<string, unknown>;
    if (record.platform !== scope.platform) return "out_of_scope";

    if (kind === "adAccount") {
      if (record.externalId !== scope.accountExternalId) return "out_of_scope";
    } else if (record.accountExternalId !== scope.accountExternalId) {
      return "out_of_scope";
    }

    if (kind === "metricRow" || kind === "actionRow") {
      const row = record as ProviderRecordByKind["metricRow"];
      if (row.currency !== scope.currency) return "out_of_scope";
      if (row.level !== scope.level) return "out_of_scope";
      if (
        scope.from === undefined ||
        scope.to === undefined ||
        compareDateKeys(row.date, scope.from) < 0 ||
        compareDateKeys(row.date, scope.to) > 0
      ) {
        return "out_of_scope";
      }
      const placements = allowedPlacements(scope.breakdown ?? "none", scope.capabilities);
      if (!placements.includes(row.placement)) return "out_of_scope";
    }

    const key = naturalKey(kind, record);
    if (keys.has(key)) return "duplicate_keys";
    keys.add(key);
  }
  if (kind === "adAccount" && records.length !== 1) return "out_of_scope";
  return undefined;
}

// ---------------------------------------------------------------------------
// Phase 10 Stage B: organic social pages
// ---------------------------------------------------------------------------

export const SOCIAL_OPERATION_RECORD_KIND = {
  getSocialAccount: "socialAccount",
  listSocialPosts: "socialPost",
  fetchPostMetrics: "socialPostSnapshot",
  fetchAccountMetrics: "socialAccountDay",
} as const satisfies Record<SocialSyncOperation, SocialRecordKind>;

/** Largest page each social operation may return (capabilities). */
export function socialMaxPageSize(
  operation: SocialSyncOperation,
  capabilities: SocialProviderCapabilities,
): number {
  switch (operation) {
    case "getSocialAccount":
      return 1;
    case "listSocialPosts":
      return capabilities.maxPageSize;
    case "fetchPostMetrics":
      return capabilities.postMetricsPageSize;
    case "fetchAccountMetrics":
      return capabilities.maxAccountMetricsRangeDays;
  }
}

export type SocialRecordScope = {
  operation: SocialSyncOperation;
  platform: string;
  accountExternalId: string;
  from?: string;
  to?: string;
  capabilities: SocialProviderCapabilities;
  /** Commit time: snapshots must be captured today or yesterday (UTC). */
  now: number;
  /** Provider-reported unmapped items of this page. */
  unresolved?: number;
};

function socialNaturalKey(kind: SocialRecordKind, record: Record<string, unknown>): string {
  switch (kind) {
    case "socialPostSnapshot":
      return String(record.postExternalId);
    case "socialAccountDay":
      return String(record.date);
    default:
      return String(record.externalId);
  }
}

/**
 * Every social record must be valid (social/validate.ts: table validators minus forbidden
 * fields, permalink rule, counts), belong to the requested platform/account, and:
 * - socialAccount: exactly one record, a supported account type
 * - socialAccountDay: a day inside the requested window (never the profile group: the
 *   validator refuses followers and provenance fields)
 * - socialPostSnapshot: captured today or yesterday (UTC)
 * Duplicate natural keys within one page are rejected. `unresolved` must be a small count.
 */
export function checkSocialRecordsInScope(
  kind: SocialRecordKind,
  records: readonly unknown[],
  scope: SocialRecordScope,
): GuardFailureKind | undefined {
  if (
    scope.unresolved !== undefined &&
    (!Number.isSafeInteger(scope.unresolved) ||
      scope.unresolved < 0 ||
      scope.unresolved > SYNC_LIMITS.hardMaxRecordsPerPage)
  ) {
    return "invalid_record";
  }
  const today = todayIn("UTC", scope.now);
  const keys = new Set<string>();
  for (const raw of records) {
    if (socialRecordIssues(kind, raw).length > 0) return "invalid_record";
    const record = raw as Record<string, unknown>;
    if (record.platform !== scope.platform) return "out_of_scope";
    if (kind === "socialAccount") {
      if (record.externalId !== scope.accountExternalId) return "out_of_scope";
      const types = scope.capabilities.accountTypes as readonly string[];
      if (!types.includes(record.accountType as string)) return "out_of_scope";
    } else if (record.accountExternalId !== scope.accountExternalId) {
      return "out_of_scope";
    }
    if (kind === "socialAccountDay") {
      const date = record.date as string;
      if (
        scope.from === undefined ||
        scope.to === undefined ||
        compareDateKeys(date, scope.from) < 0 ||
        compareDateKeys(date, scope.to) > 0
      ) {
        return "out_of_scope";
      }
    }
    if (kind === "socialPostSnapshot") {
      const day = record.capturedDate as string;
      if (day !== today && day !== addDays(today, -1)) return "out_of_scope";
    }
    const key = socialNaturalKey(kind, record);
    if (keys.has(key)) return "duplicate_keys";
    keys.add(key);
  }
  if (kind === "socialAccount" && records.length !== 1) return "out_of_scope";
  return undefined;
}

// ---------------------------------------------------------------------------
// Size caps (docs/data-model.md: attributes/extras capped at 50 keys)
// ---------------------------------------------------------------------------

export type Capped<T> = { value: T; truncated: number };

export function capAttributes(
  attributes: Record<string, string> | undefined,
): Capped<Record<string, string> | undefined> {
  if (attributes === undefined) return { value: undefined, truncated: 0 };
  let truncated = 0;
  const entries = Object.entries(attributes).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const kept: [string, string][] = [];
  for (const [key, value] of entries) {
    if (
      key.length > SYNC_LIMITS.attributeKeyMaxLength ||
      kept.length >= SYNC_LIMITS.attributesMaxKeys
    ) {
      truncated++;
      continue;
    }
    if (value.length > SYNC_LIMITS.attributeValueMaxLength) {
      truncated++;
      kept.push([key, value.slice(0, SYNC_LIMITS.attributeValueMaxLength)]);
    } else {
      kept.push([key, value]);
    }
  }
  return { value: Object.fromEntries(kept), truncated };
}

export function capExtras(
  extras: Record<string, number> | undefined,
): Capped<Record<string, number> | undefined> {
  if (extras === undefined) return { value: undefined, truncated: 0 };
  const entries = Object.entries(extras).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const kept = entries.filter(([key]) => key.length <= SYNC_LIMITS.attributeKeyMaxLength);
  const limited = kept.slice(0, SYNC_LIMITS.extrasMaxKeys);
  return { value: Object.fromEntries(limited), truncated: entries.length - limited.length };
}

export function capTextArray(values: string[] | undefined): Capped<string[] | undefined> {
  if (values === undefined) return { value: undefined, truncated: 0 };
  const limited = values
    .slice(0, SYNC_LIMITS.textArrayMaxItems)
    .map((value) => value.slice(0, SYNC_LIMITS.attributeValueMaxLength));
  const truncated =
    values.length -
    limited.length +
    values.slice(0, limited.length).filter((v) => v.length > SYNC_LIMITS.attributeValueMaxLength)
      .length;
  return { value: limited, truncated };
}

/** Applies every cap to a mapped row; absent fields stay absent. */
export function applyCaps<T extends object>(row: T): Capped<T> {
  const out: Record<string, unknown> = { ...(row as unknown as Record<string, unknown>) };
  let truncated = 0;
  const record = row as unknown as Record<string, unknown>;
  if ("attributes" in record) {
    const capped = capAttributes(record.attributes as Record<string, string> | undefined);
    out.attributes = capped.value;
    truncated += capped.truncated;
  }
  if ("extras" in record) {
    const capped = capExtras(record.extras as Record<string, number> | undefined);
    out.extras = capped.value;
    truncated += capped.truncated;
  }
  for (const field of ["headlines", "descriptions"]) {
    if (field in record) {
      const capped = capTextArray(record[field] as string[] | undefined);
      out[field] = capped.value;
      truncated += capped.truncated;
    }
  }
  for (const [key, value] of Object.entries(out)) if (value === undefined) delete out[key];
  return { value: out as T, truncated };
}
