import { validate } from "convex-helpers/validators";
import { v, type PropertyValidators } from "convex/values";
import { AD_METRICS } from "../domain/metrics";
import {
  normalizeAdAccountExternalId,
  normalizeNumericId,
  parseGoogleAdExternalId,
} from "../domain/identity";
import type { AdPlatform } from "../domain/types";
import { managerStatusValidator, testAccountStatusValidator } from "../domain/validators";
import { compareDateKeys, isDateKey } from "../lib/dates";
import { isValidCurrency, isValidTimezone } from "../lib/validation";
import { adTables } from "../tables/ads";
import { metricTables } from "../tables/metrics";
import { ProviderError } from "./errors";
import type { ProviderOperation, ProviderRecordByKind, ProviderRecordKind } from "./types";

/**
 * Boundary validation for provider records. Structure is checked against the
 * REAL Phase 2 table validators (minus tenant/lifecycle/internal-id fields,
 * plus the external-id references), so records can never drift from the
 * schema and can never smuggle in orgId or Convex ids (unknown fields fail).
 * Semantic checks add what Convex validators cannot express.
 */

const TENANT_AND_LIFECYCLE = new Set([
  "orgId",
  "createdAt",
  "updatedAt",
  "lastSeenAt",
  "removedAt",
]);
const METRIC_REFS = ["adAccountId", "entityId", "campaignId", "adGroupId", "adId", "syncedAt"];

function recordValidator(fields: PropertyValidators, drop: string[], extra: PropertyValidators) {
  const kept = Object.fromEntries(
    Object.entries(fields).filter(
      ([name]) => !TENANT_AND_LIFECYCLE.has(name) && !drop.includes(name),
    ),
  );
  return v.object({ ...kept, ...extra });
}

const externalRef = v.string();
const optionalExternalRef = v.optional(v.string());

export const RECORD_VALIDATORS = {
  adAccount: recordValidator(adTables.adAccounts.validator.fields, ["connectionId", "linkedAt"], {
    // Discovery facts (never stored on adAccounts; see ProviderAdAccount).
    managerStatus: v.optional(managerStatusValidator),
    testAccountStatus: v.optional(testAccountStatusValidator),
  }),
  campaign: recordValidator(adTables.campaigns.validator.fields, ["adAccountId"], {
    accountExternalId: externalRef,
  }),
  adGroup: recordValidator(adTables.adGroups.validator.fields, ["adAccountId", "campaignId"], {
    accountExternalId: externalRef,
    campaignExternalId: externalRef,
  }),
  ad: recordValidator(
    adTables.ads.validator.fields,
    ["adAccountId", "campaignId", "adGroupId", "creativeId"],
    {
      accountExternalId: externalRef,
      campaignExternalId: externalRef,
      adGroupExternalId: optionalExternalRef,
      creativeExternalId: optionalExternalRef,
    },
  ),
  creative: recordValidator(adTables.creatives.validator.fields, ["adAccountId"], {
    accountExternalId: externalRef,
  }),
  metricRow: recordValidator(metricTables.metricsDaily.validator.fields, METRIC_REFS, {
    accountExternalId: externalRef,
    entityExternalId: externalRef,
  }),
  actionRow: recordValidator(metricTables.actionMetricsDaily.validator.fields, METRIC_REFS, {
    accountExternalId: externalRef,
    entityExternalId: externalRef,
  }),
} satisfies Record<ProviderRecordKind, unknown>;

// ---------------------------------------------------------------------------
// Semantic checks
// ---------------------------------------------------------------------------

type Issues = string[];

function check(issues: Issues, label: string, fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    issues.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkAccountId(issues: Issues, platform: AdPlatform, value: string, label: string) {
  check(issues, label, () => {
    if (normalizeAdAccountExternalId(platform, value) !== value) {
      throw new Error(`"${value}" is not in canonical form`);
    }
  });
}

function checkNumericId(issues: Issues, value: string | undefined, label: string) {
  if (value === undefined) return;
  check(issues, label, () => {
    if (normalizeNumericId(value, label) !== value) throw new Error(`"${value}" has whitespace`);
  });
}

/** Google ads/creatives use "{adGroupId}~{adId}"; everything else is numeric. */
function checkEntityId(
  issues: Issues,
  platform: AdPlatform,
  value: string | undefined,
  label: string,
  composite: boolean,
) {
  if (value === undefined) return;
  if (platform === "google_ads" && composite) {
    check(issues, label, () => parseGoogleAdExternalId(value));
  } else {
    checkNumericId(issues, value, label);
  }
}

function checkDate(issues: Issues, value: string | undefined, label: string) {
  if (value !== undefined && !isDateKey(value))
    issues.push(`${label}: "${value}" is not YYYY-MM-DD`);
}

function checkDateOrder(issues: Issues, start?: string, end?: string) {
  if (start && end && isDateKey(start) && isDateKey(end) && compareDateKeys(start, end) > 0) {
    issues.push("startDate: must not be after endDate");
  }
}

function checkCurrency(issues: Issues, value: string) {
  if (!isValidCurrency(value)) issues.push(`currency: "${value}" is not an ISO 4217 code`);
}

function checkNonNegativeMicros(issues: Issues, value: bigint | undefined, label: string) {
  if (value !== undefined && value < 0n) issues.push(`${label}: must not be negative`);
}

function checkCount(issues: Issues, value: unknown, label: string) {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
    issues.push(`${label}: must be a finite, non-negative number`);
  }
}

function checkExtras(issues: Issues, extras: Record<string, number> | undefined) {
  for (const [key, value] of Object.entries(extras ?? {})) {
    if (!Number.isFinite(value)) issues.push(`extras.${key}: must be finite`);
  }
}

const COUNT_METRICS = (Object.keys(AD_METRICS) as (keyof typeof AD_METRICS)[]).filter(
  (key) => AD_METRICS[key].kind !== "money",
);

function semanticIssues(kind: ProviderRecordKind, record: Record<string, unknown>): Issues {
  const issues: Issues = [];
  const platform = record.platform as AdPlatform;

  switch (kind) {
    case "adAccount": {
      const r = record as ProviderRecordByKind["adAccount"];
      checkAccountId(issues, platform, r.externalId, "externalId");
      checkCurrency(issues, r.currency);
      if (!isValidTimezone(r.timezone))
        issues.push(`timezone: "${r.timezone}" is not an IANA zone`);
      break;
    }
    case "campaign": {
      const r = record as ProviderRecordByKind["campaign"];
      checkAccountId(issues, platform, r.accountExternalId, "accountExternalId");
      checkNumericId(issues, r.externalId, "externalId");
      checkNonNegativeMicros(issues, r.budgetMicros, "budgetMicros");
      checkDate(issues, r.startDate, "startDate");
      checkDate(issues, r.endDate, "endDate");
      checkDateOrder(issues, r.startDate, r.endDate);
      break;
    }
    case "adGroup": {
      const r = record as ProviderRecordByKind["adGroup"];
      checkAccountId(issues, platform, r.accountExternalId, "accountExternalId");
      checkNumericId(issues, r.externalId, "externalId");
      checkNumericId(issues, r.campaignExternalId, "campaignExternalId");
      checkNonNegativeMicros(issues, r.budgetMicros, "budgetMicros");
      checkDate(issues, r.startDate, "startDate");
      checkDate(issues, r.endDate, "endDate");
      checkDateOrder(issues, r.startDate, r.endDate);
      break;
    }
    case "ad": {
      const r = record as ProviderRecordByKind["ad"];
      checkAccountId(issues, platform, r.accountExternalId, "accountExternalId");
      checkEntityId(issues, platform, r.externalId, "externalId", true);
      checkNumericId(issues, r.campaignExternalId, "campaignExternalId");
      checkNumericId(issues, r.adGroupExternalId, "adGroupExternalId");
      checkEntityId(issues, platform, r.creativeExternalId, "creativeExternalId", true);
      if (platform === "google_ads" && r.adGroupExternalId !== undefined) {
        check(issues, "externalId", () => {
          if (parseGoogleAdExternalId(r.externalId).adGroupId !== r.adGroupExternalId) {
            throw new Error("ad group prefix does not match adGroupExternalId");
          }
        });
      }
      break;
    }
    case "creative": {
      const r = record as ProviderRecordByKind["creative"];
      checkAccountId(issues, platform, r.accountExternalId, "accountExternalId");
      checkEntityId(issues, platform, r.externalId, "externalId", true);
      break;
    }
    case "metricRow":
    case "actionRow": {
      const r = record as ProviderRecordByKind["metricRow"] | ProviderRecordByKind["actionRow"];
      checkAccountId(issues, platform, r.accountExternalId, "accountExternalId");
      if (r.level === "account") {
        if (r.entityExternalId !== r.accountExternalId) {
          issues.push("entityExternalId: account-level rows must reference the account");
        }
      } else {
        checkEntityId(issues, platform, r.entityExternalId, "entityExternalId", r.level === "ad");
      }
      checkDate(issues, r.date, "date");
      checkCurrency(issues, r.currency);
      if (kind === "metricRow") {
        const m = r as ProviderRecordByKind["metricRow"];
        checkNonNegativeMicros(issues, m.spendMicros, "spendMicros");
        for (const key of COUNT_METRICS) checkCount(issues, m[key], key);
        checkExtras(issues, m.extras);
      } else {
        const a = r as ProviderRecordByKind["actionRow"];
        checkCount(issues, a.count, "count");
        if (!a.rawActionType.trim()) issues.push("rawActionType: must not be empty");
        if (!a.attributionWindow.trim()) issues.push("attributionWindow: must not be empty");
      }
      break;
    }
  }
  return issues;
}

/** All problems with a record (empty = valid). */
export function recordIssues(kind: ProviderRecordKind, record: unknown): string[] {
  try {
    validate(RECORD_VALIDATORS[kind], record, { throw: true });
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
  return semanticIssues(kind, record as Record<string, unknown>);
}

/** Provider-side guard: invalid records become non-retryable "data" errors. */
export function assertValidRecord<K extends ProviderRecordKind>(
  kind: K,
  record: unknown,
  platform: AdPlatform,
  operation: ProviderOperation,
): asserts record is ProviderRecordByKind[K] {
  const issues = recordIssues(kind, record);
  if (issues.length > 0) {
    throw new ProviderError({
      kind: "data",
      platform,
      operation,
      message: `Invalid ${kind} record: ${issues.join("; ")}`,
    });
  }
}
