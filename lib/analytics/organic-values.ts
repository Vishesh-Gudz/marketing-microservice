import { formatCount, formatPercent, getDisplayLocale } from "./format";
import {
  ORGANIC_DATA_STATE_DESCRIPTION,
  ORGANIC_KPI_REASON_TEXT,
  ORGANIC_METRIC_LABEL,
  ORGANIC_METRIC_REASON_TEXT,
  POST_DATA_STATE_DESCRIPTION,
  POST_METRIC_LABEL,
} from "./organic-states";
import type { OrganicAggregate, PostSnapshot } from "./organic-types";
import type { ValueView } from "./values";

/**
 * Displayable organic values (KPI cards, tables). Every number is the API's number: the
 * dashboard does NO metric arithmetic (no sums, no ratios; the engagement rate is shown only
 * when the API returns it). An omitted value shows "—" with the API's reason, never 0.
 */

export const ORGANIC_VALUE_KEYS = [
  "followers",
  "followerDelta",
  "reach",
  "views",
  "accountsEngaged",
  "totalInteractions",
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "profileLinksTaps",
  "engagementRate",
] as const;
export type OrganicValueKey = (typeof ORGANIC_VALUE_KEYS)[number];

/** Headline cards (N9). */
export const ORGANIC_HEADLINE: readonly OrganicValueKey[] = [
  "followers",
  "followerDelta",
  "reach",
  "views",
  "totalInteractions",
  "engagementRate",
];

/** "Engagement details" row (N9). */
export const ORGANIC_DETAILS: readonly OrganicValueKey[] = [
  "accountsEngaged",
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "profileLinksTaps",
];

export function organicLabel(key: OrganicValueKey): string {
  return key === "engagementRate" ? "Engagement rate" : ORGANIC_METRIC_LABEL[key];
}

function formatValue(key: string, value: number, locale: string | undefined): string {
  return key === "engagementRate" ? formatPercent(value, locale) : formatCount(value, locale);
}

/** One value of an organic aggregate (overview totals or a series bucket). */
export function organicValueView(
  key: OrganicValueKey,
  aggregate: OrganicAggregate,
  locale: string | undefined = getDisplayLocale(),
): ValueView {
  if (key === "engagementRate") {
    const value = aggregate.kpis.engagementRate;
    if (value === undefined) {
      const entry = aggregate.kpis.unavailableKpis.find((u) => u.kpi === key);
      return {
        kind: "unavailable",
        text: "—",
        reason: entry
          ? ORGANIC_KPI_REASON_TEXT[entry.reason]
          : ORGANIC_DATA_STATE_DESCRIPTION[aggregate.dataState],
      };
    }
    return {
      kind: "value",
      text: formatValue(key, value, locale),
      partial: aggregate.dataState === "partial",
    };
  }
  const value = aggregate.metrics[key];
  if (value === undefined) {
    const entry = aggregate.metrics.unavailableMetrics.find((u) => u.metric === key);
    return {
      kind: "unavailable",
      text: "—",
      reason: entry
        ? ORGANIC_METRIC_REASON_TEXT[entry.reason]
        : ORGANIC_DATA_STATE_DESCRIPTION[aggregate.dataState],
    };
  }
  return {
    kind: "value",
    text: formatValue(key, value, locale),
    partial: aggregate.metrics.partialMetrics.includes(key) || aggregate.dataState === "partial",
  };
}

export const POST_VALUE_KEYS = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saves",
  "totalInteractions",
  "engagementRate",
] as const;
export type PostValueKey = (typeof POST_VALUE_KEYS)[number];

export function postLabel(key: PostValueKey): string {
  return key === "engagementRate" ? "Engagement rate" : POST_METRIC_LABEL[key];
}

/** One lifetime value of a post capture; no capture -> "—" with the post data state. */
export function postValueView(
  key: PostValueKey,
  snapshot: PostSnapshot | undefined,
  locale: string | undefined = getDisplayLocale(),
): ValueView {
  if (snapshot === undefined) {
    return { kind: "unavailable", text: "—", reason: POST_DATA_STATE_DESCRIPTION.unknown };
  }
  if (key === "engagementRate") {
    const value = snapshot.kpis.engagementRate;
    if (value === undefined) {
      const entry = snapshot.kpis.unavailableKpis.find((u) => u.kpi === key);
      return {
        kind: "unavailable",
        text: "—",
        reason: entry
          ? ORGANIC_KPI_REASON_TEXT[entry.reason]
          : POST_DATA_STATE_DESCRIPTION[snapshot.dataState],
      };
    }
    return { kind: "value", text: formatValue(key, value, locale), partial: false };
  }
  const value = snapshot.metrics[key];
  if (value === undefined) {
    const entry = snapshot.metrics.unavailableMetrics.find((u) => u.metric === key);
    return {
      kind: "unavailable",
      text: "—",
      reason: entry
        ? ORGANIC_METRIC_REASON_TEXT[entry.reason]
        : POST_DATA_STATE_DESCRIPTION[snapshot.dataState],
    };
  }
  return { kind: "value", text: formatValue(key, value, locale), partial: false };
}
