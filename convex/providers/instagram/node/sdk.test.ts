import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProviderError, type ProviderError } from "../../errors";
import type { InstagramCredential } from "../credential";
import {
  createFakeInstagram,
  FAKE_IG_APP_ID,
  FAKE_IG_TOKEN_MARKER,
  type FakeInstagram,
  type FakeMedia,
} from "../fakeInstagram.fixtures";
import { RequestBudget } from "../transport";
import { createInstagramSdkSession } from "./sdk";

// The social-sdk@0.5.0 adapter against the fake Instagram API: the SDK really runs here
// (web APIs only), every request passes our allowlisted fetch, and nothing SDK-specific
// (types, errors, cursors) leaves the session.

const USER_ID = "17841400000000101";
const media = (n: number): FakeMedia => ({
  id: `179000000000${String(n).padStart(5, "0")}`,
  caption: `Post ${n}`,
  media_type: n % 2 ? "IMAGE" : "VIDEO",
  media_product_type: n % 2 ? "FEED" : "REELS",
  permalink: `https://www.instagram.com/p/fake${n}/`,
  timestamp: "2026-09-20T10:00:00+0000",
  insights: { likes: n, comments: 1, saved: 2, shares: 3, reach: 10 * n },
});

let fake: FakeInstagram;

beforeEach(() => {
  fake = createFakeInstagram({
    users: {
      business: {
        userId: USER_ID,
        username: "fake_brand",
        accountType: "Business",
        name: "Fake Brand",
        followers: 1234,
        media: Array.from({ length: 5 }, (_, i) => media(i + 1)),
      },
    },
  });
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function session(budget = new RequestBudget(31)) {
  const credential: InstagramCredential = {
    kind: "instagram",
    v: 1,
    accessToken: fake.issueLongLivedToken("business"),
    tokenType: "long_lived",
    appId: FAKE_IG_APP_ID,
    userId: USER_ID,
    issuedAt: Date.now(),
  };
  return { credential, sdk: createInstagramSdkSession({ credential, budget }) };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.catch((e: unknown) => e);
  if (!isProviderError(error)) throw new Error(`expected ProviderError, got ${String(error)}`);
  return error;
}

describe("profile", () => {
  it("reads the account with one request and drops biography and website", async () => {
    const { sdk } = session();
    const profile = await sdk.profile("getSocialAccount");
    expect(profile).toEqual({
      userId: USER_ID,
      username: "fake_brand",
      name: "Fake Brand",
      followersCount: 1234,
      profilePictureUrl: `https://scontent.example.test/${USER_ID}.jpg?sig=fake`,
    });
    expect(JSON.stringify(profile)).not.toMatch(/biography|website|follows_count|media_count/);
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({
      method: "GET",
      bearer: true,
      path: `/v25.0/${USER_ID}`,
    });
    expect(fake.requests[0]!.url).not.toContain(FAKE_IG_TOKEN_MARKER);
  });
});

describe("media listing", () => {
  it("pages with our ig1 cursors; the SDK cursor and Graph `next` URLs never leave", async () => {
    const { sdk } = session();
    const first = await sdk.listMedia("listSocialPosts", { limit: 2 });
    expect(first.items.map((m) => m.id)).toEqual([media(1).id, media(2).id]);
    expect(first.items[0]).toEqual({
      id: media(1).id,
      caption: "Post 1",
      mediaType: "IMAGE",
      mediaProductType: "FEED",
      permalink: "https://www.instagram.com/p/fake1/",
      timestamp: "2026-09-20T10:00:00+0000",
    });
    expect(first.nextCursor).toMatch(/^ig1\./);
    expect(first.nextCursor).not.toContain("social-v1");

    const second = await sdk.listMedia("listSocialPosts", { limit: 2, cursor: first.nextCursor! });
    const third = await sdk.listMedia("listSocialPosts", { limit: 2, cursor: second.nextCursor! });
    expect([...second.items, ...third.items].map((m) => m.id)).toEqual(
      [3, 4, 5].map((n) => media(n).id),
    );
    expect(third.nextCursor).toBeUndefined();
    // One request per page, never a followed `paging.next` URL (it embeds a token).
    expect(fake.count(`/v25.0/${USER_ID}/media`)).toBe(3);
    expect(fake.requests.some((r) => r.url.includes("inurl"))).toBe(false);
    expect(fake.requests.every((r) => !r.params.includes("access_token"))).toBe(true);
  });

  it("rejects a cursor of another request (limit) or a tampered cursor", async () => {
    const { sdk } = session();
    const first = await sdk.listMedia("listSocialPosts", { limit: 2 });
    const foreign = await failure(
      sdk.listMedia("listSocialPosts", { limit: 3, cursor: first.nextCursor! }),
    );
    expect([foreign.kind, foreign.providerCode]).toEqual(["invalid_request", "cursor_invalid"]);
    const tampered = await failure(
      sdk.listMedia("listSocialPosts", { limit: 2, cursor: `${first.nextCursor!.slice(0, -2)}00` }),
    );
    expect(tampered.providerCode).toBe("cursor_invalid");
  });
});

describe("post metrics", () => {
  it("reads lifetime metrics with exactly two requests", async () => {
    const { sdk } = session();
    const values = await sdk.postMetrics("fetchPostMetrics", media(3).id);
    expect(values).toEqual([
      { name: "likes", value: 3 },
      { name: "comments", value: 1 },
      { name: "saved", value: 2 },
      { name: "shares", value: 3 },
      { name: "reach", value: 30 },
    ]);
    expect(fake.requests.map((r) => r.path)).toEqual([
      `/v25.0/${media(3).id}`,
      `/v25.0/${media(3).id}/insights`,
    ]);
  });

  it("refuses a malformed media id before any request", async () => {
    const { sdk } = session();
    expect((await failure(sdk.postMetrics("fetchPostMetrics", "../me"))).providerCode).toBe(
      "media_invalid",
    );
    expect(fake.requests).toHaveLength(0);
  });
});

describe("error classification replaces the SDK's status-only mapping", () => {
  it.each([
    [{ status: 400, body: { error: { code: 190, message: "expired" } } }, "auth", "190"],
    [
      { status: 400, body: { error: { code: 4 } }, headers: { "retry-after": "20" } },
      "rate_limited",
      "4",
    ],
    [{ status: 400, body: { error: { code: 100, error_subcode: 33 } } }, "not_found", "100/33"],
    [{ status: 403, body: { error: { code: 10 } } }, "permission", "10"],
    [{ status: 503 }, "transient", "http_503"],
  ] as const)("%j -> %s", async (response, kind, providerCode) => {
    fake.fail("profile", response);
    const { sdk } = session();
    const error = await failure(sdk.profile("getSocialAccount"));
    expect([error.kind, error.providerCode]).toEqual([kind, providerCode]);
    if (kind === "rate_limited") expect(error.retryAfterMs).toBe(20_000);
    expect(error.platform).toBe("instagram");
    expect(error.constructor.name).toBe("ProviderError");
    expect(JSON.stringify(error)).not.toContain(FAKE_IG_TOKEN_MARKER);
  });

  it("the SDK never retries on its own (one attempt; the sync engine owns retries)", async () => {
    fake.fail("profile", { status: 503 }, { status: 503 });
    const { sdk } = session();
    await failure(sdk.profile("getSocialAccount"));
    expect(fake.requests).toHaveLength(1);
  });

  it("an exhausted request budget fails explicitly, without a request", async () => {
    const { sdk } = session(new RequestBudget(1));
    await sdk.profile("getSocialAccount");
    const error = await failure(sdk.postMetrics("fetchPostMetrics", media(1).id));
    expect([error.kind, error.providerCode]).toEqual(["unknown", "request_budget_exceeded"]);
    expect(fake.requests).toHaveLength(1);
  });

  it("a response the SDK cannot use is a data error", async () => {
    fake.fail("media", { status: 200, body: { data: "not-an-array" } });
    const { sdk } = session();
    const error = await failure(sdk.listMedia("listSocialPosts", { limit: 2 }));
    expect([error.kind, error.providerCode]).toEqual(["data", "sdk_invalid_response"]);
  });
});
