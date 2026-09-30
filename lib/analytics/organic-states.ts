import type {
  OrganicDataState,
  OrganicKpiReason,
  OrganicMetricName,
  OrganicMetricReason,
  PostMetricName,
} from "./organic-types";

/**
 * Texts for the organic API's explicit missing-data semantics (Phase 10 Stage B). The
 * dashboard never turns an unavailable value into 0 and never hides why it is missing;
 * every reason comes from the API. Organic data has no "no delivery" state.
 */

export const ORGANIC_METRIC_LABEL: Record<OrganicMetricName, string> = {
  followers: "Followers",
  followerDelta: "Follower change",
  reach: "Reach",
  views: "Views",
  accountsEngaged: "Accounts engaged",
  totalInteractions: "Total interactions",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saves: "Saves",
  replies: "Replies",
  profileLinksTaps: "Profile link taps",
  profileViews: "Profile views",
  websiteClicks: "Website clicks",
};

export const POST_METRIC_LABEL: Record<PostMetricName, string> = {
  views: "Views",
  reach: "Reach",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  saves: "Saves",
  totalInteractions: "Total interactions",
  videoViews: "Video views",
};

export const ORGANIC_METRIC_REASON_TEXT: Record<OrganicMetricReason, string> = {
  deprecated_metric: "No longer provided by Instagram",
  non_additive:
    "Only available for one day (unique accounts cannot be added up across days or accounts)",
  below_follower_threshold: "Instagram does not report this for accounts under 100 followers",
  not_reported: "Not reported by Instagram",
};

export const ORGANIC_KPI_REASON_TEXT: Record<OrganicKpiReason, string> = {
  non_additive: "Only available for a single day — choose Today or Yesterday",
  numerator_unavailable: "Total interactions not reported",
  denominator_unavailable: "Reach not reported",
  zero_denominator: "Not defined (reach is 0)",
};

/** Account metrics: the data state of a range or bucket of UTC days. */
export const ORGANIC_DATA_STATE_DESCRIPTION: Record<OrganicDataState, string> = {
  reported: "Every UTC day of the range is synced.",
  partial: "Some UTC days are not synced yet; values cover the synced days only.",
  unknown: "No account data synced for this period yet.",
  unsupported: "Not supported for this account.",
};

/** Posts: the data state of the latest lifetime capture. */
export const POST_DATA_STATE_DESCRIPTION: Record<OrganicDataState, string> = {
  reported: "Lifetime totals of the latest capture.",
  partial: "The latest capture did not report every metric.",
  unknown: "Not captured yet (posts from the last 90 days are captured daily).",
  unsupported: "Not supported for this account.",
};
