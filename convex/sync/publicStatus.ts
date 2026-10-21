import { v, type Infer } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { toIso } from "../lib/dto";
import { syncRunStatusValidator } from "../tables/sync";

/**
 * Public, read-only view of an ad account's sync state (v1/adAccounts:list). Exposes only
 * what docs/sync.md lists as DTO-safe: state, schedule, coverage, last run status and the
 * error KIND with its generic message. The platform error `code` stays internal; a known
 * code is translated into a `reason` through the explicit allowlist below and anything
 * else is dropped (kind + generic message only). The same allowlist explains Google Ads and
 * Meta Ads discovery failures on a connection (connections/assets.ts recordConnectionError).
 */

export const SYNC_ERROR_REASONS = [
  "cloud_project_not_approved_for_production",
  "provider_config_invalid",
  "provider_mode_misconfigured",
  "provider_unavailable",
  "reauth_required",
  "not_ads_user",
  "permission_denied",
  "account_not_enabled",
  "account_not_accessible",
  "account_not_found",
  "rate_limited",
] as const;
export type SyncErrorReason = (typeof SYNC_ERROR_REASONS)[number];

const REASON_BY_CODE: Readonly<Record<string, SyncErrorReason>> = {
  CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION: "cloud_project_not_approved_for_production",
  google_config_invalid: "provider_config_invalid",
  DEVELOPER_TOKEN_NOT_APPROVED: "provider_config_invalid",
  DEVELOPER_TOKEN_PROHIBITED: "provider_config_invalid",
  DEVELOPER_TOKEN_INVALID: "provider_config_invalid",
  ORGANIZATION_NOT_ASSOCIATED_WITH_DEVELOPER_TOKEN: "provider_config_invalid",
  meta_config_invalid: "provider_config_invalid",
  provider_mode_missing: "provider_mode_misconfigured",
  provider_mode_invalid: "provider_mode_misconfigured",
  provider_unavailable: "provider_unavailable",
  invalid_grant: "reauth_required",
  credential_invalid: "reauth_required",
  client_id_mismatch: "reauth_required",
  NOT_ADS_USER: "not_ads_user",
  USER_PERMISSION_DENIED: "permission_denied",
  CUSTOMER_NOT_ENABLED: "account_not_enabled",
  no_route: "account_not_accessible",
  CUSTOMER_NOT_FOUND: "account_not_found",
  RESOURCE_EXHAUSTED: "rate_limited",
  RESOURCE_TEMPORARILY_EXHAUSTED: "rate_limited",
};

/**
 * Meta Ads: Graph codes are "<code>" or "<code>/<subcode>" and one code can be classified
 * differently (a permission code becomes "auth" when the ads_read probe finds the grant
 * gone), so the provider's classified KIND decides; codes only name configuration and
 * missing or inaccessible accounts. Google codes never explain a Meta error.
 * [PROVISIONAL R2/R20: needs a real Meta account to confirm the codes.]
 */
const META_REASON_BY_CODE: Readonly<Record<string, SyncErrorReason>> = {
  meta_config_invalid: "provider_config_invalid",
  provider_mode_missing: "provider_mode_misconfigured",
  provider_mode_invalid: "provider_mode_misconfigured",
  provider_unavailable: "provider_unavailable",
  "100/33": "account_not_accessible",
  "803": "account_not_found",
};
const META_REASON_BY_KIND: Readonly<Record<string, SyncErrorReason>> = {
  auth: "reauth_required",
  permission: "permission_denied",
  rate_limited: "rate_limited",
};

const lookup = (table: Readonly<Record<string, SyncErrorReason>>, key: string | undefined) =>
  key !== undefined && Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;

/**
 * The allowlisted reason of a stored error code (a "stage:" prefix is ignored). Meta Ads
 * errors also pass the platform and the error kind (see META_REASON_BY_CODE).
 */
export function syncErrorReason(
  code: string | undefined,
  context?: { platform: string; kind: string },
): SyncErrorReason | undefined {
  const bare = code?.includes(":") ? code.slice(code.lastIndexOf(":") + 1) : code;
  if (context?.platform === "meta") {
    return lookup(META_REASON_BY_CODE, bare) ?? lookup(META_REASON_BY_KIND, context.kind);
  }
  return lookup(REASON_BY_CODE, bare);
}

/** True only for a published reason (re-checks a stored value before it leaves the server). */
export function isSyncErrorReason(value: unknown): value is SyncErrorReason {
  return typeof value === "string" && (SYNC_ERROR_REASONS as readonly string[]).includes(value);
}

export const syncErrorReasonValidator = v.union(...SYNC_ERROR_REASONS.map((r) => v.literal(r)));

export const publicSyncStatusDto = v.object({
  syncState: v.union(
    v.literal("idle"),
    v.literal("running"),
    v.literal("blocked"),
    v.literal("parked"),
  ),
  lastSuccessAt: v.optional(v.string()),
  lastRunStatus: v.optional(syncRunStatusValidator),
  consecutiveFailures: v.number(),
  nextRunAt: v.optional(v.string()),
  coveredFrom: v.optional(v.string()),
  coveredThrough: v.optional(v.string()),
  lastError: v.optional(
    v.object({
      kind: v.string(),
      message: v.string(),
      reason: v.optional(syncErrorReasonValidator),
      at: v.string(),
    }),
  ),
});
export type PublicSyncStatus = Infer<typeof publicSyncStatusDto>;

export function toPublicSyncStatus(
  account: Doc<"syncAccounts">,
  lastRun: Pick<Doc<"syncRuns">, "status"> | null,
  platform?: string,
): PublicSyncStatus {
  const error = account.lastError;
  const reason =
    error !== undefined
      ? syncErrorReason(
          error.code,
          platform !== undefined ? { platform, kind: error.kind } : undefined,
        )
      : undefined;
  return {
    syncState: account.state,
    ...(account.lastSuccessAt !== undefined ? { lastSuccessAt: toIso(account.lastSuccessAt) } : {}),
    ...(lastRun !== null ? { lastRunStatus: lastRun.status } : {}),
    consecutiveFailures: account.consecutiveFailures,
    ...(account.nextPlanAt !== undefined ? { nextRunAt: toIso(account.nextPlanAt) } : {}),
    ...(account.coveredFrom !== undefined ? { coveredFrom: account.coveredFrom } : {}),
    ...(account.coveredThrough !== undefined ? { coveredThrough: account.coveredThrough } : {}),
    ...(error !== undefined
      ? {
          lastError: {
            kind: error.kind,
            message: error.message,
            ...(reason !== undefined ? { reason } : {}),
            at: toIso(error.at),
          },
        }
      : {}),
  };
}
