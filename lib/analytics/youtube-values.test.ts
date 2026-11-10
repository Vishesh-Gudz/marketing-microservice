import { describe, expect, it } from "vitest";
import {
  channelDays,
  videoStatistics,
  videoWindow,
  youtubeDay,
} from "@/tests/unit/youtube-fixtures";
import {
  formatDuration,
  formatSignedCount,
  formatViewPercentage,
  formatWatchHours,
  YOUTUBE_DAY_COLUMNS,
  YOUTUBE_WINDOW_METRICS,
  youtubeAccessNotice,
  youtubeCaptureRows,
  youtubeDayRows,
  youtubeDayValueView,
  youtubeKpiValueView,
  youtubeVideoValueView,
  youtubeWindowState,
  youtubeWindowValueView,
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
    expect(missing).toContain("Its videos and their public counts keep syncing.");
    expect(missing).toContain("never zero");
    expect(missing).not.toMatch(/stop updating/);
    expect(youtubeAccessNotice("reauth_required")).toMatchObject({ title: "Reconnect required" });
    expect(youtubeAccessNotice("not_linked")).toMatchObject({ tone: "info" });
    expect(youtubeAccessNotice("unknown")).toMatchObject({ tone: "info" });
  });
});

// ADR 0016 Checkpoint 8: the server's range totals, the subscriber count, per-video windows and
// chart rows. The formatters only turn a value into text.

describe("value formatters", () => {
  it.each([
    [10_368, "172.8"],
    [60, "1.0"],
    [2, "< 0.1"],
    [0, "0.0"],
  ])("%s minutes -> %s hours", (minutes, text) => {
    expect(formatWatchHours(minutes, "en-US")).toBe(text);
  });

  it("signs net subscribers and shows YouTube's percent number as a percent", () => {
    expect(formatSignedCount(12, "en-US")).toBe("+12");
    expect(formatSignedCount(-3, "en-US")).toBe("-3");
    expect(formatSignedCount(0, "en-US")).toBe("0");
    expect(formatViewPercentage(45.3, "en-US")).toBe("45.3%");
    expect(formatViewPercentage(112, "en-US")).toBe("112%");
  });
});

describe("youtubeKpiValueView", () => {
  it("shows the server's totals and the subscriber count", () => {
    const data = channelDays();
    expect(youtubeKpiValueView("subscribers", data, "en-US")).toEqual({
      kind: "value",
      text: "12,300",
      partial: false,
    });
    expect(youtubeKpiValueView("views", data, "en-US")).toMatchObject({ text: "3,600" });
    expect(youtubeKpiValueView("estimatedMinutesWatched", data, "en-US")).toMatchObject({
      text: "172.8",
    });
    expect(youtubeKpiValueView("averageViewDuration", data, "en-US")).toMatchObject({
      text: "2:53",
    });
    expect(youtubeKpiValueView("subscribersNet", data, "en-US")).toMatchObject({ text: "+12" });
    expect(youtubeKpiValueView("likes", data, "en-US")).toMatchObject({ text: "0" });
    expect(
      youtubeKpiValueView("views", channelDays({ dataState: "partial" }), "en-US"),
    ).toMatchObject({ partial: true });
  });

  it("explains each missing value: hidden subscribers, the API's reason, access, no sync", () => {
    expect(youtubeKpiValueView("subscribers", channelDays({ subscribers: undefined }))).toEqual({
      kind: "unavailable",
      text: "—",
      reason: "Hidden by the channel, or not captured yet",
    });
    const reasons = channelDays({
      totals: {
        reportedDays: 2,
        metrics: {},
        unavailableMetrics: [{ metric: "averageViewDuration", reason: "zero_views" }],
      },
    });
    expect(youtubeKpiValueView("averageViewDuration", reasons)).toMatchObject({
      reason: "Not defined: this range has no views",
    });
    expect(youtubeKpiValueView("shares", reasons)).toMatchObject({
      reason: "Not reported by YouTube for any day of this range",
    });
    const none = { reportedDays: 0, metrics: {}, unavailableMetrics: [] };
    expect(
      youtubeKpiValueView("views", channelDays({ totals: none, analyticsAccess: "scope_missing" })),
    ).toMatchObject({ reason: "YouTube Analytics access is missing for this channel" });
    expect(
      youtubeKpiValueView("views", channelDays({ totals: none, dataState: "unknown" })),
    ).toMatchObject({ reason: "No Pacific Time day of this range is synced yet" });
  });
});

describe("youtubeWindowValueView", () => {
  it("formats each value of a reported window as YouTube reported it", () => {
    const window = videoWindow();
    const text = (metric: (typeof YOUTUBE_WINDOW_METRICS)[number]) =>
      youtubeWindowValueView(window, metric, "en-US");
    expect(YOUTUBE_WINDOW_METRICS.map((metric) => text(metric))).toEqual(
      ["4,321", "164.6", "2:17", "45.3%", "210", "0", "17", "12", "2"].map((value) => ({
        kind: "value",
        text: value,
        partial: false,
      })),
    );
  });

  it("is never 0 outside the top 200, before a sync or for an unreported value", () => {
    expect(youtubeWindowState(undefined)).toBe("not_synced");
    expect(youtubeWindowValueView(undefined, "views")).toMatchObject({
      kind: "unavailable",
      reason: "Not synced yet",
    });
    const outside = videoWindow({ status: "not_in_top", metrics: {} });
    expect(youtubeWindowState(outside)).toBe("not_in_top");
    expect(youtubeWindowValueView(outside, "views")).toMatchObject({
      kind: "unavailable",
      reason: "Not in YouTube's top 200",
    });
    expect(youtubeWindowValueView(videoWindow({ metrics: {} }), "shares")).toMatchObject({
      kind: "unavailable",
      reason: "Not reported by YouTube for this video and period",
    });
  });
});

describe("chart rows", () => {
  it("chart each day's reported value; other days and missing values are gaps", () => {
    const rows = youtubeDayRows(
      [
        youtubeDay("2026-10-15"),
        youtubeDay("2026-10-16", { metrics: { views: 0 } }),
        youtubeDay("2026-10-17", { status: "not_reported", metrics: {} }),
        youtubeDay("2026-10-18", { status: "unknown", metrics: {} }),
      ],
      "subscribersLost",
      "en-US",
    );
    expect(rows.map((row) => [row.bucket, row.value, row.display])).toEqual([
      ["2026-10-15", 1, "1"],
      ["2026-10-16", null, "—"],
      ["2026-10-17", null, "—"],
      ["2026-10-18", null, "—"],
    ]);
    expect(
      youtubeDayRows([youtubeDay("2026-10-16", { metrics: { views: 0 } })], "views")[0],
    ).toMatchObject({ value: 0, incomplete: false });
  });

  it("chart each capture's lifetime count, never differenced", () => {
    const rows = youtubeCaptureRows(
      [
        videoStatistics({ capturedDate: "2026-10-19", metrics: { views: 9_500 } }),
        videoStatistics(),
      ],
      "likes",
      "en-US",
    );
    expect(rows.map((row) => [row.bucket, row.value, row.display, row.dataState])).toEqual([
      ["2026-10-19", null, "—", "reported"],
      ["2026-10-20", 321, "321", "reported"],
    ]);
  });
});
