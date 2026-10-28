"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  apiFilters,
  effectiveGranularity,
  parseFilters,
  resolveCompare,
  resolveRange,
  serializeFilters,
  type DashboardFilters,
} from "./filters";
import { useOrgToday, usePacificToday, useUtcToday } from "./org-context";

/**
 * Dashboard state lives in the URL (D3): shareable, reload-safe. Updates use
 * router.replace without scrolling. Must render inside <Suspense> (useSearchParams).
 */
export function useDashboardFilters() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const filters = parseFilters(new URLSearchParams(searchParams.toString()));

  const navigate = (params: URLSearchParams) => {
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };

  return {
    filters,
    searchParams,
    setFilters(next: DashboardFilters) {
      navigate(serializeFilters(next, new URLSearchParams(searchParams.toString())));
    },
    /** Sets (or, with undefined, removes) page-level params such as sort or tab. */
    setParams(updates: Record<string, string | undefined>) {
      const params = new URLSearchParams(searchParams.toString());
      for (const [name, value] of Object.entries(updates)) {
        if (value === undefined) params.delete(name);
        else params.set(name, value);
      }
      navigate(params);
    },
  };
}

/**
 * Which calendar presets resolve against: the org's days (paid), UTC days (organic Instagram)
 * or Pacific Time days (YouTube channel days, ADR 0016).
 */
export type DayBasis = "org" | "utc" | "pacific";

/**
 * The API arguments derived from the URL filters and "today": the org timezone's today by
 * default (paid analytics, unchanged); UTC's today with `dayBasis: "utc"` (organic account
 * metrics are keyed by UTC day); Pacific Time's today with `dayBasis: "pacific"` (YouTube).
 */
export function useAnalyticsScope(options: { dayBasis?: DayBasis } = {}) {
  const { filters } = useDashboardFilters();
  const orgToday = useOrgToday();
  const utcToday = useUtcToday();
  const pacificToday = usePacificToday();
  const today =
    options.dayBasis === "utc"
      ? utcToday
      : options.dayBasis === "pacific"
        ? pacificToday
        : orgToday;
  const range = resolveRange(filters, today);
  const compare = resolveCompare(filters);
  return {
    filters,
    range,
    compare,
    apiFilters: apiFilters(filters),
    granularity: effectiveGranularity(filters.granularity, range),
  };
}
