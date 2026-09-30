import {
  PERIOD_PRESETS,
  rangeDays,
  rangeProblem,
  resolvePreset,
  type DateRange,
  type PeriodPreset,
  type RangeProblem,
} from "@/convex/analytics/periods";
import type { AdPlatform } from "./types";

/**
 * URL-driven dashboard filters (D3). Pure: parse/serialize URLSearchParams with
 * validation and safe fallbacks; resolve presets from the org timezone's
 * "today" (D12); choose chart granularity (D13).
 */

export const MAX_RANGE_DAYS = 400;
export const MAX_ACCOUNT_FILTER = 50;
export const PLATFORMS: readonly AdPlatform[] = ["meta", "google_ads"];

export type Granularity = "day" | "week" | "month";
export type GranularitySetting = "auto" | Granularity;
export type CompareMode = "off" | "previous" | "custom";
export type PresetSetting = PeriodPreset | "custom";

export type DashboardFilters = {
  preset: PresetSetting;
  /** Custom range (only with preset "custom"). */
  from?: string;
  to?: string;
  compare: CompareMode;
  compareFrom?: string;
  compareTo?: string;
  platforms: AdPlatform[];
  accounts: string[];
  granularity: GranularitySetting;
};

export const DEFAULT_FILTERS: DashboardFilters = {
  preset: "last_30_days",
  compare: "previous",
  platforms: [],
  accounts: [],
  granularity: "auto",
};

/** URL parameter names owned by the global filter bar (page params such as sort/tab are kept). */
export const FILTER_PARAMS = [
  "preset",
  "from",
  "to",
  "compare",
  "cfrom",
  "cto",
  "platforms",
  "accounts",
  "granularity",
] as const;

// ---------------------------------------------------------------------------
// D13: automatic granularity (product/UI rule; the API accepts any granularity)
// ---------------------------------------------------------------------------

/** <= 62 days -> day; 63-182 days -> week; > 182 days -> month. */
export function autoGranularity(days: number): Granularity {
  if (days <= 62) return "day";
  if (days <= 182) return "week";
  return "month";
}

/** A manual day/week/month setting always overrides "auto". */
export function effectiveGranularity(setting: GranularitySetting, range: DateRange): Granularity {
  return setting === "auto" ? autoGranularity(rangeDays(range)) : setting;
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

/** The API's own range validation (shared pure module), with the API's 400-day limit. */
export function rangeError(range: {
  from?: string | undefined;
  to?: string | undefined;
}): RangeProblem | undefined {
  return rangeProblem({ from: range.from ?? "", to: range.to ?? "" }, { maxDays: MAX_RANGE_DAYS });
}

export const RANGE_ERROR_TEXT: Record<RangeProblem, string> = {
  invalid_date: "Enter valid start and end dates.",
  from_after_to: "The start date must not be after the end date.",
  too_long: `A range can cover at most ${MAX_RANGE_DAYS} days.`,
};

/** The reporting range: a preset resolved against the org's today, or the custom range. */
export function resolveRange(filters: DashboardFilters, today: string): DateRange {
  if (filters.preset !== "custom") return resolvePreset(filters.preset, today);
  const custom = { from: filters.from, to: filters.to };
  return rangeError(custom) === undefined
    ? (custom as DateRange)
    : resolvePreset(DEFAULT_FILTERS.preset as PeriodPreset, today);
}

/** The API `compare` argument. */
export function resolveCompare(
  filters: DashboardFilters,
): "previous_period" | DateRange | undefined {
  if (filters.compare === "previous") return "previous_period";
  if (filters.compare === "custom") {
    const custom = { from: filters.compareFrom, to: filters.compareTo };
    return rangeError(custom) === undefined ? (custom as DateRange) : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// URL <-> filters
// ---------------------------------------------------------------------------

function list(value: string | null): string[] {
  if (!value) return [];
  return [
    ...new Set(
      value
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

export function parseFilters(params: URLSearchParams): DashboardFilters {
  const preset = params.get("preset");
  const from = params.get("from") ?? undefined;
  const to = params.get("to") ?? undefined;
  const filters: DashboardFilters = { ...DEFAULT_FILTERS, platforms: [], accounts: [] };

  if (preset === "custom" && rangeError({ from, to }) === undefined) {
    filters.preset = "custom";
    filters.from = from;
    filters.to = to;
  } else if ((PERIOD_PRESETS as readonly string[]).includes(preset ?? "")) {
    filters.preset = preset as PeriodPreset;
  }

  const compare = params.get("compare");
  if (compare === "off") filters.compare = "off";
  if (compare === "custom") {
    const compareFrom = params.get("cfrom") ?? undefined;
    const compareTo = params.get("cto") ?? undefined;
    if (rangeError({ from: compareFrom, to: compareTo }) === undefined) {
      filters.compare = "custom";
      filters.compareFrom = compareFrom;
      filters.compareTo = compareTo;
    }
  }

  filters.platforms = list(params.get("platforms")).filter((p): p is AdPlatform =>
    (PLATFORMS as readonly string[]).includes(p),
  );
  filters.accounts = list(params.get("accounts")).slice(0, MAX_ACCOUNT_FILTER);

  const granularity = params.get("granularity");
  if (granularity === "day" || granularity === "week" || granularity === "month") {
    filters.granularity = granularity;
  }
  return filters;
}

/**
 * Writes `filters` into a copy of `base`, keeping every non-filter parameter
 * (sort, tab, ...). Defaults are omitted so URLs stay short.
 */
export function serializeFilters(
  filters: DashboardFilters,
  base: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const name of FILTER_PARAMS) params.delete(name);
  if (filters.preset !== DEFAULT_FILTERS.preset) params.set("preset", filters.preset);
  if (filters.preset === "custom" && filters.from && filters.to) {
    params.set("from", filters.from);
    params.set("to", filters.to);
  }
  if (filters.compare !== DEFAULT_FILTERS.compare) params.set("compare", filters.compare);
  if (filters.compare === "custom" && filters.compareFrom && filters.compareTo) {
    params.set("cfrom", filters.compareFrom);
    params.set("cto", filters.compareTo);
  }
  if (filters.platforms.length > 0) params.set("platforms", filters.platforms.join(","));
  if (filters.accounts.length > 0) params.set("accounts", filters.accounts.join(","));
  if (filters.granularity !== DEFAULT_FILTERS.granularity) {
    params.set("granularity", filters.granularity);
  }
  return params;
}

/** Only the global filter params of `params` (carried along when drilling down). */
export function filterParamsOnly(params: URLSearchParams): URLSearchParams {
  const kept = new URLSearchParams();
  for (const name of FILTER_PARAMS) {
    const value = params.get(name);
    if (value !== null) kept.set(name, value);
  }
  return kept;
}

/** The API `filters` argument (omitted when nothing is filtered). */
export function apiFilters(
  filters: DashboardFilters,
): { platforms?: AdPlatform[]; accountIds?: string[] } | undefined {
  if (filters.platforms.length === 0 && filters.accounts.length === 0) return undefined;
  return {
    ...(filters.platforms.length > 0 ? { platforms: filters.platforms } : {}),
    ...(filters.accounts.length > 0 ? { accountIds: filters.accounts } : {}),
  };
}

export const PRESET_LABELS: Record<PresetSetting, string> = {
  today: "Today",
  yesterday: "Yesterday",
  last_7_days: "Last 7 days",
  last_30_days: "Last 30 days",
  month_to_date: "Month to date",
  previous_month: "Previous month",
  week_to_date: "Week to date",
  previous_week: "Previous week",
  custom: "Custom range",
};
