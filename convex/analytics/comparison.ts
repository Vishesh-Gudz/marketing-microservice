import {
  COUNT_METRICS,
  FLOAT_METRICS,
  MONEY_KPIS,
  MONEY_METRICS,
  publicMetricName,
  RATIO_KPIS,
  type AggregateValues,
  type KpiName,
  type MetricName,
  type MoneyAmounts,
  type NativeMoney,
} from "./aggregate";
import { ratioFixed6 } from "./numeric";

/**
 * PURE period-over-period deltas (docs/analytics.md "Comparison").
 * - absolute = current - previous (exact; money per currency / reporting)
 * - percent  = (current - previous) / previous as a 6-decimal fraction
 * - previous = 0          -> absolute kept, percent omitted (previous_zero)
 * - previous missing     -> absolute and percent omitted (previous_unavailable)
 * - current missing      -> no delta at all (the current aggregate already lists the
 *                           metric/KPI in unavailableMetrics/unavailableKpis with its reason)
 * - money across different currencies without reporting values -> mixed_currency
 * Non-additive metrics (reach) are never compared.
 */

export const DELTA_REASONS = ["previous_zero", "previous_unavailable", "mixed_currency"] as const;
export type DeltaReason = (typeof DELTA_REASONS)[number];

export type NumberDelta = {
  absolute?: bigint;
  percent?: bigint;
  reason?: DeltaReason;
  partial?: boolean;
};
export type MoneyDelta = {
  absolute?: MoneyAmounts;
  percent?: bigint;
  reason?: DeltaReason;
  partial?: boolean;
};

export type Deltas = {
  numbers: Partial<Record<MetricName | KpiName, NumberDelta>>;
  money: Partial<Record<MetricName | KpiName, MoneyDelta>>;
};

export type ComparableAggregate = AggregateValues & { partial: boolean };

function numberDelta(
  current: bigint | undefined,
  previous: bigint | undefined,
  partial: boolean,
): NumberDelta | undefined {
  const flag = partial ? { partial: true } : {};
  if (current === undefined) return undefined;
  if (previous === undefined) return { reason: "previous_unavailable", ...flag };
  const absolute = current - previous;
  if (previous <= 0n) return { absolute, reason: "previous_zero", ...flag };
  return { absolute, percent: ratioFixed6(absolute, previous), ...flag };
}

function moneyDelta(
  current: MoneyAmounts | undefined,
  previous: MoneyAmounts | undefined,
  partial: boolean,
): MoneyDelta | undefined {
  const flag = partial ? { partial: true } : {};
  if (current === undefined) return undefined;
  if (previous === undefined) return { reason: "previous_unavailable", ...flag };

  const previousByCurrency = new Map(previous.native.map((m) => [m.currency, m.micros]));
  const native: NativeMoney[] = [];
  for (const { currency, micros } of current.native) {
    const before = previousByCurrency.get(currency);
    if (before !== undefined) native.push({ currency, micros: micros - before });
  }
  const reporting =
    current.reporting !== undefined && previous.reporting !== undefined
      ? current.reporting - previous.reporting
      : undefined;
  const absolute: MoneyAmounts | undefined =
    native.length === 0 && reporting === undefined
      ? undefined
      : reporting === undefined
        ? { native }
        : { native, reporting };

  // Percent: in the reporting currency when both sides have it, else only for one shared currency.
  let base: bigint | undefined;
  let diff: bigint | undefined;
  if (reporting !== undefined) {
    base = previous.reporting;
    diff = reporting;
  } else if (
    current.native.length === 1 &&
    previous.native.length === 1 &&
    current.native[0]!.currency === previous.native[0]!.currency
  ) {
    base = previous.native[0]!.micros;
    diff = native[0]!.micros;
  }
  const result: MoneyDelta = { ...(absolute ? { absolute } : {}), ...flag };
  if (base === undefined || diff === undefined) return { ...result, reason: "mixed_currency" };
  if (base <= 0n) return { ...result, reason: "previous_zero" };
  return { ...result, percent: ratioFixed6(diff, base) };
}

export function compareAggregates(
  current: ComparableAggregate,
  previous: ComparableAggregate,
): Deltas {
  const either = current.partial || previous.partial;
  const partialOf = (name: MetricName | KpiName) =>
    either ||
    current.partialMetrics.includes(name as MetricName) ||
    previous.partialMetrics.includes(name as MetricName) ||
    current.partialKpis.includes(name as KpiName) ||
    previous.partialKpis.includes(name as KpiName);

  const deltas: Deltas = { numbers: {}, money: {} };
  const setNumber = (name: MetricName | KpiName, delta: NumberDelta | undefined) => {
    if (delta !== undefined) deltas.numbers[name] = delta;
  };
  const setMoney = (name: MetricName | KpiName, delta: MoneyDelta | undefined) => {
    if (delta !== undefined) deltas.money[name] = delta;
  };
  for (const key of [...COUNT_METRICS, ...FLOAT_METRICS]) {
    const name = publicMetricName(key);
    setNumber(name, numberDelta(current.numbers[key], previous.numbers[key], partialOf(name)));
  }
  for (const key of MONEY_METRICS) {
    const name = publicMetricName(key);
    setMoney(name, moneyDelta(current.money[key], previous.money[key], partialOf(name)));
  }
  for (const kpi of RATIO_KPIS) {
    setNumber(kpi, numberDelta(current.ratios[kpi], previous.ratios[kpi], partialOf(kpi)));
  }
  for (const kpi of MONEY_KPIS) {
    setMoney(kpi, moneyDelta(current.moneyKpis[kpi], previous.moneyKpis[kpi], partialOf(kpi)));
  }
  return deltas;
}
