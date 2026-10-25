import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProviderError, type ProviderError } from "../errors";
import type { ProviderContext } from "../types";
import {
  createFakeYouTube,
  FAKE_CHANNEL_ID,
  FAKE_YT_CLIENT_ID,
  FAKE_YT_CLIENT_SECRET,
  FAKE_YT_TOKEN_MARKER,
  fakeVideos,
  type FakeYouTube,
} from "./fakeYouTube.fixtures";
import { createYouTubeSocialProvider } from "./provider";

// ADR 0016, Checkpoint 1: the YouTube provider against the fake Google API. Checks before any
// network access, exact request counts, the uploads listing and its cursor, exclusions and
// unresolved counts, typed errors, and no token in any URL, record or error.

const CONFIG = { clientId: FAKE_YT_CLIENT_ID, clientSecret: FAKE_YT_CLIENT_SECRET };
let fake: FakeYouTube;

function setup(videos = fakeVideos(120, "2026-10-20T10:00:00Z")) {
  fake = createFakeYouTube({
    channels: {
      brand: {
        channelId: FAKE_CHANNEL_ID,
        title: "Fake Brand",
        customUrl: "@fakebrand",
        subscriberCount: "12300",
        videos,
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

describe("metric operations (Checkpoint 3)", () => {
  it("are unsupported and make no request", async () => {
    const provider = createYouTubeSocialProvider(CONFIG);
    expect(provider.capabilities.postMetrics).toEqual([]);
    expect(provider.capabilities.accountMetrics).toEqual([]);
    const posts = await rejection(
      provider.fetchPostMetrics(ctx(), {
        accountExternalId: FAKE_CHANNEL_ID,
        publishedFrom: "2026-07-01",
      }),
    );
    const days = await rejection(
      provider.fetchAccountMetrics(ctx(), {
        accountExternalId: FAKE_CHANNEL_ID,
        from: "2026-10-01",
        to: "2026-10-02",
      }),
    );
    expect([posts.kind, days.kind]).toEqual(["unsupported", "unsupported"]);
    expect(fake.requests).toHaveLength(0);
  });
});
