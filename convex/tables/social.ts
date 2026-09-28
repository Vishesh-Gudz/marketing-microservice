import { defineTable } from "convex/server";
import { v } from "convex/values";
import { socialAccountMetricFields, socialPostMetricFields } from "../domain/metrics";
import {
  attributesValidator,
  dateKeyValidator,
  socialAccountStatusValidator,
  socialAccountTypeValidator,
  socialPlatformValidator,
  socialPostTypeValidator,
} from "../domain/validators";
import { entityLifecycleFields, orgIdField } from "./common";

// Organic social tree, deliberately separate from paid ads. The only link to
// ads is the soft reference creatives.instagramMediaExternalId -> socialPosts.externalId.
// socialAccounts is also the owner of future messaging threads (Phase 11).

export const socialTables = {
  socialAccounts: defineTable({
    orgId: orgIdField,
    platform: socialPlatformValidator,
    /** Instagram user id / Facebook page id. */
    externalId: v.string(),
    username: v.optional(v.string()),
    name: v.string(),
    accountType: socialAccountTypeValidator,
    /** Instagram -> linked Facebook page (required later for Instagram DMs). */
    linkedPageExternalId: v.optional(v.string()),
    profilePictureUrl: v.optional(v.string()),
    /** Latest known value; history lives in socialAccountMetricsDaily. */
    followersCount: v.optional(v.number()),
    status: socialAccountStatusValidator,
    attributes: v.optional(attributesValidator),
    /**
     * Phase 10: the connection whose credential syncs this account (absent = not linked;
     * rows and their data are kept on unlink), mirroring adAccounts.connectionId.
     */
    connectionId: v.optional(v.id("connections")),
    linkedAt: v.optional(v.number()),
    ...entityLifecycleFields,
  })
    .index("by_org_platform_external", ["orgId", "platform", "externalId"])
    .index("by_org_connection", ["orgId", "connectionId"]),

  socialPosts: defineTable({
    orgId: orgIdField,
    socialAccountId: v.id("socialAccounts"),
    platform: socialPlatformValidator,
    externalId: v.string(),
    type: socialPostTypeValidator,
    caption: v.optional(v.string()),
    permalink: v.optional(v.string()),
    mediaUrl: v.optional(v.string()),
    thumbnailUrl: v.optional(v.string()),
    /** Instant (epoch ms); day grouping uses the org timezone at read time. */
    publishedAt: v.number(),
    commentsEnabled: v.optional(v.boolean()),
    ...entityLifecycleFields,
  })
    .index("by_org_account_external", ["orgId", "socialAccountId", "externalId"])
    .index("by_org_account_published", ["orgId", "socialAccountId", "publishedAt"])
    .index("by_org_platform_external", ["orgId", "platform", "externalId"]),

  /** Cumulative lifetime values per post, one row per capture day (UTC). */
  socialPostMetricSnapshots: defineTable({
    orgId: orgIdField,
    socialAccountId: v.id("socialAccounts"),
    postId: v.id("socialPosts"),
    platform: socialPlatformValidator,
    capturedDate: dateKeyValidator,
    capturedAt: v.number(),
    ...socialPostMetricFields,
  }).index("by_org_post_date", ["orgId", "postId", "capturedDate"]),

  /** Daily account values; day = platform reporting day (unverified until Phase 10). */
  socialAccountMetricsDaily: defineTable({
    orgId: orgIdField,
    socialAccountId: v.id("socialAccounts"),
    platform: socialPlatformValidator,
    date: dateKeyValidator,
    ...socialAccountMetricFields,
    syncedAt: v.number(),
  }).index("by_org_account_date", ["orgId", "socialAccountId", "date"]),
};
