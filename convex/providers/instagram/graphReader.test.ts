import { afterEach, describe, expect, it, vi } from "vitest";
import { isProviderError, type ProviderError } from "../errors";
import { createInstagramGraphReader, utcDayWindow } from "./graphReader";
import { RequestBudget } from "./transport";

// Phase 10 Stage B: the Graph reader's insight reads (R2 request shapes), response
// validation (fail closed on anything unexpected) and "empty data set instead of 0".

const USER_ID = "17841400000000101";
const MEDIA_ID = "17900000000000001";
const TOKEN = "IGAAfakelong1";

let requests: URL[] = [];
function respond(body: unknown, status = 200) {
  requests = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    requests.push(new URL(String(input)));
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}
afterEach(() => vi.unstubAllGlobals());

const reader = createInstagramGraphReader({ timeoutMs: 5_000 });
const call = () => ({ operation: "fetchAccountMetrics" as const, budget: new RequestBudget(5) });

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.catch((e: unknown) => e);
  if (!isProviderError(error)) throw new Error(`expected ProviderError, got ${String(error)}`);
  return error;
}

describe("UTC day window", () => {
  it("is D 00:00Z .. D+1 00:00Z in unix seconds", () => {
    expect(utcDayWindow("2026-09-28")).toEqual({
      since: String(Date.UTC(2026, 8, 28) / 1000),
      until: String(Date.UTC(2026, 8, 29) / 1000),
    });
    expect(utcDayWindow("2026-12-31").until).toBe(String(Date.UTC(2027, 0, 1) / 1000));
  });
});

describe("readPostInsights", () => {
  it("requests exactly views,total_interactions lifetime; missing stays absent", async () => {
    respond({ data: [{ name: "views", period: "lifetime", values: [{ value: 0 }] }] });
    const values = await reader.readPostInsights(TOKEN, MEDIA_ID, call());
    expect(values).toEqual({ views: 0 });
    expect(requests).toHaveLength(1);
    const url = requests[0]!;
    expect(url.pathname).toBe(`/v25.0/${MEDIA_ID}/insights`);
    const names: string[] = [];
    url.searchParams.forEach((_value, name) => names.push(name));
    expect(names.sort()).toEqual(["metric", "period"]);
    expect(url.searchParams.get("metric")).toBe("views,total_interactions");
    expect(url.searchParams.get("period")).toBe("lifetime");
    expect(url.toString()).not.toContain(TOKEN);
  });

  it("also reads the documented total_value form", async () => {
    respond({ data: [{ name: "total_interactions", total_value: { value: 12 } }] });
    expect(await reader.readPostInsights(TOKEN, MEDIA_ID, call())).toEqual({
      total_interactions: 12,
    });
  });

  it.each([
    [
      "an unrequested metric",
      { data: [{ name: "total_likes", values: [{ value: 1 }] }] },
      "insights_unexpected",
    ],
    [
      "a duplicate metric",
      {
        data: [
          { name: "views", values: [{ value: 1 }] },
          { name: "views", values: [{ value: 2 }] },
        ],
      },
      "insights_unexpected",
    ],
    [
      "a negative value",
      { data: [{ name: "views", values: [{ value: -1 }] }] },
      "insights_invalid",
    ],
    [
      "a fractional value",
      { data: [{ name: "views", values: [{ value: 1.5 }] }] },
      "insights_invalid",
    ],
    ["a string value", { data: [{ name: "views", values: [{ value: "1" }] }] }, "insights_invalid"],
    [
      "several values",
      { data: [{ name: "views", values: [{ value: 1 }, { value: 2 }] }] },
      "insights_invalid",
    ],
    ["no data array", { rows: [] }, "schema"],
  ])("fails closed on %s", async (_label, body, code) => {
    respond(body);
    const error = await failure(reader.readPostInsights(TOKEN, MEDIA_ID, call()));
    expect([error.kind, error.providerCode]).toEqual(["data", code]);
  });

  it("refuses a malformed id before any request", async () => {
    respond({ data: [] });
    const error = await failure(reader.readPostInsights(TOKEN, "../me", call()));
    expect([error.kind, error.providerCode]).toEqual(["invalid_request", "id_invalid"]);
    expect(requests).toHaveLength(0);
  });
});

describe("readAccountInsights (request A)", () => {
  it("requests the account set for one UTC day with total_value", async () => {
    respond({
      data: [
        { name: "reach", period: "day", total_value: { value: 10 } },
        { name: "replies", period: "day", total_value: { value: 0 } },
      ],
    });
    const values = await reader.readAccountInsights(TOKEN, USER_ID, "2026-09-27", call());
    expect(values).toEqual({ reach: 10, replies: 0 });
    const params = requests[0]!.searchParams;
    expect(params.get("metric")).toBe(
      "reach,views,accounts_engaged,total_interactions,likes,comments,shares,saves,replies,profile_links_taps",
    );
    expect(params.get("period")).toBe("day");
    expect(params.get("metric_type")).toBe("total_value");
    expect(params.get("breakdown")).toBeNull();
    expect(params.get("since")).toBe(utcDayWindow("2026-09-27").since);
    expect(params.get("until")).toBe(utcDayWindow("2026-09-27").until);
  });

  it("an empty data set is an empty result, never zeros", async () => {
    respond({ data: [] });
    expect(await reader.readAccountInsights(TOKEN, USER_ID, "2026-09-27", call())).toEqual({});
  });

  it("classifies Graph errors (code, not message)", async () => {
    respond({ error: { code: 4, message: "throttled" } }, 400);
    const error = await failure(reader.readAccountInsights(TOKEN, USER_ID, "2026-09-27", call()));
    expect([error.kind, error.providerCode]).toEqual(["rate_limited", "4"]);
  });

  it("spends the explicit budget and stops when it is exhausted", async () => {
    respond({ data: [] });
    const budget = new RequestBudget(1);
    await reader.readAccountInsights(TOKEN, USER_ID, "2026-09-27", { ...call(), budget });
    const error = await failure(
      reader.readAccountInsights(TOKEN, USER_ID, "2026-09-28", { ...call(), budget }),
    );
    expect([error.kind, error.providerCode]).toEqual(["unknown", "request_budget_exceeded"]);
    expect(requests).toHaveLength(1);
  });
});

describe("readFollowBreakdown (request B)", () => {
  const follows = (results: unknown, keys: unknown = ["follow_type"]) => ({
    data: [
      {
        name: "follows_and_unfollows",
        period: "day",
        total_value: { breakdowns: [{ dimension_keys: keys, results }] },
      },
    ],
  });

  it("requests follows_and_unfollows by follow_type and returns the documented values", async () => {
    respond(
      follows([
        { dimension_values: ["FOLLOWER"], value: 4 },
        { dimension_values: ["NON_FOLLOWER"], value: 1 },
        { dimension_values: ["UNKNOWN"], value: 0 },
      ]),
    );
    expect(await reader.readFollowBreakdown(TOKEN, USER_ID, "2026-09-27", call())).toEqual({
      FOLLOWER: 4,
      NON_FOLLOWER: 1,
      UNKNOWN: 0,
    });
    const params = requests[0]!.searchParams;
    expect(params.get("metric")).toBe("follows_and_unfollows");
    expect(params.get("breakdown")).toBe("follow_type");
    expect(params.get("metric_type")).toBe("total_value");
  });

  it("not reported (e.g. under 100 followers) is undefined", async () => {
    respond({ data: [] });
    expect(await reader.readFollowBreakdown(TOKEN, USER_ID, "2026-09-27", call())).toBeUndefined();
  });

  it.each([
    [
      "another dimension",
      follows([{ dimension_values: ["FOLLOWER"], value: 1 }], ["media_product_type"]),
    ],
    [
      "a duplicate value",
      follows([
        { dimension_values: ["FOLLOWER"], value: 1 },
        { dimension_values: ["FOLLOWER"], value: 2 },
      ]),
    ],
    ["a negative value", follows([{ dimension_values: ["FOLLOWER"], value: -1 }])],
    ["a malformed dimension", follows([{ dimension_values: ["follower type"], value: 1 }])],
  ])("fails closed on %s", async (_label, body) => {
    respond(body);
    const error = await failure(reader.readFollowBreakdown(TOKEN, USER_ID, "2026-09-27", call()));
    expect([error.kind, error.providerCode]).toEqual(["data", "insights_invalid"]);
  });
});
