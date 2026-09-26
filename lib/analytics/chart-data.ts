import { formatCount, formatMoney, getDisplayLocale, toPlotNumber } from "./format";
import type { DataState, MoneyAmounts, TimeSeriesPoint } from "./types";
import { formatNumber, VALUES } from "./values";

/**
 * Time-series chart data (D6). Gaps are honest: buckets without synced data
 * (unknown / unsupported) and unavailable values are `null` (a line gap),
 * never 0. Buckets that are synced with no delivery plot additive metrics as 0.
 * Money series use ONE currency: the reporting currency when every value has
 * it, else the single native currency, else the series is unavailable.
 */

/** Chart metrics (D6). */
export const CHART_METRICS = [
  "spend",
  "impressions",
  "clicks",
  "conversions",
  "ctr",
  "cpc",
] as const;

export type ChartMetric = (typeof CHART_METRICS)[number];

export function isChartMetric(value: string | null | undefined): value is ChartMetric {
  return (CHART_METRICS as readonly (string | null | undefined)[]).includes(value);
}

export type ChartRow = {
  bucket: string;
  from: string;
  to: string;
  dataState: DataState;
  /** The bucket is cut by the range, or some of its days are not synced. */
  incomplete: boolean;
  value: number | null;
  /** Exact text for tooltips and the table view. */
  display: string;
};

export type ChartSeries =
  | { available: true; metric: ChartMetric; currency?: string; rows: ChartRow[] }
  | { available: false; metric: ChartMetric; reason: "mixed_currency" };

function rawValue(point: TimeSeriesPoint, metric: ChartMetric): number | MoneyAmounts | undefined {
  switch (metric) {
    case "spend":
    case "impressions":
    case "clicks":
    case "conversions":
      return point.metrics[metric];
    case "ctr":
    case "cpc":
      return point.kpis[metric];
  }
}

export type PlotRow = ChartRow & {
  /** Value on the solid line (complete buckets only). */
  solid: number | null;
  /** Value on the dashed line (segments touching an incomplete bucket). */
  dashed: number | null;
};

/** Splits a series into a solid line and a dashed line for partial buckets. */
export function plotRows(rows: readonly ChartRow[]): PlotRow[] {
  return rows.map((row, i) => {
    const touchesIncomplete =
      row.incomplete || rows[i - 1]?.incomplete === true || rows[i + 1]?.incomplete === true;
    return {
      ...row,
      solid: row.value !== null && !row.incomplete ? row.value : null,
      dashed: row.value !== null && touchesIncomplete ? row.value : null,
    };
  });
}

/** The one currency a money series can be drawn in, or undefined if there is none. */
export function seriesCurrency(
  amounts: readonly (MoneyAmounts | undefined)[],
  reportingCurrency: string,
): string | undefined | "mixed" {
  const present = amounts.filter((a): a is MoneyAmounts => a !== undefined);
  if (present.length === 0) return undefined;
  if (present.every((a) => a.reporting !== undefined)) return reportingCurrency;
  const natives = new Set(present.flatMap((a) => a.native.map((m) => m.currency)));
  if (natives.size === 1 && present.every((a) => a.native.length === 1)) {
    return [...natives][0];
  }
  return "mixed";
}

function pickMoney(amounts: MoneyAmounts, currency: string) {
  if (amounts.reporting?.currency === currency) return amounts.reporting;
  return amounts.native.find((m) => m.currency === currency);
}

const EMPTY = "—";

export function buildSeries(
  points: readonly TimeSeriesPoint[],
  metric: ChartMetric,
  reportingCurrency: string,
  locale: string | undefined = getDisplayLocale(),
): ChartSeries {
  const definition = VALUES[metric];
  const raws = points.map((p) => rawValue(p, metric));
  let currency: string | undefined;
  if (definition.kind === "money") {
    const chosen = seriesCurrency(raws as (MoneyAmounts | undefined)[], reportingCurrency);
    if (chosen === "mixed") return { available: false, metric, reason: "mixed_currency" };
    currency = chosen ?? reportingCurrency;
  }

  const rows = points.map((point, i): ChartRow => {
    const raw = raws[i];
    const base = {
      bucket: point.bucket,
      from: point.from,
      to: point.to,
      dataState: point.dataState,
      incomplete: point.partial || point.dataState === "partial",
    };
    if (raw === undefined) {
      // Synced but nothing delivered: additive metrics are 0; ratios stay undefined.
      if (point.dataState === "no_delivery" && definition.additive) {
        const zero =
          definition.kind === "money"
            ? formatMoney({ currency: currency!, micros: "0" }, locale)
            : formatCount(0, locale);
        return { ...base, value: 0, display: zero };
      }
      return { ...base, value: null, display: EMPTY };
    }
    if (typeof raw === "number") {
      return { ...base, value: raw, display: formatNumber(raw, definition.kind, locale) };
    }
    const money = pickMoney(raw, currency!);
    if (money === undefined) return { ...base, value: null, display: EMPTY };
    return { ...base, value: toPlotNumber(money.micros), display: formatMoney(money, locale) };
  });
  return { available: true, metric, ...(currency ? { currency } : {}), rows };
}

/** Short axis label for a bucket key (day: "Sep 3", week: "Sep 1", month: "Sep 2026"). */
export function bucketLabel(
  bucket: string,
  granularity: "day" | "week" | "month",
  locale: string | undefined = getDisplayLocale(),
): string {
  if (granularity === "month") {
    const [y, m] = bucket.split("-").map(Number);
    return new Intl.DateTimeFormat(locale, {
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    }).format(Date.UTC(y!, m! - 1, 1));
  }
  const [y, m, d] = bucket.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(Date.UTC(y!, m! - 1, d!));
}

/** A DateKey as a readable date ("Sep 3, 2026"); DateKeys have no time zone. */
export function formatDateKey(
  key: string,
  locale: string | undefined = getDisplayLocale(),
): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
    Date.UTC(y!, m! - 1, d!),
  );
}

export function formatRange(
  range: { from: string; to: string },
  locale: string | undefined = getDisplayLocale(),
): string {
  return range.from === range.to
    ? formatDateKey(range.from, locale)
    : `${formatDateKey(range.from, locale)} – ${formatDateKey(range.to, locale)}`;
}

export type SpendShares =
  | { available: true; currency: string; shares: (number | null)[] }
  | { available: false; reason: "mixed_currency" | "no_spend" };

/**
 * Share of spend per group for bar lengths (D6, display only): computed only
 * when every amount can be read in ONE currency (reporting, or a single native
 * currency). Groups without spend get `null`.
 */
export function spendShares(
  amounts: readonly (MoneyAmounts | undefined)[],
  reportingCurrency: string,
): SpendShares {
  const currency = seriesCurrency(amounts, reportingCurrency);
  if (currency === "mixed") return { available: false, reason: "mixed_currency" };
  if (currency === undefined) return { available: false, reason: "no_spend" };
  const values = amounts.map((a) => {
    const money = a ? pickMoney(a, currency) : undefined;
    return money ? toPlotNumber(money.micros) : null;
  });
  const total = values.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  if (total <= 0) return { available: false, reason: "no_spend" };
  return { available: true, currency, shares: values.map((v) => (v === null ? null : v / total)) };
}
