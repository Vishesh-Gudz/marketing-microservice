import { describe, expect, it } from "vitest";
import { todayIn } from "../lib/dates";
import {
  bucketsOf,
  overlapDays,
  PERIOD_PRESETS,
  previousPeriod,
  rangeDays,
  rangeProblem,
  resolvePreset,
} from "./periods";

describe("presets (our explicit contract)", () => {
  const today = "2026-03-04"; // a Wednesday

  it("resolves every preset to inclusive ranges", () => {
    expect(Object.fromEntries(PERIOD_PRESETS.map((p) => [p, resolvePreset(p, today)]))).toEqual({
      today: { from: "2026-03-04", to: "2026-03-04" },
      yesterday: { from: "2026-03-03", to: "2026-03-03" },
      last_7_days: { from: "2026-02-25", to: "2026-03-03" },
      last_30_days: { from: "2026-02-02", to: "2026-03-03" },
      month_to_date: { from: "2026-03-01", to: "2026-03-04" },
      previous_month: { from: "2026-02-01", to: "2026-02-28" },
      week_to_date: { from: "2026-03-02", to: "2026-03-04" },
      previous_week: { from: "2026-02-23", to: "2026-03-01" },
    });
  });

  it("last_7_days / last_30_days are complete days only: today-N .. today-1", () => {
    expect(rangeDays(resolvePreset("last_7_days", today))).toBe(7);
    expect(rangeDays(resolvePreset("last_30_days", today))).toBe(30);
    expect(resolvePreset("last_7_days", today).to).toBe("2026-03-03");
  });

  it("handles year, leap-year and week boundaries", () => {
    expect(resolvePreset("previous_month", "2028-03-10")).toEqual({
      from: "2028-02-01",
      to: "2028-02-29",
    });
    expect(resolvePreset("previous_month", "2026-01-15")).toEqual({
      from: "2025-12-01",
      to: "2025-12-31",
    });
    // 2027-01-01 is a Friday; its ISO week started Monday 2026-12-28.
    expect(resolvePreset("week_to_date", "2027-01-01")).toEqual({
      from: "2026-12-28",
      to: "2027-01-01",
    });
    expect(resolvePreset("week_to_date", "2026-03-02")).toEqual({
      from: "2026-03-02",
      to: "2026-03-02",
    });
  });

  it("uses the org timezone's today across DST changes", () => {
    // New York switches to DST on 2026-03-08 at 07:00Z.
    expect(todayIn("America/New_York", Date.parse("2026-03-08T04:30:00Z"))).toBe("2026-03-07");
    expect(todayIn("America/New_York", Date.parse("2026-03-08T05:30:00Z"))).toBe("2026-03-08");
    // Berlin leaves DST on 2026-10-25.
    expect(todayIn("Europe/Berlin", Date.parse("2026-10-24T22:30:00Z"))).toBe("2026-10-25");
    expect(todayIn("Europe/Berlin", Date.parse("2026-10-25T22:30:00Z"))).toBe("2026-10-25");
  });
});

describe("ranges", () => {
  const options = { maxDays: 400 };

  it("validates dates, order and length from the range alone (no clock)", () => {
    expect(rangeProblem({ from: "2026-04-01", to: "2026-04-10" }, options)).toBeUndefined();
    expect(rangeProblem({ from: "2026-02-30", to: "2026-04-10" }, options)).toBe("invalid_date");
    expect(rangeProblem({ from: "2026-04-10", to: "2026-04-01" }, options)).toBe("from_after_to");
    expect(rangeProblem({ from: "2025-01-01", to: "2026-04-10" }, options)).toBe("too_long");
    // Future days are not rejected (they come back as "unknown"): validity never depends on "today".
    expect(rangeProblem({ from: "2030-01-01", to: "2030-01-31" }, options)).toBeUndefined();
  });

  it("computes the previous period of the same length", () => {
    expect(previousPeriod({ from: "2026-03-01", to: "2026-03-31" })).toEqual({
      from: "2026-01-29",
      to: "2026-02-28",
    });
    expect(previousPeriod({ from: "2026-04-10", to: "2026-04-10" })).toEqual({
      from: "2026-04-09",
      to: "2026-04-09",
    });
  });

  it("counts covered days", () => {
    const range = { from: "2026-04-01", to: "2026-04-10" };
    expect(overlapDays(range, { from: "2026-03-01", through: "2026-04-30" })).toBe(10);
    expect(overlapDays(range, { from: "2026-04-05", through: "2026-04-30" })).toBe(6);
    expect(overlapDays(range, { from: "2026-05-01", through: "2026-05-30" })).toBe(0);
    expect(overlapDays(range, {})).toBe(0);
  });
});

describe("buckets", () => {
  it("builds ISO-week buckets clipped to the range", () => {
    expect(bucketsOf({ from: "2026-03-04", to: "2026-03-17" }, "week")).toEqual([
      { key: "2026-03-02", from: "2026-03-04", to: "2026-03-08", partial: true },
      { key: "2026-03-09", from: "2026-03-09", to: "2026-03-15", partial: false },
      { key: "2026-03-16", from: "2026-03-16", to: "2026-03-17", partial: true },
    ]);
  });

  it("builds month buckets across year boundaries", () => {
    expect(bucketsOf({ from: "2025-12-15", to: "2026-02-28" }, "month")).toEqual([
      { key: "2025-12", from: "2025-12-15", to: "2025-12-31", partial: true },
      { key: "2026-01", from: "2026-01-01", to: "2026-01-31", partial: false },
      { key: "2026-02", from: "2026-02-01", to: "2026-02-28", partial: false },
    ]);
  });

  it("builds one day bucket per day", () => {
    const days = bucketsOf({ from: "2026-02-27", to: "2026-03-02" }, "day");
    expect(days.map((d) => d.key)).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(days.every((d) => !d.partial)).toBe(true);
  });
});
