import { defineTable } from "convex/server";
import { v } from "convex/values";
import { adMetricFields } from "../domain/metrics";
import {
  actionTypeValidator,
  adPlatformValidator,
  attributionBasisValidator,
  currencyValidator,
  dateKeyValidator,
  entityLevelValidator,
  microsValidator,
  placementValidator,
} from "../domain/validators";
import { orgIdField } from "./common";

/** The entity a metric row describes, matching `level`. */
const metricEntityId = v.union(
  v.id("adAccounts"),
  v.id("campaigns"),
  v.id("adGroups"),
  v.id("ads"),
);

/** Shared dimensions of every paid-metric row. */
const metricDimensions = {
  orgId: orgIdField,
  platform: adPlatformValidator,
  adAccountId: v.id("adAccounts"),
  level: entityLevelValidator,
  entityId: metricEntityId,
  /** Denormalized parents: set for the row's own level and below. */
  campaignId: v.optional(v.id("campaigns")),
  adGroupId: v.optional(v.id("adGroups")),
  adId: v.optional(v.id("ads")),
  /** Calendar day in the ad account's timezone. */
  date: dateKeyValidator,
  /** "all" = platform total without breakdown (its own row; never sum it with breakdown rows). */
  placement: placementValidator,
  rawPlacement: v.optional(v.string()),
  /** Copied from the ad account. */
  currency: currencyValidator,
};

// Rows are REPLACED on re-sync (never incremented). Upsert keys:
//   metricsDaily        (orgId, entityId, placement, date)
//   actionMetricsDaily  (orgId, entityId, placement, date, rawActionType, attributionWindow)

export const metricTables = {
  /** Wide table: one row per entity x day x placement with canonical metric columns. */
  metricsDaily: defineTable({
    ...metricDimensions,
    ...adMetricFields,
    syncedAt: v.number(),
  })
    .index("by_org_entity_placement_date", ["orgId", "entityId", "placement", "date"])
    .index("by_org_level_placement_date", ["orgId", "level", "placement", "date"])
    .index("by_org_campaign_level_placement_date", [
      "orgId",
      "campaignId",
      "level",
      "placement",
      "date",
    ])
    .index("by_org_account_level_placement_date", [
      "orgId",
      "adAccountId",
      "level",
      "placement",
      "date",
    ]),

  /** Long table: every conversion/action type and attribution window without schema churn. */
  actionMetricsDaily: defineTable({
    ...metricDimensions,
    actionType: actionTypeValidator,
    /**
     * Meta action_type (e.g. offsite_conversion.fb_pixel_purchase) / Google conversion action
     * resource name (customers/{id}/conversionActions/{id}: the stable identifier, not the
     * mutable display name).
     */
    rawActionType: v.string(),
    conversionActionExternalId: v.optional(v.string()),
    /** e.g. "7d_click_1d_view", "1d_click", "default". */
    attributionWindow: v.string(),
    attributionBasis: attributionBasisValidator,
    /** Fractional with data-driven attribution. */
    count: v.number(),
    valueMicros: v.optional(microsValidator),
    /** Counts toward the account's primary `conversions` (Google primary_for_goal / Meta mapping). */
    isPrimary: v.optional(v.boolean()),
    syncedAt: v.number(),
  })
    .index("by_org_entity_placement_date_action", [
      "orgId",
      "entityId",
      "placement",
      "date",
      "rawActionType",
      "attributionWindow",
    ])
    .index("by_org_account_date", ["orgId", "adAccountId", "date"])
    // Phase 6 analytics: one level's action rows of an account without scanning ad-level rows.
    .index("by_org_account_level_date", ["orgId", "adAccountId", "level", "date"]),
};
