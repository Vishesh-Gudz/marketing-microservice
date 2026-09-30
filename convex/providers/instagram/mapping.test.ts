import { describe, expect, it } from "vitest";
import { isProviderError } from "../errors";
import { socialRecordIssues } from "../social/validate";
import {
  capCaption,
  classifyMedia,
  followerDelta,
  mapAccountDay,
  mapMedia,
  mapPostSnapshot,
  mapProfile,
  parseInstagramTimestamp,
} from "./mapping";

// Phase 10 Stage B: pure Instagram -> canonical mapping. Missing stays absent, zero stays
// zero, the permalink is the only URL, AD / STORY are excluded, and media without a product
// type are unresolved (R3).

const ACCOUNT = "17841400000000101";
const MEDIA = "17900000000000001";

describe("media classification", () => {
  it.each([
    ["IMAGE", "FEED", { kind: "post", type: "image" }],
    ["VIDEO", "FEED", { kind: "post", type: "video" }],
    ["VIDEO", "REELS", { kind: "post", type: "reel" }],
    ["CAROUSEL_ALBUM", "FEED", { kind: "post", type: "carousel" }],
    ["UNKNOWN_TYPE", "FEED", { kind: "post", type: "other" }],
    [undefined, "FEED", { kind: "post", type: "other" }],
    ["IMAGE", "AD", { kind: "excluded" }],
    ["VIDEO", "STORY", { kind: "excluded" }],
    ["IMAGE", undefined, { kind: "unresolved" }],
    ["IMAGE", "", { kind: "unresolved" }],
  ] as const)("%s / %s", (mediaType, mediaProductType, expected) => {
    expect(
      classifyMedia({
        ...(mediaType !== undefined ? { mediaType } : {}),
        ...(mediaProductType !== undefined ? { mediaProductType } : {}),
      }),
    ).toEqual(expected);
  });
});

describe("timestamps", () => {
  it("parses Instagram's +0000 offsets and ISO forms explicitly", () => {
    const expected = Date.UTC(2026, 8, 20, 10, 0, 0);
    expect(parseInstagramTimestamp("2026-09-20T10:00:00+0000")).toBe(expected);
    expect(parseInstagramTimestamp("2026-09-20T10:00:00Z")).toBe(expected);
    expect(parseInstagramTimestamp("2026-09-20T12:00:00+02:00")).toBe(expected);
    expect(parseInstagramTimestamp("2026-09-20T05:30:00-0430")).toBe(expected);
    expect(parseInstagramTimestamp("2026-09-20T10:00:00.250+0000")).toBe(expected + 250);
  });

  it.each([undefined, "", "2026-09-20", "2026-02-30T10:00:00+0000", "2026-09-20T25:00:00Z", "x"])(
    "rejects %s",
    (raw) => {
      expect(parseInstagramTimestamp(raw)).toBeUndefined();
    },
  );
});

describe("posts", () => {
  const media = {
    id: MEDIA,
    caption: "Hello",
    mediaType: "IMAGE",
    mediaProductType: "FEED",
    permalink: "https://www.instagram.com/p/Cfake/",
    timestamp: "2026-09-20T10:00:00+0000",
  };

  it("maps an organic post with its permalink as the only URL", () => {
    const mapped = mapMedia(media, ACCOUNT);
    expect(mapped).toEqual({
      kind: "post",
      record: {
        platform: "instagram",
        accountExternalId: ACCOUNT,
        externalId: MEDIA,
        type: "image",
        publishedAt: Date.UTC(2026, 8, 20, 10),
        caption: "Hello",
        permalink: "https://www.instagram.com/p/Cfake/",
      },
    });
    if (mapped.kind !== "post") throw new Error("expected a post");
    expect(socialRecordIssues("socialPost", mapped.record)).toEqual([]);
  });

  it("drops a permalink that fails R1b and keeps the post", () => {
    const mapped = mapMedia({ ...media, permalink: "https://evil.example/p/x" }, ACCOUNT);
    if (mapped.kind !== "post") throw new Error("expected a post");
    expect(mapped.record).not.toHaveProperty("permalink");
    expect(mapped.record.externalId).toBe(MEDIA);
  });

  it("excludes AD and STORY, and never maps media without a product type or timestamp", () => {
    expect(mapMedia({ ...media, mediaProductType: "AD" }, ACCOUNT)).toEqual({ kind: "excluded" });
    expect(mapMedia({ ...media, mediaProductType: "STORY" }, ACCOUNT)).toEqual({
      kind: "excluded",
    });
    const { mediaProductType: _omit, ...noType } = media;
    expect(mapMedia(noType, ACCOUNT)).toEqual({ kind: "unresolved" });
    expect(mapMedia({ ...media, timestamp: "yesterday" }, ACCOUNT)).toEqual({ kind: "unresolved" });
  });

  it("caps captions at 2,200 characters without splitting a character (F21)", () => {
    expect(capCaption("a".repeat(2_200))).toHaveLength(2_200);
    expect(capCaption("a".repeat(2_500))).toBe("a".repeat(2_200));
    const emoji = "\u{1F600}".repeat(2_300);
    const capped = capCaption(emoji)!;
    expect(Array.from(capped)).toHaveLength(2_200);
    expect(capped).toBe("\u{1F600}".repeat(2_200));
    expect(capCaption("")).toBeUndefined();
    expect(capCaption(undefined)).toBeUndefined();
    const long = mapMedia({ ...media, caption: "b".repeat(5_000) }, ACCOUNT);
    expect(long.kind === "post" && long.record.caption).toBe("b".repeat(2_200));
  });

  it("the boundary rejects a caption over the cap and any non-permalink URL", () => {
    const record = {
      platform: "instagram",
      accountExternalId: ACCOUNT,
      externalId: MEDIA,
      type: "image",
      publishedAt: 1,
    };
    expect(socialRecordIssues("socialPost", { ...record, caption: "c".repeat(2_201) })).toEqual([
      "caption: too long",
    ]);
    expect(
      socialRecordIssues("socialPost", { ...record, permalink: "https://evil.example/" }),
    ).toEqual(["permalink: not an allowed permalink"]);
    for (const field of ["mediaUrl", "thumbnailUrl", "commentsEnabled"]) {
      expect(socialRecordIssues("socialPost", { ...record, [field]: "x" })).toEqual([
        "structure: does not match the table validator",
      ]);
    }
  });
});

describe("profile (preflight)", () => {
  it("maps name, username and followers; never a URL (F1)", () => {
    const record = mapProfile(
      { username: "fake_brand", name: " Fake Brand ", followersCount: 1_234 },
      { username: "fake_brand", accountType: "business" },
      ACCOUNT,
    );
    expect(record).toEqual({
      platform: "instagram",
      externalId: ACCOUNT,
      username: "fake_brand",
      name: "Fake Brand",
      accountType: "business",
      followersCount: 1_234,
      status: "active",
    });
    expect(socialRecordIssues("socialAccount", record)).toEqual([]);
    expect(
      socialRecordIssues("socialAccount", { ...record, profilePictureUrl: "https://x.test/p.jpg" }),
    ).toEqual(["structure: does not match the table validator"]);
  });

  it("falls back to the username, then the id; followers stay absent when unknown", () => {
    expect(mapProfile({}, { username: "creator_1", accountType: "creator" }, ACCOUNT)).toEqual({
      platform: "instagram",
      externalId: ACCOUNT,
      username: "creator_1",
      name: "creator_1",
      accountType: "creator",
      status: "active",
    });
    const bare = mapProfile({ username: "not a username!" }, { accountType: "business" }, ACCOUNT);
    expect(bare.name).toBe(ACCOUNT);
    expect(bare).not.toHaveProperty("username");
    expect(bare).not.toHaveProperty("followersCount");
  });

  it("keeps an explicit follower count of zero", () => {
    expect(mapProfile({ followersCount: 0 }, { accountType: "business" }, ACCOUNT)).toMatchObject({
      followersCount: 0,
    });
  });
});

describe("post snapshots", () => {
  const capturedAt = Date.UTC(2026, 8, 28, 23, 59, 59);

  it("maps SDK + reader values; missing stays absent, zero stays zero", () => {
    const record = mapPostSnapshot({
      operation: "fetchPostMetrics",
      accountExternalId: ACCOUNT,
      postExternalId: MEDIA,
      capturedAt,
      sdk: [
        { name: "likes", value: 7 },
        { name: "saved", value: 0 },
        { name: "reach", value: 40 },
      ],
      reader: { total_interactions: 0 },
    });
    expect(record).toEqual({
      platform: "instagram",
      accountExternalId: ACCOUNT,
      postExternalId: MEDIA,
      capturedDate: "2026-09-28",
      capturedAt,
      likes: 7,
      saves: 0,
      reach: 40,
      totalInteractions: 0,
    });
    expect(socialRecordIssues("socialPostSnapshot", record)).toEqual([]);
  });

  it("an empty insight set is a snapshot with no metrics (never zero-filled)", () => {
    const record = mapPostSnapshot({
      operation: "fetchPostMetrics",
      accountExternalId: ACCOUNT,
      postExternalId: MEDIA,
      capturedAt,
      sdk: [],
      reader: {},
    });
    expect(Object.keys(record).sort()).toEqual(
      ["accountExternalId", "capturedAt", "capturedDate", "platform", "postExternalId"].sort(),
    );
  });

  it("rejects unknown or duplicated metrics as a data error", () => {
    for (const sdk of [
      [{ name: "plays", value: 1 }],
      [
        { name: "likes", value: 1 },
        { name: "likes", value: 2 },
      ],
    ]) {
      const run = () =>
        mapPostSnapshot({
          operation: "fetchPostMetrics",
          accountExternalId: ACCOUNT,
          postExternalId: MEDIA,
          capturedAt,
          sdk,
          reader: {},
        });
      expect(run).toThrow();
      try {
        run();
      } catch (error) {
        expect(isProviderError(error) && [error.kind, error.providerCode]).toEqual([
          "data",
          "metric_unexpected",
        ]);
      }
    }
  });

  it("the boundary refuses videoViews, extras and a capture day that is not the UTC day", () => {
    const record = {
      platform: "instagram",
      accountExternalId: ACCOUNT,
      postExternalId: MEDIA,
      capturedDate: "2026-09-28",
      capturedAt,
    };
    expect(socialRecordIssues("socialPostSnapshot", record)).toEqual([]);
    expect(socialRecordIssues("socialPostSnapshot", { ...record, videoViews: 1 })).toHaveLength(1);
    expect(
      socialRecordIssues("socialPostSnapshot", { ...record, extras: { reposts: 1 } }),
    ).toHaveLength(1);
    expect(
      socialRecordIssues("socialPostSnapshot", { ...record, capturedDate: "2026-09-29" }),
    ).toEqual(["capturedDate: not the UTC day of capturedAt"]);
    expect(socialRecordIssues("socialPostSnapshot", { ...record, likes: -1 })).toEqual([
      "likes: not a count",
    ]);
  });
});

describe("account days (insights column group)", () => {
  it("maps columns and extras; followerDelta = follows - unfollows (IR8)", () => {
    const record = mapAccountDay({
      operation: "fetchAccountMetrics",
      accountExternalId: ACCOUNT,
      date: "2026-09-27",
      insights: {
        reach: 120,
        views: 300,
        accounts_engaged: 12,
        total_interactions: 0,
        likes: 30,
        replies: 0,
        profile_links_taps: 4,
      },
      follows: { FOLLOWER: 9, NON_FOLLOWER: 3 },
    });
    expect(record).toEqual({
      platform: "instagram",
      accountExternalId: ACCOUNT,
      date: "2026-09-27",
      reach: 120,
      views: 300,
      accountsEngaged: 12,
      totalInteractions: 0,
      followerDelta: 6,
      extras: { likes: 30, replies: 0, profileLinksTaps: 4 },
    });
    expect(socialRecordIssues("socialAccountDay", record)).toEqual([]);
  });

  it("an empty day is a record without metrics", () => {
    const record = mapAccountDay({
      operation: "fetchAccountMetrics",
      accountExternalId: ACCOUNT,
      date: "2026-09-27",
      insights: {},
    });
    expect(record).toEqual({
      platform: "instagram",
      accountExternalId: ACCOUNT,
      date: "2026-09-27",
    });
  });

  it("followerDelta only when both sides are reported and nothing else is non-zero", () => {
    expect(followerDelta(undefined)).toBeUndefined();
    expect(followerDelta({})).toBeUndefined();
    expect(followerDelta({ FOLLOWER: 5 })).toBeUndefined();
    expect(followerDelta({ NON_FOLLOWER: 5 })).toBeUndefined();
    expect(followerDelta({ FOLLOWER: 5, NON_FOLLOWER: 5, UNKNOWN: 0 })).toBe(0);
    expect(followerDelta({ FOLLOWER: 5, NON_FOLLOWER: 8 })).toBe(-3);
    expect(followerDelta({ FOLLOWER: 5, NON_FOLLOWER: 1, UNKNOWN: 2 })).toBeUndefined();
  });

  it("the boundary refuses the profile group, provenance and deprecated columns", () => {
    const record = { platform: "instagram", accountExternalId: ACCOUNT, date: "2026-09-27" };
    for (const field of [
      "followers",
      "followersCapturedAt",
      "insightsSyncedAt",
      "syncedAt",
      "profileViews",
      "websiteClicks",
    ]) {
      expect(socialRecordIssues("socialAccountDay", { ...record, [field]: 1 })).toEqual([
        "structure: does not match the table validator",
      ]);
    }
    expect(socialRecordIssues("socialAccountDay", { ...record, followerDelta: -4 })).toEqual([]);
    expect(socialRecordIssues("socialAccountDay", { ...record, reach: 1.5 })).toEqual([
      "reach: not a count",
    ]);
  });
});
