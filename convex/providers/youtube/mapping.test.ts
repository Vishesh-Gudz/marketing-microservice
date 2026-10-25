import { describe, expect, it } from "vitest";
import { isProviderError } from "../errors";
import { socialRecordIssues } from "../social/validate";
import {
  capTitle,
  handleOf,
  mapChannel,
  mapReportDays,
  mapVideo,
  mapVideoSnapshot,
  parseYouTubeTimestamp,
} from "./mapping";
import type { RawReport } from "./schemas";
import { ACCOUNT_REPORT_METRICS } from "./semantics";

// ADR 0016: channel and video metadata -> canonical records. Missing stays absent, the built
// permalink is the only URL, "upcoming" is excluded and anything unmappable is unresolved.
// Checkpoint 3: the channel day report and video lifetime statistics, stored as reported.

const CHANNEL = "UCfakeChannel0000000000a";
const VIDEO = "vid00000000";

describe("parseYouTubeTimestamp", () => {
  it.each([
    ["2026-09-28T12:00:00Z", Date.UTC(2026, 8, 28, 12)],
    ["2026-09-28T12:00:00.250Z", Date.UTC(2026, 8, 28, 12) + 250],
  ])("parses %s", (raw, expected) => {
    expect(parseYouTubeTimestamp(raw)).toBe(expected);
  });

  it.each([
    undefined,
    "",
    "2026-09-28",
    "2026-09-28T12:00:00+02:00",
    "2026-02-30T00:00:00Z",
    "2026-09-28T24:00:00Z",
  ])("rejects %s", (raw) => {
    expect(parseYouTubeTimestamp(raw)).toBeUndefined();
  });
});

describe("capTitle and handleOf", () => {
  it("trims, keeps empty titles absent and caps at 100 code points", () => {
    expect(capTitle("  Launch  ")).toBe("Launch");
    expect(capTitle("   ")).toBeUndefined();
    expect(capTitle(undefined)).toBeUndefined();
    const emoji = "😀".repeat(101);
    expect(Array.from(capTitle(emoji)!)).toHaveLength(100);
    expect(capTitle(emoji)).toBe("😀".repeat(100));
  });

  it("keeps only handles (with the @), without the @", () => {
    expect(handleOf("@fakebrand")).toBe("fakebrand");
    expect(handleOf("@marca.ñandú")).toBe("marca.ñandú");
    expect(handleOf("fakebrand")).toBeUndefined(); // a legacy custom URL, not a handle
    expect(handleOf("@a")).toBeUndefined();
    expect(handleOf("@has space")).toBeUndefined();
    expect(handleOf(undefined)).toBeUndefined();
  });
});

describe("mapChannel", () => {
  it("maps the title, handle and (rounded) subscriber count; no URL", () => {
    const record = mapChannel({
      id: CHANNEL,
      snippet: { title: "Fake Brand", customUrl: "@fakebrand" },
      statistics: { subscriberCount: "12300", hiddenSubscriberCount: false },
      contentDetails: { relatedPlaylists: { uploads: "UUfakeChannel0000000000a" } },
    });
    expect(record).toEqual({
      platform: "youtube",
      externalId: CHANNEL,
      username: "fakebrand",
      name: "Fake Brand",
      accountType: "channel",
      followersCount: 12_300,
      status: "active",
    });
    expect(socialRecordIssues("socialAccount", record)).toEqual([]);
  });

  it("keeps a hidden or malformed subscriber count absent (never 0)", () => {
    const hidden = mapChannel({
      id: CHANNEL,
      snippet: { title: "Fake" },
      statistics: { subscriberCount: "500", hiddenSubscriberCount: true },
    });
    expect(hidden).not.toHaveProperty("followersCount");
    const malformed = mapChannel({ id: CHANNEL, statistics: { subscriberCount: "-1" } });
    expect(malformed).not.toHaveProperty("followersCount");
    expect(mapChannel({ id: CHANNEL, statistics: { subscriberCount: "0" } }).followersCount).toBe(
      0,
    );
  });

  it("falls back to the handle, then the channel id, for the name", () => {
    expect(mapChannel({ id: CHANNEL, snippet: { title: " ", customUrl: "@fakebrand" } }).name).toBe(
      "fakebrand",
    );
    expect(mapChannel({ id: CHANNEL }).name).toBe(CHANNEL);
  });
});

describe("mapVideo", () => {
  const video = (snippet: Record<string, string> | undefined) => ({
    id: VIDEO,
    ...(snippet !== undefined ? { snippet } : {}),
  });
  const base = {
    channelId: CHANNEL,
    title: "Launch day",
    publishedAt: "2026-09-28T12:00:00Z",
    liveBroadcastContent: "none",
  };

  it("maps a published upload to a video post with the built permalink", () => {
    const mapped = mapVideo(video(base), CHANNEL);
    expect(mapped).toEqual({
      kind: "post",
      record: {
        platform: "youtube",
        accountExternalId: CHANNEL,
        externalId: VIDEO,
        type: "video",
        publishedAt: Date.UTC(2026, 8, 28, 12),
        caption: "Launch day",
        permalink: `https://www.youtube.com/watch?v=${VIDEO}`,
      },
    });
    expect(mapped.kind === "post" && socialRecordIssues("socialPost", mapped.record)).toEqual([]);
  });

  it("maps a live broadcast and keeps a missing title absent", () => {
    const { title: _title, ...untitled } = base;
    const mapped = mapVideo(video({ ...untitled, liveBroadcastContent: "live" }), CHANNEL);
    expect(mapped.kind === "post" && mapped.record).not.toHaveProperty("caption");
  });

  it("excludes upcoming broadcasts and premieres", () => {
    expect(mapVideo(video({ ...base, liveBroadcastContent: "upcoming" }), CHANNEL)).toEqual({
      kind: "excluded",
    });
  });

  it.each([
    ["no snippet", undefined],
    ["another channel's upload", { ...base, channelId: "UCotherChannel000000000a" }],
    ["an unknown broadcast state", { ...base, liveBroadcastContent: "something" }],
    ["no broadcast state", { channelId: CHANNEL, title: "x", publishedAt: base.publishedAt }],
    ["no publish time", { ...base, publishedAt: "" }],
  ])("is unresolved with %s", (_label, snippet) => {
    expect(mapVideo(video(snippet), CHANNEL)).toEqual({ kind: "unresolved" });
  });
});

describe("mapVideoSnapshot", () => {
  const video = (statistics?: Record<string, string>) => ({
    id: VIDEO,
    ...(statistics !== undefined ? { statistics } : {}),
  });
  const capturedAt = Date.UTC(2026, 9, 20, 23, 30);

  it("stores the lifetime counts as reported, on the UTC capture day", () => {
    const snapshot = mapVideoSnapshot({
      operation: "fetchPostMetrics",
      accountExternalId: CHANNEL,
      video: video({ viewCount: "1500", likeCount: "0", commentCount: "12" }),
      capturedAt,
    });
    expect(snapshot).toEqual({
      platform: "youtube",
      accountExternalId: CHANNEL,
      postExternalId: VIDEO,
      capturedDate: "2026-10-20",
      capturedAt,
      views: 1500,
      likes: 0,
      comments: 12,
    });
    expect(socialRecordIssues("socialPostSnapshot", snapshot)).toEqual([]);
  });

  it("keeps hidden or disabled counts absent, never 0", () => {
    const hidden = mapVideoSnapshot({
      operation: "fetchPostMetrics",
      accountExternalId: CHANNEL,
      video: video({ viewCount: "10" }),
      capturedAt,
    });
    expect(hidden).not.toHaveProperty("likes");
    expect(hidden).not.toHaveProperty("comments");
    const none = mapVideoSnapshot({
      operation: "fetchPostMetrics",
      accountExternalId: CHANNEL,
      video: video(),
      capturedAt,
    });
    expect(none).not.toHaveProperty("views");
  });

  it.each(["-1", "1.5", "lots", "99999999999999999"])("fails closed on the count %s", (raw) => {
    let caught: unknown;
    try {
      mapVideoSnapshot({
        operation: "fetchPostMetrics",
        accountExternalId: CHANNEL,
        video: video({ viewCount: raw }),
        capturedAt,
      });
    } catch (error) {
      caught = error;
    }
    expect(isProviderError(caught) && [caught.kind, caught.providerCode]).toEqual([
      "data",
      "metric_invalid",
    ]);
  });
});

describe("mapReportDays", () => {
  const METRICS = ACCOUNT_REPORT_METRICS.split(",");
  const headers = (names = METRICS) => [
    { name: "day", columnType: "DIMENSION", dataType: "STRING" },
    ...names.map((name) => ({ name, columnType: "METRIC", dataType: "INTEGER" })),
  ];
  const map = (report: RawReport, from = "2026-10-01", to = "2026-10-03") =>
    mapReportDays({
      operation: "fetchAccountMetrics",
      accountExternalId: CHANNEL,
      from,
      to,
      report,
    });
  const failure = (report: RawReport, from?: string, to?: string) => {
    try {
      map(report, from, to);
    } catch (error) {
      return isProviderError(error) ? [error.kind, error.providerCode] : error;
    }
    throw new Error("expected a data error");
  };

  it("maps every reported value under its own name: views in the column, the rest in extras", () => {
    const days = map({
      columnHeaders: headers(),
      rows: [["2026-10-02", 120, 8, 2, 1, 300, 95, 4, 1]],
    });
    expect(days.find((day) => day.date === "2026-10-02")).toEqual({
      platform: "youtube",
      accountExternalId: CHANNEL,
      date: "2026-10-02",
      views: 120,
      extras: {
        likes: 8,
        comments: 2,
        shares: 1,
        estimatedMinutesWatched: 300,
        averageViewDuration: 95,
        subscribersGained: 4,
        subscribersLost: 1,
      },
    });
    for (const day of days) {
      expect(socialRecordIssues("socialAccountDay", day)).toEqual([]);
      expect(day).not.toHaveProperty("followerDelta"); // never calculated (III.E.4.h)
    }
  });

  it("emits one record per requested day; a day without a row reports nothing (never 0)", () => {
    const days = map({ columnHeaders: headers(), rows: [["2026-10-02", 0, 0, 0, 0, 0, 0, 0, 0]] });
    expect(days.map((day) => day.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(days[0]).toEqual({
      platform: "youtube",
      accountExternalId: CHANNEL,
      date: "2026-10-01",
    });
    expect(days[1]).toMatchObject({ views: 0, extras: { likes: 0, subscribersLost: 0 } });
  });

  it("an empty report (no rows at all) gives empty days", () => {
    const days = map({ columnHeaders: headers() });
    expect(days).toHaveLength(3);
    for (const day of days)
      expect(Object.keys(day).sort()).toEqual(["accountExternalId", "date", "platform"]);
  });

  it("a metric YouTube left out of the table, or a null cell, is absent", () => {
    const days = map({
      columnHeaders: headers(METRICS.filter((m) => m !== "shares" && m !== "views")),
      rows: [["2026-10-01", 8, null, 300, 95, 4, 1]],
    });
    expect(days[0]).toEqual({
      platform: "youtube",
      accountExternalId: CHANNEL,
      date: "2026-10-01",
      extras: {
        likes: 8,
        estimatedMinutesWatched: 300,
        averageViewDuration: 95,
        subscribersGained: 4,
        subscribersLost: 1,
      },
    });
  });

  it("keeps the Pacific Time day keys unchanged, including DST days (23 and 25 hours)", () => {
    const viewsByDay = (rows: (string | number)[][], from: string, to: string) =>
      map({ columnHeaders: headers(["views"]), rows }, from, to).map((d) => [d.date, d.views]);
    // DST starts in Pacific Time on 2026-03-08 (23 h) and ends on 2026-11-01 (25 h): each is one
    // day key, never shifted, split or merged with a neighbour.
    expect(viewsByDay([["2026-03-08", 7]], "2026-03-07", "2026-03-09")).toEqual([
      ["2026-03-07", undefined],
      ["2026-03-08", 7],
      ["2026-03-09", undefined],
    ]);
    expect(viewsByDay([["2026-11-01", 9]], "2026-10-31", "2026-11-02")).toEqual([
      ["2026-10-31", undefined],
      ["2026-11-01", 9],
      ["2026-11-02", undefined],
    ]);
  });

  it.each<[string, RawReport, string]>([
    ["no day dimension", { columnHeaders: headers().slice(1), rows: [] }, "report_unexpected"],
    ["a duplicate column", { columnHeaders: [...headers(), headers()[1]!] }, "report_unexpected"],
    [
      "a metric marked as dimension",
      { columnHeaders: [headers()[0]!, { name: "views", columnType: "DIMENSION" }] },
      "report_unexpected",
    ],
    ["an unknown metric", { columnHeaders: headers(["views", "dislikes"]) }, "metric_unexpected"],
    [
      "a short row",
      { columnHeaders: headers(["views"]), rows: [["2026-10-01"]] },
      "report_unexpected",
    ],
    [
      "a day outside the window",
      { columnHeaders: headers(["views"]), rows: [["2026-10-04", 1]] },
      "day_unexpected",
    ],
    [
      "a duplicate day",
      {
        columnHeaders: headers(["views"]),
        rows: [
          ["2026-10-01", 1],
          ["2026-10-01", 2],
        ],
      },
      "day_unexpected",
    ],
    [
      "a malformed day",
      { columnHeaders: headers(["views"]), rows: [["2026/10/01", 1]] },
      "day_unexpected",
    ],
    [
      "a negative value",
      { columnHeaders: headers(["views"]), rows: [["2026-10-01", -1]] },
      "metric_invalid",
    ],
    [
      "a fractional value",
      { columnHeaders: headers(["views"]), rows: [["2026-10-01", 1.5]] },
      "metric_invalid",
    ],
    [
      "a string value",
      { columnHeaders: headers(["views"]), rows: [["2026-10-01", "1"]] },
      "metric_invalid",
    ],
  ])("fails closed on %s", (_label, report, code) => {
    expect(failure(report)).toEqual(["data", code]);
  });
});
