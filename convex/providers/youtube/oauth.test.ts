import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pkceChallengeS256, randomToken } from "../../lib/crypto";
import { isProviderError, type ProviderError } from "../errors";
import type { OAuthClientConfig } from "../oauth";
import { runOAuthSpecContract } from "../oauth.suite";
import {
  createMockYouTubeDiscovery,
  createMockYouTubeOAuthSpec,
  MOCK_YT_INVALID_CODE,
  mockYouTubeCode,
} from "../social/mock/youtube";
import { mockYouTubeChannelId } from "../social/mock/youtubeData";
import { createYouTubeDiscovery } from "./discovery";
import {
  createFakeYouTube,
  FAKE_CHANNEL_ID,
  FAKE_YT_ANALYTICS_SCOPE,
  FAKE_YT_CLIENT_ID,
  FAKE_YT_CLIENT_SECRET,
  FAKE_YT_CODE_MARKER,
  FAKE_YT_READONLY_SCOPE,
  FAKE_YT_TOKEN_MARKER,
  type FakeYouTube,
} from "./fakeYouTube.fixtures";
import { createYouTubeOAuthSpec, YOUTUBE_SCOPES } from "./oauth";

// ADR 0016, Checkpoint 2: the YouTube OAuthSpec and discovery against the fake Google API.
// PKCE, offline access and exact scopes; the channel as identity; granular-consent outcomes;
// revocation on disconnect; YouTube's own OAuth client, never shared with Google Ads.

const REDIRECT = "https://marketing-tests.convex.site/oauth/callback";
const NOW = 1_790_000_000_000;
const CONFIG: OAuthClientConfig = {
  clientId: FAKE_YT_CLIENT_ID,
  clientSecret: FAKE_YT_CLIENT_SECRET,
};
const GOOGLE_ADS_CLIENT = "200000000002-fakeadsclient.apps.googleusercontent.com";

let fake: FakeYouTube;

function setup(channels: Parameters<typeof createFakeYouTube>[0] = {}) {
  fake = createFakeYouTube(channels);
  vi.stubGlobal("fetch", fake.fetch);
}

beforeEach(() => setup());
afterEach(() => vi.unstubAllGlobals());

async function rejection(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.catch((e: unknown) => e);
  if (!isProviderError(error)) throw new Error(`expected ProviderError, got ${String(error)}`);
  return error;
}

/** Builds the authorize URL and returns a code + verifier for `user`, as the callback sees them. */
async function consent(user = "brand", config = CONFIG) {
  const spec = createYouTubeOAuthSpec();
  const verifier = randomToken();
  const challenge = await pkceChallengeS256(verifier);
  spec.buildAuthorizationUrl({
    state: "s",
    redirectUri: REDIRECT,
    codeChallenge: challenge,
    config,
  });
  return { spec, verifier, code: fake.issueCode(user, challenge, REDIRECT) };
}

async function exchange(user = "brand", config = CONFIG) {
  const { spec, verifier, code } = await consent(user, config);
  return await spec.exchangeCode({
    code,
    redirectUri: REDIRECT,
    codeVerifier: verifier,
    config,
    now: NOW,
  });
}

runOAuthSpecContract({
  name: "youtube (fake API)",
  // fetch is resolved per request: every test runs against the fake of its beforeEach.
  create: () => createYouTubeOAuthSpec(),
  config: CONFIG,
  validCode: (_url, challenge) => fake.issueCode("brand", challenge!, REDIRECT),
  invalidCode: `${FAKE_YT_CODE_MARKER}-unknown`,
});

runOAuthSpecContract({
  name: "youtube mock",
  create: createMockYouTubeOAuthSpec,
  config: {},
  validCode: (_url, challenge) => mockYouTubeCode(challenge),
  invalidCode: MOCK_YT_INVALID_CODE,
});

describe("authorization URL", () => {
  it("asks Google for exactly the two read-only scopes, offline, with PKCE and consent", async () => {
    const spec = createYouTubeOAuthSpec();
    const challenge = await pkceChallengeS256(randomToken());
    const url = new URL(
      spec.buildAuthorizationUrl({
        state: "nonce",
        redirectUri: REDIRECT,
        codeChallenge: challenge,
        config: CONFIG,
      }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, name) => {
      params[name] = value;
    });
    expect(params).toEqual({
      client_id: FAKE_YT_CLIENT_ID,
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: `${FAKE_YT_READONLY_SCOPE} ${FAKE_YT_ANALYTICS_SCOPE}`,
      state: "nonce",
      code_challenge: challenge,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "false",
    });
    expect(url.toString()).not.toContain(FAKE_YT_CLIENT_SECRET);
    expect(spec.requiredScopes).toEqual(YOUTUBE_SCOPES);
    expect(spec.refresh).toBeUndefined(); // access tokens are minted per call (Y-D5)
  });

  it.each<[string, OAuthClientConfig]>([
    ["no client", {}],
    ["a malformed client id", { clientId: "not-a-client", clientSecret: FAKE_YT_CLIENT_SECRET }],
    ["no secret", { clientId: FAKE_YT_CLIENT_ID }],
    ["the Google Ads client", { ...CONFIG, extra: { googleAdsClientId: FAKE_YT_CLIENT_ID } }],
  ])("is not configured with %s", (_label, config) => {
    const spec = createYouTubeOAuthSpec();
    expect(spec.isConfigured?.(config)).toBe(false);
    expect(() =>
      spec.buildAuthorizationUrl({ state: "s", redirectUri: REDIRECT, codeChallenge: "c", config }),
    ).toThrow();
  });

  it("is configured with its own client next to a different Google Ads client", () => {
    expect(
      createYouTubeOAuthSpec().isConfigured?.({
        ...CONFIG,
        extra: { googleAdsClientId: GOOGLE_ADS_CLIENT },
      }),
    ).toBe(true);
  });
});

describe("exchangeCode", () => {
  it("exchanges the code (PKCE) and identifies the channel: 2 requests, secrets in bodies only", async () => {
    const grant = await exchange();
    expect(grant).toEqual({
      credential: {
        kind: "youtube",
        v: 1,
        refreshToken: expect.stringContaining(`${FAKE_YT_TOKEN_MARKER}-refresh-brand`),
        clientId: FAKE_YT_CLIENT_ID,
        channelId: FAKE_CHANNEL_ID,
        issuedAt: NOW,
        scopes: [FAKE_YT_READONLY_SCOPE, FAKE_YT_ANALYTICS_SCOPE],
      },
      identity: { externalUserId: FAKE_CHANNEL_ID }, // no title (ADR 0016, Checkpoint 3b)
      grantedScopes: [FAKE_YT_READONLY_SCOPE, FAKE_YT_ANALYTICS_SCOPE],
      refreshable: true,
    });
    expect(grant).not.toHaveProperty("expiresAt");
    expect(fake.requests.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
      "POST oauth2.googleapis.com/token",
      "GET www.googleapis.com/youtube/v3/channels",
    ]);
    const body = new URLSearchParams(fake.requests[0]!.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toMatch(/\S/);
    for (const request of fake.requests) {
      expect(request.url).not.toMatch(
        new RegExp(`${FAKE_YT_TOKEN_MARKER}|${FAKE_YT_CODE_MARKER}|secret`),
      );
    }
  });

  it("keeps the connection when only the analytics scope was unticked (granular consent)", async () => {
    setup({
      channels: {
        brand: {
          channelId: FAKE_CHANNEL_ID,
          title: "Fake Brand",
          grantedScope: FAKE_YT_READONLY_SCOPE,
        },
      },
    });
    const grant = await exchange();
    expect(grant.grantedScopes).toEqual([FAKE_YT_READONLY_SCOPE]);
  });

  it("drops anything that is not a Google scope string from the granted list", async () => {
    setup({
      channels: {
        brand: {
          channelId: FAKE_CHANNEL_ID,
          grantedScope: `${FAKE_YT_READONLY_SCOPE} <script> ${FAKE_YT_READONLY_SCOPE}`,
        },
      },
    });
    expect((await exchange()).grantedScopes).toEqual([FAKE_YT_READONLY_SCOPE]);
  });

  it.each<[string, Parameters<typeof createFakeYouTube>[0], string, string, number]>([
    [
      "no refresh token",
      { channels: { brand: { channelId: FAKE_CHANNEL_ID, omitRefreshToken: true } } },
      "auth",
      "token_exchange:no_refresh_token",
      1,
    ],
    [
      "youtube.readonly unticked",
      {
        channels: { brand: { channelId: FAKE_CHANNEL_ID, grantedScope: FAKE_YT_ANALYTICS_SCOPE } },
      },
      "permission",
      "identity:youtube_scope_missing",
      1,
    ],
    [
      "a Google account without a channel",
      { channels: { brand: null } },
      "permission",
      "identity:no_channel",
      2,
    ],
    [
      "more than one channel",
      {
        channels: {
          brand: {
            channelId: FAKE_CHANNEL_ID,
            alsoOwns: { channelId: "UCsecondChannel00000000a" },
          },
        },
      },
      "data",
      "identity:multiple_channels",
      2,
    ],
  ])("fails closed with %s", async (_label, channels, kind, code, requests) => {
    setup(channels);
    const error = await rejection(exchange());
    expect([error.kind, error.providerCode]).toEqual([kind, code]);
    expect(fake.requests).toHaveLength(requests);
    expect(JSON.stringify(error)).not.toContain(FAKE_YT_TOKEN_MARKER);
  });

  it("stages channel API failures as identity errors", async () => {
    fake.failNext("channels", {
      status: 403,
      body: { error: { code: 403, errors: [{ reason: "accessNotConfigured" }] } },
    });
    const error = await rejection(exchange());
    expect([error.kind, error.providerCode]).toEqual(["unknown", "identity:accessNotConfigured"]);
  });

  it("refuses a reused code, a missing verifier and invalid configuration", async () => {
    const { spec, verifier, code } = await consent();
    await spec.exchangeCode({
      code,
      redirectUri: REDIRECT,
      codeVerifier: verifier,
      config: CONFIG,
      now: NOW,
    });
    const reused = await rejection(
      spec.exchangeCode({
        code,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
        config: CONFIG,
        now: NOW,
      }),
    );
    expect([reused.kind, reused.providerCode]).toEqual(["auth", "token_exchange:invalid_grant"]);
    fake.requests.length = 0;
    const noVerifier = await rejection(
      spec.exchangeCode({ code, redirectUri: REDIRECT, config: CONFIG, now: NOW }),
    );
    expect([noVerifier.kind, noVerifier.providerCode]).toEqual([
      "auth",
      "token_exchange:invalid_request",
    ]);
    const shared = await rejection(
      spec.exchangeCode({
        code,
        redirectUri: REDIRECT,
        codeVerifier: verifier,
        config: { ...CONFIG, extra: { googleAdsClientId: FAKE_YT_CLIENT_ID } },
        now: NOW,
      }),
    );
    expect([shared.kind, shared.providerCode]).toEqual([
      "unknown",
      "config:youtube_config_invalid",
    ]);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("revoke", () => {
  it("revokes the refresh token at Google with the token in the form body only", async () => {
    const { credential } = await exchange();
    fake.requests.length = 0;
    await createYouTubeOAuthSpec().revoke!(credential, CONFIG);
    expect(fake.requests).toHaveLength(1);
    const [request] = fake.requests;
    expect(`${request!.method} ${request!.host}${request!.path}`).toBe(
      "POST oauth2.googleapis.com/revoke",
    );
    expect(request!.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(request!.body).get("token")).toBe(credential.refreshToken);
    expect(fake.revokedUsers).toEqual(["brand"]);
    // The grant is gone: a refresh now fails.
    const after = await rejection(
      createYouTubeDiscovery(CONFIG).listAccounts({ credential, attempt: 1 }, {}),
    );
    expect([after.kind, after.providerCode]).toEqual(["auth", "invalid_grant"]);
  });

  it("treats an already revoked token as done and surfaces other failures", async () => {
    const { credential } = await exchange();
    fake.revoke("brand");
    await expect(createYouTubeOAuthSpec().revoke!(credential, CONFIG)).resolves.toBeUndefined();
    fake.failNext("revoke", { status: 503, body: {} });
    const outage = await rejection(createYouTubeOAuthSpec().revoke!(credential, CONFIG));
    expect([outage.kind, outage.providerCode]).toEqual(["transient", "revoke:http_503"]);
  });

  it("never revokes through or for the Google Ads client, and ignores foreign credentials", async () => {
    const { credential } = await exchange();
    fake.requests.length = 0;
    const spec = createYouTubeOAuthSpec();
    const shared = await rejection(
      spec.revoke!(credential, { ...CONFIG, extra: { googleAdsClientId: FAKE_YT_CLIENT_ID } }),
    );
    expect(shared.kind).toBe("unknown");
    const adsToken = await rejection(
      spec.revoke!(
        { ...credential, clientId: GOOGLE_ADS_CLIENT },
        { ...CONFIG, extra: { googleAdsClientId: GOOGLE_ADS_CLIENT } },
      ),
    );
    expect(adsToken.kind).toBe("unknown");
    await spec.revoke!({ kind: "google", refreshToken: "x" } as never, CONFIG);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("discovery", () => {
  it("returns the credential's channel from a fresh token: 2 requests", async () => {
    const { credential } = await exchange();
    fake.requests.length = 0;
    const page = await createYouTubeDiscovery(CONFIG).listAccounts({ credential, attempt: 1 }, {});
    expect(page).toEqual({
      items: [
        {
          platform: "youtube",
          externalId: FAKE_CHANNEL_ID,
          accountType: "channel",
        },
      ],
    });
    expect(fake.requests).toHaveLength(2);
  });

  it("fails closed for a channel no longer owned, a cursor, a foreign client and shared config", async () => {
    const { credential } = await exchange();
    const discovery = createYouTubeDiscovery(CONFIG);
    const moved = await rejection(
      discovery.listAccounts(
        { credential: { ...credential, channelId: "UCotherChannel000000000a" }, attempt: 1 },
        {},
      ),
    );
    expect([moved.kind, moved.providerCode]).toEqual(["permission", "account_mismatch"]);
    fake.requests.length = 0;
    const cursor = await rejection(
      discovery.listAccounts({ credential, attempt: 1 }, { cursor: "x" }),
    );
    expect(cursor.kind).toBe("invalid_request");
    const foreign = await rejection(
      discovery.listAccounts(
        { credential: { ...credential, clientId: GOOGLE_ADS_CLIENT }, attempt: 1 },
        {},
      ),
    );
    expect([foreign.kind, foreign.providerCode]).toEqual(["auth", "client_id_mismatch"]);
    const shared = await rejection(
      createYouTubeDiscovery({ ...CONFIG, googleAdsClientId: FAKE_YT_CLIENT_ID }).listAccounts(
        { credential, attempt: 1 },
        {},
      ),
    );
    expect([shared.kind, shared.providerCode]).toEqual(["unknown", "youtube_config_invalid"]);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("mock OAuth and discovery", () => {
  async function mockExchange(user: string) {
    const spec = createMockYouTubeOAuthSpec();
    const verifier = randomToken();
    const challenge = await pkceChallengeS256(verifier);
    return await spec.exchangeCode({
      code: mockYouTubeCode(challenge, user),
      redirectUri: REDIRECT,
      codeVerifier: verifier,
      config: {},
      now: NOW,
    });
  }

  it("issues mock credentials for the mock channel and reports the granted scopes", async () => {
    const grant = await mockExchange("1");
    expect(grant.identity.externalUserId).toBe(mockYouTubeChannelId("1"));
    expect(grant.grantedScopes).toEqual([...YOUTUBE_SCOPES]);
    expect((await mockExchange("limited")).grantedScopes).toEqual([FAKE_YT_READONLY_SCOPE]);
    const page = await createMockYouTubeDiscovery().listAccounts(
      { credential: grant.credential, attempt: 1 },
      {},
    );
    expect(page.items).toEqual([
      {
        platform: "youtube",
        externalId: mockYouTubeChannelId("1"),
        accountType: "channel",
      },
    ]);
  });

  it.each([
    ["norefresh", "auth", "token_exchange:no_refresh_token"],
    ["noyoutube", "permission", "identity:youtube_scope_missing"],
    ["nochannel", "permission", "identity:no_channel"],
  ])("fails the %s user like the real spec", async (user, kind, code) => {
    const error = await rejection(mockExchange(user));
    expect([error.kind, error.providerCode]).toEqual([kind, code]);
  });

  it("rejects a revoked mock credential at discovery", async () => {
    const grant = await mockExchange("revoked");
    const error = await rejection(
      createMockYouTubeDiscovery().listAccounts({ credential: grant.credential, attempt: 1 }, {}),
    );
    expect([error.kind, error.providerCode]).toEqual(["auth", "invalid_grant"]);
  });
});
