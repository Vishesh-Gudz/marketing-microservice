import { describe, expect, it } from "vitest";
import { isProviderError } from "../errors";
import { assertValidSocialRecord, socialRecordIssues } from "./validate";

// Social provider records are validated against the REAL table validators: no tenant or
// Convex ids can be smuggled in, and failures never echo record values.

const discovered = {
  platform: "instagram",
  externalId: "17841400000000101",
  username: "fake_brand",
  accountType: "business",
};

describe("social record validation", () => {
  it("accepts a valid discovered account", () => {
    expect(socialRecordIssues("discoveredSocialAccount", discovered)).toEqual([]);
    expect(
      socialRecordIssues("discoveredSocialAccount", { ...discovered, username: undefined }),
    ).toEqual([]);
  });

  it.each([
    ["an orgId", { ...discovered, orgId: "k17abc" }],
    ["a connectionId", { ...discovered, connectionId: "k17abc" }],
    ["a discoveredAt", { ...discovered, discoveredAt: 1 }],
    ["an unknown field", { ...discovered, followers: 5 }],
    ["an unsupported account type", { ...discovered, accountType: "personal" }],
    ["an ad platform", { ...discovered, platform: "meta" }],
  ])("rejects %s", (_label, record) => {
    expect(socialRecordIssues("discoveredSocialAccount", record).length).toBeGreaterThan(0);
  });

  it.each([
    ["a non-numeric id", { ...discovered, externalId: "act_1" }],
    ["a username with spaces", { ...discovered, username: "fake brand" }],
    ["a too long username", { ...discovered, username: "a".repeat(31) }],
  ])("rejects %s (semantics)", (_label, record) => {
    expect(socialRecordIssues("discoveredSocialAccount", record).length).toBeGreaterThan(0);
  });

  it("socialAccount records cannot carry connection linkage or tenant fields", () => {
    const account = { ...discovered, name: "Fake Brand", status: "active" };
    expect(socialRecordIssues("socialAccount", account)).toEqual([]);
    expect(socialRecordIssues("socialAccount", { ...account, connectionId: "x" }).length).toBe(1);
    expect(socialRecordIssues("socialAccount", { ...account, name: " " })).toEqual([
      "name: must not be empty",
    ]);
  });

  describe("YouTube records (ADR 0016)", () => {
    const channel = {
      platform: "youtube",
      externalId: "UCfakeChannel0000000000a",
      username: "fakebrand",
      name: "Fake Brand",
      accountType: "channel",
      status: "active",
    };
    const video = {
      platform: "youtube",
      accountExternalId: channel.externalId,
      externalId: "vid00000000",
      type: "video",
      publishedAt: 1,
      caption: "Launch day",
      permalink: "https://www.youtube.com/watch?v=vid00000000",
    };

    it("accepts a channel and a video", () => {
      expect(socialRecordIssues("socialAccount", channel)).toEqual([]);
      expect(socialRecordIssues("socialAccount", { ...channel, username: "marca.ñandú" })).toEqual(
        [],
      );
      expect(socialRecordIssues("socialPost", video)).toEqual([]);
    });

    it.each([
      ["a numeric channel id", "socialAccount", { ...channel, externalId: "17841400000000101" }],
      ["a handle with spaces", "socialAccount", { ...channel, username: "fake brand" }],
      ["a handle with the @", "socialAccount", { ...channel, username: "@fakebrand" }],
      ["a malformed video id", "socialPost", { ...video, externalId: "vid" }],
      ["a channel id as video id", "socialPost", { ...video, externalId: channel.externalId }],
      ["a foreign owner id", "socialPost", { ...video, accountExternalId: "17841400000000101" }],
      [
        "an Instagram permalink",
        "socialPost",
        { ...video, permalink: "https://www.instagram.com/p/C1/" },
      ],
      [
        "another YouTube URL form",
        "socialPost",
        { ...video, permalink: "https://youtu.be/vid00000000" },
      ],
      ["a caption over 100 characters", "socialPost", { ...video, caption: "a".repeat(101) }],
    ] as const)("rejects %s", (_label, kind, record) => {
      expect(socialRecordIssues(kind, record).length).toBeGreaterThan(0);
    });

    it("keeps the Instagram rules for Instagram records", () => {
      const post = {
        platform: "instagram",
        accountExternalId: "17841400000000101",
        externalId: "17930000000000001",
        type: "image",
        publishedAt: 1,
        permalink: "https://www.youtube.com/watch?v=vid00000000",
      };
      expect(socialRecordIssues("socialPost", post)).toEqual([
        "permalink: not an allowed permalink",
      ]);
    });
  });

  it("raises a generic data error that never contains record values", () => {
    const secretish = { ...discovered, username: "IGAAfaketoken leaked" };
    let caught: unknown;
    try {
      assertValidSocialRecord(
        "discoveredSocialAccount",
        secretish,
        "instagram",
        "listSocialAccounts",
      );
    } catch (error) {
      caught = error;
    }
    expect(isProviderError(caught) && caught.kind === "data").toBe(true);
    expect(JSON.stringify({ m: (caught as Error).message, c: caught })).not.toContain(
      "IGAAfaketoken",
    );
  });
});
