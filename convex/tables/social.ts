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
// Instagram direct messages hang off socialAccounts through instagramMessagingAccounts
// (tables/instagramMessaging.ts, ADR 0017).

/**
 * ADR 0016 Checkpoint 8: the two YouTube per-video analytics windows (Pacific Time days, both
 * ending at today minus the reporting delay): the last 28 days and the channel's lifetime.
 */
export const videoAnalyticsWindowValidator = v.union(v.literal("last28"), v.literal("lifetime"));

const optionalNumber = v.optional(v.number());

export const socialTables = {
  socialAccounts: defineTable({
    orgId: orgIdField,
    platform: socialPlatformValidator,
    /** Instagram user id / Facebook page id. */
    externalId: v.string(),
    username: v.optional(v.string()),
    name: v.string(),
    accountType: socialAccountTypeValidator,
    /**
     * Instagram -> linked Facebook page. Never written: Instagram Login, including its direct
     * messages, needs no page.
     */
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
    .index("by_org_connection", ["orgId", "connectionId"])
    // GLOBAL (approved exception, ADR 0016): the YouTube retention jobs find, across orgs,
    // channels marked for purge (status "disconnected") and channels whose authorization was
    // last confirmed (lastSeenAt) more than 25 days ago. Every row read through it is
    // re-verified (platform, org) before anything is deleted.
    .index("by_platform_status_seen", ["platform", "status", "lastSeenAt"]),

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
    .index("by_org_platform_external", ["orgId", "platform", "externalId"])
    // GLOBAL (approved exception, ADR 0016): the YouTube retention job finds, across orgs,
    // videos no listing has refreshed (lastSeenAt) for 25 days. Every row read through it is
    // re-verified (platform, org, owning channel) before it and its snapshots are deleted.
    .index("by_platform_seen", ["platform", "lastSeenAt"]),

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

  /**
   * Daily account values on UTC days (Phase 10, I-D11; the day boundary is unverified, IR6).
   * Two column groups with independent writers (convex/sync/upsert.ts), each replacing only
   * its own columns: profile (followers, followersCapturedAt) from the sync preflight, and
   * insights (every other metric, extras, insightsSyncedAt) from account insights.
   */
  socialAccountMetricsDaily: defineTable({
    orgId: orgIdField,
    socialAccountId: v.id("socialAccounts"),
    platform: socialPlatformValidator,
    date: dateKeyValidator,
    ...socialAccountMetricFields,
    /** Last write of either column group. */
    syncedAt: v.number(),
    /** Phase 10 (F7): last follower capture for this day (profile group). */
    followersCapturedAt: v.optional(v.number()),
    /**
     * Phase 10 (F7): last insights write for this day (insights group), also when the
     * platform reported nothing: set = synced (absent metrics are "not reported"),
     * absent = never synced.
     */
    insightsSyncedAt: v.optional(v.number()),
  }).index("by_org_account_date", ["orgId", "socialAccountId", "date"]),

  /**
   * ADR 0016 Checkpoint 8: YouTube per-video analytics, one row per (video, window), values
   * exactly as YouTube's per-video report returned them (each under its own YouTube name; a
   * value YouTube left out stays absent). Written ONLY by convex/sync/upsert.ts: a sync replaces
   * every row of an (account, window) pair, so a video that fell out of YouTube's top 200 loses
   * its row (it is "not in the top 200", never 0). Deleted with its video (retention) and with
   * the channel (disconnect purge).
   */
  youtubeVideoAnalytics: defineTable({
    orgId: orgIdField,
    socialAccountId: v.id("socialAccounts"),
    postId: v.id("socialPosts"),
    window: videoAnalyticsWindowValidator,
    /** Inclusive Pacific Time days the report covered. */
    from: dateKeyValidator,
    to: dateKeyValidator,
    views: optionalNumber,
    estimatedMinutesWatched: optionalNumber,
    /** YouTube's own value for this video and window (seconds); never recomputed. */
    averageViewDuration: optionalNumber,
    /** YouTube's own value for this video and window (percent, a decimal); never aggregated. */
    averageViewPercentage: optionalNumber,
    likes: optionalNumber,
    comments: optionalNumber,
    shares: optionalNumber,
    subscribersGained: optionalNumber,
    subscribersLost: optionalNumber,
    /** When the window report this row came from was committed. */
    syncedAt: v.number(),
  })
    .index("by_org_post_window", ["orgId", "postId", "window"])
    .index("by_org_account_window", ["orgId", "socialAccountId", "window"]),
};
