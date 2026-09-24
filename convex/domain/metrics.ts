import { v } from "convex/values";
import { extrasValidator, microsValidator } from "./validators";

/**
 * Canonical metric catalog.
 *
 * Missing-data semantics (docs/data-model.md):
 * - field absent => not reported by the platform / not applicable
 * - 0            => reported as zero
 * Never write 0 for "unknown". Ratios (CTR, CPC, ROAS, ...) are never stored;
 * they are computed at read time from summed components (Phase 6).
 */
export type MetricKind = "money" | "count" | "float";

export type MetricSpec = {
  kind: MetricKind;
  /** Safe to sum across days/entities/placements. Reach and similar deduplicated metrics are not. */
  additive: boolean;
  description: string;
};

export const AD_METRICS = {
  spendMicros: { kind: "money", additive: true, description: "Amount spent" },
  impressions: { kind: "count", additive: true, description: "Impressions" },
  reach: { kind: "count", additive: false, description: "Unique people reached (deduplicated)" },
  clicks: { kind: "count", additive: true, description: "All clicks (Meta clicks, Google clicks)" },
  linkClicks: { kind: "count", additive: true, description: "Clicks to destination (Meta)" },
  videoPlays: { kind: "count", additive: true, description: "Video plays started" },
  videoViews: {
    kind: "count",
    additive: true,
    description: "Platform-defined video views (Meta 3s views, Google TrueView views)",
  },
  videoCompletions: { kind: "count", additive: true, description: "Videos watched to 100%" },
  engagements: { kind: "count", additive: true, description: "Platform engagement total" },
  reactions: { kind: "count", additive: true, description: "Likes/reactions" },
  comments: { kind: "count", additive: true, description: "Comments" },
  shares: { kind: "count", additive: true, description: "Shares" },
  saves: { kind: "count", additive: true, description: "Saves" },
  follows: { kind: "count", additive: true, description: "Follows / page likes" },
  conversions: {
    kind: "float",
    additive: true,
    description: "Primary conversions (fractional with data-driven attribution)",
  },
  conversionValueMicros: { kind: "money", additive: true, description: "Primary conversion value" },
  allConversions: { kind: "float", additive: true, description: "All conversions (Google)" },
} as const satisfies Record<string, MetricSpec>;

export type AdMetricKey = keyof typeof AD_METRICS;

/** Optional metric columns of `metricsDaily`, derived from the catalog kinds. */
export const adMetricFields = {
  spendMicros: v.optional(microsValidator),
  impressions: v.optional(v.number()),
  reach: v.optional(v.number()),
  clicks: v.optional(v.number()),
  linkClicks: v.optional(v.number()),
  videoPlays: v.optional(v.number()),
  videoViews: v.optional(v.number()),
  videoCompletions: v.optional(v.number()),
  engagements: v.optional(v.number()),
  reactions: v.optional(v.number()),
  comments: v.optional(v.number()),
  shares: v.optional(v.number()),
  saves: v.optional(v.number()),
  follows: v.optional(v.number()),
  conversions: v.optional(v.number()),
  conversionValueMicros: v.optional(microsValidator),
  allConversions: v.optional(v.number()),
  extras: v.optional(extrasValidator),
} satisfies Record<AdMetricKey | "extras", unknown>;

/** Cumulative lifetime values of one organic post at capture time. */
export const SOCIAL_POST_METRICS = {
  views: { kind: "count", additive: false, description: "Lifetime views" },
  reach: { kind: "count", additive: false, description: "Lifetime unique accounts reached" },
  likes: { kind: "count", additive: false, description: "Lifetime likes" },
  comments: { kind: "count", additive: false, description: "Lifetime comments" },
  shares: { kind: "count", additive: false, description: "Lifetime shares" },
  saves: { kind: "count", additive: false, description: "Lifetime saves" },
  videoViews: { kind: "count", additive: false, description: "Lifetime video views" },
  totalInteractions: { kind: "count", additive: false, description: "Lifetime interactions" },
} as const satisfies Record<string, MetricSpec>;

export type SocialPostMetricKey = keyof typeof SOCIAL_POST_METRICS;

export const socialPostMetricFields = {
  views: v.optional(v.number()),
  reach: v.optional(v.number()),
  likes: v.optional(v.number()),
  comments: v.optional(v.number()),
  shares: v.optional(v.number()),
  saves: v.optional(v.number()),
  videoViews: v.optional(v.number()),
  totalInteractions: v.optional(v.number()),
  extras: v.optional(extrasValidator),
} satisfies Record<SocialPostMetricKey | "extras", unknown>;

/** Daily values of one organic account (reporting-day semantics: see docs/data-model.md). */
export const SOCIAL_ACCOUNT_METRICS = {
  followers: { kind: "count", additive: false, description: "Follower count at end of day" },
  followerDelta: { kind: "count", additive: true, description: "Net follower change" },
  reach: { kind: "count", additive: false, description: "Unique accounts reached" },
  views: { kind: "count", additive: true, description: "Views / impressions" },
  profileViews: { kind: "count", additive: true, description: "Profile views" },
  websiteClicks: { kind: "count", additive: true, description: "Website clicks" },
  accountsEngaged: { kind: "count", additive: false, description: "Unique accounts engaged" },
  totalInteractions: { kind: "count", additive: true, description: "Interactions" },
} as const satisfies Record<string, MetricSpec>;

export type SocialAccountMetricKey = keyof typeof SOCIAL_ACCOUNT_METRICS;

export const socialAccountMetricFields = {
  followers: v.optional(v.number()),
  followerDelta: v.optional(v.number()),
  reach: v.optional(v.number()),
  views: v.optional(v.number()),
  profileViews: v.optional(v.number()),
  websiteClicks: v.optional(v.number()),
  accountsEngaged: v.optional(v.number()),
  totalInteractions: v.optional(v.number()),
  extras: v.optional(extrasValidator),
} satisfies Record<SocialAccountMetricKey | "extras", unknown>;
