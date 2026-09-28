import { validate } from "convex-helpers/validators";
import { v, type PropertyValidators } from "convex/values";
import type { SocialPlatform } from "../../domain/types";
import { isDateKey } from "../../lib/dates";
import { connectionTables } from "../../tables/connections";
import { socialTables } from "../../tables/social";
import { ProviderError } from "../errors";
import type { ProviderOperation } from "../types";
import type { SocialRecordByKind, SocialRecordKind } from "./types";

/**
 * Boundary validation for social provider records (Phase 10), mirroring
 * convex/providers/validate.ts: structure is checked against the REAL table validators
 * (minus tenant, lifecycle and internal-id fields, plus external-id references), so a
 * record can never drift from the schema or smuggle in an orgId or Convex id.
 * Failure messages are generic: record values never reach an error.
 */

const DROPPED = new Set(["orgId", "createdAt", "updatedAt", "lastSeenAt", "removedAt"]);

function recordValidator(fields: PropertyValidators, drop: string[], extra: PropertyValidators) {
  const kept = Object.fromEntries(
    Object.entries(fields).filter(([name]) => !DROPPED.has(name) && !drop.includes(name)),
  );
  return v.object({ ...kept, ...extra });
}

const externalRef = v.string();

export const SOCIAL_RECORD_VALIDATORS = {
  discoveredSocialAccount: recordValidator(
    connectionTables.discoveredSocialAccounts.validator.fields,
    ["connectionId", "discoveredAt"],
    {},
  ),
  socialAccount: recordValidator(
    socialTables.socialAccounts.validator.fields,
    ["connectionId", "linkedAt"],
    {},
  ),
  socialPost: recordValidator(socialTables.socialPosts.validator.fields, ["socialAccountId"], {
    accountExternalId: externalRef,
  }),
  socialPostSnapshot: recordValidator(
    socialTables.socialPostMetricSnapshots.validator.fields,
    ["socialAccountId", "postId"],
    { accountExternalId: externalRef, postExternalId: externalRef },
  ),
  socialAccountDay: recordValidator(
    socialTables.socialAccountMetricsDaily.validator.fields,
    ["socialAccountId", "syncedAt"],
    { accountExternalId: externalRef },
  ),
} satisfies Record<SocialRecordKind, unknown>;

/** Instagram ids (professional account, media): decimal, bounded. */
const NUMERIC_ID = /^\d{1,32}$/;
/** Instagram usernames: letters, digits, periods and underscores, at most 30 characters. */
const INSTAGRAM_USERNAME = /^[A-Za-z0-9._]{1,30}$/;

function idIssue(platform: SocialPlatform, value: string | undefined, label: string) {
  if (value === undefined) return [];
  return platform === "instagram" && !NUMERIC_ID.test(value) ? [`${label}: not an id`] : [];
}

function semanticIssues(kind: SocialRecordKind, record: Record<string, unknown>): string[] {
  const platform = record.platform as SocialPlatform;
  const issues: string[] = [];
  switch (kind) {
    case "discoveredSocialAccount":
    case "socialAccount": {
      issues.push(...idIssue(platform, record.externalId as string, "externalId"));
      const username = record.username as string | undefined;
      if (
        username !== undefined &&
        platform === "instagram" &&
        !INSTAGRAM_USERNAME.test(username)
      ) {
        issues.push("username: not a username");
      }
      if (kind === "socialAccount" && !(record.name as string).trim()) {
        issues.push("name: must not be empty");
      }
      break;
    }
    case "socialPost":
      issues.push(...idIssue(platform, record.externalId as string, "externalId"));
      issues.push(...idIssue(platform, record.accountExternalId as string, "accountExternalId"));
      break;
    case "socialPostSnapshot":
      issues.push(...idIssue(platform, record.postExternalId as string, "postExternalId"));
      issues.push(...idIssue(platform, record.accountExternalId as string, "accountExternalId"));
      if (!isDateKey(record.capturedDate as string)) issues.push("capturedDate: not a day");
      break;
    case "socialAccountDay":
      issues.push(...idIssue(platform, record.accountExternalId as string, "accountExternalId"));
      if (!isDateKey(record.date as string)) issues.push("date: not a day");
      break;
  }
  return issues;
}

/** All problems with a record (empty = valid). Structure first, then semantics. */
export function socialRecordIssues(kind: SocialRecordKind, record: unknown): string[] {
  try {
    validate(SOCIAL_RECORD_VALIDATORS[kind], record, { throw: true });
  } catch {
    return ["structure: does not match the table validator"];
  }
  return semanticIssues(kind, record as Record<string, unknown>);
}

/** Provider-side guard: invalid records become non-retryable "data" errors (generic message). */
export function assertValidSocialRecord<K extends SocialRecordKind>(
  kind: K,
  record: unknown,
  platform: SocialPlatform,
  operation: ProviderOperation,
): asserts record is SocialRecordByKind[K] {
  if (socialRecordIssues(kind, record).length > 0) {
    throw new ProviderError({
      kind: "data",
      platform,
      operation,
      message: `Invalid ${kind} record`,
      providerCode: "invalid_record",
    });
  }
}
