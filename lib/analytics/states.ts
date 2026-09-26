import type {
  ActionKpiName,
  DataState,
  KpiName,
  KpiReason,
  MetricName,
  MetricReason,
} from "./types";

/**
 * Texts for the API's explicit missing-data semantics (D10). The dashboard never
 * turns an unavailable value into 0 and never hides why it is missing.
 */

export const DATA_STATE_LABEL: Record<DataState, string> = {
  reported: "Reported",
  partial: "Partial data",
  no_delivery: "No delivery",
  unknown: "Not synced",
  unsupported: "Not supported",
};

export const DATA_STATE_DESCRIPTION: Record<DataState, string> = {
  reported: "Every day of the range is synced.",
  partial: "Some days are not synced yet; values cover the synced days only.",
  no_delivery: "No delivery in this period.",
  unknown: "No data synced for this period.",
  unsupported: "Not available for this platform.",
};

export const METRIC_REASON_TEXT: Record<MetricReason, string> = {
  not_reported: "Not reported by the platform",
  non_additive: "Cannot be summed across days or entities",
  invalid_data: "Invalid source data",
};

export const KPI_REASON_TEXT: Record<KpiReason, string> = {
  numerator_unavailable: "Input metric not available",
  denominator_unavailable: "Input metric not available",
  zero_denominator: "Not defined (divides by zero)",
  mixed_currency: "Accounts use different currencies",
  invalid_data: "Invalid source data",
};

export const METRIC_LABEL: Record<MetricName, string> = {
  spend: "Spend",
  conversionValue: "Conversion value",
  impressions: "Impressions",
  clicks: "Clicks",
  linkClicks: "Link clicks",
  reach: "Reach",
  videoPlays: "Video plays",
  videoViews: "Video views",
  videoCompletions: "Video completions",
  engagements: "Engagements",
  reactions: "Reactions",
  comments: "Comments",
  shares: "Shares",
  saves: "Saves",
  follows: "Follows",
  conversions: "Conversions",
  allConversions: "All conversions",
};

export const KPI_LABEL: Record<KpiName | ActionKpiName, string> = {
  ctr: "CTR",
  conversionRate: "Conversion rate",
  roas: "ROAS",
  cpc: "CPC",
  cpm: "CPM",
  costPerConversion: "Cost per conversion",
  costPerAction: "Cost per action",
  valuePerSpend: "Value per spend",
};

export function metricUnavailableReason(
  unavailable: readonly { metric: MetricName; reason: MetricReason }[],
  metric: MetricName,
): string | undefined {
  const entry = unavailable.find((u) => u.metric === metric);
  return entry ? METRIC_REASON_TEXT[entry.reason] : undefined;
}

export function kpiUnavailableReason<K extends string>(
  unavailable: readonly { kpi: K; reason: KpiReason }[],
  kpi: K,
): string | undefined {
  const entry = unavailable.find((u) => u.kpi === kpi);
  return entry ? KPI_REASON_TEXT[entry.reason] : undefined;
}
