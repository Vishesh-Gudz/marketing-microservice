import { describe, expect, it } from "vitest";
import { socialRecordIssues } from "../social/validate";
import { capTitle, handleOf, mapChannel, mapVideo, parseYouTubeTimestamp } from "./mapping";

// ADR 0016: channel and video metadata -> canonical records. Missing stays absent, the built
// permalink is the only URL, "upcoming" is excluded and anything unmappable is unresolved.

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
