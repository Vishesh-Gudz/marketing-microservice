import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProviderError, type ProviderError } from "../../errors";
import { socialRecordIssues } from "../../social/validate";
import { INSTAGRAM_CAPABILITIES } from "../capabilities";
import {
  createFakeInstagram,
  FAKE_IG_APP_ID,
  FAKE_IG_TOKEN_MARKER,
  type FakeInstagram,
  type FakeMedia,
} from "../fakeInstagram.fixtures";
import {
  ACCOUNT_INSIGHT_METRICS,
  FOLLOWS_METRIC,
  NEVER_REQUESTED_METRICS,
  READER_POST_METRICS,
  SDK_POST_METRIC_COLUMNS,
} from "../semantics";
import { createInstagramSocialProvider } from "./provider";

// Phase 10 Stage B: the Instagram SocialProvider against the fake Instagram API (documented
// behavior only). The SDK really runs; every request passes the transport allowlist. Checks
// mapping, exact request counts, the per-call budget, concurrency, exclusions and the
// fail-closed preflight checks.

const USER_ID = "17841400000000101";
const BUSY_ID = "17841400000000105";
const NOW = new Date("2026-09-28T12:00:00Z");
const WINDOW_FROM = "2026-07-01"; // the 90-day snapshot window ending 2026-09-28

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

const busyPost = (n: number): FakeMedia => ({
  id: `179100000000${String(n).padStart(5, "0")}`,
  media_type: "IMAGE",
  media_product_type: "FEED",
  timestamp: `2026-09-${String(28 - n).padStart(2, "0")}T08:00:00+0000`,
  insights: { likes: n, reach: 10 * n, views: 20 * n, total_interactions: n },
});

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

let fake: FakeInstagram;
let inFlight = 0;
let maxInFlight = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fake = createFakeInstagram({
    users: {
      business: {
        userId: USER_ID,
        username: "fake_brand",
        accountType: "Business",
        name: "Fake Brand",
        followers: 1234,
        media: POSTS,
        accountInsights: DAY_INSIGHTS,
        follows: {
          "2026-09-01": { FOLLOWER: 7, NON_FOLLOWER: 2 },
          "2026-09-02": { FOLLOWER: 1 },
        },
      },
      busy: {
        userId: BUSY_ID,
        username: "fake_busy",
        accountType: "Business",
        followers: 50, // under 100: follows_and_unfollows is never returned [doc]
        media: Array.from({ length: 12 }, (_, i) => busyPost(i + 1)),
        follows: { "2026-09-01": { FOLLOWER: 3, NON_FOLLOWER: 1 } },
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

const provider = createInstagramSocialProvider({ appId: FAKE_IG_APP_ID });

function ctx(user = "business", userId = USER_ID) {
  return {
    credential: {
      kind: "instagram",
      v: 1,
      accessToken: fake.issueLongLivedToken(user),
      tokenType: "long_lived",
      appId: FAKE_IG_APP_ID,
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

function paths() {
  return fake.requests.map((r) => r.path);
}

function expectOnlyAllowedMetrics() {
  const allowed = new Set([
    ...READER_POST_METRICS,
    ...ACCOUNT_INSIGHT_METRICS,
    FOLLOWS_METRIC,
    ...Object.keys(SDK_POST_METRIC_COLUMNS),
  ]);
  for (const metric of fake.requestedMetrics()) {
    expect(allowed.has(metric), metric).toBe(true);
    expect(NEVER_REQUESTED_METRICS).not.toContain(metric);
  }
}

describe("getAccount (preflight)", () => {
  it("reads the profile and the account type with exactly 2 requests; no URL survives", async () => {
    const record = await provider.getAccount(ctx(), { accountExternalId: USER_ID });
    expect(record).toEqual({
      platform: "instagram",
      externalId: USER_ID,
      username: "fake_brand",
      name: "Fake Brand",
      accountType: "business",
      followersCount: 1234,
      status: "active",
    });
    expect(paths()).toEqual([`/v25.0/${USER_ID}`, "/v25.0/me"]);
    expect(JSON.stringify(record)).not.toMatch(/https?:|biography|website|scontent/);
  });

  it("reports the current account type (drift is decided by the engine)", async () => {
    fake.users.business!.accountType = "Media_Creator";
    const record = await provider.getAccount(ctx(), { accountExternalId: USER_ID });
    expect(record.accountType).toBe("creator");
  });

  it("an unsupported account type fails closed as permission", async () => {
    fake.users.business!.accountType = "Personal";
    const error = await failure(provider.getAccount(ctx(), { accountExternalId: USER_ID }));
    expect([error.kind, error.providerCode]).toEqual(["permission", "account_type_unsupported"]);
  });

  it("checks configuration, credential and account ownership before any request", async () => {
    const unconfigured = createInstagramSocialProvider({});
    expect(
      (await failure(unconfigured.getAccount(ctx(), { accountExternalId: USER_ID }))).providerCode,
    ).toBe("instagram_config_invalid");
    const ads = await failure(
      provider.getAccount(
        { credential: { kind: "meta" }, attempt: 1 },
        { accountExternalId: USER_ID },
      ),
    );
    expect([ads.kind, ads.providerCode]).toEqual(["auth", "credential_invalid"]);
    const foreignApp = createInstagramSocialProvider({ appId: "1790000000000999" });
    const app = await failure(foreignApp.getAccount(ctx(), { accountExternalId: USER_ID }));
    expect([app.kind, app.providerCode]).toEqual(["auth", "app_id_mismatch"]);
    const other = await failure(
      provider.listPosts(ctx(), { accountExternalId: "17841400000000999" }),
    );
    expect([other.kind, other.providerCode]).toEqual(["permission", "account_mismatch"]);
    const bad = await failure(provider.listPosts(ctx(), { accountExternalId: "act_1" }));
    expect([bad.kind, bad.providerCode]).toEqual(["invalid_request", "account_invalid"]);
    expect(fake.requests).toEqual([]);
  });
});

describe("listPosts", () => {
  it("maps organic posts, excludes AD/STORY, counts media without a product type", async () => {
    const page = await provider.listPosts(ctx(), { accountExternalId: USER_ID });
    expect(page.items.map((p) => [p.externalId, p.type])).toEqual([
      [ids.image, "image"],
      [ids.reel, "reel"],
      [ids.carousel, "carousel"],
      [ids.deleted, "image"],
      [ids.old, "image"],
    ]);
    expect(page.unresolved).toBe(1); // the media without media_product_type (R3)
    expect(page.nextCursor).toBeUndefined();
    const carousel = page.items.find((p) => p.externalId === ids.carousel)!;
    expect(carousel).not.toHaveProperty("permalink"); // R1b: not an Instagram permalink
    expect(page.items[0]).toMatchObject({
      permalink: "https://www.instagram.com/p/Cimage/",
      caption: "Image",
      publishedAt: Date.UTC(2026, 8, 28, 8),
    });
    for (const item of page.items) expect(socialRecordIssues("socialPost", item)).toEqual([]);
    // One listing request; never an insights request for anything.
    expect(paths()).toEqual([`/v25.0/${USER_ID}/media`]);
  });

  it("pages 100 media per request with ig1 cursors", async () => {
    fake.users.business!.media = Array.from({ length: 150 }, (_, i) => ({
      ...busyPost((i % 25) + 1),
      id: `179200000000${String(i).padStart(5, "0")}`,
    }));
    const first = await provider.listPosts(ctx(), { accountExternalId: USER_ID });
    expect(first.items).toHaveLength(100);
    expect(first.nextCursor).toMatch(/^ig1\./);
    const second = await provider.listPosts(ctx(), {
      accountExternalId: USER_ID,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(50);
    expect(second.nextCursor).toBeUndefined();
    expect(fake.count(`/v25.0/${USER_ID}/media`)).toBe(2);
    expect(fake.requests.every((r) => new URL(r.url).searchParams.get("limit") === "100")).toBe(
      true,
    );
  });
});

describe("fetchPostMetrics", () => {
  it("snapshots in-window organic posts: 3 requests per post, none for AD / STORY", async () => {
    const page = await provider.fetchPostMetrics(ctx(), {
      accountExternalId: USER_ID,
      publishedFrom: WINDOW_FROM,
    });
    const byPost = Object.fromEntries(page.items.map((s) => [s.postExternalId, s]));
    expect(Object.keys(byPost).sort()).toEqual([ids.image, ids.reel, ids.carousel].sort());
    expect(byPost[ids.image]).toEqual({
      platform: "instagram",
      accountExternalId: USER_ID,
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
    // Missing stays absent; explicit zeros stay zero.
    expect(byPost[ids.reel]).toMatchObject({ likes: 5, reach: 50, views: 900 });
    expect(byPost[ids.reel]).not.toHaveProperty("comments");
    expect(byPost[ids.reel]).not.toHaveProperty("totalInteractions");
    expect(byPost[ids.carousel]).toMatchObject({
      likes: 0,
      comments: 0,
      reach: 0,
      totalInteractions: 0,
    });
    expect(byPost[ids.carousel]).not.toHaveProperty("saves");
    // Unresolved: the media without a product type + the post deleted since the listing.
    expect(page.unresolved).toBe(2);
    // The listing ended at the first post older than the window.
    expect(page.nextCursor).toBeUndefined();
    // 1 listing + 3 per snapshotted post + the deleted post's failed type read.
    expect(fake.count(`/v25.0/${USER_ID}/media`)).toBe(1);
    for (const id of [ids.image, ids.reel, ids.carousel]) {
      expect(fake.count(`/v25.0/${id}`)).toBe(3); // SDK type + SDK insights + reader insights
    }
    for (const id of [ids.ad, ids.story, ids.noType, ids.old]) {
      expect(fake.count(`/v25.0/${id}`)).toBe(0); // never an insights request
    }
    expect(fake.count(`/v25.0/${ids.deleted}`)).toBe(1);
    expectOnlyAllowedMetrics();
    for (const item of page.items) {
      expect(socialRecordIssues("socialPostSnapshot", item)).toEqual([]);
    }
  });

  it("a full page costs exactly 31 requests, at most 3 in flight; the next page continues", async () => {
    const first = await provider.fetchPostMetrics(ctx("busy", BUSY_ID), {
      accountExternalId: BUSY_ID,
      publishedFrom: WINDOW_FROM,
    });
    expect(first.items).toHaveLength(10);
    expect(fake.requests).toHaveLength(31);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(first.nextCursor).toMatch(/^ig1\./);
    fake.reset();
    const second = await provider.fetchPostMetrics(ctx("busy", BUSY_ID), {
      accountExternalId: BUSY_ID,
      publishedFrom: WINDOW_FROM,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeUndefined();
    expect(fake.requests).toHaveLength(1 + 2 * 3);
  });

  it("a failure other than not_found fails the whole page (no partial page)", async () => {
    fake.fail("insights", { status: 503 });
    const error = await failure(
      provider.fetchPostMetrics(ctx(), { accountExternalId: USER_ID, publishedFrom: WINDOW_FROM }),
    );
    expect(error.kind).toBe("transient");
  });

  it("rejects an invalid window before any request", async () => {
    const error = await failure(
      provider.fetchPostMetrics(ctx(), { accountExternalId: USER_ID, publishedFrom: "2026-13-01" }),
    );
    expect([error.kind, error.providerCode]).toEqual(["invalid_request", "window_invalid"]);
    expect(fake.requests).toEqual([]);
  });
});

describe("fetchAccountMetrics", () => {
  it("2 requests per UTC day, 15 days per call, one record per day (also empty days)", async () => {
    const first = await provider.fetchAccountMetrics(ctx(), {
      accountExternalId: USER_ID,
      from: "2026-09-01",
      to: "2026-09-28",
    });
    expect(first.items.map((d) => d.date)).toEqual(
      Array.from({ length: 15 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`),
    );
    expect(fake.requests).toHaveLength(30);
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(first.nextCursor).toMatch(/^ig1\./);
    expect(first.items[0]).toEqual({
      platform: "instagram",
      accountExternalId: USER_ID,
      date: "2026-09-01",
      reach: 100,
      views: 400,
      accountsEngaged: 10,
      totalInteractions: 30,
      followerDelta: 5,
      extras: { likes: 20, comments: 4, shares: 2, saves: 3, replies: 1, profileLinksTaps: 5 },
    });
    // Explicit zeros stay zero; one-sided follows never produce a delta (IR8).
    expect(first.items[1]).toEqual({
      platform: "instagram",
      accountExternalId: USER_ID,
      date: "2026-09-02",
      reach: 90,
      totalInteractions: 0,
      extras: { replies: 0 },
    });
    // A day with an empty data set: a record with no metrics, never zeros.
    expect(first.items[2]).toEqual({
      platform: "instagram",
      accountExternalId: USER_ID,
      date: "2026-09-03",
    });
    for (const item of first.items)
      expect(socialRecordIssues("socialAccountDay", item)).toEqual([]);

    // Exact request shapes: the UTC day window, request A and request B.
    const day1 = fake.requests.filter(
      (r) => new URL(r.url).searchParams.get("since") === String(Date.UTC(2026, 8, 1) / 1000),
    );
    expect(day1).toHaveLength(2);
    for (const request of day1) {
      const params = new URL(request.url).searchParams;
      expect(params.get("until")).toBe(String(Date.UTC(2026, 8, 2) / 1000));
      expect(params.get("period")).toBe("day");
      expect(params.get("metric_type")).toBe("total_value");
      expect(request.bearer).toBe(true);
    }
    expect(day1.map((r) => new URL(r.url).searchParams.get("breakdown")).sort()).toEqual([
      "follow_type",
      null,
    ]);

    fake.reset();
    const second = await provider.fetchAccountMetrics(ctx(), {
      accountExternalId: USER_ID,
      from: "2026-09-01",
      to: "2026-09-28",
      cursor: first.nextCursor!,
    });
    expect(second.items.map((d) => d.date)).toEqual(
      Array.from({ length: 13 }, (_, i) => `2026-09-${String(i + 16).padStart(2, "0")}`),
    );
    expect(second.nextCursor).toBeUndefined();
    expect(fake.requests).toHaveLength(26);
    expectOnlyAllowedMetrics();
  });

  it("an account under 100 followers never gets a followerDelta", async () => {
    const page = await provider.fetchAccountMetrics(ctx("busy", BUSY_ID), {
      accountExternalId: BUSY_ID,
      from: "2026-09-01",
      to: "2026-09-01",
    });
    expect(page.items).toEqual([
      { platform: "instagram", accountExternalId: BUSY_ID, date: "2026-09-01" },
    ]);
    expect(fake.requests).toHaveLength(2);
  });

  it("rejects ranges over 31 days, reversed ranges and foreign cursors", async () => {
    for (const [from, to] of [
      ["2026-08-01", "2026-09-28"],
      ["2026-09-02", "2026-09-01"],
      ["2026-09-01", "not-a-day"],
    ] as const) {
      const error = await failure(
        provider.fetchAccountMetrics(ctx(), { accountExternalId: USER_ID, from, to }),
      );
      expect([error.kind, error.providerCode]).toEqual(["invalid_request", "window_invalid"]);
    }
    const first = await provider.fetchAccountMetrics(ctx(), {
      accountExternalId: USER_ID,
      from: "2026-09-01",
      to: "2026-09-28",
    });
    const foreign = await failure(
      provider.fetchAccountMetrics(ctx(), {
        accountExternalId: USER_ID,
        from: "2026-09-02",
        to: "2026-09-28",
        cursor: first.nextCursor!,
      }),
    );
    expect([foreign.kind, foreign.providerCode]).toEqual(["invalid_request", "cursor_invalid"]);
  });

  it("classifies failures and never leaks the token", async () => {
    fake.fail("account_insights", { status: 400, body: { error: { code: 190 } } });
    const error = await failure(
      provider.fetchAccountMetrics(ctx(), {
        accountExternalId: USER_ID,
        from: "2026-09-01",
        to: "2026-09-01",
      }),
    );
    expect([error.kind, error.providerCode]).toEqual(["auth", "190"]);
    expect(JSON.stringify(error)).not.toContain(FAKE_IG_TOKEN_MARKER);
    expect(fake.requests.every((r) => !r.url.includes(FAKE_IG_TOKEN_MARKER))).toBe(true);
  });
});

describe("capabilities", () => {
  it("declares what the provider implements", () => {
    expect(provider.capabilities).toBe(INSTAGRAM_CAPABILITIES);
  });
});
