import { v, type Infer } from "convex/values";
import {
  adPlatformValidator,
  entityLevelValidator,
  socialPlatformValidator,
} from "../domain/validators";
import { SOCIAL_RECORD_VALIDATORS } from "../providers/social/validate";
import { RECORD_VALIDATORS } from "../providers/validate";
import { syncOperationValidator } from "../tables/sync";

/**
 * Validators for the worker <-> run-state boundary. Provider records cross it
 * as mutation arguments validated against the REAL table validators
 * (RECORD_VALIDATORS): unknown fields such as orgId or Convex ids are rejected.
 * No credential ever crosses it.
 */

export const breakdownValidator = v.union(v.literal("none"), v.literal("placement"));

/** What the worker asks the provider for (external ids and window only). */
export const fetchRequestValidator = v.object({
  operation: syncOperationValidator,
  accountExternalId: v.string(),
  level: v.optional(entityLevelValidator),
  from: v.optional(v.string()),
  to: v.optional(v.string()),
  breakdown: v.optional(breakdownValidator),
  updatedSince: v.optional(v.number()),
  cursor: v.optional(v.string()),
});
export type FetchRequest = Infer<typeof fetchRequestValidator>;

export const claimResultValidator = v.union(
  v.object({ status: v.literal("skip") }),
  v.object({
    status: v.literal("fetch"),
    claimSeq: v.number(),
    orgId: v.string(),
    connectionId: v.id("connections"),
    platform: v.union(adPlatformValidator, socialPlatformValidator),
    /** Phase 10: present (and "social") only on claims of organic social subjects. */
    subject: v.optional(v.literal("social")),
    attempt: v.number(),
    request: fetchRequestValidator,
  }),
);
export type ClaimResult = Infer<typeof claimResultValidator>;

const nextCursor = v.optional(v.string());

/** One provider page, tagged by record kind. */
export const providerPageValidator = v.union(
  v.object({
    kind: v.literal("adAccount"),
    items: v.array(RECORD_VALIDATORS.adAccount),
    nextCursor,
  }),
  v.object({
    kind: v.literal("campaign"),
    items: v.array(RECORD_VALIDATORS.campaign),
    nextCursor,
  }),
  v.object({
    kind: v.literal("adGroup"),
    items: v.array(RECORD_VALIDATORS.adGroup),
    nextCursor,
  }),
  v.object({
    kind: v.literal("creative"),
    items: v.array(RECORD_VALIDATORS.creative),
    nextCursor,
  }),
  v.object({ kind: v.literal("ad"), items: v.array(RECORD_VALIDATORS.ad), nextCursor }),
  v.object({
    kind: v.literal("metricRow"),
    items: v.array(RECORD_VALIDATORS.metricRow),
    nextCursor,
  }),
  v.object({
    kind: v.literal("actionRow"),
    items: v.array(RECORD_VALIDATORS.actionRow),
    nextCursor,
  }),
);
export type ProviderPageArg = Infer<typeof providerPageValidator>;

/**
 * Phase 10 Stage B: one organic social provider page (commitSocialPage), validated against
 * the social record validators (no URL other than the permalink, no provenance fields).
 * `unresolved` counts platform items the provider could not map (never excluded items).
 */
const unresolved = v.optional(v.number());
export const socialPageValidator = v.union(
  v.object({
    kind: v.literal("socialAccount"),
    items: v.array(SOCIAL_RECORD_VALIDATORS.socialAccount),
    nextCursor,
  }),
  v.object({
    kind: v.literal("socialPost"),
    items: v.array(SOCIAL_RECORD_VALIDATORS.socialPost),
    nextCursor,
    unresolved,
  }),
  v.object({
    kind: v.literal("socialPostSnapshot"),
    items: v.array(SOCIAL_RECORD_VALIDATORS.socialPostSnapshot),
    nextCursor,
    unresolved,
  }),
  v.object({
    kind: v.literal("socialAccountDay"),
    items: v.array(SOCIAL_RECORD_VALIDATORS.socialAccountDay),
    nextCursor,
  }),
);
export type SocialPageArg = Infer<typeof socialPageValidator>;

/** Serialized SyncFailure (policy.ts); unknown shapes are treated as internal. */
export const failureValidator = v.object({
  source: v.union(
    v.literal("provider"),
    v.literal("credential"),
    v.literal("guard"),
    v.literal("account"),
    v.literal("internal"),
  ),
  kind: v.string(),
  retryAfterMs: v.optional(v.number()),
  code: v.optional(v.string()),
});
export type FailureArg = Infer<typeof failureValidator>;

export const commitResultValidator = v.object({
  ok: v.boolean(),
  reason: v.optional(v.string()),
});
