import { describe, expect, it } from "vitest";
import { ANALYTICS_LIMITS } from "@/convex/analytics/config";
import { MAX_ACCOUNT_FILTER, MAX_RANGE_DAYS } from "@/lib/analytics/filters";

// The dashboard validates ranges and account filters before calling the API. It may not
// import convex/analytics/config (D23), so this test (outside the guarded frontend
// directories) keeps its copies of the limits in sync with the API.
describe("dashboard limits", () => {
  it("mirror the API limits", () => {
    expect(MAX_RANGE_DAYS).toBe(ANALYTICS_LIMITS.maxRangeDays);
    expect(MAX_ACCOUNT_FILTER).toBe(ANALYTICS_LIMITS.maxAccountIds);
  });
});
