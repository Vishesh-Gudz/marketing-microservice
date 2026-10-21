import { afterEach, describe, expect, it, vi } from "vitest";
import { createGoogleAdsClient } from "./client";
import {
  adsError,
  createFakeGoogleAds,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CLIENT_SECRET,
  installFakeGoogleAds,
  type FakeGoogleAds,
} from "./fakeGoogleAds.fixtures";
import { accessibleCustomers, resolveRoute, type Session } from "./route";

// Phase 9 G-D3: login-customer-id resolution inside the provider.

afterEach(() => {
  vi.unstubAllGlobals();
});

async function session(fake: FakeGoogleAds, user = "u1"): Promise<Session> {
  installFakeGoogleAds(fake);
  const client = createGoogleAdsClient({ version: "v25", timeoutMs: 1_000 });
  // Obtain an access token for `user` through the fake's refresh flow.
  const verifier = "route-verifier-0123456789abcdefghijklmnopqrstuvwxyz0123";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  const challenge = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const exchanged = await client.token({
    grant_type: "authorization_code",
    code: fake.issueCode(user, challenge),
    client_id: FAKE_GOOGLE_CLIENT_ID,
    client_secret: FAKE_GOOGLE_CLIENT_SECRET,
    redirect_uri: "https://x.test/cb",
    code_verifier: verifier,
  });
  if (!exchanged.ok) throw new Error("setup failed");
  const accessToken = (exchanged.body as { access_token: string }).access_token;
  fake.log.length = 0;
  return { client, auth: { accessToken } };
}

describe("resolveRoute", () => {
  it("lists accessible customers sorted and de-duplicated", async () => {
    const s = await session(createFakeGoogleAds());
    expect(await accessibleCustomers(s, "listAccounts")).toEqual(["1110000001", "7770000001"]);
  });

  it("uses direct access first (no login-customer-id), even when a manager also lists it", async () => {
    const fake = createFakeGoogleAds();
    const s = await session(fake);
    expect(await resolveRoute(s, "7770000001", "getAccount")).toEqual({ route: "7770000001" });
    expect(fake.counts().search).toBe(0);
  });

  it.each([
    ["a manager's client", "2220000001"],
    ["a client of a sub-manager (flattened hierarchy)", "4440000001"],
    ["a sub-manager", "3330000001"],
  ])("routes %s through the accessible manager", async (_label, target) => {
    const fake = createFakeGoogleAds();
    const s = await session(fake);
    const route = await resolveRoute(s, target, "getAccount");
    expect(route.route).toBe("1110000001");
    expect(route.managed?.customerClient.id).toBe(target);
    expect(fake.log.at(-1)).toMatchObject({
      kind: "search",
      loginCustomerId: "1110000001",
      customerId: "1110000001",
    });
  });

  it.each([
    ["an unknown customer", "9999999999"],
    ["a hidden client", "5550000001"],
  ])("has no route for %s → not_found", async (_label, target) => {
    const s = await session(createFakeGoogleAds());
    await expect(resolveRoute(s, target, "getAccount")).rejects.toMatchObject({
      kind: "not_found",
      providerCode: "no_route",
    });
  });

  it("skips a candidate it cannot read and keeps looking", async () => {
    const fake = createFakeGoogleAds();
    const s = await session(fake, "u1");
    fake.inject({
      match: (e) => e.kind === "search" && e.customerId === "1110000001",
      response: adsError(403, "PERMISSION_DENIED", "authorizationError", "USER_PERMISSION_DENIED"),
    });
    await expect(resolveRoute(s, "2220000001", "getAccount")).rejects.toMatchObject({
      kind: "not_found",
    });
  });

  it("propagates auth, quota and transient failures", async () => {
    const fake = createFakeGoogleAds();
    const s = await session(fake);
    fake.inject({
      match: (e) => e.kind === "search",
      response: adsError(429, "RESOURCE_EXHAUSTED", "quotaError", "RESOURCE_EXHAUSTED", "7s"),
    });
    await expect(resolveRoute(s, "2220000001", "getAccount")).rejects.toMatchObject({
      kind: "rate_limited",
      retryAfterMs: 7_000,
    });
  });

  it("fails closed beyond the candidate limit", async () => {
    const fake = createFakeGoogleAds();
    const s = await session(fake);
    const many = Array.from({ length: 101 }, (_, i) => String(8_000_000_000 + i));
    await expect(resolveRoute(s, "2220000001", "getAccount", many)).rejects.toMatchObject({
      kind: "unknown",
      providerCode: "google_route_limit",
    });
    expect(fake.counts().search).toBe(0);
  });
});
