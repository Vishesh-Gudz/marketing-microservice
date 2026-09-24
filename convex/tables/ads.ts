import { defineTable } from "convex/server";
import { v } from "convex/values";
import {
  adAccountStatusValidator,
  adGroupKindValidator,
  adPlatformValidator,
  attributesValidator,
  budgetLevelValidator,
  budgetTypeValidator,
  channelTypeValidator,
  creativeFormatValidator,
  currencyValidator,
  dateKeyValidator,
  deliveryStatusValidator,
  entityStatusValidator,
  microsValidator,
  objectiveValidator,
} from "../domain/validators";
import { entityLifecycleFields, orgIdField } from "./common";

// Paid advertising hierarchy: adAccounts > campaigns > adGroups > ads (+ creatives).
// Natural keys: see convex/domain/identity.ts. Money = int64 micros of the account currency.
// Dates (startDate/endDate) are DateKeys in the ad account's timezone.

export const adTables = {
  adAccounts: defineTable({
    orgId: orgIdField,
    platform: adPlatformValidator,
    /** Meta: numeric id without "act_". Google: 10-digit customer id without dashes. */
    externalId: v.string(),
    name: v.string(),
    /** ISO 4217; immutable per account on both platforms. */
    currency: currencyValidator,
    /** IANA time zone; defines the calendar day of every metric row of this account. */
    timezone: v.string(),
    status: adAccountStatusValidator,
    rawStatus: v.optional(v.string()),
    /** Google manager (MCC) accounts have no metrics of their own. */
    isManager: v.boolean(),
    /** Google manager customer id / Meta business id. */
    parentExternalId: v.optional(v.string()),
    attributes: v.optional(attributesValidator),
    ...entityLifecycleFields,
  }).index("by_org_platform_external", ["orgId", "platform", "externalId"]),

  campaigns: defineTable({
    orgId: orgIdField,
    adAccountId: v.id("adAccounts"),
    platform: adPlatformValidator,
    externalId: v.string(),
    name: v.string(),
    status: entityStatusValidator,
    rawStatus: v.optional(v.string()),
    deliveryStatus: v.optional(deliveryStatusValidator),
    objective: objectiveValidator,
    rawObjective: v.optional(v.string()),
    channelType: v.optional(channelTypeValidator),
    budgetType: budgetTypeValidator,
    budgetMicros: v.optional(microsValidator),
    /** "campaign" = Meta CBO / Google campaign budget; "ad_group" = Meta ABO. */
    budgetLevel: budgetLevelValidator,
    isSharedBudget: v.optional(v.boolean()),
    bidStrategy: v.optional(v.string()),
    startDate: v.optional(dateKeyValidator),
    endDate: v.optional(dateKeyValidator),
    platformCreatedAt: v.optional(v.number()),
    platformUpdatedAt: v.optional(v.number()),
    attributes: v.optional(attributesValidator),
    ...entityLifecycleFields,
  })
    .index("by_org_account_external", ["orgId", "adAccountId", "externalId"])
    .index("by_org_status", ["orgId", "status"]),

  /** Meta ad sets, Google ad groups, Google Performance Max asset groups. */
  adGroups: defineTable({
    orgId: orgIdField,
    adAccountId: v.id("adAccounts"),
    campaignId: v.id("campaigns"),
    platform: adPlatformValidator,
    externalId: v.string(),
    name: v.string(),
    kind: adGroupKindValidator,
    status: entityStatusValidator,
    rawStatus: v.optional(v.string()),
    deliveryStatus: v.optional(deliveryStatusValidator),
    budgetType: v.optional(budgetTypeValidator),
    budgetMicros: v.optional(microsValidator),
    optimizationGoal: v.optional(v.string()),
    /** Normalized window label, e.g. "7d_click_1d_view". */
    attributionSetting: v.optional(v.string()),
    startDate: v.optional(dateKeyValidator),
    endDate: v.optional(dateKeyValidator),
    attributes: v.optional(attributesValidator),
    ...entityLifecycleFields,
  })
    .index("by_org_account_external", ["orgId", "adAccountId", "externalId"])
    .index("by_org_campaign", ["orgId", "campaignId"]),

  ads: defineTable({
    orgId: orgIdField,
    adAccountId: v.id("adAccounts"),
    campaignId: v.id("campaigns"),
    /** Absent only where the platform has no ad-group level for the ad. */
    adGroupId: v.optional(v.id("adGroups")),
    platform: adPlatformValidator,
    /** Google: "{adGroupId}~{adId}" (ad ids are unique only within an ad group). */
    externalId: v.string(),
    name: v.string(),
    status: entityStatusValidator,
    rawStatus: v.optional(v.string()),
    deliveryStatus: v.optional(deliveryStatusValidator),
    creativeId: v.optional(v.id("creatives")),
    format: v.optional(creativeFormatValidator),
    attributes: v.optional(attributesValidator),
    ...entityLifecycleFields,
  })
    .index("by_org_account_external", ["orgId", "adAccountId", "externalId"])
    .index("by_org_adGroup", ["orgId", "adGroupId"])
    .index("by_org_campaign", ["orgId", "campaignId"]),

  /** Meta: reusable creative objects. Google: one per ad (externalId = ad externalId). */
  creatives: defineTable({
    orgId: orgIdField,
    adAccountId: v.id("adAccounts"),
    platform: adPlatformValidator,
    externalId: v.string(),
    format: creativeFormatValidator,
    title: v.optional(v.string()),
    body: v.optional(v.string()),
    headlines: v.optional(v.array(v.string())),
    descriptions: v.optional(v.array(v.string())),
    callToAction: v.optional(v.string()),
    linkUrl: v.optional(v.string()),
    /** Meta URLs are signed and expire; refreshed by sync. */
    thumbnailUrl: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    videoExternalId: v.optional(v.string()),
    /** Meta effective_instagram_media_id: soft link to socialPosts.externalId. */
    instagramMediaExternalId: v.optional(v.string()),
    /** Meta effective_object_story_id. */
    facebookPostExternalId: v.optional(v.string()),
    attributes: v.optional(attributesValidator),
    lastSeenAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    .index("by_org_account_external", ["orgId", "adAccountId", "externalId"])
    .index("by_org_igMedia", ["orgId", "instagramMediaExternalId"]),
};
