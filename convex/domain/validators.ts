import { v, type Validator } from "convex/values";
import {
  ACTION_TYPES,
  AD_ACCOUNT_STATUSES,
  AD_GROUP_KINDS,
  AD_PLATFORMS,
  ATTRIBUTION_BASES,
  BUDGET_LEVELS,
  BUDGET_TYPES,
  CHANNEL_TYPES,
  CREATIVE_FORMATS,
  DELIVERY_STATUSES,
  ENTITY_LEVELS,
  ENTITY_STATUSES,
  OBJECTIVES,
  PLACEMENTS,
  SOCIAL_ACCOUNT_STATUSES,
  SOCIAL_ACCOUNT_TYPES,
  SOCIAL_PLATFORMS,
  SOCIAL_POST_TYPES,
} from "./types";

/**
 * Builds `v.union(v.literal(a), v.literal(b), ...)` from a const array so the
 * TypeScript type and the Convex validator can never drift apart.
 */
export function literalUnion<const T extends readonly [string, ...string[]]>(
  values: T,
): Validator<T[number], "required", never> {
  return v.union(...values.map((value) => v.literal(value))) as unknown as Validator<
    T[number],
    "required",
    never
  >;
}

export const adPlatformValidator = literalUnion(AD_PLATFORMS);
export const socialPlatformValidator = literalUnion(SOCIAL_PLATFORMS);
export const entityLevelValidator = literalUnion(ENTITY_LEVELS);
export const placementValidator = literalUnion(PLACEMENTS);
export const adAccountStatusValidator = literalUnion(AD_ACCOUNT_STATUSES);
export const entityStatusValidator = literalUnion(ENTITY_STATUSES);
export const deliveryStatusValidator = literalUnion(DELIVERY_STATUSES);
export const objectiveValidator = literalUnion(OBJECTIVES);
export const channelTypeValidator = literalUnion(CHANNEL_TYPES);
export const budgetTypeValidator = literalUnion(BUDGET_TYPES);
export const budgetLevelValidator = literalUnion(BUDGET_LEVELS);
export const adGroupKindValidator = literalUnion(AD_GROUP_KINDS);
export const creativeFormatValidator = literalUnion(CREATIVE_FORMATS);
export const actionTypeValidator = literalUnion(ACTION_TYPES);
export const attributionBasisValidator = literalUnion(ATTRIBUTION_BASES);
export const socialAccountTypeValidator = literalUnion(SOCIAL_ACCOUNT_TYPES);
export const socialAccountStatusValidator = literalUnion(SOCIAL_ACCOUNT_STATUSES);
export const socialPostTypeValidator = literalUnion(SOCIAL_POST_TYPES);

/** "YYYY-MM-DD". Convex validators cannot check formats; write paths use lib/dates. */
export const dateKeyValidator = v.string();

/** Integer micros of the row's currency (1 unit = 1_000_000 micros). */
export const microsValidator = v.int64();

/** ISO 4217 code of the owning account. */
export const currencyValidator = v.string();

/** Small string map for unmapped platform attributes (capped by write helpers). */
export const attributesValidator = v.record(v.string(), v.string());

/** Small numeric map for unmapped platform metrics (capped by write helpers). */
export const extrasValidator = v.record(v.string(), v.number());
