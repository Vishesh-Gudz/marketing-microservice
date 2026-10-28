import { describe, expect, it } from "vitest";
import { videoStatistics, youtubeDay } from "@/tests/unit/youtube-fixtures";
import {
  formatDuration,
  YOUTUBE_DAY_COLUMNS,
  youtubeAccessNotice,
  youtubeDayValueView,
  youtubeVideoValueView,
} from "./youtube-values";

// YouTube values are the API's values for one channel and one day (or one capture): shown as
// reported, never computed, never turned into 0.

describe("youtubeDayValueView", () => {
  it("shows a reported value, and a reported 0 as 0", () => {
    const day = youtubeDay("2026-10-17");
    expect(youtubeDayValueView(day, "views", "en-US")).toEqual({
      kind: "value",
      text: "1,200",
      partial: false,
    });
    expect(youtubeDayValueView(day, "likes", "en-US")).toMatchObject({ kind: "value", text: "0" });
    expect(youtubeDayValueView(day, "averageViewDuration", "en-US")).toMatchObject({
      text: "1:23",
    });
  });

  it("explains a metric a reported day lacks, and every value of other days", () => {
    const missing = youtubeDay("2026-10-17", { metrics: { views: 5 } });
    expect(youtubeDayValueView(missing, "shares")).toEqual({
      kind: "unavailable",
      text: "—",
      reason: "Not reported by YouTube for this day",
    });
    for (const status of ["not_reported", "unknown"] as const) {
      const day = youtubeDay("2026-10-18", { status, metrics: {} });
      for (const metric of YOUTUBE_DAY_COLUMNS) {
        expect(youtubeDayValueView(day, metric)).toMatchObject({ kind: "unavailable", text: "—" });
      }
    }
    expect(
      youtubeDayValueView(youtubeDay("2026-10-18", { status: "unknown", metrics: {} }), "views"),
    ).toMatchObject({ reason: "Not synced yet. YouTube reports days about 3 days late." });
  });
});

describe("youtubeVideoValueView", () => {
  it("shows lifetime counts; a hidden count or a never-captured video is never 0", () => {
    expect(youtubeVideoValueView(videoStatistics(), "views", "en-US")).toMatchObject({
      text: "9,876",
    });
    const hidden = videoStatistics({ metrics: { views: 10, comments: 1 } });
    expect(youtubeVideoValueView(hidden, "likes")).toEqual({
      kind: "unavailable",
      text: "—",
      reason: "Not reported by YouTube (hidden or disabled by the channel owner)",
    });
    expect(youtubeVideoValueView(undefined, "views")).toMatchObject({ kind: "unavailable" });
  });
});

describe("formatDuration", () => {
  it.each([
    [0, "0:00"],
    [59, "0:59"],
    [83, "1:23"],
    [3_600, "1:00:00"],
    [3_725.4, "1:02:05"],
  ])("%s seconds -> %s", (seconds, text) => {
    expect(formatDuration(seconds)).toBe(text);
  });
});

describe("youtubeAccessNotice", () => {
  it("is silent when granted and explains every other grant state", () => {
    expect(youtubeAccessNotice("granted")).toBeNull();
    expect(youtubeAccessNotice("scope_missing")).toMatchObject({
      tone: "warning",
      title: "YouTube Analytics access is missing",
    });
    // ADR 0016 open question 13: only the daily metrics wait; nothing is shown as zero.
    const missing = youtubeAccessNotice("scope_missing")!.message;
    expect(missing).toContain("Its videos and their statistics keep syncing.");
    expect(missing).toContain("never zero");
    expect(missing).not.toMatch(/stop updating/);
    expect(youtubeAccessNotice("reauth_required")).toMatchObject({ title: "Reconnect required" });
    expect(youtubeAccessNotice("not_linked")).toMatchObject({ tone: "info" });
    expect(youtubeAccessNotice("unknown")).toMatchObject({ tone: "info" });
  });
});
