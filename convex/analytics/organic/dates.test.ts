import { describe, expect, it } from "vitest";
import { addDays, toDateKey } from "../../lib/dates";
import { resolveOrganicPreset, zonedDayStart, zonedRangeInstants } from "./dates";

// Phase 10 Stage B (R12): account-metric presets resolve against today in UTC; post publish
// filters are org-timezone calendar days turned into exact instants.

describe("resolveOrganicPreset (UTC)", () => {
  it("uses today's UTC day even where the local day differs", () => {
    // 02:00 UTC on Sep 29 is still Sep 28 in Los Angeles; the UTC day decides.
    const now = Date.UTC(2026, 8, 29, 2);
    expect(toDateKey(now, "America/Los_Angeles")).toBe("2026-09-28");
    expect(resolveOrganicPreset("today", now)).toEqual({ from: "2026-09-29", to: "2026-09-29" });
    expect(resolveOrganicPreset("last_7_days", now)).toEqual({
      from: "2026-09-22",
      to: "2026-09-28",
    });
    expect(resolveOrganicPreset("previous_month", now)).toEqual({
      from: "2026-08-01",
      to: "2026-08-31",
    });
  });
});

describe("zonedDayStart", () => {
  it.each([
    ["UTC", "2026-09-28", Date.UTC(2026, 8, 28)],
    ["Asia/Tokyo", "2026-09-28", Date.UTC(2026, 8, 27, 15)],
    ["America/New_York", "2026-03-08", Date.UTC(2026, 2, 8, 5)], // EST, DST starts at 02:00
    ["America/New_York", "2026-03-09", Date.UTC(2026, 2, 9, 4)], // EDT
    ["America/New_York", "2026-11-01", Date.UTC(2026, 10, 1, 4)], // EDT until 02:00
    ["Pacific/Kiritimati", "2026-09-28", Date.UTC(2026, 8, 27, 10)], // +14
    ["Pacific/Pago_Pago", "2026-09-28", Date.UTC(2026, 8, 28, 11)], // -11
    ["Asia/Kolkata", "2026-09-28", Date.UTC(2026, 8, 27, 18, 30)], // +5:30
  ])("%s %s", (zone, day, expected) => {
    expect(zonedDayStart(day, zone)).toBe(expected);
  });

  it.each(["America/Santiago", "America/Sao_Paulo", "Australia/Lord_Howe", "Europe/London"])(
    "is the first instant of the local day in %s, across a year",
    (zone) => {
      for (let i = 0; i < 366; i += 7) {
        const day = addDays("2026-01-01", i);
        const start = zonedDayStart(day, zone);
        expect(toDateKey(start, zone)).toBe(day);
        expect(toDateKey(start - 1, zone) < day).toBe(true);
      }
    },
  );
});

describe("zonedRangeInstants", () => {
  it("is [start of from, start of the day after to) in the zone", () => {
    expect(zonedRangeInstants({ from: "2026-09-01", to: "2026-09-30" }, "Asia/Tokyo")).toEqual({
      start: Date.UTC(2026, 7, 31, 15),
      end: Date.UTC(2026, 8, 30, 15),
    });
    expect(zonedRangeInstants({}, "UTC")).toEqual({});
    expect(zonedRangeInstants({ to: "2026-09-30" }, "UTC")).toEqual({ end: Date.UTC(2026, 9, 1) });
  });
});
