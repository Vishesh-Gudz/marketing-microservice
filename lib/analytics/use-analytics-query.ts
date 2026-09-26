"use client";

import { useQuery, type OptionalRestArgsOrSkip } from "convex/react";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import { useState } from "react";

export type AnalyticsQueryState<T> = {
  /** The latest result, or the previous result while new arguments load. */
  data: T | undefined;
  /** Nothing to show yet (first load). */
  isLoading: boolean;
  /** `data` is from previous arguments; a new result is on its way. */
  isUpdating: boolean;
};

/**
 * Convex `useQuery` (reactive, cached, no extra client cache — D2/D4) that keeps
 * the previous result while new arguments load, so changing a filter dims the
 * view instead of flashing skeletons. Errors still throw to the nearest
 * QueryBoundary. "skip" returns nothing.
 */
export function useAnalyticsQuery<Query extends FunctionReference<"query">>(
  query: Query,
  args: FunctionArgs<Query> | "skip",
): AnalyticsQueryState<FunctionReturnType<Query>> {
  const result = useQuery(query, ...([args] as OptionalRestArgsOrSkip<Query>));
  const [stored, setStored] = useState<{ data: FunctionReturnType<Query> } | undefined>(undefined);
  // Derived state (updated during render): remember the last result we saw.
  if (result !== undefined && stored?.data !== result) setStored({ data: result });

  if (args === "skip") return { data: undefined, isLoading: false, isUpdating: false };
  const data = result ?? stored?.data;
  return {
    data,
    isLoading: data === undefined,
    isUpdating: result === undefined && data !== undefined,
  };
}
