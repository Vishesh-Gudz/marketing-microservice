/**
 * Canonical, platform-independent vocabulary. Every provider (Phase 3+)
 * normalizes into these values; raw platform values are kept alongside in
 * `raw*` fields. Arrays are the single source of truth for both TypeScript
 * types and Convex validators (see ./validators.ts).
 */

// ---------------------------------------------------------------------------
// Platforms
// ---------------------------------------------------------------------------

/** Paid advertising platforms. Instagram ads are Meta ads (placement "instagram"). */
export const AD_PLATFORMS = ["meta", "google_ads"] as const;
export type AdPlatform = (typeof AD_PLATFORMS)[number];

/** Organic social platforms (separate data tree from paid ads). */
export const SOCIAL_PLATFORMS = ["instagram", "facebook"] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

/**
 * What an org can connect (Phase 4 connections). The ad platforms plus Instagram Login
 * (Phase 10: organic Instagram only, never Instagram ads, which stay Meta ads).
 */
export const CONNECTION_PROVIDERS = ["meta", "google_ads", "instagram"] as const;
export type ConnectionProvider = (typeof CONNECTION_PROVIDERS)[number];

/**
 * Connection providers that grant access to organic social accounts (not ad accounts).
 * Each value is also the SocialPlatform of the accounts it discovers.
 */
export const SOCIAL_CONNECTION_PROVIDERS = ["instagram"] as const satisfies readonly Extract<
  ConnectionProvider,
  SocialPlatform
>[];
export type SocialConnectionProvider = (typeof SOCIAL_CONNECTION_PROVIDERS)[number];

export function isAdPlatform(value: string): value is AdPlatform {
  return (AD_PLATFORMS as readonly string[]).includes(value);
}

export function isSocialConnectionProvider(value: string): value is SocialConnectionProvider {
  return (SOCIAL_CONNECTION_PROVIDERS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Paid advertising
// ---------------------------------------------------------------------------

/** Hierarchy level a metric row describes. */
export const ENTITY_LEVELS = ["account", "campaign", "ad_group", "ad"] as const;
export type EntityLevel = (typeof ENTITY_LEVELS)[number];

/**
 * Where an ad was shown. "all" is the platform-reported total without
 * breakdown and is stored as its own row (reach is not additive).
 * Meta: publisher_platform. Google: ad_network_type.
 */
export const PLACEMENTS = [
  "all",
  "facebook",
  "instagram",
  "audience_network",
  "messenger",
  "threads",
  "google_search",
  "search_partners",
  "google_display",
  "youtube",
  "discover",
  "gmail",
  "cross_network",
  "other",
] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const AD_ACCOUNT_STATUSES = ["active", "disabled", "closed", "pending", "unknown"] as const;
export type AdAccountStatus = (typeof AD_ACCOUNT_STATUSES)[number];

/** Configured status of a campaign / ad group / ad. */
export const ENTITY_STATUSES = [
  "active",
  "paused",
  "removed",
  "archived",
  "pending",
  "unknown",
] as const;
export type EntityStatus = (typeof ENTITY_STATUSES)[number];

/** Effective delivery (Meta effective_status, Google serving_status). */
export const DELIVERY_STATUSES = [
  "delivering",
  "not_delivering",
  "limited",
  "scheduled",
  "ended",
  "unknown",
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export const OBJECTIVES = [
  "awareness",
  "traffic",
  "engagement",
  "leads",
  "app_promotion",
  "sales",
  "video_views",
  "local",
  "other",
  "unknown",
] as const;
export type Objective = (typeof OBJECTIVES)[number];

/** Campaign channel (Google advertising_channel_type; Meta campaigns are "social"). */
export const CHANNEL_TYPES = [
  "search",
  "display",
  "video",
  "shopping",
  "performance_max",
  "demand_gen",
  "app",
  "social",
  "other",
] as const;
export type ChannelType = (typeof CHANNEL_TYPES)[number];

export const BUDGET_TYPES = ["daily", "lifetime", "none"] as const;
export type BudgetType = (typeof BUDGET_TYPES)[number];

/** Meta CBO (campaign) vs ABO (ad set). */
export const BUDGET_LEVELS = ["campaign", "ad_group"] as const;
export type BudgetLevel = (typeof BUDGET_LEVELS)[number];

/** Meta ad set, Google ad group, Google Performance Max asset group. */
export const AD_GROUP_KINDS = ["ad_set", "ad_group", "asset_group"] as const;
export type AdGroupKind = (typeof AD_GROUP_KINDS)[number];

export const CREATIVE_FORMATS = [
  "image",
  "video",
  "carousel",
  "text",
  "responsive_search",
  "responsive_display",
  "collection",
  "dynamic",
  "other",
] as const;
export type CreativeFormat = (typeof CREATIVE_FORMATS)[number];

/** Normalized conversion/action category; raw platform type is kept separately. */
export const ACTION_TYPES = [
  "purchase",
  "lead",
  "add_to_cart",
  "initiate_checkout",
  "complete_registration",
  "app_install",
  "subscribe",
  "contact",
  "page_view",
  "view_content",
  "custom",
  "other",
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** Which date conversions are attributed to. Platform defaults: impression/click date. */
export const ATTRIBUTION_BASES = ["impression_or_click_date", "conversion_date"] as const;
export type AttributionBasis = (typeof ATTRIBUTION_BASES)[number];

// ---------------------------------------------------------------------------
// Organic social
// ---------------------------------------------------------------------------

export const SOCIAL_ACCOUNT_TYPES = ["business", "creator", "page"] as const;
export type SocialAccountType = (typeof SOCIAL_ACCOUNT_TYPES)[number];

export const SOCIAL_ACCOUNT_STATUSES = ["active", "disconnected", "unknown"] as const;
export type SocialAccountStatus = (typeof SOCIAL_ACCOUNT_STATUSES)[number];

export const SOCIAL_POST_TYPES = [
  "image",
  "video",
  "reel",
  "carousel",
  "story",
  "text",
  "other",
] as const;
export type SocialPostType = (typeof SOCIAL_POST_TYPES)[number];
