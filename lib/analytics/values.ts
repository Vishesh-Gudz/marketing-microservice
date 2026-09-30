import {
  formatCount,
  formatDecimal,
  formatMoney,
  formatMultiple,
  formatPercent,
  moneyDisplay,
} from "./format";
import { DATA_STATE_DESCRIPTION, KPI_REASON_TEXT, METRIC_REASON_TEXT } from "./states";
import type { Aggregate, KpiName, MetricName, MoneyAmounts } from "./types";

/**
 * One displayable value of an aggregate (KPI cards, tables). Never invents a
 * number (D10): an omitted value shows "—" with the API's reason; a range
 * without delivery says so instead of showing 0 (only charts plot it as 0, D6).
 */

export type ValueKind = "money" | "count" | "decimal" | "percent" | "multiple";

export type ValueDefinition =
  | { key: MetricName; source: "metrics"; label: string; kind: ValueKind; additive: boolean }
  | { key: KpiName; source: "kpis"; label: string; kind: ValueKind; additive: false };

export const VALUES = {
  spend: { key: "spend", source: "metrics", label: "Spend", kind: "money", additive: true },
  conversionValue: {
    key: "conversionValue",
    source: "metrics",
    label: "Conversion value",
    kind: "money",
    additive: true,
  },
  impressions: {
    key: "impressions",
    source: "metrics",
    label: "Impressions",
    kind: "count",
    additive: true,
  },
  clicks: { key: "clicks", source: "metrics", label: "Clicks", kind: "count", additive: true },
  conversions: {
    key: "conversions",
    source: "metrics",
    label: "Conversions",
    kind: "decimal",
    additive: true,
  },
  ctr: { key: "ctr", source: "kpis", label: "CTR", kind: "percent", additive: false },
  cpc: { key: "cpc", source: "kpis", label: "CPC", kind: "money", additive: false },
  cpm: { key: "cpm", source: "kpis", label: "CPM", kind: "money", additive: false },
  conversionRate: {
    key: "conversionRate",
    source: "kpis",
    label: "Conversion rate",
    kind: "percent",
    additive: false,
  },
  costPerConversion: {
    key: "costPerConversion",
    source: "kpis",
    label: "Cost / conversion",
    kind: "money",
    additive: false,
  },
  roas: { key: "roas", source: "kpis", label: "ROAS", kind: "multiple", additive: false },
} as const satisfies Record<string, ValueDefinition>;

export type ValueKey = keyof typeof VALUES;

/** The 10 headline KPIs (D8), in display order. */
export const KPI_CARDS: readonly ValueKey[] = [
  "spend",
  "impressions",
  "clicks",
  "ctr",
  "cpc",
  "cpm",
  "conversions",
  "conversionValue",
  "costPerConversion",
  "roas",
];

export type ValueView =
  | {
      kind: "value";
      text: string;
      /** Per-currency values when there is no single display value. */
      detail?: string[];
      partial: boolean;
    }
  | { kind: "unavailable"; text: "—"; reason: string };

export function formatNumber(value: number, kind: ValueKind, locale?: string): string {
  switch (kind) {
    case "percent":
      return formatPercent(value, locale);
    case "multiple":
      return formatMultiple(value, locale);
    case "decimal":
      return formatDecimal(value, locale);
    default:
      return formatCount(value, locale);
  }
}

export function moneyView(
  amounts: MoneyAmounts,
  locale?: string,
): { text: string; detail?: string[] } | undefined {
  const display = moneyDisplay(amounts);
  switch (display.kind) {
    case "reporting":
    case "native":
      return { text: formatMoney(display.money, locale) };
    case "multiple":
      return {
        text: "Multiple currencies",
        detail: display.native.map((m) => formatMoney(m, locale)),
      };
    case "none":
      return undefined;
  }
}

function rawOf(definition: ValueDefinition, aggregate: Aggregate) {
  return definition.source === "metrics"
    ? aggregate.metrics[definition.key]
    : aggregate.kpis[definition.key];
}

function reasonOf(definition: ValueDefinition, aggregate: Aggregate): string {
  if (definition.source === "metrics") {
    const entry = aggregate.metrics.unavailableMetrics.find((u) => u.metric === definition.key);
    if (entry) return METRIC_REASON_TEXT[entry.reason];
  } else {
    const entry = aggregate.kpis.unavailableKpis.find((u) => u.kpi === definition.key);
    if (entry) return KPI_REASON_TEXT[entry.reason];
  }
  // Partial without a value: the synced days have no rows; the other days are unknown.
  if (aggregate.dataState === "partial") {
    return "Nothing reported on the synced days; some days are not synced yet.";
  }
  return DATA_STATE_DESCRIPTION[aggregate.dataState];
}

function isPartial(definition: ValueDefinition, aggregate: Aggregate): boolean {
  return definition.source === "metrics"
    ? aggregate.metrics.partialMetrics.includes(definition.key)
    : aggregate.kpis.partialKpis.includes(definition.key);
}

export function valueView(
  key: ValueKey,
  aggregate: Aggregate,
  options: { locale?: string } = {},
): ValueView {
  const definition: ValueDefinition = VALUES[key];
  const raw = rawOf(definition, aggregate);
  const partial = isPartial(definition, aggregate) || aggregate.dataState === "partial";
  if (raw === undefined) {
    return { kind: "unavailable", text: "—", reason: reasonOf(definition, aggregate) };
  }
  if (typeof raw === "number") {
    return { kind: "value", text: formatNumber(raw, definition.kind, options.locale), partial };
  }
  const money = moneyView(raw, options.locale);
  if (money === undefined) {
    return { kind: "unavailable", text: "—", reason: reasonOf(definition, aggregate) };
  }
  return { kind: "value", ...money, partial };
}
