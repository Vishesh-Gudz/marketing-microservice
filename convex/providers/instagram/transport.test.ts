import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAllowedRequest,
  createSdkFetch,
  parseErrorBody,
  RequestBudget,
  RequestBudgetExceededError,
  SDK_MEDIA_FIELDS,
  SDK_PROFILE_FIELDS,
  sendInstagram,
  TransportBlockedError,
  type FailureCapture,
  type InstagramCaller,
} from "./transport";

// Phase 10 transport guard: the strict per-caller allowlist, the global no-secret-in-URL
// rule and its ONE approved exception (the two documented Instagram token endpoints).

const G = "https://graph.instagram.com";
const BEARER = { authorization: "Bearer IGAAfaketoken" };

function check(
  caller: InstagramCaller,
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: boolean } = {},
) {
  try {
    assertAllowedRequest(caller, {
      method: options.method ?? "GET",
      url: new URL(url),
      headers: new Headers(options.headers ?? {}),
      hasBody: options.body ?? false,
    });
    return "allowed";
  } catch (error) {
    if (error instanceof TransportBlockedError) return error.reason;
    throw error;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("secret-in-URL exception: exactly two documented shapes", () => {
  it("allows the long-lived exchange with exactly grant_type, client_secret, access_token", () => {
    expect(
      check(
        "oauth",
        `${G}/access_token?grant_type=ig_exchange_token&client_secret=s3cret&access_token=IGAAfake`,
      ),
    ).toBe("allowed");
  });

  it("allows the refresh with exactly grant_type and access_token", () => {
    expect(
      check("oauth", `${G}/refresh_access_token?grant_type=ig_refresh_token&access_token=IGAAfake`),
    ).toBe("allowed");
  });

  it.each([
    [
      "extra parameter",
      `${G}/access_token?grant_type=ig_exchange_token&client_secret=s&access_token=t&x=1`,
    ],
    ["missing client_secret", `${G}/access_token?grant_type=ig_exchange_token&access_token=t`],
    [
      "wrong grant",
      `${G}/access_token?grant_type=fb_exchange_token&client_secret=s&access_token=t`,
    ],
    ["empty token", `${G}/access_token?grant_type=ig_exchange_token&client_secret=s&access_token=`],
    [
      "refresh with a secret",
      `${G}/refresh_access_token?grant_type=ig_refresh_token&access_token=t&client_secret=s`,
    ],
    [
      "refresh wrong grant",
      `${G}/refresh_access_token?grant_type=ig_exchange_token&access_token=t`,
    ],
    [
      "duplicate token",
      `${G}/refresh_access_token?grant_type=ig_refresh_token&access_token=t&access_token=u`,
    ],
  ])("refuses %s", (_label, url) => {
    expect(check("oauth", url)).toBe("secret_in_url");
  });

  it.each([
    [
      "versioned path",
      `${G}/v25.0/access_token?grant_type=ig_exchange_token&client_secret=s&access_token=t`,
    ],
    [
      "other path",
      `${G}/oauth/access_token?grant_type=ig_exchange_token&client_secret=s&access_token=t`,
    ],
  ])("refuses the exception on a %s", (_label, url) => {
    expect(check("oauth", url)).not.toBe("allowed");
  });

  it.each([
    [
      "graph.facebook.com",
      "https://graph.facebook.com/access_token?grant_type=ig_exchange_token&client_secret=s&access_token=t",
    ],
    [
      "api.instagram.com GET",
      "https://api.instagram.com/access_token?grant_type=ig_exchange_token&client_secret=s&access_token=t",
    ],
    [
      "an attacker host",
      "https://evil.example/access_token?grant_type=ig_exchange_token&client_secret=s&access_token=t",
    ],
  ])("refuses the exception on %s", (_label, url) => {
    expect(check("oauth", url)).not.toBe("allowed");
  });

  it("refuses POST, http, userinfo, fragments, ports and an Authorization header on the exception", () => {
    const url = `${G}/access_token?grant_type=ig_exchange_token&client_secret=s&access_token=t`;
    expect(check("oauth", url, { method: "POST" })).toBe("method");
    expect(check("oauth", url.replace("https:", "http:"))).toBe("scheme");
    expect(check("oauth", url.replace("https://", "https://u:p@"))).toBe("credentials_in_url");
    expect(check("oauth", `${url}#frag`)).toBe("fragment");
    expect(check("oauth", url.replace(".com/", ".com:8443/"))).toBe("port");
    expect(check("oauth", url, { headers: BEARER })).toBe("authorization");
  });

  it("the exception is reserved to the oauth caller", () => {
    const url = `${G}/refresh_access_token?grant_type=ig_refresh_token&access_token=t`;
    expect(check("graph_reader", url, { headers: BEARER })).toBe("secret_in_url");
    expect(check("sdk", url, { headers: BEARER })).toBe("secret_in_url");
  });
});

describe("the global rule: no secret in any other URL", () => {
  it.each([
    "access_token",
    "client_secret",
    "code",
    "refresh_token",
    "developer_token",
    "token",
    "input_token",
    "fb_exchange_token",
    "appsecret_proof",
    "my_secret",
    "Access_Token",
    "id_token",
  ])("rejects %s in a Graph read URL", (name) => {
    const url = `${G}/v25.0/me?fields=user_id,username,account_type&${name}=x`;
    expect(check("graph_reader", url, { headers: BEARER })).toBe("secret_in_url");
    expect(check("sdk", url, { headers: BEARER })).toBe("secret_in_url");
  });

  it("rejects any query string on the code exchange POST (secrets travel in the body)", () => {
    expect(
      check("oauth", "https://api.instagram.com/oauth/access_token?code=abc", { method: "POST" }),
    ).toBe("secret_in_url");
    expect(
      check("oauth", "https://api.instagram.com/oauth/access_token?x=1", { method: "POST" }),
    ).toBe("query");
    expect(
      check("oauth", "https://api.instagram.com/oauth/access_token", {
        method: "POST",
        body: true,
      }),
    ).toBe("allowed");
    expect(check("oauth", "https://api.instagram.com/oauth/access_token")).toBe("method");
  });
});

describe("Graph reader allowlist (minimal, read-only)", () => {
  it("allows only the identity read and non-deprecated insight metrics", () => {
    expect(
      check("graph_reader", `${G}/v25.0/me?fields=user_id,username,account_type`, {
        headers: BEARER,
      }),
    ).toBe("allowed");
    expect(
      check(
        "graph_reader",
        `${G}/v25.0/17900000000000001/insights?metric=views,total_interactions&period=lifetime`,
        {
          headers: BEARER,
        },
      ),
    ).toBe("allowed");
    expect(
      check(
        "graph_reader",
        `${G}/v25.0/17841400000000101/insights?metric=reach,accounts_engaged&period=day&metric_type=total_value&since=1790000000&until=1790086400`,
        { headers: BEARER },
      ),
    ).toBe("allowed");
  });

  // Phase 10 Stage B (R2): three strict request shapes on /{id}/insights.
  const DAY = "since=1790000000&until=1790086400";
  const ACCOUNT_A =
    "metric=reach,views,accounts_engaged,total_interactions,likes,comments,shares,saves,replies,profile_links_taps";

  it.each([
    ["post insights", `metric=views,total_interactions&period=lifetime`],
    ["post views only", `metric=views&period=lifetime`],
    ["account request A", `${ACCOUNT_A}&period=day&metric_type=total_value&${DAY}`],
    [
      "account request B",
      `metric=follows_and_unfollows&period=day&metric_type=total_value&breakdown=follow_type&${DAY}`,
    ],
  ])("R2 allows exactly the %s shape", (_label, query) => {
    const url = `${G}/v25.0/17841400000000101/insights?${query}`;
    expect(check("graph_reader", url, { headers: BEARER })).toBe("allowed");
  });

  it.each([
    ["post insights without period", "metric=views,total_interactions"],
    ["post insights with period=day", "metric=views&period=day"],
    ["post insights with metric_type", "metric=views&period=lifetime&metric_type=total_value"],
    ["post insights with a window", `metric=views&period=lifetime&${DAY}`],
    ["account insights as lifetime", "metric=reach&period=lifetime"],
    ["account insights without a window", "metric=reach&period=day&metric_type=total_value"],
    [
      "account insights without since",
      "metric=reach&period=day&metric_type=total_value&until=1790086400",
    ],
    ["account insights without metric_type", `metric=reach&period=day&${DAY}`],
    ["time_series", `metric=reach&period=day&metric_type=time_series&${DAY}`],
    [
      "a breakdown on request A",
      `metric=reach&period=day&metric_type=total_value&breakdown=follow_type&${DAY}`,
    ],
    [
      "follows_and_unfollows without its breakdown",
      `metric=follows_and_unfollows&period=day&metric_type=total_value&${DAY}`,
    ],
    [
      "follows_and_unfollows mixed with other metrics",
      `metric=follows_and_unfollows,reach&period=day&metric_type=total_value&breakdown=follow_type&${DAY}`,
    ],
    [
      "breakdown media_product_type",
      `metric=follows_and_unfollows&period=day&metric_type=total_value&breakdown=media_product_type&${DAY}`,
    ],
    [
      "breakdown follower_type",
      `metric=follows_and_unfollows&period=day&metric_type=total_value&breakdown=follower_type&${DAY}`,
    ],
    ["reposts (account)", `metric=reposts&period=day&metric_type=total_value&${DAY}`],
    ["reposts (post)", "metric=views,reposts&period=lifetime"],
  ])("R2 refuses %s", (_label, query) => {
    const url = `${G}/v25.0/17841400000000101/insights?${query}`;
    expect(check("graph_reader", url, { headers: BEARER })).toBe("query");
  });

  it.each([
    "total_likes",
    "total_comments",
    "total_views",
    "total_shares",
    "reposts",
    "profile_visits",
    "follows",
    "profile_activity",
    "impressions",
    "facebook_views",
    "crossposted_views",
    "ig_reels_avg_watch_time",
  ])("F5/F6: %s is refused in every reader shape and by the SDK caller", (metric) => {
    const urls = [
      `${G}/v25.0/17900000000000001/insights?metric=${metric}&period=lifetime`,
      `${G}/v25.0/17900000000000001/insights?metric=views,${metric}&period=lifetime`,
      `${G}/v25.0/17841400000000101/insights?metric=${metric}&period=day&metric_type=total_value&${DAY}`,
      `${G}/v25.0/17841400000000101/insights?metric=${metric}&period=day&metric_type=total_value&breakdown=follow_type&${DAY}`,
    ];
    for (const url of urls) {
      expect(check("graph_reader", url, { headers: BEARER })).toBe("query");
      expect(check("sdk", url, { headers: BEARER })).toBe("query");
    }
  });

  it.each(["impressions", "plays", "video_views", "profile_views", "website_clicks"])(
    "rejects the deprecated metric %s",
    (metric) => {
      expect(
        check("graph_reader", `${G}/v25.0/17900000000000001/insights?metric=views,${metric}`, {
          headers: BEARER,
        }),
      ).toBe("query");
    },
  );

  it.each([
    ["other identity fields", `${G}/v25.0/me?fields=user_id,username,account_type,email`],
    ["no fields", `${G}/v25.0/me`],
    ["media listing", `${G}/v25.0/17841400000000101/media?fields=id`],
    ["comments edge", `${G}/v25.0/17900000000000001/comments`],
    ["messages edge", `${G}/v25.0/17841400000000101/conversations`],
    ["publishing edge", `${G}/v25.0/17841400000000101/media_publish`],
    ["non-numeric id", `${G}/v25.0/abc/insights?metric=views`],
    ["other version", `${G}/v26.0/me?fields=user_id,username,account_type`],
    ["no version", `${G}/me?fields=user_id,username,account_type`],
    ["encoded path", `${G}/v25.0/%6De?fields=user_id,username,account_type`],
    ["duplicate metric", `${G}/v25.0/17900000000000001/insights?metric=views,views`],
    ["unknown parameter", `${G}/v25.0/17900000000000001/insights?metric=views&debug=all`],
    ["duplicate parameter", `${G}/v25.0/17900000000000001/insights?metric=views&metric=reach`],
  ])("rejects %s", (_label, url) => {
    expect(check("graph_reader", url, { headers: BEARER })).not.toBe("allowed");
  });

  // graph.facebook.com is allowed for Unified Login's exact routes only (unified.test.ts):
  // Instagram Login reads and ads endpoints on it are still refused, on the path.
  it.each([
    [
      "graph.facebook.com (Meta Ads host)",
      "https://graph.facebook.com/v25.0/me?fields=user_id,username,account_type",
    ],
    ["an ads endpoint", "https://graph.facebook.com/v25.0/act_1/insights?metric=views"],
    [
      "an ads endpoint on the Unified version",
      "https://graph.facebook.com/v26.0/act_1/insights?metric=views",
    ],
  ])("rejects %s", (_label, url) => {
    expect(check("graph_reader", url, { headers: BEARER })).toBe("path");
  });

  it("rejects a lookalike host", () => {
    expect(
      check(
        "graph_reader",
        "https://graph.instagram.com.evil.example/v25.0/me?fields=user_id,username,account_type",
        { headers: BEARER },
      ),
    ).toBe("host");
  });

  it("requires GET, no body and a Bearer token", () => {
    const url = `${G}/v25.0/me?fields=user_id,username,account_type`;
    expect(check("graph_reader", url)).toBe("authorization");
    expect(check("graph_reader", url, { headers: { authorization: "Basic x" } })).toBe(
      "authorization",
    );
    expect(check("graph_reader", url, { headers: BEARER, method: "POST" })).toBe("method");
    expect(check("graph_reader", url, { headers: BEARER, method: "DELETE" })).toBe("method");
    expect(check("graph_reader", url, { headers: BEARER, body: true })).toBe("body");
  });
});

describe("SDK allowlist: exactly the reads social-sdk 0.5.0 makes for us", () => {
  it("allows profile, media type, media page and post metrics", () => {
    const id = "17841400000000101";
    for (const url of [
      `${G}/v25.0/${id}?fields=${SDK_PROFILE_FIELDS}`,
      `${G}/v25.0/17900000000000001?fields=media_product_type`,
      `${G}/v25.0/${id}/media?fields=${SDK_MEDIA_FIELDS}&limit=100`,
      `${G}/v25.0/${id}/media?fields=${SDK_MEDIA_FIELDS}&limit=10&after=QVFIUmx0`,
      `${G}/v25.0/17900000000000001/insights?metric=likes,comments,saved,shares,reach`,
      `${G}/v25.0/17900000000000001/insights?metric=shares,reach`,
    ]) {
      expect(check("sdk", url, { headers: BEARER }), url).toBe("allowed");
    }
  });

  it.each([
    ["the reader identity read", `${G}/v25.0/me?fields=user_id,username,account_type`],
    ["other profile fields", `${G}/v25.0/17841400000000101?fields=id,username`],
    ["views via the SDK caller", `${G}/v25.0/17900000000000001/insights?metric=views`],
    ["comments", `${G}/v25.0/17900000000000001/comments?fields=id`],
    ["limit 101", `${G}/v25.0/17841400000000101/media?fields=${SDK_MEDIA_FIELDS}&limit=101`],
    ["publishing", `${G}/v25.0/17841400000000101/media_publish`],
  ])("rejects %s", (_label, url) => {
    expect(check("sdk", url, { headers: BEARER })).not.toBe("allowed");
  });
});

describe("request budget", () => {
  it("allows exactly `max` requests, then fails explicitly", () => {
    const budget = new RequestBudget(2);
    budget.take();
    budget.take();
    expect(() => budget.take()).toThrow(RequestBudgetExceededError);
    expect(budget.count).toBe(2);
    expect(() => new RequestBudget(0)).toThrow();
  });
});

describe("sendInstagram", () => {
  const identityUrl = () => {
    const url = new URL(`${G}/v25.0/me`);
    url.searchParams.set("fields", "user_id,username,account_type");
    return url;
  };

  it("refuses before any network access and reports only a reason", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await sendInstagram(
      "graph_reader",
      new URL(`${G}/v25.0/me?fields=user_id&access_token=IGAAleak`),
      { method: "GET", headers: BEARER },
      { timeoutMs: 1_000 },
    );
    expect(result).toEqual({ ok: false, failure: { type: "blocked", reason: "secret_in_url" } });
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("IGAAleak");
  });

  it("spends the budget and refuses when it is exhausted", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ user_id: "1" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const budget = new RequestBudget(1);
    const init = { method: "GET" as const, headers: BEARER };
    expect(
      (await sendInstagram("graph_reader", identityUrl(), init, { timeoutMs: 1_000, budget })).ok,
    ).toBe(true);
    expect(
      await sendInstagram("graph_reader", identityUrl(), init, { timeoutMs: 1_000, budget }),
    ).toEqual({
      ok: false,
      failure: { type: "budget_exceeded" },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("never propagates a network error (it may contain the URL)", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      throw new Error(`connect failed for ${url}`);
    });
    const result = await sendInstagram(
      "oauth",
      new URL(`${G}/refresh_access_token?grant_type=ig_refresh_token&access_token=IGAAsecret`),
      { method: "GET" },
      { timeoutMs: 1_000 },
    );
    expect(result).toEqual({ ok: false, failure: { type: "network" } });
    expect(JSON.stringify(result)).not.toContain("IGAAsecret");
  });

  it("keeps only error codes from failed responses, never messages or trace ids", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message: "Invalid token IGAAsecret",
              code: 190,
              error_subcode: 463,
              fbtrace_id: "T",
            },
          }),
          {
            status: 400,
            headers: {
              "x-business-use-case-usage": '{"1":[{"estimated_time_to_regain_access":5}]}',
            },
          },
        ),
    );
    const result = await sendInstagram(
      "graph_reader",
      identityUrl(),
      { method: "GET", headers: BEARER },
      { timeoutMs: 1_000 },
    );
    expect(result).toEqual({
      ok: false,
      failure: {
        type: "http",
        status: 400,
        error: { code: 190, subcode: 463 },
        usage: { regainAccessMinutes: 5 },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/IGAAsecret|Invalid token|fbtrace/);
  });

  it("parses the OAuth endpoint error shape by code only", () => {
    expect(parseErrorBody({ error_type: "OAuthException", code: 400, error_message: "x" })).toEqual(
      { code: 400 },
    );
    expect(parseErrorBody({ error: "text" })).toBeUndefined();
    expect(parseErrorBody("IGAAsecret")).toBeUndefined();
  });
});

describe("createSdkFetch (the fetch injected into social-sdk)", () => {
  it("refuses non-allowlisted SDK requests before the network and captures the reason", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const capture: FailureCapture = {};
    const sdkFetch = createSdkFetch({ budget: new RequestBudget(5), capture });
    await expect(
      sdkFetch(new URL(`${G}/v25.0/17841400000000101/media_publish`), {
        method: "POST",
        headers: BEARER,
      }),
    ).rejects.toThrow(TransportBlockedError);
    expect(capture.last).toEqual({ type: "blocked", reason: "method" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("captures the Meta error code of a failed response and returns the response untouched", async () => {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify({ error: { code: 4, message: "throttled" } }), {
          status: 400,
          headers: { "retry-after": "30" },
        }),
    );
    const capture: FailureCapture = {};
    const sdkFetch = createSdkFetch({ budget: new RequestBudget(5), capture });
    const response = await sdkFetch(
      new URL(`${G}/v25.0/17841400000000101?fields=${SDK_PROFILE_FIELDS}`),
      { headers: new Headers(BEARER) },
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: 4, message: "throttled" } });
    expect(capture.last).toEqual({
      type: "http",
      status: 400,
      error: { code: 4 },
      usage: { retryAfterSeconds: 30 },
    });
  });

  it("enforces the budget", async () => {
    vi.stubGlobal("fetch", async () => new Response("{}", { status: 200 }));
    const capture: FailureCapture = {};
    const sdkFetch = createSdkFetch({ budget: new RequestBudget(1), capture });
    const url = new URL(`${G}/v25.0/17900000000000001?fields=media_product_type`);
    await sdkFetch(url, { headers: BEARER });
    await expect(sdkFetch(url, { headers: BEARER })).rejects.toThrow(RequestBudgetExceededError);
    expect(capture.last).toEqual({ type: "budget_exceeded" });
  });

  it("rethrows network failures without the URL", async () => {
    vi.stubGlobal("fetch", async (url: string) => {
      throw new Error(`boom ${url}`);
    });
    const capture: FailureCapture = {};
    const sdkFetch = createSdkFetch({ budget: new RequestBudget(1), capture });
    const error = await sdkFetch(
      new URL(`${G}/v25.0/17900000000000001?fields=media_product_type`),
      {
        headers: BEARER,
      },
    ).catch((e: unknown) => e);
    expect(String(error)).not.toContain("graph.instagram.com");
    expect(capture.last).toEqual({ type: "network" });
  });
});

describe('"messaging" caller (ADR 0017: the webhook subscription)', () => {
  const SUBSCRIBE = `${G}/v25.0/17841400000000101/subscribed_apps?subscribed_fields=messages,messaging_seen,message_edit`;

  it("allows exactly the subscription POST with a Bearer token", () => {
    expect(check("messaging", SUBSCRIBE, { method: "POST", headers: BEARER })).toBe("allowed");
  });

  it("allows a text send: POST, no query, a JSON body and a Bearer token (IM4)", () => {
    expect(
      check("messaging", `${G}/v25.0/17841400000000101/messages`, {
        method: "POST",
        headers: { ...BEARER, "content-type": "application/json; charset=utf-8" },
        body: true,
      }),
    ).toBe("allowed");
    for (const caller of ["graph_reader", "sdk"] as const) {
      expect(
        check(caller, `${G}/v25.0/17841400000000101/messages`, {
          method: "POST",
          headers: { ...BEARER, "content-type": "application/json" },
          body: true,
        }),
      ).toBe("method");
    }
  });

  it.each([
    ["a GET", SUBSCRIBE, { method: "GET", headers: BEARER }, "method"],
    ["no Bearer token", SUBSCRIBE, { method: "POST" }, "authorization"],
    ["a body", SUBSCRIBE, { method: "POST", headers: BEARER, body: true }, "body"],
    [
      "the token in the query (Meta's sample)",
      `${SUBSCRIBE}&access_token=IGAAfaketoken`,
      { method: "POST", headers: BEARER },
      "secret_in_url",
    ],
    [
      "other fields",
      `${G}/v25.0/17841400000000101/subscribed_apps?subscribed_fields=messages,comments`,
      { method: "POST", headers: BEARER },
      "query",
    ],
    [
      "a send without a body",
      `${G}/v25.0/17841400000000101/messages`,
      { method: "POST", headers: BEARER },
      "path",
    ],
    [
      "a send whose body is not JSON",
      `${G}/v25.0/17841400000000101/messages`,
      { method: "POST", headers: { ...BEARER, "content-type": "text/plain" }, body: true },
      "body",
    ],
    [
      "a send with a query",
      `${G}/v25.0/17841400000000101/messages?recipient=1`,
      { method: "POST", headers: { ...BEARER, "content-type": "application/json" }, body: true },
      "query",
    ],
    [
      "a send with the token in the query",
      `${G}/v25.0/17841400000000101/messages?access_token=IGAAfaketoken`,
      { method: "POST", headers: { ...BEARER, "content-type": "application/json" }, body: true },
      "secret_in_url",
    ],
    [
      "a send without a Bearer token",
      `${G}/v25.0/17841400000000101/messages`,
      { method: "POST", headers: { "content-type": "application/json" }, body: true },
      "authorization",
    ],
  ] as const)("refuses %s", (_label, url, options, reason) => {
    expect(check("messaging", url, options)).toBe(reason);
  });

  it("is not reachable through the other callers", () => {
    for (const caller of ["graph_reader", "sdk"] as const) {
      expect(check(caller, SUBSCRIBE, { method: "POST", headers: BEARER })).toBe("method");
    }
  });
});
