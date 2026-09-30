import type { Doc } from "../_generated/dataModel";
import { AD_METRICS, type AdMetricKey } from "../domain/metrics";
import type { DateKey } from "../lib/dates";
import type { FxConverter } from "./fx";
import { FIXED_SCALE, ratioFixed6, roundDiv, toFixed6 } from "./numeric";

/**
 * PURE aggregation of metricsDaily rows (docs/analytics.md "Aggregation").
 *
 * - Rows are only ever aggregated across days and across entities of ONE level
 *   and ONE placement set; callers never mix "all" with breakdown rows.
 * - Additive metrics are summed exactly (bigint): counts as integers, float
 *   metrics as 6-decimal fixed point, money as micros per currency.
 * - A field absent on every row is "not_reported"; absent on some rows it is
 *   summed over the rows that report it and listed as partial. 0 stays 0.
 * - Non-additive metrics (reach) exist only at the stored grain (one row).
 * - KPIs use PAIRED sums: numerator and denominator are summed only over rows
 *   that report both; the KPI is partial if some row lacked either.
 */

export const COUNT_METRICS = [
  "impressions",
  "clicks",
  "linkClicks",
  "videoPlays",
  "videoViews",
  "videoCompletions",
  "engagements",
  "reactions",
  "comments",
  "shares",
  "saves",
  "follows",
] as const satisfies readonly AdMetricKey[];
export const FLOAT_METRICS = [
  "conversions",
  "allConversions",
] as const satisfies readonly AdMetricKey[];
export const MONEY_METRICS = [
  "spendMicros",
  "conversionValueMicros",
] as const satisfies readonly AdMetricKey[];
export const NON_ADDITIVE_METRICS = ["reach"] as const satisfies readonly AdMetricKey[];

export type CountKey = (typeof COUNT_METRICS)[number];
export type FloatKey = (typeof FLOAT_METRICS)[number];
export type MoneyKey = (typeof MONEY_METRICS)[number];
type AdditiveKey = CountKey | FloatKey | MoneyKey;
const ADDITIVE_KEYS: readonly AdditiveKey[] = [
  ...COUNT_METRICS,
  ...FLOAT_METRICS,
  ...MONEY_METRICS,
];

/** Public metric names (money fields drop the "Micros" suffix). */
export const METRIC_NAMES = [
  "spend",
  "impressions",
  "clicks",
  "linkClicks",
  "reach",
  "videoPlays",
  "videoViews",
  "videoCompletions",
  "engagements",
  "reactions",
  "comments",
  "shares",
  "saves",
  "follows",
  "conversions",
  "conversionValue",
  "allConversions",
] as const;
export type MetricName = (typeof METRIC_NAMES)[number];

export function publicMetricName(key: AdMetricKey): MetricName {
  if (key === "spendMicros") return "spend";
  if (key === "conversionValueMicros") return "conversionValue";
  return key;
}

export const RATIO_KPIS = ["ctr", "conversionRate", "roas"] as const;
export const MONEY_KPIS = ["cpc", "cpm", "costPerConversion"] as const;
export const KPI_NAMES = [...RATIO_KPIS, ...MONEY_KPIS] as const;
export type RatioKpi = (typeof RATIO_KPIS)[number];
export type MoneyKpi = (typeof MONEY_KPIS)[number];
export type KpiName = RatioKpi | MoneyKpi;

export const KPI_UNAVAILABLE_REASONS = [
  "numerator_unavailable",
  "denominator_unavailable",
  "zero_denominator",
  "mixed_currency",
  "invalid_data",
] as const;
export type KpiUnavailableReason = (typeof KPI_UNAVAILABLE_REASONS)[number];

export const METRIC_UNAVAILABLE_REASONS = ["not_reported", "non_additive", "invalid_data"] as const;
export type MetricUnavailableReason = (typeof METRIC_UNAVAILABLE_REASONS)[number];

/** Numerator/denominator fields of each KPI (paired per row). */
const KPI_FIELDS: Record<KpiName, [AdditiveKey, AdditiveKey]> = {
  ctr: ["clicks", "impressions"],
  conversionRate: ["conversions", "clicks"],
  roas: ["conversionValueMicros", "spendMicros"],
  cpc: ["spendMicros", "clicks"],
  cpm: ["spendMicros", "impressions"],
  costPerConversion: ["spendMicros", "conversions"],
};

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

type Pair = { num: bigint; den: bigint; rows: number };

type Cell = {
  currency: string;
  date: DateKey;
  sums: Map<AdditiveKey, bigint>;
  present: Map<AdditiveKey, number>;
  pairs: Map<KpiName, Pair>;
};

/** Row value -> exact bigint (count, fixed-point float, or micros); "invalid" for bad data. */
function rowValue(row: MetricRow, key: AdditiveKey): bigint | "absent" | "invalid" {
  const value = row[key];
  if (value === undefined) return "absent";
  if (typeof value === "bigint") return value < 0n ? "invalid" : value;
  if (!Number.isFinite(value) || value < 0) return "invalid";
  if ((FLOAT_METRICS as readonly string[]).includes(key)) return toFixed6(value);
  return Number.isInteger(value) ? BigInt(value) : "invalid";
}

export type MetricRow = Pick<Doc<"metricsDaily">, "currency" | "date" | AdditiveKey | "reach">;

export class MetricAccumulator {
  private readonly cells = new Map<string, Cell>();
  rows = 0;
  private reach: number | undefined;
  private reachPresent = 0;
  private readonly present = new Map<AdditiveKey, number>();
  private readonly invalid = new Set<AdditiveKey>();

  add(row: MetricRow): void {
    this.rows++;
    const cellKey = `${row.currency}|${row.date}`;
    let cell = this.cells.get(cellKey);
    if (cell === undefined) {
      cell = {
        currency: row.currency,
        date: row.date,
        sums: new Map(),
        present: new Map(),
        pairs: new Map(),
      };
      this.cells.set(cellKey, cell);
    }
    const values = new Map<AdditiveKey, bigint>();
    for (const key of ADDITIVE_KEYS) {
      const value = rowValue(row, key);
      if (value === "absent") continue;
      if (value === "invalid") {
        this.invalid.add(key);
        continue;
      }
      values.set(key, value);
      cell.sums.set(key, (cell.sums.get(key) ?? 0n) + value);
      cell.present.set(key, (cell.present.get(key) ?? 0) + 1);
      this.present.set(key, (this.present.get(key) ?? 0) + 1);
    }
    for (const kpi of KPI_NAMES) {
      const [numKey, denKey] = KPI_FIELDS[kpi];
      const num = values.get(numKey);
      const den = values.get(denKey);
      if (num === undefined || den === undefined) continue;
      const pair = cell.pairs.get(kpi) ?? { num: 0n, den: 0n, rows: 0 };
      pair.num += num;
      pair.den += den;
      pair.rows++;
      cell.pairs.set(kpi, pair);
    }
    if (row.reach !== undefined) {
      this.reachPresent++;
      this.reach = row.reach;
    }
  }

  summarize(fx: FxConverter): AggregateValues {
    return summarize(this, fx);
  }

  /** @internal */
  state() {
    return {
      cells: [...this.cells.values()],
      rows: this.rows,
      reach: this.reach,
      reachPresent: this.reachPresent,
      present: this.present,
      invalid: this.invalid,
    };
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

export type NativeMoney = { currency: string; micros: bigint };
export type MoneyAmounts = { native: NativeMoney[]; reporting?: bigint };

export type AggregateValues = {
  rows: number;
  /** Counts (integers) and float metrics (6-decimal fixed point). */
  numbers: Partial<Record<CountKey | FloatKey, bigint>>;
  money: Partial<Record<MoneyKey, MoneyAmounts>>;
  reach?: number;
  unavailableMetrics: { metric: MetricName; reason: MetricUnavailableReason }[];
  partialMetrics: MetricName[];
  ratios: Partial<Record<RatioKpi, bigint>>;
  moneyKpis: Partial<Record<MoneyKpi, MoneyAmounts>>;
  unavailableKpis: { kpi: KpiName; reason: KpiUnavailableReason }[];
  partialKpis: KpiName[];
};

function byCurrency(cells: Cell[]): Map<string, Cell[]> {
  const groups = new Map<string, Cell[]>();
  for (const cell of cells) {
    const list = groups.get(cell.currency) ?? [];
    list.push(cell);
    groups.set(cell.currency, list);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Sums one money value per cell into native-per-currency plus (if every rate exists) reporting. */
function moneyAmounts(
  cells: Cell[],
  pick: (cell: Cell) => bigint | undefined,
  fx: FxConverter,
): MoneyAmounts | undefined {
  const native: NativeMoney[] = [];
  let reporting = 0n;
  let complete = true;
  for (const [currency, group] of byCurrency(cells)) {
    let total: bigint | undefined;
    for (const cell of group) {
      const value = pick(cell);
      if (value === undefined) continue;
      total = (total ?? 0n) + value;
      // Every cell is attempted, so the FX status lists every missing (currency, day).
      const converted = fx.convert(value, currency, cell.date);
      if (converted === undefined) complete = false;
      else reporting += converted;
    }
    if (total !== undefined) native.push({ currency, micros: total });
  }
  if (native.length === 0) return undefined;
  return complete ? { native, reporting } : { native };
}

function summarize(acc: MetricAccumulator, fx: FxConverter): AggregateValues {
  const { cells, rows, reach, reachPresent, present, invalid } = acc.state();
  const result: AggregateValues = {
    rows,
    numbers: {},
    money: {},
    unavailableMetrics: [],
    partialMetrics: [],
    ratios: {},
    moneyKpis: {},
    unavailableKpis: [],
    partialKpis: [],
  };
  if (rows === 0) return result;

  // Metrics
  for (const key of [...COUNT_METRICS, ...FLOAT_METRICS, ...MONEY_METRICS] as AdditiveKey[]) {
    const name = publicMetricName(key);
    const count = present.get(key) ?? 0;
    if (invalid.has(key)) {
      result.unavailableMetrics.push({ metric: name, reason: "invalid_data" });
      continue;
    }
    if (count === 0) {
      result.unavailableMetrics.push({ metric: name, reason: "not_reported" });
      continue;
    }
    if (count < rows) result.partialMetrics.push(name);
    if ((MONEY_METRICS as readonly string[]).includes(key)) {
      const amounts = moneyAmounts(cells, (c) => c.sums.get(key), fx);
      if (amounts) result.money[key as MoneyKey] = amounts;
    } else {
      let total = 0n;
      for (const cell of cells) total += cell.sums.get(key) ?? 0n;
      result.numbers[key as CountKey | FloatKey] = total;
    }
  }
  if (reachPresent === 0) {
    result.unavailableMetrics.push({ metric: "reach", reason: "not_reported" });
  } else if (rows === 1) {
    result.reach = reach;
  } else {
    result.unavailableMetrics.push({ metric: "reach", reason: "non_additive" });
  }

  // KPIs
  for (const kpi of KPI_NAMES) {
    const [numKey, denKey] = KPI_FIELDS[kpi];
    const pairCells = cells.filter((c) => c.pairs.has(kpi));
    const pairRows = pairCells.reduce((n, c) => n + c.pairs.get(kpi)!.rows, 0);
    const unavailable = (reason: KpiUnavailableReason) =>
      result.unavailableKpis.push({ kpi, reason });

    if (invalid.has(numKey) || invalid.has(denKey)) {
      unavailable("invalid_data");
      continue;
    }
    if ((present.get(numKey) ?? 0) === 0) {
      unavailable("numerator_unavailable");
      continue;
    }
    if ((present.get(denKey) ?? 0) === 0 || pairRows === 0) {
      unavailable("denominator_unavailable");
      continue;
    }

    let produced = false;
    if (kpi === "ctr" || kpi === "conversionRate") {
      let num = 0n;
      let den = 0n;
      for (const cell of pairCells) {
        num += cell.pairs.get(kpi)!.num;
        den += cell.pairs.get(kpi)!.den;
      }
      if (den > 0n) {
        // conversionRate: num is fixed-point conversions, so num/den is already x 10^6.
        result.ratios[kpi] = kpi === "ctr" ? ratioFixed6(num, den) : roundDiv(num, den);
        produced = true;
      } else {
        unavailable("zero_denominator");
        continue;
      }
    } else if (kpi === "roas") {
      const currencies = new Set(pairCells.map((c) => c.currency));
      let num = 0n;
      let den = 0n;
      if (currencies.size === 1) {
        for (const cell of pairCells) {
          num += cell.pairs.get(kpi)!.num;
          den += cell.pairs.get(kpi)!.den;
        }
      } else {
        let complete = true;
        for (const cell of pairCells) {
          const pair = cell.pairs.get(kpi)!;
          const n = fx.convert(pair.num, cell.currency, cell.date);
          const d = fx.convert(pair.den, cell.currency, cell.date);
          if (n === undefined || d === undefined) complete = false;
          else {
            num += n;
            den += d;
          }
        }
        if (!complete) {
          unavailable("mixed_currency");
          continue;
        }
      }
      if (den > 0n) {
        result.ratios.roas = ratioFixed6(num, den);
        produced = true;
      } else {
        unavailable("zero_denominator");
        continue;
      }
    } else {
      const amounts = moneyKpi(kpi, pairCells, fx);
      if (amounts) {
        result.moneyKpis[kpi] = amounts;
        produced = true;
      } else {
        unavailable("zero_denominator");
        continue;
      }
    }
    if (produced && pairRows < rows) result.partialKpis.push(kpi);
  }
  return result;
}

/** CPC / CPM / cost per conversion from paired money numerators and count denominators. */
function moneyValue(kpi: MoneyKpi, spend: bigint, den: bigint): bigint | undefined {
  if (den <= 0n) return undefined;
  switch (kpi) {
    case "cpc":
      return roundDiv(spend, den);
    case "cpm":
      return roundDiv(spend * 1000n, den);
    case "costPerConversion":
      // den is fixed-point conversions (x 10^6).
      return roundDiv(spend * FIXED_SCALE, den);
  }
}

function moneyKpi(kpi: MoneyKpi, cells: Cell[], fx: FxConverter): MoneyAmounts | undefined {
  const native: NativeMoney[] = [];
  let reportingNum = 0n;
  let complete = true;
  let totalDen = 0n;
  for (const [currency, group] of byCurrency(cells)) {
    let num = 0n;
    let den = 0n;
    for (const cell of group) {
      const pair = cell.pairs.get(kpi)!;
      num += pair.num;
      den += pair.den;
      const converted = fx.convert(pair.num, currency, cell.date);
      if (converted === undefined) complete = false;
      else reportingNum += converted;
    }
    totalDen += den;
    const value = moneyValue(kpi, num, den);
    if (value !== undefined) native.push({ currency, micros: value });
  }
  const reporting = complete ? moneyValue(kpi, reportingNum, totalDen) : undefined;
  if (native.length === 0 && reporting === undefined) return undefined;
  return reporting === undefined ? { native } : { native, reporting };
}

/** Sanity check used by tests: the lists above cover the whole metric catalog. */
export function catalogKeys(): AdMetricKey[] {
  return Object.keys(AD_METRICS) as AdMetricKey[];
}
