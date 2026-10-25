import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProviderError, type ProviderError } from "../errors";
import type { ProviderContext } from "../types";
import {
  createFakeYouTube,
  FAKE_CHANNEL_ID,
  FAKE_YT_ANALYTICS_SCOPE,
  FAKE_YT_CLIENT_ID,
  FAKE_YT_CLIENT_SECRET,
  FAKE_YT_READONLY_SCOPE,
  FAKE_YT_TOKEN_MARKER,
  fakeVideos,
  type FakeChannel,
  type FakeVideo,
  type FakeYouTube,
} from "./fakeYouTube.fixtures";
import { createYouTubeSocialProvider } from "./provider";

// ADR 0016: the YouTube provider against the fake Google API. Checks before any network access,
// exact request counts, the uploads listing and its cursor, exclusions and unresolved counts,
// typed errors, and no token in any URL, record or error. Checkpoint 3: video lifetime
// statistics and the channel day report, stored as reported (missing = absent, never 0).

const CONFIG = { clientId: FAKE_YT_CLIENT_ID, clientSecret: FAKE_YT_CLIENT_SECRET };
let fake: FakeYouTube;

function setup(videos = fakeVideos(120, "2026-10-20T10:00:00Z"), brand: Partial<FakeChannel> = {}) {
  fake = createFakeYouTube({
    channels: {
      brand: {
        channelId: FAKE_CHANNEL_ID,
        title: "Fake Brand",
        customUrl: "@fakebrand",
        subscriberCount: "12300",
        videos,
        ...brand,
      },
      hidden: { channelId: "UChiddenChannel00000000a", title: "Hidden", hidden: true },
    },
  });
  vi.stubGlobal("fetch", fake.fetch);
}

function ctx(overrides: Record<string, unknown> = {}, user = "brand"): ProviderContext {
  return {
    credential: {
      kind: "youtube",
      v: 1,
      refreshToken: fake.issueRefreshToken(user),
      clientId: FAKE_YT_CLIENT_ID,
      channelId: FAKE_CHANNEL_ID,
      issuedAt: 0,
      scopes: [],
      ...overrides,
    },
    attempt: 1,
  };
}

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.catch((e: unknown) => e);
  if (!isProviderError(error)) throw new Error(`expected ProviderError, got ${String(error)}`);
  return error;
}

beforeEach(() => setup());
afterEach(() => vi.unstubAllGlobals());

describe("getAccount", () => {
  it("mints a token and reads the owned channel: 2 requests, token only in body/header", async () => {
    const provider = createYouTubeSocialProvider(CONFIG);
    const record = await provider.getAccount(ctx(), { accountExternalId: FAKE_CHANNEL_ID });
    expect(record).toEqual({
      platform: "youtube",
      externalId: FAKE_CHANNEL_ID,
      username: "fakebrand",
      name: "Fake Brand",
      accountType: "channel",
      followersCount: 12_300,
      status: "active",
    });
    expect(fake.requests.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
      "POST oauth2.googleapis.com/token",
      "GET www.googleapis.com/youtube/v3/channels",
    ]);
    expect(fake.requests[1]!.bearer).toBe(true);
    for (const request of fake.requests) expect(request.url).not.toContain(FAKE_YT_TOKEN_MARKER);
    expect(JSON.stringify(record)).not.toContain(FAKE_YT_TOKEN_MARKER);
  });

  it("keeps a hidden subscriber count absent", async () => {
    const provider = createYouTubeSocialProvider(CONFIG);
    const record = await provider.getAccount(
      ctx({ channelId: "UChiddenChannel00000000a" }, "hidden"),
      { accountExternalId: "UChiddenChannel00000000a" },
    );
    expect(record).not.toHaveProperty("followersCount");
  });

  it("refuses a channel the authorization does not own", async () => {
    // The credential claims a channel, but mine=true answers for another one.
    const provider = createYouTubeSocialProvider(CONFIG);
    const error = await rejection(
      provider.getAccount(ctx({ channelId: "UChiddenChannel00000000a" }), {
        accountExternalId: "UChiddenChannel00000000a",
      }),
    );
    expect([error.kind, error.providerCode]).toEqual(["permission", "account_mismatch"]);
  });

  it.each<[string, Record<string, unknown>, string, string, string]>([
    ["a foreign channel", {}, "UCotherChannel000000000a", "permission", "account_mismatch"],
    ["a malformed channel id", {}, "not-a-channel", "invalid_request", "account_invalid"],
    [
      "another OAuth client",
      { clientId: "1-other.apps.googleusercontent.com" },
      FAKE_CHANNEL_ID,
      "auth",
      "client_id_mismatch",
    ],
    ["a malformed credential", { refreshToken: "" }, FAKE_CHANNEL_ID, "auth", "credential_invalid"],
  ])("fails before any request for %s", async (_label, overrides, channel, kind, code) => {
    const provider = createYouTubeSocialProvider(CONFIG);
    const error = await rejection(
      provider.getAccount(ctx(overrides), { accountExternalId: channel }),
    );
    expect([error.kind, error.providerCode]).toEqual([kind, code]);
    expect(fake.requests).toHaveLength(0);
  });

  it("treats missing configuration as unknown (never reauth), before any request", async () => {
    const provider = createYouTubeSocialProvider({ clientId: "not-a-client-id" });
    const error = await rejection(
      provider.getAccount(ctx(), { accountExternalId: FAKE_CHANNEL_ID }),
    );
    expect([error.kind, error.providerCode]).toEqual(["unknown", "youtube_config_invalid"]);
    expect(fake.requests).toHaveLength(0);
  });

  it("maps a revoked refresh token to auth (needs_reauth)", async () => {
    const context = ctx();
    fake.revoke("brand");
    const error = await rejection(
      createYouTubeSocialProvider(CONFIG).getAccount(context, {
        accountExternalId: FAKE_CHANNEL_ID,
      }),
    );
    expect([error.kind, error.providerCode]).toEqual(["auth", "invalid_grant"]);
    expect(error.message).not.toContain(FAKE_YT_TOKEN_MARKER);
  });

  it.each<[string, number, unknown, string, string]>([
    [
      "an exhausted quota",
      403,
      { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } },
      "rate_limited",
      "quotaExceeded",
    ],
    [
      "the API not enabled",
      403,
      { error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } },
      "unknown",
      "accessNotConfigured",
    ],
    [
      "a server error",
      503,
      { error: { code: 503, status: "UNAVAILABLE" } },
      "transient",
      "UNAVAILABLE",
    ],
  ])("classifies %s", async (_label, status, body, kind, code) => {
    fake.failNext("channels", { status, body });
    const error = await rejection(
      createYouTubeSocialProvider(CONFIG).getAccount(ctx(), { accountExternalId: FAKE_CHANNEL_ID }),
    );
    expect([error.kind, error.providerCode]).toEqual([kind, code]);
  });

  it("rejects a malformed payload as data", async () => {
    fake.failNext("channels", { status: 200, body: { items: [{ id: 42 }] } });
    const error = await rejection(
      createYouTubeSocialProvider(CONFIG).getAccount(ctx(), { accountExternalId: FAKE_CHANNEL_ID }),
    );
    expect([error.kind, error.providerCode]).toEqual(["data", "schema"]);
  });
});

describe("listPosts", () => {
  it("pages through the uploads playlist: 4 requests, then 3 (the playlist id travels in the cursor)", async () => {
    const provider = createYouTubeSocialProvider(CONFIG);
    const pages: number[] = [];
    const counts: number[] = [];
    const ids = new Set<string>();
    let cursor: string | undefined;
    do {
      const before = fake.requests.length;
      const page = await provider.listPosts(ctx(), {
        accountExternalId: FAKE_CHANNEL_ID,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      counts.push(fake.requests.length - before);
      pages.push(page.items.length);
      for (const post of page.items) ids.add(post.externalId);
      expect(page.unresolved).toBeUndefined();
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(pages).toEqual([50, 50, 20]);
    expect(counts).toEqual([4, 3, 3]);
    expect(ids.size).toBe(120);
    expect(fake.requests.filter((r) => r.path.endsWith("/channels"))).toHaveLength(1);
    for (const request of fake.requests) expect(request.url).not.toContain(FAKE_YT_TOKEN_MARKER);
  });

  it("returns newest-first video posts with titles and built permalinks only", async () => {
    const page = await createYouTubeSocialProvider(CONFIG).listPosts(ctx(), {
      accountExternalId: FAKE_CHANNEL_ID,
    });
    expect(page.items[0]).toEqual({
      platform: "youtube",
      accountExternalId: FAKE_CHANNEL_ID,
      externalId: "vid00000000",
      type: "video",
      publishedAt: Date.UTC(2026, 9, 20, 10),
      caption: "Fake video 0",
      permalink: "https://www.youtube.com/watch?v=vid00000000",
    });
    const urls = JSON.stringify(page.items).match(/https?:\/\/[^"]*/g) ?? [];
    for (const url of urls) expect(url).toMatch(/^https:\/\/www\.youtube\.com\/watch\?v=/);
  });

  it("excludes upcoming broadcasts and counts deleted, foreign or unmappable uploads as unresolved", async () => {
    const [a, b, c, d, e] = fakeVideos(5, "2026-10-20T10:00:00Z");
    setup([
      { ...a!, liveBroadcastContent: "upcoming" },
      { ...b!, deleted: true },
      { ...c!, channelId: "UCotherChannel000000000a" },
      { id: d!.id, title: "no time" },
      e!,
    ]);
    const page = await createYouTubeSocialProvider(CONFIG).listPosts(ctx(), {
      accountExternalId: FAKE_CHANNEL_ID,
    });
    expect(page.items.map((post) => post.externalId)).toEqual([e!.id]);
    expect(page.unresolved).toBe(3);
  });

  it("handles a channel without uploads", async () => {
    setup([]);
    const page = await createYouTubeSocialProvider(CONFIG).listPosts(ctx(), {
      accountExternalId: FAKE_CHANNEL_ID,
    });
    expect(page).toEqual({ items: [] });
    // token + channel + playlistItems; no videos request for an empty page
    expect(fake.requests).toHaveLength(3);
  });

  it("rejects a foreign or tampered cursor before any request", async () => {
    const provider = createYouTubeSocialProvider(CONFIG);
    const first = await provider.listPosts(ctx(), { accountExternalId: FAKE_CHANNEL_ID });
    fake.requests.length = 0;
    const tampered = `${first.nextCursor!.slice(0, -2)}xx`;
    const error = await rejection(
      provider.listPosts(ctx(), { accountExternalId: FAKE_CHANNEL_ID, cursor: tampered }),
    );
    expect([error.kind, error.providerCode]).toEqual(["invalid_request", "cursor_invalid"]);
    expect(fake.requests).toHaveLength(0);
  });

  it("maps an expired page token to invalid_request (the engine restarts the task once)", async () => {
    const provider = createYouTubeSocialProvider(CONFIG);
    const first = await provider.listPosts(ctx(), { accountExternalId: FAKE_CHANNEL_ID });
    fake.failNext("playlistItems", {
      status: 400,
      body: { error: { code: 400, errors: [{ reason: "invalidPageToken" }] } },
    });
    const error = await rejection(
      provider.listPosts(ctx(), { accountExternalId: FAKE_CHANNEL_ID, cursor: first.nextCursor! }),
    );
    expect([error.kind, error.providerCode]).toEqual(["invalid_request", "invalidPageToken"]);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint 3: lifetime video statistics and the channel day report
// ---------------------------------------------------------------------------

const SCOPED = { scopes: [FAKE_YT_READONLY_SCOPE, FAKE_YT_ANALYTICS_SCOPE] };
const NOW = new Date("2026-10-20T12:00:00Z");

function withStatistics(videos: FakeVideo[]): FakeVideo[] {
  return videos.map((video, i) => ({
    ...video,
    statistics: {
      viewCount: String(100 * (i + 1)),
      ...(i % 5 === 4 ? {} : { likeCount: String(i) }), // every 5th hides its likes
      commentCount: String(i % 3),
    },
  }));
}

describe("fetchPostMetrics", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("snapshots the uploads of the window from batched statistics, then stops", async () => {
    // 120 uploads, one per day before 2026-10-20: 91 are on or after 2026-07-22.
    setup(withStatistics(fakeVideos(120, "2026-10-20T10:00:00Z")));
    const provider = createYouTubeSocialProvider(CONFIG);
    const snapshots = [];
    const counts: number[] = [];
    let cursor: string | undefined;
    do {
      const before = fake.requests.length;
      const page = await provider.fetchPostMetrics(ctx(SCOPED), {
        accountExternalId: FAKE_CHANNEL_ID,
        publishedFrom: "2026-07-22",
        ...(cursor !== undefined ? { cursor } : {}),
      });
      counts.push(fake.requests.length - before);
      snapshots.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(snapshots).toHaveLength(91);
    expect(counts).toEqual([4, 3]); // the second page reached the window end: no third page
    expect(fake.requests.filter((r) => r.path.endsWith("/videos"))).toHaveLength(2);
    for (const request of fake.requests.filter((r) => r.path.endsWith("/videos"))) {
      expect(new URL(request.url).searchParams.get("part")).toBe("snippet,statistics");
    }
    expect(snapshots[0]).toEqual({
      platform: "youtube",
      accountExternalId: FAKE_CHANNEL_ID,
      postExternalId: "vid00000000",
      capturedDate: "2026-10-20",
      capturedAt: NOW.getTime(),
      views: 100,
      likes: 0,
      comments: 0,
    });
    // Hidden like counts stay absent.
    expect(snapshots[4]).not.toHaveProperty("likes");
    expect(snapshots[4]).toMatchObject({ views: 500, comments: 1 });
  });

  it("skips upcoming broadcasts and counts uploads videos.list no longer returns", async () => {
    const [a, b, c] = withStatistics(fakeVideos(3, "2026-10-20T10:00:00Z"));
    setup([{ ...a!, liveBroadcastContent: "upcoming" }, { ...b!, deleted: true }, c!]);
    const page = await createYouTubeSocialProvider(CONFIG).fetchPostMetrics(ctx(SCOPED), {
      accountExternalId: FAKE_CHANNEL_ID,
      publishedFrom: "2026-07-22",
    });
    expect(page.items.map((s) => s.postExternalId)).toEqual([c!.id]);
    expect(page.unresolved).toBe(1);
  });

  it("is bound to its window: a listing cursor or another window's cursor is foreign", async () => {
    setup(withStatistics(fakeVideos(120, "2026-10-20T10:00:00Z")));
    const provider = createYouTubeSocialProvider(CONFIG);
    const listing = await provider.listPosts(ctx(SCOPED), { accountExternalId: FAKE_CHANNEL_ID });
    const window = await provider.fetchPostMetrics(ctx(SCOPED), {
      accountExternalId: FAKE_CHANNEL_ID,
      publishedFrom: "2026-07-22",
    });
    fake.requests.length = 0;
    for (const [publishedFrom, cursor] of [
      ["2026-07-22", listing.nextCursor!],
      ["2026-07-23", window.nextCursor!],
    ] as const) {
      const error = await rejection(
        provider.fetchPostMetrics(ctx(SCOPED), {
          accountExternalId: FAKE_CHANNEL_ID,
          publishedFrom,
          cursor,
        }),
      );
      expect([error.kind, error.providerCode]).toEqual(["invalid_request", "cursor_invalid"]);
    }
    expect(fake.requests).toHaveLength(0);
  });

  it("fails one page on a statistics outage (retried by the engine) and on a malformed count", async () => {
    setup(withStatistics(fakeVideos(3, "2026-10-20T10:00:00Z")));
    const provider = createYouTubeSocialProvider(CONFIG);
    const request = { accountExternalId: FAKE_CHANNEL_ID, publishedFrom: "2026-07-22" };
    fake.failNext("videos", {
      status: 503,
      body: { error: { code: 503, errors: [{ reason: "backendError" }] } },
    });
    const outage = await rejection(provider.fetchPostMetrics(ctx(SCOPED), request));
    expect([outage.kind, outage.retryable]).toEqual(["transient", true]);
    expect((await provider.fetchPostMetrics(ctx(SCOPED), request)).items).toHaveLength(3);

    setup([{ ...fakeVideos(1, "2026-10-20T10:00:00Z")[0]!, statistics: { viewCount: "-5" } }]);
    const malformed = await rejection(
      createYouTubeSocialProvider(CONFIG).fetchPostMetrics(ctx(SCOPED), request),
    );
    expect([malformed.kind, malformed.providerCode]).toEqual(["data", "metric_invalid"]);
  });
});

describe("fetchAccountMetrics", () => {
  const METRICS = (n: number) => ({
    views: 100 + n,
    likes: n,
    comments: 1,
    shares: 0,
    estimatedMinutesWatched: 250 + n,
    averageViewDuration: 90,
    subscribersGained: 3,
    subscribersLost: 1,
  });
  const range = { accountExternalId: FAKE_CHANNEL_ID, from: "2026-10-01", to: "2026-10-03" };

  it("reads the whole window with ONE report and returns one record per day", async () => {
    setup([], { days: { "2026-10-01": METRICS(1), "2026-10-03": METRICS(3) } });
    const page = await createYouTubeSocialProvider(CONFIG).fetchAccountMetrics(ctx(SCOPED), range);
    expect(fake.requests.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
      "POST oauth2.googleapis.com/token",
      "GET youtubeanalytics.googleapis.com/v2/reports",
    ]);
    const params = new URL(fake.requests[1]!.url).searchParams;
    expect(params.get("ids")).toBe("channel==MINE");
    expect([params.get("startDate"), params.get("endDate")]).toEqual(["2026-10-01", "2026-10-03"]);
    expect(page.nextCursor).toBeUndefined();
    expect(page.items.map((day) => day.date)).toEqual(["2026-10-01", "2026-10-02", "2026-10-03"]);
    expect(page.items[0]).toEqual({
      platform: "youtube",
      accountExternalId: FAKE_CHANNEL_ID,
      date: "2026-10-01",
      views: 101,
      extras: {
        likes: 1,
        comments: 1,
        shares: 0,
        estimatedMinutesWatched: 251,
        averageViewDuration: 90,
        subscribersGained: 3,
        subscribersLost: 1,
      },
    });
    // A day YouTube returned no row for reports nothing: no value, never 0.
    expect(page.items[1]).toEqual({
      platform: "youtube",
      accountExternalId: FAKE_CHANNEL_ID,
      date: "2026-10-02",
    });
    for (const day of page.items) expect(day).not.toHaveProperty("followerDelta");
  });

  it("days past YouTube's processing cut-off and left-out metrics stay absent", async () => {
    setup([], {
      days: { "2026-10-01": METRICS(1), "2026-10-02": METRICS(2), "2026-10-03": METRICS(3) },
      processedThrough: "2026-10-02",
      omitMetrics: ["shares"],
    });
    const page = await createYouTubeSocialProvider(CONFIG).fetchAccountMetrics(ctx(SCOPED), range);
    expect(page.items[1]!.extras).not.toHaveProperty("shares");
    expect(page.items[1]).toMatchObject({ views: 102 });
    expect(page.items[2]).not.toHaveProperty("views");
  });

  it("an empty report gives empty days", async () => {
    setup([], {});
    const page = await createYouTubeSocialProvider(CONFIG).fetchAccountMetrics(ctx(SCOPED), range);
    expect(page.items).toHaveLength(3);
    expect(page.items.every((day) => day.views === undefined && day.extras === undefined)).toBe(
      true,
    );
  });

  it("refuses a missing analytics grant, bad windows and cursors before any request", async () => {
    setup([], {});
    const provider = createYouTubeSocialProvider(CONFIG);
    const scope = await rejection(
      provider.fetchAccountMetrics(ctx({ scopes: [FAKE_YT_READONLY_SCOPE] }), range),
    );
    expect([scope.kind, scope.providerCode]).toEqual(["permission", "analytics_scope_missing"]);
    for (const window of [
      { from: "2026-10-03", to: "2026-10-01" },
      { from: "2026-09-01", to: "2026-10-02" }, // 32 days
      { from: "2026-10-1", to: "2026-10-02" },
    ]) {
      const error = await rejection(
        provider.fetchAccountMetrics(ctx(SCOPED), {
          accountExternalId: FAKE_CHANNEL_ID,
          ...window,
        }),
      );
      expect([error.kind, error.providerCode]).toEqual(["invalid_request", "window_invalid"]);
    }
    const cursor = await rejection(
      provider.fetchAccountMetrics(ctx(SCOPED), { ...range, cursor: "x" }),
    );
    expect(cursor.kind).toBe("invalid_request");
    expect(fake.requests).toHaveLength(0);
  });

  it.each<[string, number, unknown, string, string]>([
    [
      "an exhausted quota",
      403,
      { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } },
      "rate_limited",
      "quotaExceeded",
    ],
    [
      "a revoked analytics grant",
      403,
      { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } },
      "permission",
      "insufficientPermissions",
    ],
    [
      "the Analytics API not enabled",
      403,
      { error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } },
      "unknown",
      "accessNotConfigured",
    ],
    [
      "a backend error",
      500,
      { error: { code: 500, errors: [{ reason: "backendError" }] } },
      "transient",
      "backendError",
    ],
  ])("classifies %s", async (_label, status, body, kind, code) => {
    setup([], {});
    fake.failNext("reports", { status, body });
    const error = await rejection(
      createYouTubeSocialProvider(CONFIG).fetchAccountMetrics(ctx(SCOPED), range),
    );
    expect([error.kind, error.providerCode]).toEqual([kind, code]);
    expect(JSON.stringify(error)).not.toContain(FAKE_YT_TOKEN_MARKER);
  });

  it("rejects a malformed report as data", async () => {
    setup([], {});
    fake.failNext("reports", { status: 200, body: { columnHeaders: [{ name: "views" }] } });
    const error = await rejection(
      createYouTubeSocialProvider(CONFIG).fetchAccountMetrics(ctx(SCOPED), range),
    );
    expect([error.kind, error.providerCode]).toEqual(["data", "report_unexpected"]);
  });
});
