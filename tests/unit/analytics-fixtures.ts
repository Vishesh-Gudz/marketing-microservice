import type {
  Aggregate,
  EntitySummary,
  Kpis,
  Metrics,
  Money,
  MoneyAmounts,
  Org,
  OverviewResult,
  PerformanceRow,
  TimeSeriesPoint,
} from "@/lib/analytics/types";

/** Builders for public v1 analytics DTOs (component and pure-logic tests). */

export function money(currency: string, units: number | string): Money {
  const micros = BigInt(Math.round(Number(units) * 1_000_000)).toString();
  return { currency, micros };
}

export function amounts(native: Money[], reporting?: Money): MoneyAmounts {
  return reporting ? { native, reporting } : { native };
}

export function usd(units: number): MoneyAmounts {
  return amounts([money("USD", units)], money("USD", units));
}

export function metrics(
  values: Partial<Omit<Metrics, "unavailableMetrics" | "partialMetrics">> & {
    unavailableMetrics?: Metrics["unavailableMetrics"];
    partialMetrics?: Metrics["partialMetrics"];
  },
): Metrics {
  return { unavailableMetrics: [], partialMetrics: [], ...values };
}

export function kpis(
  values: Partial<Omit<Kpis, "unavailableKpis" | "partialKpis">> & {
    unavailableKpis?: Kpis["unavailableKpis"];
    partialKpis?: Kpis["partialKpis"];
  },
): Kpis {
  return { unavailableKpis: [], partialKpis: [], ...values };
}

export function aggregate(
  overrides: { dataState?: Aggregate["dataState"]; metrics?: Metrics; kpis?: Kpis } = {},
): Aggregate {
  return {
    dataState: overrides.dataState ?? "reported",
    metrics: overrides.metrics ?? metrics({}),
    kpis: overrides.kpis ?? kpis({}),
  };
}

export const REPORTED = aggregate({
  metrics: metrics({
    spend: usd(1234.56),
    conversionValue: usd(5000),
    impressions: 100_000,
    clicks: 2_000,
    conversions: 40,
    reach: 50_000,
  }),
  kpis: kpis({
    ctr: 0.02,
    conversionRate: 0.02,
    roas: 4.05,
    cpc: usd(0.617),
    cpm: usd(12.35),
    costPerConversion: usd(30.86),
  }),
});

export function overview(overrides: Partial<OverviewResult> = {}): OverviewResult {
  return {
    range: { from: "2026-08-26", to: "2026-09-24" },
    accountCount: 2,
    totals: REPORTED,
    coverage: { dataState: "reported", accounts: [] },
    fx: { reportingCurrency: "USD", status: "not_needed" },
    ...overrides,
  };
}

export function point(bucket: string, overrides: Partial<TimeSeriesPoint> = {}): TimeSeriesPoint {
  return {
    bucket,
    from: bucket,
    to: bucket,
    partial: false,
    ...aggregate(),
    ...overrides,
  };
}

export function entity(overrides: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: "campaign1",
    level: "campaign",
    externalId: "c-1",
    name: "Spring Sale",
    platform: "meta",
    status: "active",
    accountId: "account1",
    currency: "USD",
    removed: false,
    ...overrides,
  };
}

export function performanceRow(overrides: Partial<PerformanceRow> = {}): PerformanceRow {
  return { entity: entity(), ...REPORTED, ...overrides };
}

export const ORG: Org = {
  id: "org1",
  externalOrgId: "dev-org",
  issuer: "https://dev-issuer.marketing.local",
  displayName: "Dev Organization",
  reportingCurrency: "USD",
  timezone: "UTC",
  role: "admin",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
