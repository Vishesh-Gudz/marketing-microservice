import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eachDay } from "../../lib/dates";
import { isProviderError } from "../errors";
import { INSTAGRAM_CAPABILITIES } from "../instagram/capabilities";
import {
  createFakeInstagram,
  FAKE_IG_APP_ID,
  type FakeInstagram,
  type FakeMedia,
} from "../instagram/fakeInstagram.fixtures";
import { createInstagramSocialProvider } from "../instagram/node/provider";
import type { ProviderContext } from "../types";
import { createMockSocialProvider, mockInstagramAccountId } from "./mock";
import type { SocialProvider } from "./types";
import { socialRecordIssues } from "./validate";

// Phase 10 Stage B: the contract every SocialProvider must pass (the mock, and Instagram
// against the fake API): valid records only, no tenant/internal/provenance/URL fields
// (other than the permalink), bounded pagination that terminates, snapshots only of listed
// posts, exactly one record per requested account day, typed errors.

const NOW = new Date("2026-09-28T12:00:00Z");
const FORBIDDEN_KEYS = [
  "_id",
  "_creationTime",
  "orgId",
  "socialAccountId",
  "postId",
  "connectionId",
  "linkedAt",
  "createdAt",
  "updatedAt",
  "lastSeenAt",
  "removedAt",
  "syncedAt",
  "followers",
  "followersCapturedAt",
  "insightsSyncedAt",
  "profilePictureUrl",
  "mediaUrl",
  "thumbnailUrl",
  "videoViews",
  "profileViews",
  "websiteClicks",
];

type Subject = {
  name: string;
  provider: () => SocialProvider;
  ctx: () => ProviderContext;
  account: string;
};

const IG_USER = "17841400000000101";
let fake: FakeInstagram;

const fakeMedia = (n: number, productType = "FEED"): FakeMedia => ({
  id: `179300000000${String(n).padStart(5, "0")}`,
  media_type: n % 3 === 0 ? "VIDEO" : "IMAGE",
  media_product_type: productType,
  permalink: `https://www.instagram.com/p/C${n}/`,
  timestamp: new Date(NOW.getTime() - n * 36 * 3_600_000).toISOString().replace(".000Z", "+0000"),
  insights: { likes: n, reach: n * 10, views: n * 20, total_interactions: n + 1 },
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = createFakeInstagram({
    users: {
      business: {
        userId: IG_USER,
        username: "fake_brand",
        accountType: "Business",
        followers: 500,
        media: Array.from({ length: 130 }, (_, i) => fakeMedia(i + 1, i === 4 ? "AD" : "FEED")),
        accountInsights: { "2026-09-27": { reach: 5, views: 0 } },
        follows: { "2026-09-27": { FOLLOWER: 2, NON_FOLLOWER: 1 } },
      },
    },
  });
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const subjects: Subject[] = [
  {
    name: "mock",
    provider: createMockSocialProvider,
    ctx: () => ({
      credential: { kind: "mock_social", token: "mock-ig-token-1", user: "1" },
      attempt: 1,
    }),
    account: mockInstagramAccountId("1"),
  },
  {
    name: "instagram (fake API)",
    provider: () => createInstagramSocialProvider({ appId: FAKE_IG_APP_ID }),
    ctx: () => ({
      credential: {
        kind: "instagram",
        v: 1,
        accessToken: fake.issueLongLivedToken("business"),
        tokenType: "long_lived",
        appId: FAKE_IG_APP_ID,
        userId: IG_USER,
        issuedAt: 0,
      },
      attempt: 1,
    }),
    account: IG_USER,
  },
];

function expectCanonical(kind: Parameters<typeof socialRecordIssues>[0], record: unknown) {
  expect(socialRecordIssues(kind, record), JSON.stringify(record)).toEqual([]);
  for (const key of FORBIDDEN_KEYS) expect(record).not.toHaveProperty(key);
  const urls = JSON.stringify(record).match(/https?:\/\/[^"]*/g) ?? [];
  for (const url of urls) expect(url).toMatch(/^https:\/\/(www\.)?instagram\.com\//);
}

describe.each(subjects)("SocialProvider contract: $name", (subject) => {
  it("declares the Instagram capabilities", () => {
    expect(subject.provider().capabilities).toBe(INSTAGRAM_CAPABILITIES);
  });

  it("getAccount returns the requested account only", async () => {
    const record = await subject
      .provider()
      .getAccount(subject.ctx(), { accountExternalId: subject.account });
    expectCanonical("socialAccount", record);
    expect(record.externalId).toBe(subject.account);
    expect(INSTAGRAM_CAPABILITIES.accountTypes).toContain(record.accountType);
  });

  it("listPosts pages terminate, stay within the page size and never repeat a post", async () => {
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
      expect(page.items.length).toBeLessThanOrEqual(INSTAGRAM_CAPABILITIES.maxPageSize);
      expect(Number.isSafeInteger(page.unresolved ?? 0)).toBe(true);
      for (const post of page.items) {
        expectCanonical("socialPost", post);
        expect(post.accountExternalId).toBe(subject.account);
        expect(seen.has(post.externalId)).toBe(false);
        seen.add(post.externalId);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && pages <= INSTAGRAM_CAPABILITIES.requestBudget.maxListingPages);
    expect(cursor).toBeUndefined();
    expect(seen.size).toBeGreaterThan(0);
  });

  it("fetchPostMetrics snapshots only listed, in-window posts, captured today", async () => {
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
        publishedFrom: "2026-07-01",
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(INSTAGRAM_CAPABILITIES.postMetricsPageSize);
      for (const snapshot of page.items) {
        expectCanonical("socialPostSnapshot", snapshot);
        expect(listed.has(snapshot.postExternalId)).toBe(true);
        expect(snapshot.capturedDate).toBe("2026-09-28");
        snapshots++;
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(snapshots).toBeGreaterThan(0);
  });

  it("fetchAccountMetrics returns exactly one record per requested day", async () => {
    const provider = subject.provider();
    const days: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await provider.fetchAccountMetrics(subject.ctx(), {
        accountExternalId: subject.account,
        from: "2026-08-29",
        to: "2026-09-28",
        ...(cursor ? { cursor } : {}),
      });
      for (const day of page.items) {
        expectCanonical("socialAccountDay", day);
        days.push(day.date);
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(days).toEqual(eachDay("2026-08-29", "2026-09-28"));
  });

  it("rejects ranges over the capability limit and foreign accounts with typed errors", async () => {
    const provider = subject.provider();
    const tooLong = await provider
      .fetchAccountMetrics(subject.ctx(), {
        accountExternalId: subject.account,
        from: "2026-08-01",
        to: "2026-09-28",
      })
      .catch((e: unknown) => e);
    expect(isProviderError(tooLong) && tooLong.kind).toBe("invalid_request");
    const foreign = await provider
      .listPosts(subject.ctx(), { accountExternalId: "17841400000000999" })
      .catch((e: unknown) => e);
    expect(isProviderError(foreign) && foreign.kind).toBe("permission");
  });
});
