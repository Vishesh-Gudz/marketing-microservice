import { validate } from "convex-helpers/validators";
import { v, type PropertyValidators } from "convex/values";
import type { SocialPlatform } from "../../domain/types";
import { isDateKey, toDateKey } from "../../lib/dates";
import { connectionTables } from "../../tables/connections";
import { socialTables } from "../../tables/social";
import { ProviderError } from "../errors";
import type { ProviderOperation } from "../types";
import { allowedPermalink, CAPTION_MAX_CHARS } from "../instagram/semantics";
import {
  SOCIAL_RECORD_DROPPED_FIELDS,
  type SocialRecordByKind,
  type SocialRecordKind,
} from "./types";

/**
 * Boundary validation for social provider records (Phase 10), mirroring
 * convex/providers/validate.ts: structure is checked against the REAL table validators
 * (minus tenant, lifecycle and internal-id fields, plus external-id references), so a
 * record can never drift from the schema or smuggle in an orgId or Convex id.
 * Failure messages are generic: record values never reach an error.
 */

const DROPPED = new Set(["orgId", "createdAt", "updatedAt", "lastSeenAt", "removedAt"]);

function recordValidator(
  fields: PropertyValidators,
  drop: readonly string[],
  extra: PropertyValidators,
) {
  const kept = Object.fromEntries(
    Object.entries(fields).filter(([name]) => !DROPPED.has(name) && !drop.includes(name)),
  );
  return v.object({ ...kept, ...extra });
}

const externalRef = v.string();

export const SOCIAL_RECORD_VALIDATORS = {
  discoveredSocialAccount: recordValidator(
    connectionTables.discoveredSocialAccounts.validator.fields,
    SOCIAL_RECORD_DROPPED_FIELDS.discoveredSocialAccount,
    {},
  ),
  socialAccount: recordValidator(
    socialTables.socialAccounts.validator.fields,
    SOCIAL_RECORD_DROPPED_FIELDS.socialAccount,
    {},
  ),
  socialPost: recordValidator(
    socialTables.socialPosts.validator.fields,
    SOCIAL_RECORD_DROPPED_FIELDS.socialPost,
    { accountExternalId: externalRef },
  ),
  socialPostSnapshot: recordValidator(
    socialTables.socialPostMetricSnapshots.validator.fields,
    SOCIAL_RECORD_DROPPED_FIELDS.socialPostSnapshot,
    { accountExternalId: externalRef, postExternalId: externalRef },
  ),
  socialAccountDay: recordValidator(
    socialTables.socialAccountMetricsDaily.validator.fields,
    SOCIAL_RECORD_DROPPED_FIELDS.socialAccountDay,
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
    case "socialPost": {
      issues.push(...idIssue(platform, record.externalId as string, "externalId"));
      issues.push(...idIssue(platform, record.accountExternalId as string, "accountExternalId"));
      // F1 / R1b: the permalink is the only URL a record may carry, and only an allowed
      // (normalized) Instagram permalink; no other platform has a permalink rule yet.
      const permalink = record.permalink as string | undefined;
      if (
        permalink !== undefined &&
        (platform !== "instagram" || allowedPermalink(permalink) !== permalink)
      ) {
        issues.push("permalink: not an allowed permalink");
      }
      if (!isInstant(record.publishedAt)) issues.push("publishedAt: not an instant");
      // F21: captions are capped at 2,200 characters (code points) before they get here.
      const caption = record.caption as string | undefined;
      if (caption !== undefined && Array.from(caption).length > CAPTION_MAX_CHARS) {
        issues.push("caption: too long");
      }
      break;
    }
    case "socialPostSnapshot":
      issues.push(...idIssue(platform, record.postExternalId as string, "postExternalId"));
      issues.push(...idIssue(platform, record.accountExternalId as string, "accountExternalId"));
      if (!isDateKey(record.capturedDate as string)) issues.push("capturedDate: not a day");
      if (!isInstant(record.capturedAt)) issues.push("capturedAt: not an instant");
      else if (toDateKey(record.capturedAt as number, "UTC") !== record.capturedDate) {
        issues.push("capturedDate: not the UTC day of capturedAt");
      }
      issues.push(...countIssues(record, SNAPSHOT_COUNTS));
      break;
    case "socialAccountDay":
      issues.push(...idIssue(platform, record.accountExternalId as string, "accountExternalId"));
      if (!isDateKey(record.date as string)) issues.push("date: not a day");
      // followerDelta is a signed net change; every other value is a count.
      issues.push(...countIssues(record, DAY_COUNTS));
      if (record.followerDelta !== undefined && !Number.isSafeInteger(record.followerDelta)) {
        issues.push("followerDelta: not an integer");
      }
      break;
  }
  return issues;
}

function isInstant(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const SNAPSHOT_COUNTS = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saves",
  "totalInteractions",
] as const;
const DAY_COUNTS = ["reach", "views", "accountsEngaged", "totalInteractions"] as const;

/** Metric values are non-negative integers (extras too); absent stays absent. */
function countIssues(record: Record<string, unknown>, fields: readonly string[]): string[] {
  const issues: string[] = [];
  const isCount = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  for (const field of fields) {
    if (record[field] !== undefined && !isCount(record[field])) {
      issues.push(`${field}: not a count`);
    }
  }
  const extras = record.extras as Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(extras ?? {})) {
    if (!isCount(value)) issues.push(`extras.${key}: not a count`);
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
