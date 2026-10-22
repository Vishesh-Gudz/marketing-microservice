import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { ConnectionProvider } from "../domain/types";
import { createFakeGoogleAds } from "../providers/google/fakeGoogleAds.fixtures";
import { createFakeInstagram } from "../providers/instagram/fakeInstagram.fixtures";
import { createFakeGraph, type FakeGraph } from "../providers/meta/fakeGraph.fixtures";
import {
  as,
  claimResult,
  connectGoogleFake,
  connectInstagramFake,
  newBackend,
  RETURN_URL,
  setupSyncOrg,
  stubLiveGoogle,
  stubLiveInstagram,
  stubLiveMeta,
  type Backend,
} from "../test.helpers";
import { oauthRedirectUri, validateRedirectOrigin } from "./config";

// The OAuth redirect URI per provider: CONVEX_SITE_URL/oauth/callback, except Meta with the
// optional META_OAUTH_REDIRECT_ORIGIN (Facebook Login for Business only accepts plain http for
// http://localhost while the app is in development mode; a local deployment's site URL is
// http://127.0.0.1:<port>). Unit checks of the resolution, then the real connect flow on
// convex-test against the fake platforms.

vi.setConfig({ testTimeout: 120_000 });

const LOCAL_SITE = "http://127.0.0.1:3211";
const LOCAL_META_ORIGIN = "http://localhost:3211";
const LOCAL_META_CALLBACK = "http://localhost:3211/oauth/callback";
const LOCAL_SITE_CALLBACK = "http://127.0.0.1:3211/oauth/callback";
const CLOUD_SITE = "https://happy-otter-123.convex.site";
const CLOUD_SITE_CALLBACK = "https://happy-otter-123.convex.site/oauth/callback";
const ENV = "META_OAUTH_REDIRECT_ORIGIN";
const PROVIDERS: ConnectionProvider[] = ["meta", "google_ads", "instagram"];

let graph: FakeGraph;
beforeEach(() => {
  graph = createFakeGraph();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function caughtFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("oauthRedirectUri", () => {
  it("without an override every provider uses CONVEX_SITE_URL", () => {
    vi.stubEnv("CONVEX_SITE_URL", LOCAL_SITE);
    for (const provider of PROVIDERS) expect(oauthRedirectUri(provider)).toBe(LOCAL_SITE_CALLBACK);
    vi.stubEnv(ENV, "");
    for (const provider of PROVIDERS) expect(oauthRedirectUri(provider)).toBe(LOCAL_SITE_CALLBACK);
  });

  it("local development: Meta uses http://localhost:3211/oauth/callback; Google Ads and Instagram are unchanged", () => {
    vi.stubEnv("CONVEX_SITE_URL", LOCAL_SITE);
    vi.stubEnv(ENV, LOCAL_META_ORIGIN);
    expect(oauthRedirectUri("meta")).toBe(LOCAL_META_CALLBACK);
    expect(oauthRedirectUri("google_ads")).toBe(LOCAL_SITE_CALLBACK);
    expect(oauthRedirectUri("instagram")).toBe(LOCAL_SITE_CALLBACK);
    // A trailing slash is the same origin.
    vi.stubEnv(ENV, `${LOCAL_META_ORIGIN}/`);
    expect(oauthRedirectUri("meta")).toBe(LOCAL_META_CALLBACK);
  });

  it("accepts only that origin, normalized, also when the local site URL is localhost or [::1]", () => {
    for (const [value, site] of [
      ["HTTP://LOCALHOST:3211", LOCAL_SITE],
      ["http://localhost:03211", LOCAL_SITE],
      [LOCAL_META_ORIGIN, "http://localhost:3211"],
      [LOCAL_META_ORIGIN, "http://[::1]:3211"],
    ]) {
      expect(validateRedirectOrigin(value!, site!), `${value} on ${site}`).toEqual({
        ok: true,
        origin: LOCAL_META_ORIGIN,
      });
    }
  });

  it("a cloud (https) deployment leaves the override unset: Meta uses its https CONVEX_SITE_URL like every provider", () => {
    vi.stubEnv("CONVEX_SITE_URL", CLOUD_SITE);
    for (const provider of PROVIDERS) expect(oauthRedirectUri(provider)).toBe(CLOUD_SITE_CALLBACK);
  });

  it.each([
    // Arbitrary or untrusted https origins: codes must never be redirected off this deployment.
    ["an arbitrary https host", "https://evil.example", "only http://localhost is allowed"],
    [
      "another Convex deployment",
      "https://other-deployment-456.convex.site",
      "only http://localhost is allowed",
    ],
    ["https on localhost", "https://localhost:3211", "only http://localhost is allowed"],
    // Other loopback names and hosts.
    ["plain http on 127.0.0.1", "http://127.0.0.1:3211", "only http://localhost is allowed"],
    ["plain http on IPv6 loopback", "http://[::1]:3211", "only http://localhost is allowed"],
    ["plain http on another host", "http://example.com:3211", "only http://localhost is allowed"],
    [
      "a host that only starts with localhost",
      "http://localhost.example.com:3211",
      "only http://localhost is allowed",
    ],
    ["localhost with a trailing dot", "http://localhost.:3211", "only http://localhost is allowed"],
    ["another scheme", "ftp://localhost:3211", "only http://localhost is allowed"],
    // Unexpected ports.
    ["the dashboard's port", "http://localhost:3000", "its port must match CONVEX_SITE_URL"],
    ["the backend API port", "http://localhost:3210", "its port must match CONVEX_SITE_URL"],
    ["the default port", "http://localhost", "its port must match CONVEX_SITE_URL"],
    // Malformed origins.
    [
      "a path",
      "http://localhost:3211/oauth/callback",
      "it must be an origin without a path, query or fragment",
    ],
    [
      "a query",
      "http://localhost:3211/?next=1",
      "it must be an origin without a path, query or fragment",
    ],
    [
      "a fragment",
      "http://localhost:3211/#x",
      "it must be an origin without a path, query or fragment",
    ],
    ["credentials", "http://user:pw@localhost:3211", "it must not contain credentials"],
    ["no scheme", "localhost:3211", "it must be an origin without a path, query or fragment"],
    ["not a URL", "not a url", "it is not an absolute URL"],
  ])("refuses %s, naming the variable but never its value", (_label, value, reason) => {
    vi.stubEnv("CONVEX_SITE_URL", LOCAL_SITE);
    expect(validateRedirectOrigin(value, LOCAL_SITE)).toEqual({ ok: false, reason });
    vi.stubEnv(ENV, value);
    const error = caughtFrom(() => oauthRedirectUri("meta")) as {
      data: { code: string; message: string };
    };
    expect(error.data).toEqual({ code: "INTERNAL", message: `${ENV} is invalid: ${reason}.` });
    expect(error.data.message).not.toContain(value);
    // A bad Meta setting never changes Google Ads or Instagram.
    expect(oauthRedirectUri("google_ads")).toBe(LOCAL_SITE_CALLBACK);
    expect(oauthRedirectUri("instagram")).toBe(LOCAL_SITE_CALLBACK);
  });

  it.each([
    [
      "http://localhost on the same port",
      "http://localhost:3211",
      "it is only allowed on a local deployment",
    ],
    ["the deployment's own https origin", CLOUD_SITE, "only http://localhost is allowed"],
    ["an arbitrary https host", "https://evil.example", "only http://localhost is allowed"],
  ])("a cloud (https) deployment refuses every override: %s", (_label, value, reason) => {
    expect(validateRedirectOrigin(value, CLOUD_SITE)).toEqual({ ok: false, reason });
    vi.stubEnv("CONVEX_SITE_URL", CLOUD_SITE);
    vi.stubEnv(ENV, value);
    expect(caughtFrom(() => oauthRedirectUri("meta"))).toMatchObject({
      data: { code: "INTERNAL", message: `${ENV} is invalid: ${reason}.` },
    });
    expect(oauthRedirectUri("google_ads")).toBe(CLOUD_SITE_CALLBACK);
    expect(oauthRedirectUri("instagram")).toBe(CLOUD_SITE_CALLBACK);
  });

  it("a missing CONVEX_SITE_URL still fails closed for every provider", () => {
    vi.stubEnv("CONVEX_SITE_URL", undefined);
    vi.stubEnv(ENV, LOCAL_META_ORIGIN);
    for (const provider of PROVIDERS) {
      expect(caughtFrom(() => oauthRedirectUri(provider))).toMatchObject({
        data: { code: "INTERNAL", message: "OAuth redirect URI is not available" },
      });
    }
  });
});

async function beginMeta(t: Backend) {
  const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
    provider: "meta",
    returnUrl: RETURN_URL,
  });
  return new URL(authorizeUrl).searchParams;
}

/**
 * The callback's redirect parameters completed by the initiator's claim (S2), or null for the
 * static error page (no redirect).
 */
async function callback(t: Backend, state: string, code: string) {
  const response = await t.fetch(
    `/oauth/callback?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
    { method: "GET", redirect: "manual" },
  );
  const location = response.headers.get("location");
  return location === null ? null : await claimResult(t, new URL(location).searchParams);
}

async function stored(t: Backend) {
  return await t.run(async (ctx) => ({
    states: (await ctx.db.query("oauthStates").collect()).map((s) => s.status),
    connections: (await ctx.db.query("connections").collect()).length,
    credentials: (await ctx.db.query("credentials").collect()).length,
  }));
}

describe("the Meta connect flow with META_OAUTH_REDIRECT_ORIGIN (fake Graph)", () => {
  it("a cloud (https) deployment with the override unset: authorization and exchange use its https CONVEX_SITE_URL", async () => {
    stubLiveMeta(graph, { CONVEX_SITE_URL: CLOUD_SITE });
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await beginMeta(t);
    expect(params.get("redirect_uri")).toBe(CLOUD_SITE_CALLBACK);
    const code = graph.issueCode("u1", params.get("redirect_uri")!);
    expect((await callback(t, params.get("state")!, code))?.get("status")).toBe("connected");
  });

  it("authorization and code exchange both use http://localhost:3211/oauth/callback; the state stays single-use", async () => {
    stubLiveMeta(graph, { CONVEX_SITE_URL: LOCAL_SITE, [ENV]: LOCAL_META_ORIGIN });
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await beginMeta(t);
    expect(params.get("redirect_uri")).toBe(LOCAL_META_CALLBACK);
    // The fake Graph refuses (100/36008) an exchange whose redirect_uri differs from this one.
    const code = graph.issueCode("u1", params.get("redirect_uri")!);
    const result = await callback(t, params.get("state")!, code);
    expect(result?.get("status")).toBe("connected");
    expect(await stored(t)).toEqual({ states: ["consumed"], connections: 1, credentials: 1 });

    // Replaying the callback is refused with the static page: nothing new is stored.
    expect(await callback(t, params.get("state")!, graph.issueCode("u1"))).toBeNull();
    expect(await stored(t)).toEqual({ states: ["consumed"], connections: 1, credentials: 1 });
  });

  it("a different redirect_uri at the exchange is refused by Meta's exact match and fails closed", async () => {
    stubLiveMeta(graph, { CONVEX_SITE_URL: LOCAL_SITE, [ENV]: LOCAL_META_ORIGIN });
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await beginMeta(t);
    const code = graph.issueCode("u1", params.get("redirect_uri")!);
    // The override disappears between the dialog and the callback: the exchange would send
    // http://127.0.0.1:3211/oauth/callback, which Meta rejects.
    vi.stubEnv(ENV, "");
    const result = await callback(t, params.get("state")!, code);
    expect(result?.get("status")).toBe("error");
    expect(result?.get("error")).toBe("exchange_failed");
    expect(await stored(t)).toEqual({ states: ["failed"], connections: 0, credentials: 0 });
    // Refused for the redirect_uri mismatch itself (Meta 100/36008), at the code exchange.
    const [failure] = await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .collect()
        .then((rows) => rows.filter((row) => row.action === "connection.oauth_failed")),
    );
    expect(failure?.changes?.providerCode?.to).toBe("100/36008");
    expect(failure?.changes?.failureStage?.to).toBe("code_exchange");
  });

  it.each([
    ["http://127.0.0.1:3211", "127.0.0.1"],
    ["https://evil.example", "evil.example"],
    ["https://other-deployment-456.convex.site", "other-deployment-456"],
  ])(
    "an untrusted override (%s) refuses beginConnect before any OAuth state exists; no Graph call",
    async (value, marker) => {
      stubLiveMeta(graph, { CONVEX_SITE_URL: LOCAL_SITE, [ENV]: value });
      const t = newBackend();
      await setupSyncOrg(t);
      let caught: unknown;
      try {
        await beginMeta(t);
      } catch (error) {
        caught = error;
      }
      expect(caught).toMatchObject({ data: { code: "INTERNAL" } });
      expect(JSON.stringify((caught as { data: unknown }).data)).not.toContain(marker);
      expect(await stored(t)).toEqual({ states: [], connections: 0, credentials: 0 });
      expect(graph.calls()).toBe(0);
    },
  );

  it("an override made invalid after beginConnect fails the callback closed without calling Meta", async () => {
    stubLiveMeta(graph, { CONVEX_SITE_URL: LOCAL_SITE, [ENV]: LOCAL_META_ORIGIN });
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await beginMeta(t);
    const code = graph.issueCode("u1", params.get("redirect_uri")!);
    vi.stubEnv(ENV, "http://example.com");
    const result = await callback(t, params.get("state")!, code);
    expect(result?.get("error")).toBe("internal");
    expect(graph.calls()).toBe(0);
    expect(await stored(t)).toEqual({ states: ["failed"], connections: 0, credentials: 0 });
    // The failed state cannot be replayed once the setting is fixed.
    vi.stubEnv(ENV, LOCAL_META_ORIGIN);
    expect(await callback(t, params.get("state")!, code)).toBeNull();
    expect(graph.calls()).toBe(0);
  });
});

describe("Google Ads and Instagram keep CONVEX_SITE_URL whatever the Meta override is", () => {
  const OVERRIDES = [
    ["valid", LOCAL_META_ORIGIN],
    ["invalid", "https://evil.example"],
  ] as const;

  it.each(OVERRIDES)(
    "Google Ads (%s Meta override): authorization and exchange use http://127.0.0.1:3211/oauth/callback",
    async (_label, override) => {
      const fake = createFakeGoogleAds();
      stubLiveGoogle(fake, { CONVEX_SITE_URL: LOCAL_SITE, [ENV]: override });
      const t = newBackend();
      await setupSyncOrg(t);
      const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
        provider: "google_ads",
        returnUrl: RETURN_URL,
      });
      expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(LOCAL_SITE_CALLBACK);
      // The fake Google API binds the code to the dialog's redirect_uri and checks the exchange.
      expect((await connectGoogleFake(t, fake, "u1")).get("status")).toBe("connected");
    },
  );

  it.each(OVERRIDES)(
    "Instagram (%s Meta override): authorization uses http://127.0.0.1:3211/oauth/callback and still connects",
    async (_label, override) => {
      const fake = createFakeInstagram();
      stubLiveInstagram(fake, { CONVEX_SITE_URL: LOCAL_SITE, [ENV]: override });
      const t = newBackend();
      await setupSyncOrg(t);
      const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
        provider: "instagram",
        returnUrl: RETURN_URL,
      });
      expect(new URL(authorizeUrl).searchParams.get("redirect_uri")).toBe(LOCAL_SITE_CALLBACK);
      expect((await connectInstagramFake(t, fake)).get("status")).toBe("connected");
    },
  );
});
