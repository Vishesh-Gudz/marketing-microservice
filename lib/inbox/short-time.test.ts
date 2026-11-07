import { describe, expect, it } from "vitest";
import { shortTime } from "./short-time";

// Rows show messaging-app times; days count in the org's time zone.

const NOW = Date.parse("2026-11-04T12:00:00.000Z"); // Wed 4 Nov, 17:30 in Kolkata
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

describe("shortTime", () => {
  it("counts minutes, then hours, within the same day", () => {
    expect(shortTime(at(0.5), NOW, "UTC")).toBe("now");
    expect(shortTime(at(5), NOW, "UTC")).toBe("5m");
    expect(shortTime(at(59), NOW, "UTC")).toBe("59m");
    expect(shortTime(at(3 * 60), NOW, "UTC")).toBe("3h");
    // A clock a little ahead never shows a negative time.
    expect(shortTime(at(-2), NOW, "UTC")).toBe("now");
  });

  it("says Yesterday, then the weekday within a week, then the date", () => {
    expect(shortTime("2026-11-03T20:00:00.000Z", NOW, "UTC")).toBe("Yesterday");
    expect(shortTime("2026-11-02T09:00:00.000Z", NOW, "UTC")).toBe("Mon");
    expect(shortTime("2026-10-21T09:00:00.000Z", NOW, "UTC")).toBe("Oct 21");
    expect(shortTime("2025-12-30T09:00:00.000Z", NOW, "UTC")).toBe("Dec 30, 2025");
  });

  it("counts days in the organization's time zone", () => {
    // 23:00 UTC on 3 Nov is already 4 Nov in Kolkata (UTC+5:30), but 9 hours earlier.
    expect(shortTime("2026-11-03T23:00:00.000Z", NOW, "Asia/Kolkata")).toBe("13h");
    expect(shortTime("2026-11-03T23:00:00.000Z", NOW, "UTC")).toBe("Yesterday");
  });
});
