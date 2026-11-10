import { afterEach, describe, expect, it, vi } from "vitest";
import { isProviderError } from "../errors";
import {
  hasInstagramMessagingPermission,
  instagramOrganicSyncAllowed,
  UNIFIED_INSIGHTS_PERMISSION,
} from "./config";
import { NEVER_REQUESTED_METRICS, UNIFIED_POST_METRIC_NAMES } from "./semantics";
import {
  assertAllowedRequest,
  RequestBudget,
  SDK_PROFILE_FIELDS,
  TransportBlockedError,
  UNIFIED_MEDIA_FIELDS,
  UNIFIED_POST_METRICS,
  UNIFIED_PROFILE_FIELDS,
  type InstagramCaller,
} from "./transport";
import { createUnifiedOrganicReader } from "./unifiedOrganic";

// O1: the Unified Login organic routes on graph.facebook.com/v26.0 (exact shapes, nothing
// else), the Instagram Login allowlist left unchanged, the connection gate, and the reader's
// fail-closed parsing.

const F = "https://graph.facebook.com/v26.0";
const G = "https://graph.instagram.com/v25.0";
const IG = "17841400000000301";
const MEDIA = "17900000000000001";
const BEARER = { authorization: "Bearer EAAGunifiedfake-x" };
const DAY = "since=1790000000&until=1790086400";
const ACCOUNT_A =
  "reach,views,accounts_engaged,total_interactions,likes,comments,shares,saves,replies,profile_links_taps";

function check(
  caller: InstagramCaller,
  url: string,
  options: { method?: string; headers?: Record<string, string> } = { headers: BEARER },
) {
  try {
    assertAllowedRequest(caller, {
      method: options.method ?? "GET",
      url: new URL(url),
      headers: new Headers(options.headers ?? {}),
      hasBody: false,
    });
    return "allowed";
  } catch (error) {
    if (error instanceof TransportBlockedError) return error.reason;
    throw error;
  }
}

const ROUTES = {
  profile: `${F}/${IG}?fields=${UNIFIED_PROFILE_FIELDS}`,
  media: `${F}/${IG}/media?fields=${UNIFIED_MEDIA_FIELDS}&limit=100`,
  mediaNext: `${F}/${IG}/media?fields=${UNIFIED_MEDIA_FIELDS}&limit=10&after=QVFIUmFmYWtl`,
  post: `${F}/${MEDIA}/insights?metric=${UNIFIED_POST_METRICS}&period=lifetime`,
  accountA: `${F}/${IG}/insights?metric=${ACCOUNT_A}&period=day&metric_type=total_value&${DAY}`,
  accountB: `${F}/${IG}/insights?metric=follows_and_unfollows&period=day&metric_type=total_value&breakdown=follow_type&${DAY}`,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transport: Unified organic routes (graph_reader, graph.facebook.com/v26.0)", () => {
  it("names the exact documented lists", () => {
    expect(UNIFIED_PROFILE_FIELDS).toBe("id,username,name,followers_count,media_count");
    expect(UNIFIED_MEDIA_FIELDS).toBe(
      "id,caption,media_type,media_product_type,permalink,timestamp",
    );
    expect(UNIFIED_POST_METRICS).toBe("likes,comments,saved,shares,reach,views,total_interactions");
    // The provider requests exactly the list the transport allows (checked independently).
    expect(UNIFIED_POST_METRIC_NAMES.join(",")).toBe(UNIFIED_POST_METRICS);
  });

  it.each(Object.entries(ROUTES))("allows %s with a Bearer token", (_name, url) => {
    expect(check("graph_reader", url)).toBe("allowed");
  });

  it.each([
    ["the SDK profile fields", `${F}/${IG}?fields=${SDK_PROFILE_FIELDS}`],
    ["the profile picture", `${F}/${IG}?fields=${UNIFIED_PROFILE_FIELDS},profile_picture_url`],
    ["a profile without fields", `${F}/${IG}`],
    ["an extra profile parameter", `${ROUTES.profile}&debug=all`],
    ["a media page without a limit", `${F}/${IG}/media?fields=${UNIFIED_MEDIA_FIELDS}`],
    ["a page size of 0", `${F}/${IG}/media?fields=${UNIFIED_MEDIA_FIELDS}&limit=0`],
    ["a page size of 101", `${F}/${IG}/media?fields=${UNIFIED_MEDIA_FIELDS}&limit=101`],
    ["media with username", `${F}/${IG}/media?fields=${UNIFIED_MEDIA_FIELDS},username&limit=10`],
    ["media with media_url", `${F}/${IG}/media?fields=${UNIFIED_MEDIA_FIELDS},media_url&limit=10`],
    ["a media page with `before`", `${ROUTES.media}&before=QVFI`],
    ["a non-printable cursor", `${ROUTES.media}&after=a%20b`],
    [
      "a post metric subset",
      `${F}/${MEDIA}/insights?metric=views,total_interactions&period=lifetime`,
    ],
    [
      "reordered post metrics",
      `${F}/${MEDIA}/insights?metric=views,likes,comments,saved,shares,reach,total_interactions&period=lifetime`,
    ],
    ["post metrics by day", `${F}/${MEDIA}/insights?metric=${UNIFIED_POST_METRICS}&period=day`],
    ["post metrics without a period", `${F}/${MEDIA}/insights?metric=${UNIFIED_POST_METRICS}`],
    [
      "an ad-inclusive post metric",
      `${F}/${MEDIA}/insights?metric=${UNIFIED_POST_METRICS},total_likes&period=lifetime`,
    ],
    ["account insights as a time series", ROUTES.accountA.replace("total_value", "time_series")],
    ["another breakdown", ROUTES.accountB.replace("follow_type", "media_product_type")],
    ["account insights without until", ROUTES.accountA.replace("&until=1790086400", "")],
    ["the identity read of Instagram Login", `${F}/me?fields=user_id,username,account_type`],
    ["another Graph version", ROUTES.profile.replace("/v26.0/", "/v25.0/")],
    ["an ads edge", `${F}/act_1/insights?metric=reach&period=day`],
    ["a page id path segment", `${F}/${IG}/feed?limit=10`],
  ])("refuses %s", (_label, url) => {
    expect(check("graph_reader", url)).not.toBe("allowed");
  });

  it.each([...NEVER_REQUESTED_METRICS, "total_comments", "total_views", "total_shares"])(
    "refuses the forbidden metric %s in every insights shape",
    (metric) => {
      expect(
        check("graph_reader", `${F}/${MEDIA}/insights?metric=${metric}&period=lifetime`),
      ).not.toBe("allowed");
      expect(
        check(
          "graph_reader",
          `${F}/${IG}/insights?metric=${metric}&period=day&metric_type=total_value&${DAY}`,
        ),
      ).not.toBe("allowed");
    },
  );

  it.each([
    ["the token in the query", "access_token=EAAGunifiedfake-x"],
    ["an appsecret_proof", "appsecret_proof=abc"],
  ])("refuses %s on every organic route", (_label, extra) => {
    for (const url of Object.values(ROUTES)) {
      expect(check("graph_reader", `${url}&${extra}`)).toBe("secret_in_url");
    }
  });

  it("requires GET and the Bearer header", () => {
    for (const url of Object.values(ROUTES)) {
      expect(check("graph_reader", url, { headers: {} })).toBe("authorization");
      expect(check("graph_reader", url, { method: "POST", headers: BEARER })).toBe("method");
    }
  });

  it("is reachable through the reader only: never the SDK, messaging or OAuth caller", () => {
    for (const url of Object.values(ROUTES)) {
      expect(check("sdk", url)).not.toBe("allowed");
      expect(check("messaging", url)).not.toBe("allowed");
      expect(check("oauth", url)).not.toBe("allowed");
    }
  });

  it("leaves Instagram Login's allowlist unchanged (graph.instagram.com)", () => {
    expect(
      check(
        "graph_reader",
        `${G}/${MEDIA}/insights?metric=${UNIFIED_POST_METRICS}&period=lifetime`,
      ),
    ).toBe("query");
    expect(check("graph_reader", `${G}/${IG}?fields=${UNIFIED_PROFILE_FIELDS}`)).toBe("path");
    expect(check("graph_reader", `${G}/${IG}/media?fields=${UNIFIED_MEDIA_FIELDS}&limit=10`)).toBe(
      "path",
    );
    expect(check("sdk", `${G}/${IG}?fields=${UNIFIED_PROFILE_FIELDS}`)).toBe("query");
  });
});

describe("the organic sync gate (config.ts)", () => {
  it("Instagram Login always syncs; Unified Login only with instagram_manage_insights", () => {
    expect(UNIFIED_INSIGHTS_PERMISSION).toBe("instagram_manage_insights");
    expect(
      instagramOrganicSyncAllowed([
        "instagram_business_basic",
        "instagram_business_manage_insights",
      ]),
    ).toBe(true);
    expect(instagramOrganicSyncAllowed(["instagram_basic", "instagram_manage_messages"])).toBe(
      false,
    );
    expect(
      instagramOrganicSyncAllowed([
        "instagram_basic",
        "instagram_manage_messages",
        "instagram_manage_insights",
      ]),
    ).toBe(true);
    // Messaging is decided separately and is unaffected by the insights permission.
    expect(hasInstagramMessagingPermission(["instagram_basic", "instagram_manage_insights"])).toBe(
      false,
    );
  });
});

describe("Unified organic reader: fail-closed parsing", () => {
  const reader = createUnifiedOrganicReader({ timeoutMs: 5_000 });
  const call = () => ({ operation: "listSocialPosts" as const, budget: new RequestBudget(1) });

  function respond(body: unknown) {
    vi.stubGlobal(
      "fetch",
      async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
  }

  async function code(promise: Promise<unknown>) {
    const error = await promise.catch((e: unknown) => e);
    return isProviderError(error) ? [error.kind, error.providerCode] : ["no error"];
  }

  it("keeps listed media to the read type with the SDK listing's caps", async () => {
    respond({
      data: [
        {
          id: MEDIA,
          caption: "x".repeat(9_000),
          media_type: "IMAGE",
          media_product_type: "FEED",
          permalink: "https://www.instagram.com/p/C1/",
          timestamp: "2026-09-28T08:00:00+0000",
          media_url: "https://scontent.example.test/never.jpg",
        },
      ],
    });
    const page = await reader.listMedia("t", IG, { limit: 10 }, call());
    expect(page).toEqual({
      items: [
        {
          id: MEDIA,
          mediaType: "IMAGE",
          mediaProductType: "FEED",
          permalink: "https://www.instagram.com/p/C1/",
          timestamp: "2026-09-28T08:00:00+0000",
        },
      ],
    });
  });

  it.each([
    ["a numeric media id", { data: [{ id: 17900000000000001 }] }, "media_invalid"],
    ["a media item without an id", { data: [{ media_type: "IMAGE" }] }, "media_invalid"],
    ["no data array", { paging: {} }, "schema"],
  ])("refuses %s", async (_label, body, providerCode) => {
    respond(body);
    expect(await code(reader.listMedia("t", IG, { limit: 10 }, call()))).toEqual([
      "data",
      providerCode,
    ]);
  });

  it("refuses an invalid page size or account id before any request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    expect(await code(reader.listMedia("t", IG, { limit: 101 }, call()))).toEqual([
      "invalid_request",
      "limit_invalid",
    ]);
    expect(await code(reader.listMedia("t", "act_1", { limit: 10 }, call()))).toEqual([
      "invalid_request",
      "id_invalid",
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops a malformed follower count; refuses a metric that was not requested", async () => {
    respond({ id: IG, username: "fake_unified", followers_count: -1 });
    expect(await reader.readProfile("t", IG, call())).toEqual({ username: "fake_unified" });
    respond({ data: [{ name: "impressions", values: [{ value: 1 }] }] });
    expect(await code(reader.readPostInsights("t", MEDIA, call()))).toEqual([
      "data",
      "insights_unexpected",
    ]);
  });

  it("splits one post response into the SDK and reader groups; missing stays absent", async () => {
    respond({
      data: [
        { name: "likes", values: [{ value: 3 }] },
        { name: "saved", values: [{ value: 0 }] },
        { name: "views", values: [{ value: 40 }] },
      ],
    });
    expect(await reader.readPostInsights("t", MEDIA, call())).toEqual({
      sdk: [
        { name: "likes", value: 3 },
        { name: "saved", value: 0 },
      ],
      reader: { views: 40 },
    });
  });
});
