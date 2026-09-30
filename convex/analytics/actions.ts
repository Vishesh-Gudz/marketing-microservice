import type { Doc } from "../_generated/dataModel";
import type { ActionType, AttributionBasis } from "../domain/types";
import type { DateKey } from "../lib/dates";
import type { MoneyAmounts, NativeMoney } from "./aggregate";
import type { FxConverter } from "./fx";
import { FIXED_SCALE, ratioFixed6, roundDiv, toFixed6 } from "./numeric";

/**
 * PURE action-metric aggregation (docs/analytics.md "Action metrics").
 *
 * - Rows are grouped by (actionType, rawActionType, conversionActionExternalId,
 *   attributionWindow, attributionBasis, isPrimary). Different windows or
 *   action types are NEVER summed together (they are different measurements).
 * - count is summed as 6-decimal fixed point; value as micros per currency.
 * - Action rows are sparse (a day without a conversion has no row), so the
 *   per-action KPIs divide the SCOPE's total spend (same level, placement
 *   "all") by the group's total count: inside coverage a missing action row
 *   means zero actions, not unknown.
 * - Wide metricsDaily.conversions (platform primary conversions) is a separate
 *   measurement and is never derived from, or compared with, these groups.
 */

export type ActionKpi = "costPerAction" | "valuePerSpend";
export type ActionKpiReason =
  | "numerator_unavailable"
  | "denominator_unavailable"
  | "zero_denominator"
  | "mixed_currency"
  | "invalid_data";

export type ActionGroup = {
  actionType: ActionType;
  rawActionType: string;
  conversionActionExternalId?: string;
  attributionWindow: string;
  attributionBasis: AttributionBasis;
  isPrimary?: boolean;
  rows: number;
  /** 6-decimal fixed point. */
  count: bigint;
  value?: MoneyAmounts;
  valuePartial: boolean;
  costPerAction?: MoneyAmounts;
  /** value / spend, 6-decimal fixed point. */
  valuePerSpend?: bigint;
  unavailableKpis: { kpi: ActionKpi; reason: ActionKpiReason }[];
};

type ActionRow = Pick<
  Doc<"actionMetricsDaily">,
  | "actionType"
  | "rawActionType"
  | "conversionActionExternalId"
  | "attributionWindow"
  | "attributionBasis"
  | "isPrimary"
  | "count"
  | "valueMicros"
  | "currency"
  | "date"
>;
type SpendRow = Pick<Doc<"metricsDaily">, "currency" | "date" | "spendMicros">;

type Working = {
  group: Omit<
    ActionGroup,
    "count" | "value" | "valuePartial" | "costPerAction" | "valuePerSpend" | "unavailableKpis"
  >;
  countByCurrency: Map<string, bigint>;
  valueCells: Map<string, { currency: string; date: DateKey; micros: bigint }>;
  valueRows: number;
  invalid: boolean;
};

function groupKey(row: ActionRow): string {
  return JSON.stringify([
    row.actionType,
    row.rawActionType,
    row.conversionActionExternalId ?? null,
    row.attributionWindow,
    row.attributionBasis,
    row.isPrimary ?? null,
  ]);
}

function sortedCurrencies<T>(map: Map<string, T>): [string, T][] {
  return [...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

export function aggregateActions(
  rows: readonly ActionRow[],
  spendRows: readonly SpendRow[],
  fx: FxConverter,
): ActionGroup[] {
  // Scope spend per (currency, day).
  const spendCells = new Map<string, { currency: string; date: DateKey; micros: bigint }>();
  let spendRowsReported = 0;
  for (const row of spendRows) {
    if (row.spendMicros === undefined) continue;
    spendRowsReported++;
    const key = `${row.currency}|${row.date}`;
    const cell = spendCells.get(key) ?? { currency: row.currency, date: row.date, micros: 0n };
    cell.micros += row.spendMicros;
    spendCells.set(key, cell);
  }
  const spendByCurrency = new Map<string, bigint>();
  let spendReporting = 0n;
  let spendReportingComplete = true;
  for (const cell of spendCells.values()) {
    spendByCurrency.set(cell.currency, (spendByCurrency.get(cell.currency) ?? 0n) + cell.micros);
    const converted = fx.convert(cell.micros, cell.currency, cell.date);
    if (converted === undefined) spendReportingComplete = false;
    else spendReporting += converted;
  }

  const groups = new Map<string, Working>();
  for (const row of rows) {
    const key = groupKey(row);
    let working = groups.get(key);
    if (working === undefined) {
      working = {
        group: {
          actionType: row.actionType,
          rawActionType: row.rawActionType,
          ...(row.conversionActionExternalId !== undefined
            ? { conversionActionExternalId: row.conversionActionExternalId }
            : {}),
          attributionWindow: row.attributionWindow,
          attributionBasis: row.attributionBasis,
          ...(row.isPrimary !== undefined ? { isPrimary: row.isPrimary } : {}),
          rows: 0,
        },
        countByCurrency: new Map(),
        valueCells: new Map(),
        valueRows: 0,
        invalid: false,
      };
      groups.set(key, working);
    }
    working.group.rows++;
    if (!Number.isFinite(row.count) || row.count < 0) {
      working.invalid = true;
    } else {
      const count = toFixed6(row.count);
      working.countByCurrency.set(
        row.currency,
        (working.countByCurrency.get(row.currency) ?? 0n) + count,
      );
    }
    if (row.valueMicros !== undefined) {
      if (row.valueMicros < 0n) working.invalid = true;
      working.valueRows++;
      const cellKey = `${row.currency}|${row.date}`;
      const cell = working.valueCells.get(cellKey) ?? {
        currency: row.currency,
        date: row.date,
        micros: 0n,
      };
      cell.micros += row.valueMicros;
      working.valueCells.set(cellKey, cell);
    }
  }

  const result: ActionGroup[] = [];
  for (const working of groups.values()) {
    const { group } = working;
    const count = [...working.countByCurrency.values()].reduce((a, b) => a + b, 0n);
    const out: ActionGroup = {
      ...group,
      count,
      valuePartial: working.valueRows > 0 && working.valueRows < group.rows,
      unavailableKpis: [],
    };
    const unavailable = (kpi: ActionKpi, reason: ActionKpiReason) =>
      out.unavailableKpis.push({ kpi, reason });

    // Value (native per currency + reporting).
    if (working.valueRows > 0) {
      const byCurrency = new Map<string, bigint>();
      let reporting = 0n;
      let complete = true;
      for (const cell of working.valueCells.values()) {
        byCurrency.set(cell.currency, (byCurrency.get(cell.currency) ?? 0n) + cell.micros);
        const converted = fx.convert(cell.micros, cell.currency, cell.date);
        if (converted === undefined) complete = false;
        else reporting += converted;
      }
      const native: NativeMoney[] = sortedCurrencies(byCurrency).map(([currency, micros]) => ({
        currency,
        micros,
      }));
      out.value = complete ? { native, reporting } : { native };
    }

    if (working.invalid) {
      unavailable("costPerAction", "invalid_data");
      unavailable("valuePerSpend", "invalid_data");
      result.push(out);
      continue;
    }

    // Cost per action = scope spend / group count.
    if (spendRowsReported === 0) {
      unavailable("costPerAction", "numerator_unavailable");
    } else if (count <= 0n) {
      unavailable("costPerAction", "zero_denominator");
    } else {
      const native: NativeMoney[] = [];
      for (const [currency, countInCurrency] of sortedCurrencies(working.countByCurrency)) {
        const spend = spendByCurrency.get(currency);
        if (spend === undefined || countInCurrency <= 0n) continue;
        native.push({ currency, micros: roundDiv(spend * FIXED_SCALE, countInCurrency) });
      }
      const reporting = spendReportingComplete
        ? roundDiv(spendReporting * FIXED_SCALE, count)
        : undefined;
      out.costPerAction = reporting === undefined ? { native } : { native, reporting };
    }

    // Value per spend (action ROAS).
    if (out.value === undefined) {
      unavailable("valuePerSpend", "numerator_unavailable");
    } else if (spendRowsReported === 0) {
      unavailable("valuePerSpend", "denominator_unavailable");
    } else {
      const currencies = new Set([
        ...spendByCurrency.keys(),
        ...out.value.native.map((m) => m.currency),
      ]);
      let num: bigint | undefined;
      let den: bigint | undefined;
      if (currencies.size === 1) {
        num = out.value.native[0]!.micros;
        den = [...spendByCurrency.values()][0]!;
      } else if (out.value.reporting !== undefined && spendReportingComplete) {
        num = out.value.reporting;
        den = spendReporting;
      }
      if (num === undefined || den === undefined) unavailable("valuePerSpend", "mixed_currency");
      else if (den <= 0n) unavailable("valuePerSpend", "zero_denominator");
      else out.valuePerSpend = ratioFixed6(num, den);
    }
    result.push(out);
  }

  return result.sort((a, b) => {
    const primary = Number(b.isPrimary ?? false) - Number(a.isPrimary ?? false);
    if (primary !== 0) return primary;
    for (const [x, y] of [
      [a.actionType, b.actionType],
      [a.rawActionType, b.rawActionType],
      [a.attributionWindow, b.attributionWindow],
    ] as const) {
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
}
