import { describe, expect, it } from "vitest";
import { clockTime, continuesPrevious, dayLabel, timeLeft } from "./conversation-time";

// Day breaks, clock times and reply-window countdowns inside a conversation, in the org's time
// zone.

const NOW = Date.parse("2026-11-04T12:00:00.000Z"); // Wed 4 Nov, 17:30 in Kolkata

describe("dayLabel", () => {
  it("says Today, Yesterday, the weekday within a week, then the date", () => {
    expect(dayLabel("2026-11-04T01:00:00.000Z", NOW, "UTC")).toBe("Today");
    expect(dayLabel("2026-11-03T23:59:00.000Z", NOW, "UTC")).toBe("Yesterday");
    expect(dayLabel("2026-11-02T09:00:00.000Z", NOW, "UTC")).toBe("Monday");
    expect(dayLabel("2026-10-21T09:00:00.000Z", NOW, "UTC")).toBe("Oct 21");
    expect(dayLabel("2025-12-30T09:00:00.000Z", NOW, "UTC")).toBe("Dec 30, 2025");
    // A clock a little ahead never shows a day in the future.
    expect(dayLabel("2026-11-05T09:00:00.000Z", NOW, "UTC")).toBe("Today");
  });

  it("counts days in the organization's time zone", () => {
    // 23:00 UTC on 3 Nov is already 4 Nov in Kolkata (UTC+5:30).
    expect(dayLabel("2026-11-03T23:00:00.000Z", NOW, "Asia/Kolkata")).toBe("Today");
    expect(dayLabel("2026-11-03T23:00:00.000Z", NOW, "UTC")).toBe("Yesterday");
  });
});

describe("clockTime", () => {
  it("shows the time of day in the organization's time zone", () => {
    expect(clockTime("2026-11-04T12:00:00.000Z", "UTC")).toBe("12:00 PM");
    expect(clockTime("2026-11-04T12:00:00.000Z", "Asia/Kolkata")).toBe("5:30 PM");
  });
});

describe("timeLeft", () => {
  const inMinutes = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString();

  it("counts days, then hours, then minutes, rounded down", () => {
    expect(timeLeft(inMinutes(6 * 24 * 60 + 30), NOW)).toBe("6d left");
    expect(timeLeft(inMinutes(47 * 60 + 59), NOW)).toBe("47h left");
    expect(timeLeft(inMinutes(21 * 60 + 40), NOW)).toBe("21h left");
    expect(timeLeft(inMinutes(60), NOW)).toBe("1h left");
    expect(timeLeft(inMinutes(35.5), NOW)).toBe("35m left");
    expect(timeLeft(inMinutes(0.2), NOW)).toBe("1m left");
  });

  it("says nothing once the time has passed", () => {
    expect(timeLeft(inMinutes(0), NOW)).toBeUndefined();
    expect(timeLeft(inMinutes(-5), NOW)).toBeUndefined();
  });
});

describe("continuesPrevious", () => {
  const msg = (outbound: boolean, at: string) => ({ outbound, at });

  it("groups messages from the same side within five minutes of each other", () => {
    expect(
      continuesPrevious(
        msg(false, "2026-11-04T10:00:00.000Z"),
        msg(false, "2026-11-04T10:04:59.000Z"),
        "UTC",
      ),
    ).toBe(true);
    expect(continuesPrevious(undefined, msg(false, "2026-11-04T10:00:00.000Z"), "UTC")).toBe(false);
    expect(
      continuesPrevious(
        msg(false, "2026-11-04T10:00:00.000Z"),
        msg(true, "2026-11-04T10:01:00.000Z"),
        "UTC",
      ),
    ).toBe(false);
    expect(
      continuesPrevious(
        msg(true, "2026-11-04T10:00:00.000Z"),
        msg(true, "2026-11-04T10:05:00.000Z"),
        "UTC",
      ),
    ).toBe(false);
  });

  it("starts a new group on a new day", () => {
    expect(
      continuesPrevious(
        msg(false, "2026-11-03T23:58:00.000Z"),
        msg(false, "2026-11-04T00:01:00.000Z"),
        "UTC",
      ),
    ).toBe(false);
  });
});
