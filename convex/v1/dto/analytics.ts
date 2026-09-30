import { v, type Infer } from "convex/values";
import type { ActionGroup } from "../../analytics/actions";
import {
  COUNT_METRICS,
  FLOAT_METRICS,
  KPI_NAMES,
  KPI_UNAVAILABLE_REASONS,
  METRIC_NAMES,
  METRIC_UNAVAILABLE_REASONS,
  MONEY_KPIS,
  MONEY_METRICS,
  publicMetricName,
  RATIO_KPIS,
  type AggregateValues,
  type MoneyAmounts,
} from "../../analytics/aggregate";
import {
  DELTA_REASONS,
  type Deltas,
  type MoneyDelta,
  type NumberDelta,
} from "../../analytics/comparison";
import { DATA_STATES } from "../../analytics/coverage";
import { countToNumber, fixed6ToNumber } from "../../analytics/numeric";
import type {
  Aggregate,
  Comparison,
  CoverageResult,
  EntitySummary,
  FxResult,
  PerformanceRow,
} from "../../analytics/queries";
import {
  actionTypeValidator,
  adPlatformValidator,
  attributionBasisValidator,
  budgetTypeValidator,
  channelTypeValidator,
  deliveryStatusValidator,
  entityLevelValidator,
  entityStatusValidator,
  literalUnion,
  objectiveValidator,
  placementValidator,
} from "../../domain/validators";
import { toIso } from "../../lib/dto";
import { moneyDto, toMoneyDto } from "../../lib/money";

/**
 * Analytics DTOs (docs/analytics.md, docs/api/conventions.md).
 * - ALL money values (metrics AND money KPIs: cpc, cpm, costPerConversion) are
 *   MoneyAmountsDto: `native` (one Money per account currency) plus `reporting`
 *   (org reporting currency) when every needed exchange rate exists.
 * - Ratio KPIs (ctr, conversionRate, roas) and percent changes are fractions
 *   (0.0123 = 1.23%) as JSON numbers with at most 6 decimals.
 * - Unavailable values are omitted (never null, never 0) and explained in
 *   unavailableMetrics / unavailableKpis.
 */

export const dateRangeDto = v.object({ from: v.string(), to: v.string() });

export const moneyAmountsDto = v.object({
  native: v.array(moneyDto),
  reporting: v.optional(moneyDto),
});
export type MoneyAmountsDto = Infer<typeof moneyAmountsDto>;

const metricName = literalUnion(METRIC_NAMES);
const kpiName = literalUnion(KPI_NAMES);
export const dataStateDto = literalUnion(DATA_STATES);
const optionalNumber = v.optional(v.number());
const optionalMoney = v.optional(moneyAmountsDto);

export const metricsDto = v.object({
  spend: optionalMoney,
  conversionValue: optionalMoney,
  impressions: optionalNumber,
  clicks: optionalNumber,
  linkClicks: optionalNumber,
  reach: optionalNumber,
  videoPlays: optionalNumber,
  videoViews: optionalNumber,
  videoCompletions: optionalNumber,
  engagements: optionalNumber,
  reactions: optionalNumber,
  comments: optionalNumber,
  shares: optionalNumber,
  saves: optionalNumber,
  follows: optionalNumber,
  /** Platform primary conversions (fractional with data-driven attribution). */
  conversions: optionalNumber,
  allConversions: optionalNumber,
  unavailableMetrics: v.array(
    v.object({ metric: metricName, reason: literalUnion(METRIC_UNAVAILABLE_REASONS) }),
  ),
  partialMetrics: v.array(metricName),
});
export type MetricsDto = Infer<typeof metricsDto>;

export const kpisDto = v.object({
  ctr: optionalNumber,
  conversionRate: optionalNumber,
  roas: optionalNumber,
  cpc: optionalMoney,
  cpm: optionalMoney,
  costPerConversion: optionalMoney,
  unavailableKpis: v.array(
    v.object({ kpi: kpiName, reason: literalUnion(KPI_UNAVAILABLE_REASONS) }),
  ),
  partialKpis: v.array(kpiName),
});
export type KpisDto = Infer<typeof kpisDto>;

const numberDeltaDto = v.object({
  absolute: optionalNumber,
  percent: optionalNumber,
  reason: v.optional(literalUnion(DELTA_REASONS)),
  partial: v.optional(v.boolean()),
});
const moneyDeltaDto = v.object({
  absolute: optionalMoney,
  percent: optionalNumber,
  reason: v.optional(literalUnion(DELTA_REASONS)),
  partial: v.optional(v.boolean()),
});
const optionalNumberDelta = v.optional(numberDeltaDto);
const optionalMoneyDelta = v.optional(moneyDeltaDto);

export const deltasDto = v.object({
  spend: optionalMoneyDelta,
  conversionValue: optionalMoneyDelta,
  impressions: optionalNumberDelta,
  clicks: optionalNumberDelta,
  linkClicks: optionalNumberDelta,
  videoPlays: optionalNumberDelta,
  videoViews: optionalNumberDelta,
  videoCompletions: optionalNumberDelta,
  engagements: optionalNumberDelta,
  reactions: optionalNumberDelta,
  comments: optionalNumberDelta,
  shares: optionalNumberDelta,
  saves: optionalNumberDelta,
  follows: optionalNumberDelta,
  conversions: optionalNumberDelta,
  allConversions: optionalNumberDelta,
  ctr: optionalNumberDelta,
  conversionRate: optionalNumberDelta,
  roas: optionalNumberDelta,
  cpc: optionalMoneyDelta,
  cpm: optionalMoneyDelta,
  costPerConversion: optionalMoneyDelta,
});

const aggregateFields = { dataState: dataStateDto, metrics: metricsDto, kpis: kpisDto };
export const aggregateDto = v.object(aggregateFields);

export const comparisonDto = v.object({
  range: dateRangeDto,
  previous: aggregateDto,
  deltas: deltasDto,
});

export const coverageDto = v.object({
  dataState: dataStateDto,
  accounts: v.array(
    v.object({
      accountId: v.string(),
      coveredFrom: v.optional(v.string()),
      coveredThrough: v.optional(v.string()),
      daysUncovered: v.number(),
      lastSyncedAt: v.optional(v.string()),
      supported: v.boolean(),
    }),
  ),
});

export const fxDto = v.object({
  reportingCurrency: v.string(),
  status: v.union(v.literal("not_needed"), v.literal("complete"), v.literal("missing")),
  missing: v.optional(v.array(v.object({ currency: v.string(), days: v.number() }))),
});

export const granularityValidator = v.union(
  v.literal("day"),
  v.literal("week"),
  v.literal("month"),
);

export const timeSeriesDto = v.object({
  range: dateRangeDto,
  granularity: granularityValidator,
  level: entityLevelValidator,
  points: v.array(
    v.object({
      /** day: YYYY-MM-DD; week: the ISO week's Monday; month: YYYY-MM. */
      bucket: v.string(),
      from: v.string(),
      to: v.string(),
      /** The bucket is cut by the requested range. */
      partial: v.boolean(),
      ...aggregateFields,
    }),
  ),
  coverage: coverageDto,
  fx: fxDto,
});
export type TimeSeriesDto = Infer<typeof timeSeriesDto>;

export const performanceLevelValidator = v.union(
  v.literal("campaign"),
  v.literal("ad_group"),
  v.literal("ad"),
);

export const entitySummaryDto = v.object({
  id: v.string(),
  level: performanceLevelValidator,
  externalId: v.string(),
  name: v.string(),
  platform: adPlatformValidator,
  status: entityStatusValidator,
  deliveryStatus: v.optional(deliveryStatusValidator),
  accountId: v.string(),
  campaignId: v.optional(v.string()),
  adGroupId: v.optional(v.string()),
  currency: v.string(),
  removed: v.boolean(),
  objective: v.optional(objectiveValidator),
  channelType: v.optional(channelTypeValidator),
  budgetType: v.optional(budgetTypeValidator),
  budget: v.optional(moneyDto),
});

/**
 * Overview. With `entity` (Phase 7, D5) the totals/comparison/coverage/fx describe that one
 * campaign / ad group / ad, and `entity` carries its summary (the same EntitySummaryDto as
 * performance rows). Without `entity` the response is unchanged and `entity` is omitted.
 */
export const overviewDto = v.object({
  range: dateRangeDto,
  accountCount: v.number(),
  totals: aggregateDto,
  comparison: v.optional(comparisonDto),
  coverage: coverageDto,
  fx: fxDto,
  entity: v.optional(entitySummaryDto),
});
export type OverviewDto = Infer<typeof overviewDto>;

export const performanceRowDto = v.object({
  entity: entitySummaryDto,
  ...aggregateFields,
  comparison: v.optional(comparisonDto),
});

export const performancePageDto = v.object({
  page: v.array(performanceRowDto),
  isDone: v.boolean(),
  continueCursor: v.string(),
  range: dateRangeDto,
  fx: fxDto,
});
export type PerformancePageDto = Infer<typeof performancePageDto>;

export const breakdownByValidator = v.union(
  v.literal("platform"),
  v.literal("account"),
  v.literal("placement"),
);

export const breakdownDto = v.object({
  by: breakdownByValidator,
  level: entityLevelValidator,
  range: dateRangeDto,
  groups: v.array(
    v.object({
      key: v.string(),
      platform: v.optional(adPlatformValidator),
      accountId: v.optional(v.string()),
      placement: v.optional(placementValidator),
      ...aggregateFields,
    }),
  ),
  coverage: coverageDto,
  fx: fxDto,
});
export type BreakdownDto = Infer<typeof breakdownDto>;

const actionKpiName = v.union(v.literal("costPerAction"), v.literal("valuePerSpend"));

export const actionGroupDto = v.object({
  actionType: actionTypeValidator,
  rawActionType: v.string(),
  conversionActionExternalId: v.optional(v.string()),
  attributionWindow: v.string(),
  attributionBasis: attributionBasisValidator,
  isPrimary: v.optional(v.boolean()),
  /** Sum of the action count (fractional with data-driven attribution). */
  count: v.number(),
  value: optionalMoney,
  /** Some rows of the group did not report a value. */
  partialValue: v.boolean(),
  /**
   * Scope spend / group count: the spend of the same scope (same accounts or entity, same
   * level, placement "all", same range) divided by this group's summed count. Action rows
   * are sparse (no row on a day without the action), so spend is not paired row by row.
   * native: per account currency; reporting: converted spend / total count.
   */
  costPerAction: optionalMoney,
  /** Group value / scope spend (same scope definition), as a fraction. */
  valuePerSpend: optionalNumber,
  unavailableKpis: v.array(
    v.object({ kpi: actionKpiName, reason: literalUnion(KPI_UNAVAILABLE_REASONS) }),
  ),
});

export const actionsDto = v.object({
  range: dateRangeDto,
  level: entityLevelValidator,
  dataState: dataStateDto,
  groups: v.array(actionGroupDto),
  coverage: coverageDto,
  fx: fxDto,
});
export type ActionsDto = Infer<typeof actionsDto>;

// ---------------------------------------------------------------------------
// Mappers (bigint domain values -> JSON-safe DTOs)
// ---------------------------------------------------------------------------

const isFloat = (key: string) => (FLOAT_METRICS as readonly string[]).includes(key);

export function toMoneyAmountsDto(
  amounts: MoneyAmounts,
  reportingCurrency: string,
): MoneyAmountsDto {
  return {
    native: amounts.native.map((m) => toMoneyDto(m.micros, m.currency)),
    ...(amounts.reporting !== undefined
      ? { reporting: toMoneyDto(amounts.reporting, reportingCurrency) }
      : {}),
  };
}

export function toMetricsDto(values: AggregateValues, reportingCurrency: string): MetricsDto {
  const dto: Record<string, unknown> = {};
  for (const key of COUNT_METRICS) {
    const value = values.numbers[key];
    if (value !== undefined) dto[publicMetricName(key)] = countToNumber(value);
  }
  for (const key of FLOAT_METRICS) {
    const value = values.numbers[key];
    if (value !== undefined) dto[publicMetricName(key)] = fixed6ToNumber(value);
  }
  for (const key of MONEY_METRICS) {
    const value = values.money[key];
    if (value !== undefined)
      dto[publicMetricName(key)] = toMoneyAmountsDto(value, reportingCurrency);
  }
  if (values.reach !== undefined) dto.reach = values.reach;
  return {
    ...(dto as Omit<MetricsDto, "unavailableMetrics" | "partialMetrics">),
    unavailableMetrics: values.unavailableMetrics,
    partialMetrics: values.partialMetrics,
  };
}

export function toKpisDto(values: AggregateValues, reportingCurrency: string): KpisDto {
  const dto: Record<string, unknown> = {};
  for (const kpi of RATIO_KPIS) {
    const value = values.ratios[kpi];
    if (value !== undefined) dto[kpi] = fixed6ToNumber(value);
  }
  for (const kpi of MONEY_KPIS) {
    const value = values.moneyKpis[kpi];
    if (value !== undefined) dto[kpi] = toMoneyAmountsDto(value, reportingCurrency);
  }
  return {
    ...(dto as Omit<KpisDto, "unavailableKpis" | "partialKpis">),
    unavailableKpis: values.unavailableKpis,
    partialKpis: values.partialKpis,
  };
}

export function toAggregateDto(aggregate: Aggregate, reportingCurrency: string) {
  return {
    dataState: aggregate.dataState,
    metrics: toMetricsDto(aggregate.values, reportingCurrency),
    kpis: toKpisDto(aggregate.values, reportingCurrency),
  };
}

function toNumberDelta(delta: NumberDelta, scaled: boolean) {
  return {
    ...(delta.absolute !== undefined
      ? { absolute: scaled ? fixed6ToNumber(delta.absolute) : countToNumber(delta.absolute) }
      : {}),
    ...(delta.percent !== undefined ? { percent: fixed6ToNumber(delta.percent) } : {}),
    ...(delta.reason !== undefined ? { reason: delta.reason } : {}),
    ...(delta.partial ? { partial: true } : {}),
  };
}

function toMoneyDelta(delta: MoneyDelta, reportingCurrency: string) {
  return {
    ...(delta.absolute !== undefined
      ? { absolute: toMoneyAmountsDto(delta.absolute, reportingCurrency) }
      : {}),
    ...(delta.percent !== undefined ? { percent: fixed6ToNumber(delta.percent) } : {}),
    ...(delta.reason !== undefined ? { reason: delta.reason } : {}),
    ...(delta.partial ? { partial: true } : {}),
  };
}

export function toDeltasDto(deltas: Deltas, reportingCurrency: string) {
  const dto: Record<string, unknown> = {};
  for (const [name, delta] of Object.entries(deltas.numbers)) {
    const scaled = isFloat(name) || (RATIO_KPIS as readonly string[]).includes(name);
    dto[name] = toNumberDelta(delta, scaled);
  }
  for (const [name, delta] of Object.entries(deltas.money)) {
    dto[name] = toMoneyDelta(delta, reportingCurrency);
  }
  return dto as Infer<typeof deltasDto>;
}

export function toComparisonDto(comparison: Comparison, reportingCurrency: string) {
  return {
    range: comparison.range,
    previous: toAggregateDto(comparison.previous, reportingCurrency),
    deltas: toDeltasDto(comparison.deltas, reportingCurrency),
  };
}

export function toCoverageDto(coverage: CoverageResult) {
  return {
    dataState: coverage.dataState,
    accounts: coverage.accounts.map(({ lastSyncedAt, ...rest }) => ({
      ...rest,
      ...(lastSyncedAt !== undefined ? { lastSyncedAt: toIso(lastSyncedAt) } : {}),
    })),
  };
}

export function toFxDto(fx: FxResult) {
  return fx;
}

export function toEntitySummaryDto(entity: EntitySummary) {
  const { budgetMicros, ...rest } = entity;
  return {
    ...rest,
    ...(budgetMicros !== undefined ? { budget: toMoneyDto(budgetMicros, entity.currency) } : {}),
  };
}

export function toPerformanceRowDto(row: PerformanceRow, reportingCurrency: string) {
  return {
    entity: toEntitySummaryDto(row.entity),
    ...toAggregateDto(row.current, reportingCurrency),
    ...(row.comparison ? { comparison: toComparisonDto(row.comparison, reportingCurrency) } : {}),
  };
}

export function toActionGroupDto(group: ActionGroup, reportingCurrency: string) {
  return {
    actionType: group.actionType,
    rawActionType: group.rawActionType,
    ...(group.conversionActionExternalId !== undefined
      ? { conversionActionExternalId: group.conversionActionExternalId }
      : {}),
    attributionWindow: group.attributionWindow,
    attributionBasis: group.attributionBasis,
    ...(group.isPrimary !== undefined ? { isPrimary: group.isPrimary } : {}),
    count: fixed6ToNumber(group.count),
    ...(group.value ? { value: toMoneyAmountsDto(group.value, reportingCurrency) } : {}),
    partialValue: group.valuePartial,
    ...(group.costPerAction
      ? { costPerAction: toMoneyAmountsDto(group.costPerAction, reportingCurrency) }
      : {}),
    ...(group.valuePerSpend !== undefined
      ? { valuePerSpend: fixed6ToNumber(group.valuePerSpend) }
      : {}),
    unavailableKpis: group.unavailableKpis,
  };
}
