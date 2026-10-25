import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { mockYouTubeChannelId } from "../providers/social/mock/youtubeData";
import {
  createFakeYouTube,
  FAKE_CHANNEL_ID,
  FAKE_YT_ANALYTICS_SCOPE,
  FAKE_YT_CLIENT_ID,
  FAKE_YT_CLIENT_SECRET,
  FAKE_YT_CODE_MARKER,
  FAKE_YT_READONLY_SCOPE,
  FAKE_YT_TOKEN_MARKER,
  fakeVideos,
  type FakeChannel,
  type FakeYouTube,
} from "../providers/youtube/fakeYouTube.fixtures";
import schema from "../schema";
import {
  as,
  connectMockYouTube,
  connectYouTubeFake,
  drainScheduler,
  expectMarketingError,
  ISSUER_CRM,
  linkMock,
  linkSocial,
  newBackend,
  planAndDrain,
  RETURN_URL,
  setupSyncOrg,
  stubLiveYouTube,
  type Backend,
} from "../test.helpers";
import { TOKEN_REFRESH_PROVIDERS } from "./tokenRefresh";

// ADR 0016, Checkpoint 2, end to end on convex-test: the REAL connect flow with the YouTube
// OAuthSpec + default-runtime discovery (PROVIDER_MODE=live) against the fake Google API, the
// discoveredSocialAccounts -> socialAccounts link path, the credential lifecycle (needs_reauth,
// disconnect with revocation at Google), tenant isolation, Google Ads isolation and leak scans.
// The fake models documented behavior only (not real-channel evidence).

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-10-20T12:00:00Z");
const CRM = { issuer: ISSUER_CRM };
const OTHER_CHANNEL = "UCotherChannel000000000a";

const BRAND: FakeChannel = {
  channelId: FAKE_CHANNEL_ID,
  title: "Fake Brand",
  customUrl: "@fakebrand",
  subscriberCount: "12300",
  videos: fakeVideos(3, "2026-10-19T10:00:00Z"),
};

let fake: FakeYouTube;
function fakeWith(channels: Record<string, FakeChannel | null> = {}) {
  fake = createFakeYouTube({
    channels: {
      brand: BRAND,
      other: { channelId: OTHER_CHANNEL, title: "Other" },
      analyticsUnticked: { ...BRAND, grantedScope: FAKE_YT_READONLY_SCOPE },
      noRefresh: { ...BRAND, omitRefreshToken: true },
      youtubeUnticked: { ...BRAND, grantedScope: FAKE_YT_ANALYTICS_SCOPE },
      noChannel: null,
      ...channels,
    },
  });
  return fake;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fakeWith();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function allRows(t: Backend) {
  return await t.run(async (ctx) => {
    const out: Record<string, unknown[]> = {};
    for (const table of Object.keys(schema.tables) as (keyof typeof schema.tables)[]) {
      out[table] = await ctx.db.query(table).collect();
    }
    out._scheduled = await ctx.db.system.query("_scheduled_functions").collect();
    return out;
  });
}

/**
 * Secrets that must never appear anywhere outside the encrypted credential blob: token values,
 * codes, the client secret, token fields or parameters, API URLs and unstored payload parts.
 * (Granted scope strings are https://www.googleapis.com/auth/... values and are stored on
 * purpose; the diagnostic code no_refresh_token is not a token.)
 */
const SECRET_MARKERS = [
  FAKE_YT_TOKEN_MARKER,
  FAKE_YT_CODE_MARKER,
  FAKE_YT_CLIENT_SECRET,
  '"access_token"',
  '"refresh_token"',
  "access_token=",
  "refresh_token=",
  "client_secret",
  "code_verifier=",
  "oauth2.googleapis.com",
  "googleapis.com/youtube/",
  "never stored",
  "ytimg",
  "yt3.",
];

function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
  for (const marker of SECRET_MARKERS) expect(text, marker).not.toContain(marker);
}

async function auditActions(t: Backend) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("auditLog").collect()).map((e) => ({
      action: e.action,
      changes: e.changes,
    })),
  );
}

async function connectedBrand(t: Backend, who = {}) {
  await setupSyncOrg(t, who);
  const params = await connectYouTubeFake(t, fake, "brand", who);
  expect(params.get("status"), params.get("error") ?? "").toBe("connected");
  return params.get("connection")!;
}

describe("YouTube connect flow (live, fake API)", () => {
  it("beginConnect builds a Google consent URL with PKCE and stores only the nonce hash", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
      provider: "youtube",
      returnUrl: RETURN_URL,
    });
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(FAKE_YT_CLIENT_ID);
    expect(url.searchParams.get("scope")).toBe(
      `${FAKE_YT_READONLY_SCOPE} ${FAKE_YT_ANALYTICS_SCOPE}`,
    );
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("redirect_uri")).toMatch(/\/oauth\/callback$/);
    expect(authorizeUrl).not.toContain(FAKE_YT_CLIENT_SECRET);
    const states = await t.run((ctx) => ctx.db.query("oauthStates").collect());
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({ provider: "youtube", status: "pending" });
    expect(states[0]!.codeVerifier).toMatch(/\S/);
    expect(JSON.stringify(states)).not.toContain(url.searchParams.get("state")!);
    expect(fake.requests).toHaveLength(0);
  });

  it("connects, encrypts the refresh token and discovers the channel of the consent", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const connectionId = await connectedBrand(t);

    const rows = await allRows(t);
    expect(rows.connections).toHaveLength(1);
    expect(rows.connections![0]).toMatchObject({
      provider: "youtube",
      externalUserId: FAKE_CHANNEL_ID,
      status: "active",
      grantedScopes: [FAKE_YT_READONLY_SCOPE, FAKE_YT_ANALYTICS_SCOPE],
      credentialVersion: 1,
    });
    expect(rows.connections![0]).not.toHaveProperty("tokenExpiresAt");
    // ADR 0016 (Checkpoint 3b): no channel title or handle on rows that outlive the data.
    expect(rows.connections![0]).not.toHaveProperty("displayName");
    expect(rows.credentials).toHaveLength(1);
    expect(rows.oauthGrants).toEqual([]);
    expect(rows.discoveredSocialAccounts).toHaveLength(1);
    expect(rows.discoveredSocialAccounts![0]).toMatchObject({
      platform: "youtube",
      externalId: FAKE_CHANNEL_ID,
      accountType: "channel",
    });
    expect(rows.discoveredSocialAccounts![0]).not.toHaveProperty("username");
    expect(rows.discoveredAssets).toEqual([]); // never ad-account discovery
    expect(rows.socialAccounts).toEqual([]); // discovery alone links nothing
    expectNoSecrets(rows);

    const dto = await as(t).query(api.v1.connections.get, { connectionId });
    expect(dto).toMatchObject({ provider: "youtube", status: "active", missingScopes: [] });
    expectNoSecrets(dto);
    // token exchange + channel identity; then discovery: token + channel
    expect(fake.requests.map((r) => r.path)).toEqual([
      "/token",
      "/youtube/v3/channels",
      "/token",
      "/youtube/v3/channels",
    ]);
    for (const request of fake.requests) {
      expect(request.url).not.toMatch(new RegExp(`${FAKE_YT_TOKEN_MARKER}|${FAKE_YT_CODE_MARKER}`));
    }
  });

  it("connects without the analytics scope and reports it missing (granular consent)", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectYouTubeFake(t, fake, "analyticsUnticked");
    expect(params.get("status")).toBe("connected");
    const dto = await as(t).query(api.v1.connections.get, {
      connectionId: params.get("connection")!,
    });
    expect(dto.grantedScopes).toEqual([FAKE_YT_READONLY_SCOPE]);
    expect(dto.missingScopes).toEqual([FAKE_YT_ANALYTICS_SCOPE]);
  });

  it.each([
    [
      "no refresh token",
      "noRefresh",
      { failureKind: "auth", failureStage: "token_exchange", providerCode: "no_refresh_token" },
    ],
    [
      "youtube.readonly unticked",
      "youtubeUnticked",
      {
        failureKind: "permission",
        failureStage: "identity",
        providerCode: "youtube_scope_missing",
      },
    ],
    [
      "a Google account without a channel",
      "noChannel",
      { failureKind: "permission", failureStage: "identity", providerCode: "no_channel" },
    ],
  ] as const)(
    "fails closed on %s with sanitized D28b diagnostics",
    async (_label, user, expected) => {
      stubLiveYouTube(fake);
      const t = newBackend();
      await setupSyncOrg(t);
      const params = await connectYouTubeFake(t, fake, user);
      expect(params.get("status")).toBe("error");
      expect(params.get("error")).toBe("exchange_failed");
      const rows = await allRows(t);
      expect(rows.connections).toEqual([]);
      expect(rows.credentials).toEqual([]);
      expect(rows.oauthGrants).toEqual([]);
      const failed = (await auditActions(t)).find((e) => e.action === "connection.oauth_failed");
      expect(failed?.changes).toEqual({
        failureKind: { from: null, to: expected.failureKind },
        failureStage: { from: null, to: expected.failureStage },
        providerCode: { from: null, to: expected.providerCode },
        reason: { from: null, to: "exchange_failed" },
      });
      expectNoSecrets(rows);
    },
  );

  it("rejects denied consent, replayed, unknown and expired states", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const begin = async () =>
      new URL(
        (
          await as(t).action(api.v1.connections.beginConnect, {
            provider: "youtube",
            returnUrl: RETURN_URL,
          })
        ).authorizeUrl,
      ).searchParams;
    const call = (query: string) =>
      t.fetch(`/oauth/callback?${query}`, { method: "GET", redirect: "manual" });
    const errorOf = (response: Response) =>
      new URL(response.headers.get("location")!).searchParams.get("error");

    const denied = await begin();
    const deniedResponse = await call(`state=${denied.get("state")}&error=access_denied`);
    expect(errorOf(deniedResponse)).toBe("access_denied");
    // A replayed state is unknown: static failure page, the return URL is not revealed.
    const code = fake.issueCode(
      "brand",
      denied.get("code_challenge")!,
      denied.get("redirect_uri")!,
    );
    const replay = await call(`state=${denied.get("state")}&code=${code}`);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("location")).toBeNull();
    expect(await replay.text()).toContain("Connection failed");
    const unknown = await call(`state=not-a-state&code=${code}`);
    expect(unknown.headers.get("location")).toBeNull();

    const late = await begin();
    vi.setSystemTime(NOW.getTime() + 11 * 60_000); // past the 10-minute state TTL
    const lateCode = fake.issueCode(
      "brand",
      late.get("code_challenge")!,
      late.get("redirect_uri")!,
    );
    expect(errorOf(await call(`state=${late.get("state")}&code=${lateCode}`))).toBe(
      "expired_state",
    );

    expect(fake.requests).toHaveLength(0); // no exchange ever reached Google
    expect(await t.run((ctx) => ctx.db.query("connections").collect())).toEqual([]);
  });

  it("cannot connect YouTube unconfigured or through the Google Ads OAuth client", async () => {
    vi.stubEnv("PROVIDER_MODE", "live");
    vi.stubGlobal("fetch", fake.fetch);
    const t = newBackend();
    await setupSyncOrg(t);
    const begin = () =>
      as(t).action(api.v1.connections.beginConnect, { provider: "youtube", returnUrl: RETURN_URL });
    await expectMarketingError(begin(), "INVALID_ARGUMENT");
    stubLiveYouTube(fake, {
      GOOGLE_CLIENT_ID: FAKE_YT_CLIENT_ID,
      GOOGLE_CLIENT_SECRET: "fake-google-ads-secret-1",
    });
    await expectMarketingError(begin(), "INVALID_ARGUMENT");
    expect(await t.run((ctx) => ctx.db.query("oauthStates").collect())).toEqual([]);
    expect(fake.requests).toHaveLength(0);
  });

  it("reconnecting a different channel into a connection is an identity mismatch", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const connectionId = await connectedBrand(t);
    const mismatch = await connectYouTubeFake(
      t,
      fake,
      "other",
      {},
      {
        reconnectConnectionId: connectionId,
      },
    );
    expect(mismatch.get("error")).toBe("identity_mismatch");
    const again = await connectYouTubeFake(
      t,
      fake,
      "brand",
      {},
      {
        reconnectConnectionId: connectionId,
      },
    );
    expect(again.get("status")).toBe("connected");
    const connections = await t.run((ctx) => ctx.db.query("connections").collect());
    expect(connections).toHaveLength(1);
    expect(connections[0]!.credentialVersion).toBe(2);
  });

  it("is isolated from Google Ads: no Google Ads connection, client or token is touched", async () => {
    stubLiveYouTube(fake, {
      GOOGLE_CLIENT_ID: "200000000002-fakeadsclient.apps.googleusercontent.com",
    });
    const t = newBackend();
    await connectedBrand(t);
    const rows = await allRows(t);
    expect((rows.connections as { provider: string }[]).map((c) => c.provider)).toEqual([
      "youtube",
    ]);
    for (const request of fake.requests) {
      if (request.body !== undefined) {
        expect(new URLSearchParams(request.body).get("client_id")).toBe(FAKE_YT_CLIENT_ID);
      }
    }
  });
});

describe("linking and lifecycle", () => {
  it("links the channel through the canonical write path and syncs its metadata", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const connectionId = await connectedBrand(t);
    const discovered = await as(t).query(api.v1.connections.listDiscoveredSocialAccounts, {
      connectionId,
    });
    expect(discovered).toEqual([
      {
        externalId: FAKE_CHANNEL_ID,
        platform: "youtube",
        accountType: "channel",
        linked: false,
        discoveredAt: NOW.toISOString(),
      },
    ]);
    const [account] = await linkSocial(t, connectionId, [FAKE_CHANNEL_ID]);
    expect(account).toMatchObject({
      platform: "youtube",
      externalId: FAKE_CHANNEL_ID,
      accountType: "channel",
      status: "active",
      linked: true,
      connectionId,
    });
    const state = await t.run((ctx) => ctx.db.query("syncAccounts").collect());
    expect(state).toHaveLength(1);
    expect(state[0]!.socialAccountId).toBe(account!.id);
    // An ad account can never be linked through a YouTube connection.
    await expectMarketingError(linkMock(t, connectionId, [FAKE_CHANNEL_ID]), "NOT_FOUND");

    await planAndDrain(t);
    const synced = await t.run(async (ctx) => ({
      account: await ctx.db.query("socialAccounts").first(),
      posts: await ctx.db.query("socialPosts").collect(),
    }));
    expect(synced.account).toMatchObject({ name: "Fake Brand", followersCount: 12_300 });
    expect(synced.posts).toHaveLength(3);
    expectNoSecrets(await allRows(t));
  });

  it("a credential revoked at Google moves the connection to needs_reauth on the next sync", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const connectionId = await connectedBrand(t);
    await linkSocial(t, connectionId, [FAKE_CHANNEL_ID]);
    fake.revoke("brand"); // the user removed access in their Google account
    await planAndDrain(t);
    const connection = await t.run((ctx) => ctx.db.query("connections").first());
    expect(connection).toMatchObject({ status: "needs_reauth" });
    const run = await t.run((ctx) => ctx.db.query("syncRuns").first());
    expect(run).toMatchObject({ status: "failed", error: { kind: "auth", code: "invalid_grant" } });
    expect((await auditActions(t)).map((e) => e.action)).toContain("connection.needs_reauth");
    expectNoSecrets(await allRows(t));

    // Reconnecting the same channel makes it active again.
    const again = await connectYouTubeFake(
      t,
      fake,
      "brand",
      {},
      { reconnectConnectionId: connectionId },
    );
    expect(again.get("status")).toBe("connected");
    expect((await t.run((ctx) => ctx.db.query("connections").first()))!.status).toBe("active");
  });

  it("disconnect revokes the token at Google, purges the channel and deletes the credential", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const connectionId = await connectedBrand(t);
    await linkSocial(t, connectionId, [FAKE_CHANNEL_ID]);
    fake.requests.length = 0;

    const disconnected = await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    expect(disconnected.status).toBe("revoked");
    await drainScheduler(t);

    expect(fake.revokedUsers).toEqual(["brand"]);
    const revoke = fake.requests.find((r) => r.path === "/revoke")!;
    expect(revoke.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(new URLSearchParams(revoke.body).get("token")).toContain(
      `${FAKE_YT_TOKEN_MARKER}-refresh-brand`,
    );
    const rows = await allRows(t);
    expect(rows.credentials).toEqual([]);
    expect(rows.discoveredSocialAccounts).toEqual([]);
    // ADR 0016 (Checkpoint 3b): the channel row and its data are deleted (youtubeRetention.test.ts).
    expect(rows.socialAccounts).toEqual([]);
    const actions = (await auditActions(t)).map((e) => e.action);
    expect(actions).toContain("connection.disconnected");
    expect(actions).toContain("credential.deleted");
    expectNoSecrets(rows);
  });

  it("the credential is deleted even when the revocation fails at Google", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const connectionId = await connectedBrand(t);
    fake.failNext("revoke", { status: 503, body: {} });
    await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    await drainScheduler(t);
    expect(await t.run((ctx) => ctx.db.query("credentials").collect())).toEqual([]);
  });

  it("is never refreshed by the token refresh job (access tokens are minted per call)", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await connectedBrand(t);
    expect(TOKEN_REFRESH_PROVIDERS).not.toContain("youtube");
    expect(
      await t.query(internal.connections.tokenRefresh.refreshCandidates, { now: Date.now() }),
    ).toEqual([]);
    fake.requests.length = 0;
    expect(await t.action(internal.connections.tokenRefresh.refreshExpiringTokens, {})).toEqual({
      refreshed: 0,
      superseded: 0,
      skipped: 0,
      reauth: 0,
      failed: 0,
    });
    expect(fake.requests).toHaveLength(0);
  });

  it("is admin-only and tenant-isolated", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const connectionId = await connectedBrand(t);
    const [account] = await linkSocial(t, connectionId, [FAKE_CHANNEL_ID]);
    await setupSyncOrg(t, CRM);

    await expectMarketingError(
      as(t, { role: "viewer" }).mutation(api.v1.connections.disconnect, { connectionId }),
      "FORBIDDEN",
    );
    await expectMarketingError(
      as(t, CRM).query(api.v1.connections.get, { connectionId }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t, CRM).query(api.v1.connections.listDiscoveredSocialAccounts, { connectionId }),
      "NOT_FOUND",
    );
    await expectMarketingError(linkSocial(t, connectionId, [FAKE_CHANNEL_ID], CRM), "NOT_FOUND");
    await expectMarketingError(
      as(t, CRM).mutation(api.v1.connections.unlinkSocialAccount, { socialAccountId: account!.id }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t, CRM).mutation(api.v1.connections.disconnect, { connectionId }),
      "NOT_FOUND",
    );
  });

  it("a consent can only be claimed by its initiator in its org", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    await setupSyncOrg(t, CRM);
    const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
      provider: "youtube",
      returnUrl: RETURN_URL,
    });
    const params = new URL(authorizeUrl).searchParams;
    const code = fake.issueCode(
      "brand",
      params.get("code_challenge")!,
      params.get("redirect_uri")!,
    );
    const response = await t.fetch(
      `/oauth/callback?state=${encodeURIComponent(params.get("state")!)}&code=${encodeURIComponent(code)}`,
      { method: "GET", redirect: "manual" },
    );
    const claim = new URL(response.headers.get("location")!).searchParams.get("claim")!;
    await expectMarketingError(
      as(t, CRM).action(api.v1.connections.completeConnect, { claim }),
      "NOT_FOUND",
    );
    // The refused presentation invalidated the grant for good.
    await expectMarketingError(
      as(t).action(api.v1.connections.completeConnect, { claim }),
      "NOT_FOUND",
    );
    expect(await t.run((ctx) => ctx.db.query("connections").collect())).toEqual([]);
    expectNoSecrets(await allRows(t));
  });
});

describe("mock mode", () => {
  it("connects and links a mock channel without any live credential", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectMockYouTube(t, "1");
    expect(params.get("status")).toBe("connected");
    const connectionId = params.get("connection")!;
    const [account] = await linkSocial(t, connectionId, [mockYouTubeChannelId("1")]);
    expect(account).toMatchObject({ platform: "youtube", accountType: "channel", linked: true });
    await planAndDrain(t);
    expect((await t.run((ctx) => ctx.db.query("socialPosts").collect())).length).toBeGreaterThan(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["limited", "connected", undefined],
    ["nochannel", "error", "exchange_failed"],
    ["norefresh", "error", "exchange_failed"],
  ])("mock user %s: %s", async (user, status, error) => {
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectMockYouTube(t, user);
    expect(params.get("status")).toBe(status);
    expect(params.get("error") ?? undefined).toBe(error);
    if (user === "limited") {
      const dto = await as(t).query(api.v1.connections.get, {
        connectionId: params.get("connection")!,
      });
      expect(dto.missingScopes).toEqual([FAKE_YT_ANALYTICS_SCOPE]);
    }
  });

  it("a revoked mock credential reports discovery_failed and keeps the connection", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectMockYouTube(t, "revoked");
    expect(params.get("status")).toBe("connected");
    expect(params.get("warning")).toBe("discovery_failed");
  });
});
