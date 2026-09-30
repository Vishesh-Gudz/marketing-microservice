import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adsError,
  createFakeGoogleAds,
  FAKE_DEVELOPER_TOKEN,
  FAKE_GOOGLE_CLIENT_ID,
  FAKE_GOOGLE_CONFIG,
  installFakeGoogleAds,
  oauthErrorResponse,
  type FakeGoogleAds,
} from "./fakeGoogleAds.fixtures";
import { createGoogleOAuthSpec, GOOGLE_ADS_SCOPE } from "./oauth";

// Phase 9 G-D4/G-D5/G-D6 + D28b stages: the Google OAuth spec against the fake API.

const REDIRECT = "https://marketing-tests.convex.site/oauth/callback";
const VERIFIER = "oauth-test-verifier-0123456789abcdefghijklmnopqrstuvwxyz";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function challengeOf(verifier: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const spec = (developerToken: string = FAKE_DEVELOPER_TOKEN) =>
  createGoogleOAuthSpec({ developerToken });

async function exchange(fake: FakeGoogleAds, user = "u1", options: { verifier?: string } = {}) {
  const code = fake.issueCode(user, await challengeOf(VERIFIER), REDIRECT);
  return await spec().exchangeCode({
    code,
    redirectUri: REDIRECT,
    codeVerifier: options.verifier ?? VERIFIER,
    config: FAKE_GOOGLE_CONFIG,
    now: 1_790_000_000_000,
  });
}

describe("authorization URL", () => {
  it("uses PKCE S256, offline access with consent, and ONLY the adwords + openid scopes", async () => {
    const challenge = await challengeOf(VERIFIER);
    const url = new URL(
      spec().buildAuthorizationUrl({
        state: "st",
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        config: FAKE_GOOGLE_CONFIG,
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, key) => (params[key] = value));
    expect(params).toEqual({
      client_id: FAKE_GOOGLE_CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: `${GOOGLE_ADS_SCOPE} openid`,
      state: "st",
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
    });
    expect(url.toString()).not.toMatch(/email|profile|client_secret|developer/);
    const s = spec();
    expect(s.requestedScopes).toEqual([GOOGLE_ADS_SCOPE, "openid"]);
    expect(s.requiredScopes).toEqual([GOOGLE_ADS_SCOPE]);
    expect(s.usesPkce).toBe(true);
    expect(s.refresh).toBeUndefined();
    expect(s.revoke).toBeUndefined();
  });

  it("refuses to build a URL with invalid configuration or without PKCE", () => {
    for (const config of [
      {},
      { ...FAKE_GOOGLE_CONFIG, clientId: "not-a-client-id" },
      { ...FAKE_GOOGLE_CONFIG, clientSecret: "short" },
    ]) {
      expect(() =>
        spec().buildAuthorizationUrl({
          state: "s",
          redirectUri: REDIRECT,
          codeChallenge: "c",
          config,
        }),
      ).toThrow(expect.objectContaining({ providerCode: "config:google_config_invalid" }));
    }
    expect(() =>
      spec("bad token!").buildAuthorizationUrl({
        state: "s",
        redirectUri: REDIRECT,
        codeChallenge: "c",
        config: FAKE_GOOGLE_CONFIG,
      }),
    ).toThrow(expect.objectContaining({ kind: "unknown" }));
    expect(() =>
      spec().buildAuthorizationUrl({
        state: "s",
        redirectUri: REDIRECT,
        config: FAKE_GOOGLE_CONFIG,
      }),
    ).toThrow();
  });
});

describe("exchangeCode", () => {
  it("runs token_exchange → identity → api_access and returns a refresh-token credential", async () => {
    const fake = installFakeGoogleAds(createFakeGoogleAds());
    const grant = await exchange(fake);
    expect(grant).toEqual({
      credential: {
        kind: "google",
        v: 1,
        refreshToken: "test-refresh-u1",
        clientId: FAKE_GOOGLE_CLIENT_ID,
        issuedAt: 1_790_000_000_000,
        scopes: [GOOGLE_ADS_SCOPE, "openid"],
      },
      identity: { externalUserId: "100000000000000000001" },
      grantedScopes: [GOOGLE_ADS_SCOPE, "openid"],
      refreshable: true,
    });
    // No access token is stored; no email or display name anywhere.
    expect(JSON.stringify(grant)).not.toMatch(/test-access|email|@/);
    expect(grant).not.toHaveProperty("expiresAt");
    expect(fake.log.map((e) => e.kind)).toEqual(["token_exchange", "userinfo", "accessible"]);
    expect(fake.log.every((e) => !e.secretInUrl)).toBe(true);
    expect(fake.log[0]!.formFields.sort()).toEqual(
      ["client_id", "client_secret", "code", "code_verifier", "grant_type", "redirect_uri"].sort(),
    );
    expect(fake.log[2]).toMatchObject({ developerToken: true, hasBearer: true });
  });

  it.each([
    [
      "an invalid or reused code",
      async (fake: FakeGoogleAds) => {
        const code = fake.issueCode("u1", await challengeOf(VERIFIER), REDIRECT);
        await spec().exchangeCode({
          code,
          redirectUri: REDIRECT,
          codeVerifier: VERIFIER,
          config: FAKE_GOOGLE_CONFIG,
          now: 1,
        });
        return spec().exchangeCode({
          code,
          redirectUri: REDIRECT,
          codeVerifier: VERIFIER,
          config: FAKE_GOOGLE_CONFIG,
          now: 1,
        });
      },
      "auth",
      "token_exchange:invalid_grant",
    ],
    [
      "a wrong PKCE verifier",
      (fake: FakeGoogleAds) =>
        exchange(fake, "u1", { verifier: "wrong-verifier-0123456789abcdefghijklmnopqrstuv" }),
      "auth",
      "token_exchange:invalid_grant",
    ],
    [
      "no refresh token issued",
      (fake: FakeGoogleAds) => exchange(fake, "norefresh"),
      "auth",
      "token_exchange:no_refresh_token",
    ],
    [
      "a Google account without Google Ads",
      (fake: FakeGoogleAds) => exchange(fake, "noads"),
      "auth",
      "api_access:NOT_ADS_USER",
    ],
    [
      "a wrong OAuth client secret",
      (fake: FakeGoogleAds) => {
        fake.inject({
          match: (e) => e.kind === "token_exchange",
          response: oauthErrorResponse(401, "invalid_client"),
        });
        return exchange(fake);
      },
      "unknown",
      "token_exchange:invalid_client",
    ],
    [
      "an unavailable userinfo endpoint",
      (fake: FakeGoogleAds) => {
        fake.inject({ match: (e) => e.kind === "userinfo", response: { status: 503, body: {} } });
        return exchange(fake);
      },
      "transient",
      "identity:http_503",
    ],
    [
      "a developer token that is not approved",
      (fake: FakeGoogleAds) => {
        fake.inject({
          match: (e) => e.kind === "accessible",
          response: adsError(
            403,
            "PERMISSION_DENIED",
            "authorizationError",
            "DEVELOPER_TOKEN_NOT_APPROVED",
          ),
        });
        return exchange(fake);
      },
      "unknown",
      "api_access:DEVELOPER_TOKEN_NOT_APPROVED",
    ],
    [
      "a network failure",
      (fake: FakeGoogleAds) => {
        fake.inject({ match: (e) => e.kind === "token_exchange", response: "network" });
        return exchange(fake);
      },
      "transient",
      "token_exchange:network",
    ],
  ])("classifies %s", async (_label, run, kind, providerCode) => {
    const fake = installFakeGoogleAds(createFakeGoogleAds());
    let caught: unknown;
    try {
      await run(fake);
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ kind, providerCode });
    const text = `${(caught as Error).message} ${JSON.stringify(caught)}`;
    expect(text).not.toMatch(
      /test-(access|refresh|gcode)|test-google-client-secret|test-developer-token|Fake|fakeRequestId|https?:/,
    );
  });

  it("requires the PKCE verifier and a valid configuration before any network call", async () => {
    const fake = installFakeGoogleAds(createFakeGoogleAds());
    await expect(
      spec().exchangeCode({ code: "x", redirectUri: REDIRECT, config: FAKE_GOOGLE_CONFIG, now: 1 }),
    ).rejects.toMatchObject({
      kind: "auth",
      retryable: false,
      providerCode: "token_exchange:invalid_request",
    });
    await expect(
      spec().exchangeCode({
        code: "x",
        redirectUri: REDIRECT,
        codeVerifier: VERIFIER,
        config: { clientId: FAKE_GOOGLE_CLIENT_ID },
        now: 1,
      }),
    ).rejects.toMatchObject({ kind: "unknown", providerCode: "config:google_config_invalid" });
    await expect(
      createGoogleOAuthSpec({ developerToken: "x" }).exchangeCode({
        code: "x",
        redirectUri: REDIRECT,
        codeVerifier: VERIFIER,
        config: FAKE_GOOGLE_CONFIG,
        now: 1,
      }),
    ).rejects.toMatchObject({ kind: "unknown", providerCode: "config:google_config_invalid" });
    expect(fake.log).toHaveLength(0);
  });

  it("uses the version override for the API-access call", async () => {
    const fake = installFakeGoogleAds(createFakeGoogleAds());
    const s = createGoogleOAuthSpec({ developerToken: FAKE_DEVELOPER_TOKEN, version: "v26" });
    expect(s.providerId).toBe("google-ads-api/v26");
    await s.exchangeCode({
      code: fake.issueCode("u1", await challengeOf(VERIFIER), REDIRECT),
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
      config: FAKE_GOOGLE_CONFIG,
      now: 1,
    });
    expect(fake.log.find((e) => e.kind === "accessible")!.path).toBe(
      "/v26/customers:listAccessibleCustomers",
    );
  });
});
