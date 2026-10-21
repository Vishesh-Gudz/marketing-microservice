import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertAllowedEndpoint,
  createGoogleAdsClient,
  ForbiddenEndpointError,
  parseDuration,
  parseErrorBody,
  sendChecked,
} from "./client";
import { adsError, createFakeGoogleAds, installFakeGoogleAds } from "./fakeGoogleAds.fixtures";

// Phase 9 G-D8 / G-D16: the read-only transport. Every request is checked against the
// endpoint allowlist BEFORE fetch; tokens travel in headers or form bodies only.

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = () => createGoogleAdsClient({ version: "v25", timeoutMs: 1_000 });
const auth = { accessToken: "test-access-x" };

describe("read-only endpoint allowlist", () => {
  it.each([
    ["POST", "https://oauth2.googleapis.com/token"],
    ["GET", "https://openidconnect.googleapis.com/v1/userinfo"],
    ["GET", "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers"],
    ["POST", "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search"],
  ])("allows %s %s", (method, url) => {
    expect(() => assertAllowedEndpoint(method, url)).not.toThrow();
  });

  it.each([
    ["POST", "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:mutate"],
    ["POST", "https://googleads.googleapis.com/v25/customers/1234567890/campaigns:mutate"],
    ["POST", "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:searchStream"],
    ["POST", "https://googleads.googleapis.com/v25/customers:listAccessibleCustomers"],
    ["GET", "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search"],
    ["POST", "https://googleads.googleapis.com/v25/customers/123/googleAds:search"],
    ["POST", "https://oauth2.googleapis.com/revoke"],
    ["GET", "https://www.googleapis.com/oauth2/v3/userinfo"],
    ["POST", "https://evil.example.test/v25/customers/1234567890/googleAds:search"],
    ["POST", "https://googleads.googleapis.com/v25/customers/1234567890/googleAds:search?x=1"],
  ])("refuses %s %s before any network call", async (method, url) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      sendChecked(method as "GET" | "POST", url, { headers: {} }, 1_000),
    ).rejects.toBeInstanceOf(ForbiddenEndpointError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a malformed customer id or login-customer-id before any network call", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      client().search(auth, "123-456-7890", "SELECT customer.id FROM customer"),
    ).rejects.toBeInstanceOf(ForbiddenEndpointError);
    await expect(
      client().search(
        { ...auth, loginCustomerId: "abc" },
        "1234567890",
        "SELECT customer.id FROM customer",
      ),
    ).rejects.toBeInstanceOf(ForbiddenEndpointError);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("transport", () => {
  it("sends the access token as a header only; login-customer-id when routed; never a developer token", async () => {
    const fake = installFakeGoogleAds(createFakeGoogleAds());
    await client().search(
      { ...auth, loginCustomerId: "1110000001" },
      "2220000001",
      "SELECT customer.id FROM customer",
    );
    await client().listAccessibleCustomers(auth);
    const [search, accessible] = fake.log;
    expect(search).toMatchObject({
      method: "POST",
      kind: "search",
      hasBearer: true,
      developerTokenHeader: false,
      loginCustomerId: "1110000001",
      customerId: "2220000001",
      secretInUrl: false,
    });
    expect(accessible).toMatchObject({
      method: "GET",
      kind: "accessible",
      developerTokenHeader: false,
      secretInUrl: false,
    });
    expect(accessible).not.toHaveProperty("loginCustomerId");
  });

  it("sends exactly the documented Google Ads headers (developer tokens were sunset 2026-09-09)", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await client().search(
      { ...auth, loginCustomerId: "1110000001" },
      "2220000001",
      "SELECT customer.id FROM customer",
    );
    await client().listAccessibleCustomers(auth);
    const sent = fetch.mock.calls.map((call) => {
      const init = (call as unknown as [string, RequestInit])[1];
      const names: string[] = [];
      new Headers(init.headers).forEach((_value, name) => names.push(name));
      return names.sort();
    });
    expect(sent).toEqual([
      ["accept", "authorization", "content-type", "login-customer-id"],
      ["accept", "authorization"],
    ]);
  });

  it("posts OAuth secrets in a form body, never in the URL", async () => {
    const fake = installFakeGoogleAds(createFakeGoogleAds());
    await client().token({
      grant_type: "refresh_token",
      refresh_token: "test-refresh-none",
      client_id: "x",
      client_secret: "y",
    });
    expect(fake.log[0]).toMatchObject({
      method: "POST",
      kind: "token_refresh",
      secretInUrl: false,
      formFields: ["grant_type", "refresh_token", "client_id", "client_secret"],
    });
  });

  it("reports timeouts and network failures without the underlying error", async () => {
    const fake = installFakeGoogleAds(createFakeGoogleAds());
    fake.inject({ match: () => true, response: "hang" });
    const slow = createGoogleAdsClient({ version: "v25", timeoutMs: 20 });
    expect(await slow.listAccessibleCustomers(auth)).toEqual({
      ok: false,
      failure: { type: "timeout" },
    });
    fake.inject({ match: () => true, response: "network" });
    expect(await client().listAccessibleCustomers(auth)).toEqual({
      ok: false,
      failure: { type: "network" },
    });
  });

  it("returns structured Google Ads failures (codes, RPC status, retry delay) and no text", async () => {
    const fake = installFakeGoogleAds(createFakeGoogleAds());
    fake.inject({
      match: () => true,
      response: adsError(429, "RESOURCE_EXHAUSTED", "quotaError", "RESOURCE_EXHAUSTED", "12.5s"),
    });
    const result = await client().listAccessibleCustomers(auth);
    expect(result).toEqual({
      ok: false,
      failure: {
        type: "http",
        status: 429,
        rpcStatus: "RESOURCE_EXHAUSTED",
        adsErrors: [{ family: "quotaError", code: "RESOURCE_EXHAUSTED" }],
        retryAfterMs: 12_500,
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/Fake|fakeRequestId|message/);
  });
});

describe("error body parsing", () => {
  it("reads quota error details and RetryInfo; keeps the largest delay", () => {
    expect(
      parseErrorBody({
        error: {
          status: "RESOURCE_EXHAUSTED",
          details: [
            {
              errors: [
                {
                  errorCode: { quotaError: "RESOURCE_TEMPORARILY_EXHAUSTED" },
                  details: { quotaErrorDetails: { retryDelay: "40s" } },
                },
              ],
            },
            { retryDelay: "5s" },
          ],
        },
      }),
    ).toEqual({
      adsErrors: [{ family: "quotaError", code: "RESOURCE_TEMPORARILY_EXHAUSTED" }],
      rpcStatus: "RESOURCE_EXHAUSTED",
      retryAfterMs: 40_000,
    });
  });

  it("reads OAuth errors and drops anything malformed", () => {
    expect(parseErrorBody({ error: "invalid_grant", error_description: "secret text" })).toEqual({
      adsErrors: [],
      oauthError: "invalid_grant",
    });
    expect(parseErrorBody({ error: "Invalid Grant <script>" })).toEqual({ adsErrors: [] });
    expect(
      parseErrorBody({
        error: {
          details: [{ errors: [{ errorCode: { "bad family": "X", queryError: "lower" } }] }],
        },
      }),
    ).toEqual({ adsErrors: [] });
    expect(parseErrorBody(undefined)).toEqual({ adsErrors: [] });
  });

  it.each([
    ["30s", 30_000],
    ["1.5s", 1_500],
    ["0.001s", 1],
    ["30", undefined],
    ["-1s", undefined],
    [30, undefined],
  ])("parses the duration %j", (value, ms) => {
    expect(parseDuration(value)).toBe(ms);
  });
});
