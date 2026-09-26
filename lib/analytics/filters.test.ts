import { describe, expect, it } from "vitest";
import { todayIn } from "@/convex/lib/dates";
import {
  DEFAULT_FILTERS,
  MAX_ACCOUNT_FILTER,
  apiFilters,
  autoGranularity,
  effectiveGranularity,
  filterParamsOnly,
  parseFilters,
  rangeError,
  resolveCompare,
  resolveRange,
  serializeFilters,
} from "./filters";

const params = (query: string) => new URLSearchParams(query);

describe("D13 granularity", () => {
  it("auto: <= 62 days day, 63-182 week, > 182 month", () => {
    expect(autoGranularity(1)).toBe("day");
    expect(autoGranularity(62)).toBe("day");
    expect(autoGranularity(63)).toBe("week");
    expect(autoGranularity(182)).toBe("week");
    expect(autoGranularity(183)).toBe("month");
    expect(autoGranularity(400)).toBe("month");
  });

  it("uses the inclusive range length", () => {
    // 2026-01-01..2026-03-03 = 62 days; ..03-04 = 63 days.
    expect(effectiveGranularity("auto", { from: "2026-01-01", to: "2026-03-03" })).toBe("day");
    expect(effectiveGranularity("auto", { from: "2026-01-01", to: "2026-03-04" })).toBe("week");
    // 2026-01-01..2026-07-01 = 182 days; ..07-02 = 183 days.
    expect(effectiveGranularity("auto", { from: "2026-01-01", to: "2026-07-01" })).toBe("week");
    expect(effectiveGranularity("auto", { from: "2026-01-01", to: "2026-07-02" })).toBe("month");
  });

  it("manual day/week/month always overrides auto", () => {
    const long = { from: "2025-01-01", to: "2025-12-31" };
    const short = { from: "2026-01-01", to: "2026-01-07" };
    expect(effectiveGranularity("day", long)).toBe("day");
    expect(effectiveGranularity("week", short)).toBe("week");
    expect(effectiveGranularity("month", short)).toBe("month");
  });
});

describe("URL filters", () => {
  it("defaults to the last 30 days compared with the previous period", () => {
    expect(parseFilters(params(""))).toEqual(DEFAULT_FILTERS);
    expect(serializeFilters(DEFAULT_FILTERS).toString()).toBe("");
  });

  it("round-trips every filter", () => {
    const filters = {
      preset: "custom" as const,
      from: "2026-01-01",
      to: "2026-01-31",
      compare: "custom" as const,
      compareFrom: "2025-01-01",
      compareTo: "2025-01-31",
      platforms: ["meta" as const],
      accounts: ["a1", "a2"],
      granularity: "week" as const,
    };
    const query = serializeFilters(filters);
    expect(query.toString()).toBe(
      "preset=custom&from=2026-01-01&to=2026-01-31&compare=custom&cfrom=2025-01-01&cto=2025-01-31&platforms=meta&accounts=a1%2Ca2&granularity=week",
    );
    expect(parseFilters(query)).toEqual(filters);
  });

  it("falls back safely on invalid values", () => {
    const parsed = parseFilters(
      params(
        "preset=last_999_days&compare=sometimes&platforms=meta,tiktok,meta&granularity=hour&accounts=,x,,x",
      ),
    );
    expect(parsed.preset).toBe("last_30_days");
    expect(parsed.compare).toBe("previous");
    expect(parsed.platforms).toEqual(["meta"]);
    expect(parsed.accounts).toEqual(["x"]);
    expect(parsed.granularity).toBe("auto");
  });

  it("rejects invalid custom ranges (falls back to the default preset)", () => {
    expect(parseFilters(params("preset=custom&from=2026-02-30&to=2026-03-01")).preset).toBe(
      "last_30_days",
    );
    expect(parseFilters(params("preset=custom&from=2026-03-02&to=2026-03-01")).preset).toBe(
      "last_30_days",
    );
    expect(parseFilters(params("preset=custom&from=2024-01-01&to=2026-01-01")).preset).toBe(
      "last_30_days",
    );
    expect(parseFilters(params("compare=custom&cfrom=bad&cto=2026-01-01")).compare).toBe(
      "previous",
    );
  });

  it("caps the account filter at the API limit", () => {
    const ids = Array.from({ length: 60 }, (_, i) => `a${i}`).join(",");
    expect(parseFilters(params(`accounts=${ids}`)).accounts).toHaveLength(MAX_ACCOUNT_FILTER);
  });

  it("keeps page params when writing filters and extracts filter params for links", () => {
    const base = params("sort=name&dir=asc&preset=today");
    const next = serializeFilters({ ...DEFAULT_FILTERS, preset: "yesterday" }, base);
    expect(next.get("sort")).toBe("name");
    expect(next.get("preset")).toBe("yesterday");
    expect(filterParamsOnly(next).toString()).toBe("preset=yesterday");
  });
});

describe("API arguments", () => {
  it("resolves presets from the org's today", () => {
    expect(resolveRange(DEFAULT_FILTERS, "2026-09-25")).toEqual({
      from: "2026-08-26",
      to: "2026-09-24",
    });
    expect(resolveRange({ ...DEFAULT_FILTERS, preset: "today" }, "2026-09-25")).toEqual({
      from: "2026-09-25",
      to: "2026-09-25",
    });
    expect(
      resolveRange(
        { ...DEFAULT_FILTERS, preset: "custom", from: "2026-01-01", to: "2026-01-02" },
        "2026-09-25",
      ),
    ).toEqual({ from: "2026-01-01", to: "2026-01-02" });
  });

  it("uses the org timezone's today, also across DST changes", () => {
    // 2026-03-08 06:30 UTC: US DST starts that night; New York is still on the 8th (01:30 EST),
    // Tokyo is already on the 8th (15:30), Honolulu (no DST) is still on the 7th (20:30).
    const instant = Date.UTC(2026, 2, 8, 6, 30);
    const newYork = todayIn("America/New_York", instant);
    expect(newYork).toBe("2026-03-08");
    expect(todayIn("Pacific/Honolulu", instant)).toBe("2026-03-07");
    expect(resolveRange({ ...DEFAULT_FILTERS, preset: "yesterday" }, newYork)).toEqual({
      from: "2026-03-07",
      to: "2026-03-07",
    });
    // Autumn change: 2026-11-01 05:30 UTC is 01:30 EDT/EST on the 1st in New York.
    expect(todayIn("America/New_York", Date.UTC(2026, 10, 1, 5, 30))).toBe("2026-11-01");
    expect(resolveRange({ ...DEFAULT_FILTERS, preset: "last_7_days" }, "2026-11-01")).toEqual({
      from: "2026-10-25",
      to: "2026-10-31",
    });
  });

  it("maps compare modes", () => {
    expect(resolveCompare(DEFAULT_FILTERS)).toBe("previous_period");
    expect(resolveCompare({ ...DEFAULT_FILTERS, compare: "off" })).toBeUndefined();
    expect(
      resolveCompare({
        ...DEFAULT_FILTERS,
        compare: "custom",
        compareFrom: "2025-01-01",
        compareTo: "2025-01-02",
      }),
    ).toEqual({ from: "2025-01-01", to: "2025-01-02" });
  });

  it("omits empty filters", () => {
    expect(apiFilters(DEFAULT_FILTERS)).toBeUndefined();
    expect(apiFilters({ ...DEFAULT_FILTERS, platforms: ["google_ads"] })).toEqual({
      platforms: ["google_ads"],
    });
    expect(apiFilters({ ...DEFAULT_FILTERS, accounts: ["a"] })).toEqual({ accountIds: ["a"] });
  });

  it("validates ranges like the API", () => {
    expect(rangeError({ from: "2026-01-01", to: "2026-01-01" })).toBeUndefined();
    expect(rangeError({ from: "2026-01-02", to: "2026-01-01" })).toBe("from_after_to");
    expect(rangeError({ from: "", to: "2026-01-01" })).toBe("invalid_date");
    expect(rangeError({ from: "2025-01-01", to: "2026-02-05" })).toBe("too_long");
  });
});
