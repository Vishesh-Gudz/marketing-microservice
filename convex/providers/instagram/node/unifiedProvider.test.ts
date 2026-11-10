import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProviderError, type ProviderError } from "../../errors";
import { socialRecordIssues } from "../../social/validate";
import { createFakeInstagram, FAKE_IG_APP_ID, type FakeMedia } from "../fakeInstagram.fixtures";
import {
  createFakeUnified,
  FAKE_UNIFIED_APP_ID,
  FAKE_UNIFIED_TOKEN_MARKER,
  type FakeUnified,
} from "../fakeUnified.fixtures";
import { ACCOUNT_INSIGHT_METRICS, FOLLOWS_METRIC, NEVER_REQUESTED_METRICS } from "../semantics";
import { UNIFIED_POST_METRICS } from "../transport";
import { createInstagramSocialProvider } from "./provider";

// O1: the Instagram SocialProvider with an Instagram API with Unified Login credential, against
// the fake graph.facebook.com (documented shapes only). Every read goes through the Unified
// organic reader (no SDK): exact requests, budgets, exclusions, error mapping, and rows
// identical to what the Instagram Login path stores for the same media.

const IG = "17841400000000301"; // the fake client's assigned account
const NOW = new Date("2026-09-28T12:00:00Z");
const WINDOW_FROM = "2026-07-01";
const V = "/v26.0";

const ids = {
  image: "17900000000000001",
  reel: "17900000000000002",
  ad: "17900000000000003",
  story: "17900000000000004",
  carousel: "17900000000000005",
  noType: "17900000000000006",
  deleted: "17900000000000007",
  old: "17900000000000008",
};

const POSTS: FakeMedia[] = [
  {
    id: ids.image,
    caption: "Image",
    media_type: "IMAGE",
    media_product_type: "FEED",
    permalink: "https://www.instagram.com/p/Cimage/",
    timestamp: "2026-09-28T08:00:00+0000",
    insights: {
      likes: 10,
      comments: 2,
      saved: 3,
      shares: 1,
      reach: 100,
      views: 250,
      total_interactions: 16,
    },
  },
  {
    id: ids.reel,
    media_type: "VIDEO",
    media_product_type: "REELS",
    permalink: "https://www.instagram.com/reel/Creel/",
    timestamp: "2026-09-27T08:00:00+0000",
    insights: { likes: 5, reach: 50, views: 900 },
  },
  {
    id: ids.ad,
    media_type: "IMAGE",
    media_product_type: "AD",
    timestamp: "2026-09-26T08:00:00+0000",
    insights: { likes: 999 },
  },
  {
    id: ids.story,
    media_type: "IMAGE",
    media_product_type: "STORY",
    timestamp: "2026-09-25T08:00:00+0000",
    insights: { reach: 999 },
  },
  {
    id: ids.carousel,
    caption: "Carousel",
    media_type: "CAROUSEL_ALBUM",
    media_product_type: "FEED",
    permalink: "https://evil.example/p/x",
    timestamp: "2026-09-24T08:00:00+0000",
    insights: { likes: 0, comments: 0, reach: 0, total_interactions: 0 },
  },
  {
    id: ids.noType,
    media_type: "VIDEO",
    timestamp: "2026-09-23T08:00:00+0000",
    insights: { likes: 1 },
  },
  {
    id: ids.deleted,
    media_type: "IMAGE",
    media_product_type: "FEED",
    timestamp: "2026-09-22T08:00:00+0000",
    deleted: true,
  },
  {
    id: ids.old,
    media_type: "IMAGE",
    media_product_type: "FEED",
    timestamp: "2026-06-01T08:00:00+0000",
    insights: { likes: 4 },
  },
];

const DAY_INSIGHTS: Record<string, Record<string, number>> = {
  "2026-09-01": {
    reach: 100,
    views: 400,
    accounts_engaged: 10,
    total_interactions: 30,
    likes: 20,
    comments: 4,
    shares: 2,
    saves: 3,
    replies: 1,
    profile_links_taps: 5,
  },
  "2026-09-02": { reach: 90, total_interactions: 0, replies: 0 },
  // 2026-09-03: nothing reported (empty data set)
};
const FOLLOWS = {
  "2026-09-01": { FOLLOWER: 7, NON_FOLLOWER: 2 },
  "2026-09-02": { FOLLOWER: 1 },
};

const busyPost = (n: number): FakeMedia => ({
  id: `179100000000${String(n).padStart(5, "0")}`,
  media_type: "IMAGE",
  media_product_type: "FEED",
  timestamp: `2026-09-${String(28 - n).padStart(2, "0")}T08:00:00+0000`,
  insights: { likes: n, reach: 10 * n, views: 20 * n, total_interactions: n },
});

let fake: FakeUnified;
let inFlight = 0;
let maxInFlight = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = createFakeUnified({
    organic: {
      [IG]: {
        name: "Fake Unified",
        followers: 1234,
        media: POSTS.map((m) => ({ ...m })),
        accountInsights: DAY_INSIGHTS,
        follows: FOLLOWS,
      },
    },
  });
  inFlight = 0;
  maxInFlight = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return await fake.fetch(input, init);
    } finally {
      inFlight--;
    }
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const provider = createInstagramSocialProvider({ appId: FAKE_UNIFIED_APP_ID });

function ctx(client = "insights", userId = IG) {
  return {
    credential: {
      kind: "instagram",
      v: 1,
      setup: "unified",
      accessToken: fake.issueToken(client),
      tokenType: "system_user",
      appId: FAKE_UNIFIED_APP_ID,
      userId,
      issuedAt: 0,
    },
    attempt: 1,
  };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.catch((e: unknown) => e);
  if (!isProviderError(error)) throw new Error(`expected ProviderError, got ${String(error)}`);
  return error;
}

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const paths = () => fake.requests.map((r) => r.path);

/** Every request: graph.facebook.com/v26.0, GET, Bearer, no secret in the URL, allowed metrics. */
function expectUnifiedRequestsOnly() {
  const allowed = new Set([...UNIFIED_POST_METRICS.split(","), ...ACCOUNT_INSIGHT_METRICS]);
  allowed.add(FOLLOWS_METRIC);
  for (const request of fake.requests) {
    const url = new URL(request.url);
    expect(url.hostname).toBe("graph.facebook.com");
    expect(url.pathname.startsWith(`${V}/`)).toBe(true);
    expect(request.method).toBe("GET");
    expect(request.bearer).toBe(true);
    expect(request.url).not.toContain(FAKE_UNIFIED_TOKEN_MARKER);
    expect(request.params).not.toContain("access_token");
    expect(request.params).not.toContain("appsecret_proof");
  }
  for (const metric of fake.requestedMetrics()) {
    expect(allowed.has(metric), metric).toBe(true);
    expect(NEVER_REQUESTED_METRICS).not.toContain(metric);
  }
}

describe("getAccount (Unified preflight)", () => {
  it("reads the profile with exactly 1 request; account type PROVISIONAL business", async () => {
    const record = await provider.getAccount(ctx(), { accountExternalId: IG });
    expect(record).toEqual({
      platform: "instagram",
      externalId: IG,
      username: "fake_unified",
      name: "Fake Unified",
      accountType: "business",
      followersCount: 1234,
      status: "active",
    });
    expect(paths()).toEqual([`${V}/${IG}`]);
    expect(new URL(fake.requests[0]!.url).searchParams.get("fields")).toBe(
      "id,username,name,followers_count,media_count",
    );
    expect(socialRecordIssues("socialAccount", record)).toEqual([]);
    expectUnifiedRequestsOnly();
  });

  it("falls back to the username when Meta reports no name", async () => {
    delete fake.organic[IG]!.name;
    const record = await provider.getAccount(ctx(), { accountExternalId: IG });
    expect(record.name).toBe("fake_unified");
  });

  it("refuses a profile answering for another account", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ id: "17841400000000999", username: "someone_else" }),
    );
    const error = await failure(provider.getAccount(ctx(), { accountExternalId: IG }));
    expect([error.kind, error.providerCode]).toEqual(["data", "identity_mismatch"]);
  });

  it("checks the app and the account before any request", async () => {
    const foreignApp = createInstagramSocialProvider({ appId: FAKE_IG_APP_ID });
    const app = await failure(foreignApp.getAccount(ctx(), { accountExternalId: IG }));
    expect([app.kind, app.providerCode]).toEqual(["auth", "app_id_mismatch"]);
    const other = await failure(
      provider.listPosts(ctx(), { accountExternalId: "17841400000000999" }),
    );
    expect([other.kind, other.providerCode]).toEqual(["permission", "account_mismatch"]);
    const malformed = await failure(
      provider.getAccount(
        { credential: { ...ctx().credential, tokenType: "long_lived" }, attempt: 1 },
        { accountExternalId: IG },
      ),
    );
    expect([malformed.kind, malformed.providerCode]).toEqual(["auth", "credential_invalid"]);
    expect(fake.requests).toEqual([]);
  });
});

describe("listPosts (Unified)", () => {
  it("maps organic posts, excludes AD/STORY, counts media without a product type", async () => {
    const page = await provider.listPosts(ctx(), { accountExternalId: IG });
    expect(page.items.map((p) => [p.externalId, p.type])).toEqual([
      [ids.image, "image"],
      [ids.reel, "reel"],
      [ids.carousel, "carousel"],
      [ids.deleted, "image"],
      [ids.old, "image"],
    ]);
    expect(page.unresolved).toBe(1);
    expect(page.nextCursor).toBeUndefined();
    expect(page.items.find((p) => p.externalId === ids.carousel)).not.toHaveProperty("permalink");
    expect(page.items[0]).toMatchObject({
      permalink: "https://www.instagram.com/p/Cimage/",
      caption: "Image",
      publishedAt: Date.UTC(2026, 8, 28, 8),
    });
    for (const item of page.items) expect(socialRecordIssues("socialPost", item)).toEqual([]);
    expect(paths()).toEqual([`${V}/${IG}/media`]);
    const params = new URL(fake.requests[0]!.url).searchParams;
    expect(params.get("fields")).toBe(
      "id,caption,media_type,media_product_type,permalink,timestamp",
    );
    expect(params.get("limit")).toBe("100");
    expectUnifiedRequestsOnly();
  });

  it("pages 100 media per request with ig1 cursors and never follows `next` URLs", async () => {
    fake.organic[IG]!.media = Array.from({ length: 150 }, (_, i) => ({
      ...busyPost((i % 25) + 1),
      id: `179200000000${String(i).padStart(5, "0")}`,
    }));
    const first = await provider.listPosts(ctx(), { accountExternalId: IG });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toMatch(/^ig1\./);
    expect(first.nextCursor).not.toContain(FAKE_UNIFIED_TOKEN_MARKER);
    const second = await provider.listPosts(ctx(), {
      accountExternalId: IG,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(50);
    expect(second.nextCursor).toBeUndefined();
    expect(fake.count(`${V}/${IG}/media`)).toBe(2);
    expect(new URL(fake.requests[1]!.url).searchParams.get("after")).not.toBeNull();
    expectUnifiedRequestsOnly();
  });

  it("refuses a cursor from another request (an account metrics cursor, a malformed one)", async () => {
    const days = await provider.fetchAccountMetrics(ctx(), {
      accountExternalId: IG,
      from: "2026-09-01",
      to: "2026-09-28",
    });
    fake.reset();
    for (const cursor of [days.nextCursor!, "ig1.bogus.0"]) {
      const error = await failure(provider.listPosts(ctx(), { accountExternalId: IG, cursor }));
      expect([error.kind, error.providerCode]).toEqual(["invalid_request", "cursor_invalid"]);
    }
    expect(fake.requests).toEqual([]);
  });

  it("fails closed on a next page without a usable cursor", async () => {
    vi.stubGlobal("fetch", async () =>
      jsonResponse({ data: [], paging: { next: "https://graph.facebook.com/x" } }),
    );
    const error = await failure(provider.listPosts(ctx(), { accountExternalId: IG }));
    expect([error.kind, error.providerCode]).toEqual(["data", "cursor_unexpected"]);
  });
});

describe("fetchPostMetrics (Unified)", () => {
  it("snapshots in-window organic posts with ONE request per post, none for AD / STORY", async () => {
    const page = await provider.fetchPostMetrics(ctx(), {
      accountExternalId: IG,
      publishedFrom: WINDOW_FROM,
    });
    const byPost = Object.fromEntries(page.items.map((s) => [s.postExternalId, s]));
    expect(Object.keys(byPost).sort()).toEqual([ids.image, ids.reel, ids.carousel].sort());
    expect(byPost[ids.image]).toEqual({
      platform: "instagram",
      accountExternalId: IG,
      postExternalId: ids.image,
      capturedDate: "2026-09-28",
      capturedAt: NOW.getTime(),
      likes: 10,
      comments: 2,
      saves: 3,
      shares: 1,
      reach: 100,
      views: 250,
      totalInteractions: 16,
    });
    expect(byPost[ids.reel]).toMatchObject({ likes: 5, reach: 50, views: 900 });
    expect(byPost[ids.reel]).not.toHaveProperty("comments");
    expect(byPost[ids.carousel]).toMatchObject({ likes: 0, comments: 0, totalInteractions: 0 });
    expect(byPost[ids.carousel]).not.toHaveProperty("saves");
    // Unresolved: the media without a product type + the post deleted since the listing.
    expect(page.unresolved).toBe(2);
    expect(page.nextCursor).toBeUndefined();
    expect(fake.count(`${V}/${IG}/media`)).toBe(1);
    for (const id of [ids.image, ids.reel, ids.carousel, ids.deleted]) {
      expect(fake.count(`${V}/${id}`)).toBe(1);
      const request = fake.requests.find((r) => r.path === `${V}/${id}/insights`)!;
      const params = new URL(request.url).searchParams;
      expect(params.get("metric")).toBe(UNIFIED_POST_METRICS);
      expect(params.get("period")).toBe("lifetime");
      expect(request.params).toEqual(["metric", "period"]);
    }
    for (const id of [ids.ad, ids.story, ids.noType, ids.old]) {
      expect(fake.count(`${V}/${id}`)).toBe(0);
    }
    for (const item of page.items) {
      expect(socialRecordIssues("socialPostSnapshot", item)).toEqual([]);
    }
    expectUnifiedRequestsOnly();
  });

  it("a full page costs 11 requests (listing + 10 posts), at most 3 in flight", async () => {
    fake.organic[IG]!.media = Array.from({ length: 12 }, (_, i) => busyPost(i + 1));
    const first = await provider.fetchPostMetrics(ctx(), {
      accountExternalId: IG,
      publishedFrom: WINDOW_FROM,
    });
    expect(first.items).toHaveLength(10);
    expect(fake.requests).toHaveLength(11);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(first.nextCursor).toMatch(/^ig1\./);
    fake.reset();
    const second = await provider.fetchPostMetrics(ctx(), {
      accountExternalId: IG,
      publishedFrom: WINDOW_FROM,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    expect(fake.requests).toHaveLength(1 + 2);
  });

  it.each([
    ["a missing insights permission (code 10)", { status: 403, code: 10 }, "permission", "10"],
    ["an expired token (190)", { status: 400, code: 190 }, "auth", "190"],
    ["throttling (4)", { status: 400, code: 4 }, "rate_limited", "4"],
    ["a server error", { status: 500, code: 1 }, "transient", "1"],
  ] as const)("classifies %s", async (_label, failureSpec, kind, code) => {
    fake.failures.media_insights = failureSpec;
    const error = await failure(
      provider.fetchPostMetrics(ctx(), { accountExternalId: IG, publishedFrom: WINDOW_FROM }),
    );
    expect([error.kind, error.providerCode]).toEqual([kind, code]);
    expect(JSON.stringify(error)).not.toContain(FAKE_UNIFIED_TOKEN_MARKER);
  });

  it("a connection without instagram_manage_insights is refused by Meta (code 10, permission)", async () => {
    const error = await failure(
      provider.fetchPostMetrics(ctx("messaging"), {
        accountExternalId: IG,
        publishedFrom: WINDOW_FROM,
      }),
    );
    expect([error.kind, error.providerCode]).toEqual(["permission", "10"]);
  });
});

describe("fetchAccountMetrics (Unified)", () => {
  it("the Instagram Login day requests on graph.facebook.com: 2 per day, 15 days per call", async () => {
    const first = await provider.fetchAccountMetrics(ctx(), {
      accountExternalId: IG,
      from: "2026-09-01",
      to: "2026-09-28",
    });
    expect(first.items).toHaveLength(15);
    expect(fake.requests).toHaveLength(30);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(first.items[0]).toEqual({
      platform: "instagram",
      accountExternalId: IG,
      date: "2026-09-01",
      reach: 100,
      views: 400,
      accountsEngaged: 10,
      totalInteractions: 30,
      followerDelta: 5,
      extras: { likes: 20, comments: 4, shares: 2, saves: 3, replies: 1, profileLinksTaps: 5 },
    });
    expect(first.items[1]).toEqual({
      platform: "instagram",
      accountExternalId: IG,
      date: "2026-09-02",
      reach: 90,
      totalInteractions: 0,
      extras: { replies: 0 },
    });
    expect(first.items[2]).toEqual({
      platform: "instagram",
      accountExternalId: IG,
      date: "2026-09-03",
    });
    const day1 = fake.requests.filter(
      (r) => new URL(r.url).searchParams.get("since") === String(Date.UTC(2026, 8, 1) / 1000),
    );
    expect(day1.map((r) => r.params.join("&")).sort()).toEqual([
      "breakdown&metric&metric_type&period&since&until",
      "metric&metric_type&period&since&until",
    ]);
    expect(
      day1
        .map((r) => new URL(r.url).searchParams.get("metric"))
        .sort((a, b) => a!.length - b!.length),
    ).toEqual([FOLLOWS_METRIC, ACCOUNT_INSIGHT_METRICS.join(",")]);
    expect(first.nextCursor).toMatch(/^ig1\./);
    fake.reset();
    const second = await provider.fetchAccountMetrics(ctx(), {
      accountExternalId: IG,
      from: "2026-09-01",
      to: "2026-09-28",
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(13);
    expect(second.nextCursor).toBeUndefined();
    expectUnifiedRequestsOnly();
  });

  it("under 100 followers there is no follow breakdown and no followerDelta", async () => {
    fake.organic[IG]!.followers = 50;
    const page = await provider.fetchAccountMetrics(ctx(), {
      accountExternalId: IG,
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(page.items[0]).not.toHaveProperty("followerDelta");
    expect(fake.requests).toHaveLength(2);
  });

  it("classifies failures and never leaks the token", async () => {
    fake.failures.account_insights = { status: 400, code: 190 };
    const error = await failure(
      provider.fetchAccountMetrics(ctx(), {
        accountExternalId: IG,
        from: "2026-09-01",
        to: "2026-09-01",
      }),
    );
    expect([error.kind, error.providerCode]).toEqual(["auth", "190"]);
    expect(JSON.stringify(error)).not.toContain(FAKE_UNIFIED_TOKEN_MARKER);
  });
});

describe("same rows as the Instagram Login path", () => {
  it("posts, snapshots and days are identical for the same media and insights", async () => {
    const login = createFakeInstagram({
      users: {
        business: {
          userId: IG,
          username: "fake_unified",
          accountType: "Business",
          name: "Fake Unified",
          followers: 1234,
          media: POSTS.map((m) => ({ ...m })),
          accountInsights: DAY_INSIGHTS,
          follows: FOLLOWS,
        },
      },
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
      return host === "graph.facebook.com" ? fake.fetch(input, init) : login.fetch(input, init);
    });
    const loginProvider = createInstagramSocialProvider({ appId: FAKE_IG_APP_ID });
    const loginCtx = {
      credential: {
        kind: "instagram",
        v: 1,
        accessToken: login.issueLongLivedToken("business"),
        tokenType: "long_lived",
        appId: FAKE_IG_APP_ID,
        userId: IG,
        issuedAt: 0,
      },
      attempt: 1,
    };
    const account = { accountExternalId: IG };
    const window = { ...account, publishedFrom: WINDOW_FROM };
    const days = { ...account, from: "2026-09-01", to: "2026-09-05" };

    const strip = <T extends { nextCursor?: string }>({ nextCursor: _c, ...rest }: T) => rest;
    expect(strip(await provider.listPosts(ctx(), account))).toEqual(
      strip(await loginProvider.listPosts(loginCtx, account)),
    );
    expect(strip(await provider.fetchPostMetrics(ctx(), window))).toEqual(
      strip(await loginProvider.fetchPostMetrics(loginCtx, window)),
    );
    expect(strip(await provider.fetchAccountMetrics(ctx(), days))).toEqual(
      strip(await loginProvider.fetchAccountMetrics(loginCtx, days)),
    );
    expect(await provider.getAccount(ctx(), account)).toEqual(
      await loginProvider.getAccount(loginCtx, account),
    );
    // The Unified path never reached graph.instagram.com, the Login path never Facebook.
    expect(login.requests.every((r) => r.host !== "graph.facebook.com")).toBe(true);
    expectUnifiedRequestsOnly();
  });
});
