import { describe, expect, it } from "vitest";
import {
  addDays,
  assertDateKey,
  compareDateKeys,
  DateKeyError,
  diffDays,
  eachDay,
  isDateKey,
  isoWeekKey,
  MAX_DAY_SPAN,
  monthChunks,
  monthKey,
  startOfIsoWeek,
  toDateKey,
  todayIn,
} from "./dates";

describe("DateKey validation", () => {
  it.each(["2026-09-24", "2024-02-29", "2000-01-01"])("accepts %s", (key) => {
    expect(isDateKey(key)).toBe(true);
  });

  it.each(["2026-9-24", "2026-02-30", "2025-02-29", "2026-13-01", "20260924", "", 20260924])(
    "rejects %j",
    (key) => {
      expect(isDateKey(key)).toBe(false);
    },
  );

  it("assertDateKey throws a DateKeyError", () => {
    expect(() => assertDateKey("2026-02-30")).toThrow(DateKeyError);
  });
});

describe("toDateKey (calendar day in a time zone)", () => {
  const instant = Date.UTC(2026, 8, 24, 3, 30); // 2026-09-24T03:30Z

  it("uses the target zone's calendar day", () => {
    expect(toDateKey(instant, "UTC")).toBe("2026-09-24");
    expect(toDateKey(instant, "America/Los_Angeles")).toBe("2026-09-23");
    expect(toDateKey(instant, "Asia/Kolkata")).toBe("2026-09-24");
  });

  it("handles extreme offsets (UTC+14 and UTC-12)", () => {
    const lateUtc = Date.UTC(2026, 8, 24, 11, 0);
    expect(toDateKey(lateUtc, "Pacific/Kiritimati")).toBe("2026-09-25");
    expect(toDateKey(lateUtc, "Etc/GMT+12")).toBe("2026-09-23");
  });

  it("handles DST transition days", () => {
    // US DST ends 2026-11-01 at 06:00Z (02:00 EDT -> 01:00 EST).
    expect(toDateKey(Date.UTC(2026, 10, 1, 3, 59), "America/New_York")).toBe("2026-10-31");
    expect(toDateKey(Date.UTC(2026, 10, 1, 4, 0), "America/New_York")).toBe("2026-11-01");
    expect(toDateKey(Date.UTC(2026, 10, 2, 4, 59), "America/New_York")).toBe("2026-11-01");
    expect(toDateKey(Date.UTC(2026, 10, 2, 5, 0), "America/New_York")).toBe("2026-11-02");
  });

  it("todayIn uses the supplied clock", () => {
    expect(todayIn("Asia/Tokyo", Date.UTC(2026, 11, 31, 15, 0))).toBe("2027-01-01");
  });
});

describe("arithmetic", () => {
  it("adds days across month, year and leap boundaries", () => {
    expect(addDays("2026-09-30", 1)).toBe("2026-10-01");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("diffs and compares", () => {
    expect(diffDays("2026-01-01", "2026-12-31")).toBe(364);
    expect(diffDays("2026-09-24", "2026-09-20")).toBe(-4);
    expect(compareDateKeys("2026-09-01", "2026-10-01")).toBe(-1);
    expect(compareDateKeys("2026-09-01", "2026-09-01")).toBe(0);
  });

  it("enumerates inclusive ranges with a safety cap", () => {
    expect(eachDay("2026-09-29", "2026-10-02")).toEqual([
      "2026-09-29",
      "2026-09-30",
      "2026-10-01",
      "2026-10-02",
    ]);
    expect(eachDay("2026-09-24", "2026-09-24")).toEqual(["2026-09-24"]);
    expect(() => eachDay("2026-09-25", "2026-09-24")).toThrow(DateKeyError);
    expect(() => eachDay("2000-01-01", addDays("2000-01-01", MAX_DAY_SPAN))).toThrow(DateKeyError);
  });
});

describe("buckets", () => {
  it("builds month keys and month chunks", () => {
    expect(monthKey("2026-09-24")).toBe("2026-09");
    expect(monthChunks("2026-01-15", "2026-03-10")).toEqual([
      { from: "2026-01-15", to: "2026-01-31" },
      { from: "2026-02-01", to: "2026-02-28" },
      { from: "2026-03-01", to: "2026-03-10" },
    ]);
    expect(monthChunks("2024-02-10", "2024-02-29")).toEqual([
      { from: "2024-02-10", to: "2024-02-29" },
    ]);
  });

  it("computes ISO weeks, including year-crossing weeks", () => {
    expect(startOfIsoWeek("2026-09-24")).toBe("2026-09-21");
    expect(isoWeekKey("2026-09-24")).toBe("2026-W39");
    expect(isoWeekKey("2026-12-31")).toBe("2026-W53");
    expect(isoWeekKey("2027-01-01")).toBe("2026-W53");
    expect(isoWeekKey("2025-12-29")).toBe("2026-W01");
    expect(isoWeekKey("2021-01-03")).toBe("2020-W53");
  });
});
