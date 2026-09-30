import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/convex/_generated/api";
import { useAnalyticsQuery } from "./use-analytics-query";

const useQueryMock = vi.fn();
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

const argsA = { range: { from: "2026-09-01", to: "2026-09-30" } };
const argsB = { range: { from: "2026-08-01", to: "2026-08-31" } };

describe("useAnalyticsQuery", () => {
  beforeEach(() => useQueryMock.mockReset());

  it("is loading until the first result arrives", () => {
    useQueryMock.mockReturnValue(undefined);
    const { result } = renderHook(() => useAnalyticsQuery(api.v1.analytics.overview, argsA));
    expect(result.current).toEqual({ data: undefined, isLoading: true, isUpdating: false });
  });

  it("keeps the previous result while new arguments load", () => {
    const first = { marker: "first" };
    const second = { marker: "second" };
    useQueryMock.mockReturnValue(first);
    const { result, rerender } = renderHook(
      ({ args }) => useAnalyticsQuery(api.v1.analytics.overview, args),
      { initialProps: { args: argsA } },
    );
    expect(result.current).toEqual({ data: first, isLoading: false, isUpdating: false });

    useQueryMock.mockReturnValue(undefined);
    rerender({ args: argsB });
    expect(result.current).toEqual({ data: first, isLoading: false, isUpdating: true });

    useQueryMock.mockReturnValue(second);
    rerender({ args: argsB });
    expect(result.current).toEqual({ data: second, isLoading: false, isUpdating: false });
  });

  it("lets query errors propagate to the nearest boundary", () => {
    const failure = new Error("query failed");
    useQueryMock.mockImplementation(() => {
      throw failure;
    });
    expect(() => renderHook(() => useAnalyticsQuery(api.v1.analytics.overview, argsA))).toThrow(
      failure,
    );
    useQueryMock.mockReset();
  });

  it("passes skip through and returns nothing", () => {
    useQueryMock.mockReturnValue(undefined);
    const { result } = renderHook(() => useAnalyticsQuery(api.v1.analytics.overview, "skip"));
    expect(useQueryMock).toHaveBeenCalledWith(api.v1.analytics.overview, "skip");
    expect(result.current).toEqual({ data: undefined, isLoading: false, isUpdating: false });
  });
});
