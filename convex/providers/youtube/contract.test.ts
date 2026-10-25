import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eachDay } from "../../lib/dates";
import { isProviderError } from "../errors";
import { createMockYouTubeSocialProvider } from "../social/mock/youtube";
import { mockYouTubeChannelId } from "../social/mock/youtubeData";
import type { SocialProvider } from "../social/types";
import { socialRecordIssues } from "../social/validate";
import type { ProviderContext } from "../types";
import { YOUTUBE_CAPABILITIES } from "./capabilities";
import {
  createFakeYouTube,
  FAKE_CHANNEL_ID,
  FAKE_YT_CLIENT_ID,
  FAKE_YT_CLIENT_SECRET,
  fakeVideos,
  type FakeYouTube,
} from "./fakeYouTube.fixtures";
import { createYouTubeSocialProvider } from "./provider";

// ADR 0016: the contract both YouTube providers (the mock, and the live provider against the
// fake API) must pass: valid canonical records only, no tenant, internal, provenance or URL
// fields (other than the built permalink), bounded pagination that terminates without repeats,
// typed errors; Checkpoint 3: snapshots of listed in-window uploads only and exactly one record
// per requested day carrying only values YouTube reports.

const NOW = new Date("2026-10-20T12:00:00Z");
const FORBIDDEN_KEYS = [
  "_id",
  "_creationTime",
  "orgId",
  "socialAccountId",
  "connectionId",
  "linkedAt",
  "createdAt",
  "updatedAt",
  "lastSeenAt",
  "removedAt",
  "profilePictureUrl",
  "mediaUrl",
  "thumbnailUrl",
  "commentsEnabled",
];

let fake: FakeYouTube;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = createFakeYouTube({
    channels: {
      brand: {
        channelId: FAKE_CHANNEL_ID,
        title: "Fake Brand",
        customUrl: "@fakebrand",
        subscriberCount: "12300",
        videos: fakeVideos(130, "2026-10-20T08:00:00Z").map((video, i) => ({
          ...video,
          statistics: { viewCount: String(i * 10), commentCount: "0" },
        })),
        days: Object.fromEntries(
          eachDay("2026-09-17", "2026-10-17")
            .filter((_day, i) => i % 4 !== 0)
            .map((day, i) => [day, { views: i, likes: 0, subscribersGained: 1 }]),
        ),
      },
    },
  });
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Subject = {
  name: string;
  provider: () => SocialProvider;
  ctx: () => ProviderContext;
  account: string;
};

const subjects: Subject[] = [
  {
    name: "mock",
    provider: createMockYouTubeSocialProvider,
    ctx: () => ({
      credential: { kind: "mock_youtube", token: "mock-yt-token-1", user: "1" },
      attempt: 1,
    }),
    account: mockYouTubeChannelId("1"),
  },
  {
    name: "youtube (fake API)",
    provider: () =>
      createYouTubeSocialProvider({
        clientId: FAKE_YT_CLIENT_ID,
        clientSecret: FAKE_YT_CLIENT_SECRET,
      }),
    ctx: () => ({
      credential: {
        kind: "youtube",
        v: 1,
        refreshToken: fake.issueRefreshToken("brand"),
        clientId: FAKE_YT_CLIENT_ID,
        channelId: FAKE_CHANNEL_ID,
        issuedAt: 0,
        scopes: [
          "https://www.googleapis.com/auth/youtube.readonly",
          "https://www.googleapis.com/auth/yt-analytics.readonly",
        ],
      },
      attempt: 1,
    }),
    account: FAKE_CHANNEL_ID,
  },
];

function expectCanonical(kind: Parameters<typeof socialRecordIssues>[0], record: unknown) {
  expect(socialRecordIssues(kind, record), JSON.stringify(record)).toEqual([]);
  for (const key of FORBIDDEN_KEYS) expect(record).not.toHaveProperty(key);
  const urls = JSON.stringify(record).match(/https?:\/\/[^"]*/g) ?? [];
  for (const url of urls) expect(url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]{11}$/);
}

describe.each(subjects)("YouTube SocialProvider contract: $name", (subject) => {
  it("declares the YouTube capabilities", () => {
    expect(subject.provider().capabilities).toBe(YOUTUBE_CAPABILITIES);
    expect(subject.provider().platform).toBe("youtube");
  });

  it("getAccount returns the requested channel only", async () => {
    const record = await subject
      .provider()
      .getAccount(subject.ctx(), { accountExternalId: subject.account });
    expectCanonical("socialAccount", record);
    expect(record.externalId).toBe(subject.account);
    expect(record.accountType).toBe("channel");
  });

  it("listPosts pages terminate, stay within the page size and never repeat a video", async () => {
    const provider = subject.provider();
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await provider.listPosts(subject.ctx(), {
        accountExternalId: subject.account,
        ...(cursor ? { cursor } : {}),
      });
      pages++;
      expect(page.items.length).toBeLessThanOrEqual(YOUTUBE_CAPABILITIES.maxPageSize);
      for (const post of page.items) {
        expectCanonical("socialPost", post);
        expect(post.accountExternalId).toBe(subject.account);
        expect(post.type).toBe("video");
        expect(seen.has(post.externalId)).toBe(false);
        seen.add(post.externalId);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && pages <= YOUTUBE_CAPABILITIES.requestBudget.maxListingPages);
    expect(cursor).toBeUndefined();
    expect(seen.size).toBeGreaterThan(0);
  });

  it("refuses foreign channels and foreign cursors with typed errors", async () => {
    const provider = subject.provider();
    const foreign = await provider
      .listPosts(subject.ctx(), { accountExternalId: "UCotherChannel000000000a" })
      .catch((e: unknown) => e);
    expect(isProviderError(foreign) && foreign.kind).toBe("permission");
    const cursor = await provider
      .listPosts(subject.ctx(), { accountExternalId: subject.account, cursor: "v1.0.abc" })
      .catch((e: unknown) => e);
    expect(isProviderError(cursor) && cursor.kind).toBe("invalid_request");
  });

  it("fetchPostMetrics snapshots only listed, in-window uploads, captured today", async () => {
    const provider = subject.provider();
    const listed = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await provider.listPosts(subject.ctx(), {
        accountExternalId: subject.account,
        ...(cursor ? { cursor } : {}),
      });
      for (const post of page.items) listed.add(post.externalId);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    let snapshots = 0;
    do {
      const page = await provider.fetchPostMetrics(subject.ctx(), {
        accountExternalId: subject.account,
        publishedFrom: "2026-07-22",
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(YOUTUBE_CAPABILITIES.postMetricsPageSize);
      for (const snapshot of page.items) {
        expectCanonical("socialPostSnapshot", snapshot);
        expect(listed.has(snapshot.postExternalId)).toBe(true);
        expect(snapshot.capturedDate).toBe("2026-10-20");
        for (const key of Object.keys(snapshot)) {
          expect([
            "platform",
            "accountExternalId",
            "postExternalId",
            "capturedDate",
            "capturedAt",
            "views",
            "likes",
            "comments",
          ]).toContain(key);
        }
        snapshots++;
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(snapshots).toBeGreaterThan(0);
  });

  it("fetchAccountMetrics returns exactly one record per requested day, reported values only", async () => {
    const page = await subject.provider().fetchAccountMetrics(subject.ctx(), {
      accountExternalId: subject.account,
      from: "2026-09-17",
      to: "2026-10-17",
    });
    expect(page.nextCursor).toBeUndefined();
    expect(page.items.map((day) => day.date)).toEqual(eachDay("2026-09-17", "2026-10-17"));
    let empty = 0;
    for (const day of page.items) {
      expectCanonical("socialAccountDay", day);
      for (const never of ["followerDelta", "reach", "accountsEngaged", "totalInteractions"]) {
        expect(day).not.toHaveProperty(never);
      }
      if (day.views === undefined && day.extras === undefined) empty++;
    }
    expect(empty).toBeGreaterThan(0); // days without a row stay empty, never 0
  });

  it("rejects windows over the capability limit with a typed error", async () => {
    const error = await subject
      .provider()
      .fetchAccountMetrics(subject.ctx(), {
        accountExternalId: subject.account,
        from: "2026-08-01",
        to: "2026-10-17",
      })
      .catch((e: unknown) => e);
    expect(isProviderError(error) && error.kind).toBe("invalid_request");
  });
});
