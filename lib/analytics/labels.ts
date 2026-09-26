/**
 * Display labels for canonical enum values. Unknown values fall back to a
 * humanized form, so a new enum value never breaks the dashboard.
 */

const OVERRIDES: Record<string, string> = {
  meta: "Meta",
  google_ads: "Google Ads",
  audience_network: "Audience Network",
  google_search: "Google Search",
  google_display: "Google Display",
  youtube: "YouTube",
  gmail: "Gmail",
  ad_group: "Ad group",
  performance_max: "Performance Max",
  demand_gen: "Demand Gen",
  impression_or_click_date: "Impression / click date",
  conversion_date: "Conversion date",
  all: "All placements",
};

export function humanize(value: string): string {
  const override = OVERRIDES[value];
  if (override) return override;
  const text = value.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Level names used in headings ("Campaigns", "Ad groups", "Ads"). */
export const LEVEL_PLURAL: Record<"account" | "campaign" | "ad_group" | "ad", string> = {
  account: "Accounts",
  campaign: "Campaigns",
  ad_group: "Ad groups",
  ad: "Ads",
};
