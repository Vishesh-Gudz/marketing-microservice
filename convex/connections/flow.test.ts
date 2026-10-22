import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { sha256Base64Url } from "../lib/crypto";
import {
  MOCK_INVALID_CODE,
  MOCK_UNAVAILABLE_CODE,
  mockAuthorizationCode,
} from "../providers/mock/oauth";
import {
  as,
  claimResult,
  connectMockInstagram,
  expectMarketingError,
  followCallback,
  ISSUER_ERP,
  linkMock,
  linkSocial,
  newBackend,
  redirectParams,
  registerAppWithReturnUrls,
  RETURN_URL,
  type Backend,
} from "../test.helpers";
import { MAX_PENDING_STATES_PER_ORG } from "./config";

afterEach(() => {
  vi.useRealTimers();
});

async function setup() {
  const t = newBackend();
  await registerAppWithReturnUrls(t, ISSUER_ERP, "erp");
  await as(t).mutation(api.v1.orgs.ensure, {});
  return t;
}

async function begin(
  t: Backend,
  provider: "meta" | "google_ads" = "meta",
  extra: { returnUrl?: string; reconnectConnectionId?: string } = {},
) {
  return await as(t).action(api.v1.connections.beginConnect, {
    provider,
    returnUrl: RETURN_URL,
    ...extra,
  });
}

/** Callback, then the claim by the same user (S2), as the dashboard does. */
async function complete(t: Backend, url: string) {
  return await claimResult(t, redirectParams(await followCallback(t, url)));
}

async function connect(t: Backend, provider: "meta" | "google_ads" = "meta") {
  const { authorizeUrl } = await begin(t, provider);
  const params = await complete(t, authorizeUrl);
  expect(params.get("status")).toBe("connected");
  return { connectionId: params.get("connection")!, authorizeUrl };
}

function withCode(url: string, code: string | null, extra: Record<string, string> = {}) {
  const parsed = new URL(url);
  if (code === null) parsed.searchParams.delete("code");
  else parsed.searchParams.set("code", code);
  for (const [k, v] of Object.entries(extra)) parsed.searchParams.set(k, v);
  return parsed.toString();
}

const states = (t: Backend) => t.run((ctx) => ctx.db.query("oauthStates").collect());
const connections = (t: Backend) => t.run((ctx) => ctx.db.query("connections").collect());
const audit = async (t: Backend) =>
  (
    await as(t).query(api.v1.audit.list, { paginationOpts: { numItems: 100, cursor: null } })
  ).page.map((e) => e.action);

describe("beginConnect", () => {
  it("returns an authorize URL to our callback and stores only a hash of the nonce", async () => {
    const t = await setup();
    const before = Date.now();
    const { authorizeUrl, expiresAt } = await begin(t);
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe(
      "https://marketing-tests.convex.site/oauth/callback",
    );
    const state = url.searchParams.get("state")!;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(expiresAt) - before).toBeGreaterThan(9 * 60_000);

    const [row] = await states(t);
    expect(row!.nonceHash).toBe(await sha256Base64Url(state));
    expect(JSON.stringify(row)).not.toContain(state);
    expect(row).toMatchObject({ status: "pending", provider: "meta", returnUrl: RETURN_URL });
    expect(row!.codeVerifier).toBeDefined();
    expect(await audit(t)).toContain("connection.oauth_started");
  });

  it("rejects return URLs outside the app allowlist", async () => {
    const t = await setup();
    for (const returnUrl of [
      "https://evil.test/",
      "https://app.example.test/admin",
      "javascript:alert(1)",
    ]) {
      await expectMarketingError(begin(t, "meta", { returnUrl }), "INVALID_ARGUMENT");
    }
  });

  it("caps pending attempts per org", async () => {
    const t = await setup();
    for (let i = 0; i < MAX_PENDING_STATES_PER_ORG; i++) await begin(t);
    await expectMarketingError(begin(t), "RATE_LIMITED");
  });

  it("rejects reconnect targets that do not belong to the caller", async () => {
    const t = await setup();
    await expectMarketingError(
      begin(t, "meta", { reconnectConnectionId: "not-an-id" }),
      "NOT_FOUND",
    );
  });
});

describe("OAuth callback", () => {
  it("creates an active connection with an encrypted credential and discovered assets", async () => {
    const t = await setup();
    const { connectionId } = await connect(t);
    const connection = await as(t).query(api.v1.connections.get, { connectionId });
    expect(connection).toMatchObject({
      provider: "meta",
      status: "active",
      missingScopes: [],
      expiresSoon: false,
    });
    expect(connection.tokenExpiresAt).toBeDefined();

    const stored = await t.run(async (ctx) => ({
      credentials: await ctx.db.query("credentials").collect(),
      assets: await ctx.db.query("discoveredAssets").collect(),
      states: await ctx.db.query("oauthStates").collect(),
    }));
    expect(stored.credentials).toHaveLength(1);
    expect(stored.credentials[0]!.algorithm).toBe("AES-256-GCM");
    expect(new TextDecoder("latin1").decode(stored.credentials[0]!.ciphertext)).not.toContain(
      "mock-token",
    );
    expect(stored.assets.map((a) => a.externalId).sort()).toEqual(["1001", "1002", "1003"]);
    expect(stored.states[0]!.status).toBe("consumed");
    expect(await audit(t)).toEqual(
      expect.arrayContaining([
        "connection.oauth_started",
        "connection.oauth_granted",
        "connection.connected",
        "connection.assets_discovered",
      ]),
    );
  });

  it("is single-use: a replayed callback is rejected without a redirect", async () => {
    const t = await setup();
    const { authorizeUrl } = await connect(t);
    const replay = await followCallback(t, authorizeUrl);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("location")).toBeNull();
    expect(await replay.text()).toContain("Connection failed");
    expect(await connections(t)).toHaveLength(1);
  });

  it("rejects unknown or missing state with a static page", async () => {
    const t = await setup();
    for (const path of ["/oauth/callback?state=forged&code=x", "/oauth/callback?code=x"]) {
      const response = await t.fetch(path, { method: "GET", redirect: "manual" });
      expect(response.status).toBe(200);
      expect(response.headers.get("location")).toBeNull();
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-security-policy")).toBe("default-src 'none'");
    }
    expect(await connections(t)).toHaveLength(0);
  });

  it("rejects expired states and redirects with expired_state", async () => {
    const t = await setup();
    const { authorizeUrl } = await begin(t);
    await t.run(async (ctx) => {
      for (const s of await ctx.db.query("oauthStates").collect())
        await ctx.db.patch(s._id, { expiresAt: Date.now() - 1 });
    });
    const params = redirectParams(await followCallback(t, authorizeUrl));
    expect(params.get("error")).toBe("expired_state");
    expect(await connections(t)).toHaveLength(0);
  });

  it("handles denied consent", async () => {
    const t = await setup();
    const { authorizeUrl } = await begin(t);
    const params = redirectParams(
      await followCallback(t, withCode(authorizeUrl, null, { error: "access_denied" })),
    );
    // Exactly these two parameters: no codes, tokens or messages.
    expect(params.toString()).toBe("status=error&error=access_denied");
    expect((await states(t))[0]!.status).toBe("failed");
    expect(await connections(t)).toHaveLength(0);
    expect(await audit(t)).toContain("connection.oauth_failed");
  });

  it.each([
    ["invalid code", MOCK_INVALID_CODE],
    ["unavailable token endpoint", MOCK_UNAVAILABLE_CODE],
    [
      "code issued for another PKCE challenge",
      mockAuthorizationCode("meta", "some-other-challenge"),
    ],
  ])("fails with exchange_failed on %s", async (_label, code) => {
    const t = await setup();
    const { authorizeUrl } = await begin(t);
    const params = redirectParams(await followCallback(t, withCode(authorizeUrl, code)));
    expect(params.get("error")).toBe("exchange_failed");
    expect(await connections(t)).toHaveLength(0);
  });

  it("rejects the callback if the app was disabled after beginConnect", async () => {
    const t = await setup();
    const { authorizeUrl } = await begin(t);
    await t.mutation(internal.admin.integrationApps.setStatus, {
      issuer: ISSUER_ERP,
      status: "disabled",
    });
    expect(redirectParams(await followCallback(t, authorizeUrl)).get("error")).toBe(
      "invalid_state",
    );
    expect(await connections(t)).toHaveLength(0);
  });

  it("fails closed when the encryption key is not configured", async () => {
    const t = await setup();
    const { authorizeUrl } = await begin(t);
    const saved = process.env.TOKEN_ENCRYPTION_KEYS;
    delete process.env.TOKEN_ENCRYPTION_KEYS;
    try {
      expect(redirectParams(await followCallback(t, authorizeUrl)).get("error")).toBe("internal");
    } finally {
      process.env.TOKEN_ENCRYPTION_KEYS = saved;
    }
    expect(await connections(t)).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("credentials").collect())).toHaveLength(0);
  });

  it("refuses a state without a return URL before any exchange (S2: nowhere to claim)", async () => {
    const t = await setup();
    const { authorizeUrl } = await begin(t, "google_ads");
    // A state created before returnUrl became required.
    await t.run(async (ctx) => {
      for (const s of await ctx.db.query("oauthStates").collect())
        await ctx.db.patch(s._id, { returnUrl: undefined });
    });
    const response = await followCallback(t, authorizeUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).toContain("Connection failed");
    expect((await states(t))[0]).toMatchObject({ status: "failed", failureCode: "invalid_state" });
    expect(await connections(t)).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("oauthGrants").collect())).toHaveLength(0);
  });

  it("keeps the connection but reports discovery failures", async () => {
    const t = await setup();
    const { authorizeUrl } = await begin(t);
    const challenge = new URL(authorizeUrl).searchParams.get("code_challenge")!;
    const params = await complete(
      t,
      withCode(authorizeUrl, mockAuthorizationCode("meta", challenge, "revoked")),
    );
    expect(params.get("status")).toBe("connected");
    expect(params.get("warning")).toBe("discovery_failed");
    const connection = await as(t).query(api.v1.connections.get, {
      connectionId: params.get("connection")!,
    });
    expect(connection.status).toBe("active");
    expect(connection.lastError).toMatchObject({
      kind: "auth",
      message: "The platform request failed",
    });
  });

  it("surfaces missing required scopes", async () => {
    const t = await setup();
    const { authorizeUrl } = await begin(t, "google_ads");
    const challenge = new URL(authorizeUrl).searchParams.get("code_challenge")!;
    const params = await complete(
      t,
      withCode(authorizeUrl, mockAuthorizationCode("google_ads", challenge, "limited")),
    );
    const connection = await as(t).query(api.v1.connections.get, {
      connectionId: params.get("connection")!,
    });
    expect(connection.missingScopes).toEqual(["https://www.googleapis.com/auth/adwords"]);
  });
});

describe("reconnect", () => {
  it("updates the same connection for the same identity", async () => {
    const t = await setup();
    const first = await connect(t);
    const second = await connect(t);
    expect(second.connectionId).toBe(first.connectionId);
    const [row] = await connections(t);
    expect(row!.credentialVersion).toBe(2);
    expect(await t.run((ctx) => ctx.db.query("credentials").collect())).toHaveLength(1);
    expect(await audit(t)).toContain("connection.reconnected");
  });

  it("refuses an explicit reconnect by a different identity", async () => {
    const t = await setup();
    const { connectionId } = await connect(t);
    const { authorizeUrl } = await begin(t, "meta", {
      returnUrl: RETURN_URL,
      reconnectConnectionId: connectionId,
    });
    const challenge = new URL(authorizeUrl).searchParams.get("code_challenge")!;
    const params = redirectParams(
      await followCallback(
        t,
        withCode(authorizeUrl, mockAuthorizationCode("meta", challenge, "2")),
      ),
    );
    expect(params.get("error")).toBe("identity_mismatch");
    expect(await connections(t)).toHaveLength(1);
  });

  it("reactivates a needs_reauth connection", async () => {
    const t = await setup();
    const { connectionId } = await connect(t);
    await t.mutation(internal.connections.lifecycle.markNeedsReauth, {
      connectionId: connectionId as Id<"connections">,
      reason: "test",
      actorSubject: "test",
    });
    expect((await as(t).query(api.v1.connections.get, { connectionId })).status).toBe(
      "needs_reauth",
    );
    await connect(t);
    expect((await as(t).query(api.v1.connections.get, { connectionId })).status).toBe("active");
  });
});

describe("lifecycle", () => {
  it("disconnect revokes, unlinks accounts, drops assets and deletes the credential", async () => {
    vi.useFakeTimers();
    const t = await setup();
    const { connectionId } = await connect(t);
    await as(t).mutation(api.v1.connections.linkAdAccounts, {
      connectionId,
      externalIds: ["1001"],
    });

    const result = await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    expect(result.status).toBe("revoked");
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const snapshot = await t.run(async (ctx) => ({
      credentials: await ctx.db.query("credentials").collect(),
      assets: await ctx.db.query("discoveredAssets").collect(),
      accounts: await ctx.db.query("adAccounts").collect(),
    }));
    expect(snapshot.credentials).toHaveLength(0);
    expect(snapshot.assets).toHaveLength(0);
    expect(snapshot.accounts).toHaveLength(1);
    expect(snapshot.accounts[0]!.connectionId).toBeUndefined();
    expect(await audit(t)).toEqual(
      expect.arrayContaining([
        "connection.disconnected",
        "adAccount.unlinked",
        "credential.deleted",
      ]),
    );
    // Disconnect is idempotent.
    expect((await as(t).mutation(api.v1.connections.disconnect, { connectionId })).status).toBe(
      "revoked",
    );
  });

  it("disconnecting Google Ads leaves the org's Meta and Instagram connections untouched", async () => {
    vi.useFakeTimers();
    const t = await setup();
    const google = await connect(t, "google_ads");
    const meta = await connect(t, "meta");
    const instagram = (await connectMockInstagram(t)).get("connection")!;
    await linkMock(t, google.connectionId, ["1112223333"]);
    await linkMock(t, meta.connectionId, ["1001"]);
    const [igAsset] = await as(t).query(api.v1.connections.listDiscoveredSocialAccounts, {
      connectionId: instagram,
    });
    await linkSocial(t, instagram, [igAsset!.externalId]);
    const before = await t.run(async (ctx) => ({
      credentials: (await ctx.db.query("credentials").collect()).map((c) => c._id),
      socialAssets: await ctx.db.query("discoveredSocialAccounts").collect(),
    }));

    await as(t).mutation(api.v1.connections.disconnect, { connectionId: google.connectionId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const status = Object.fromEntries((await connections(t)).map((c) => [c.provider, c.status]));
    expect(status).toEqual({ google_ads: "revoked", meta: "active", instagram: "active" });
    const accounts = await as(t).query(api.v1.adAccounts.list, {});
    expect(accounts.map((a) => [a.platform, a.linked, a.connectionId ?? null])).toEqual(
      expect.arrayContaining([
        ["google_ads", false, null],
        ["meta", true, meta.connectionId],
      ]),
    );
    const social = await as(t).query(api.v1.socialAccounts.list, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(social.page.map((s) => [s.linked, s.connectionId])).toEqual([[true, instagram]]);
    const after = await t.run(async (ctx) => ({
      credentials: (await ctx.db.query("credentials").collect()).map((c) => c._id),
      socialAssets: await ctx.db.query("discoveredSocialAccounts").collect(),
    }));
    // Only the Google credential is gone; Instagram discovery is kept as it was.
    expect(after.credentials).toHaveLength(2);
    expect(before.credentials).toEqual(expect.arrayContaining(after.credentials));
    expect(after.socialAssets).toEqual(before.socialAssets);
  });

  it("refreshAssets re-runs discovery; inactive connections are refused", async () => {
    vi.useFakeTimers();
    const t = await setup();
    const { connectionId } = await connect(t);
    await t.run(async (ctx) => {
      for (const a of await ctx.db.query("discoveredAssets").collect()) await ctx.db.delete(a._id);
    });
    await as(t).mutation(api.v1.connections.refreshAssets, { connectionId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(
      await as(t).query(api.v1.connections.listDiscoveredAssets, { connectionId }),
    ).toHaveLength(3);

    await t.mutation(internal.connections.lifecycle.markNeedsReauth, {
      connectionId: connectionId as Id<"connections">,
      reason: "test",
      actorSubject: "test",
    });
    await expectMarketingError(
      as(t).mutation(api.v1.connections.refreshAssets, { connectionId }),
      "CONFLICT",
    );
  });

  it("never decrypts credentials of inactive connections", async () => {
    const t = await setup();
    const { connectionId } = await connect(t);
    await t.mutation(internal.connections.lifecycle.markNeedsReauth, {
      connectionId: connectionId as Id<"connections">,
      reason: "test",
      actorSubject: "test",
    });
    await t.run(async (ctx) => {
      for (const a of await ctx.db.query("discoveredAssets").collect()) await ctx.db.delete(a._id);
    });
    await t.action(internal.connections.oauthFlow.runDiscovery, {
      connectionId: connectionId as Id<"connections">,
      actorSubject: "test",
    });
    expect(await t.run((ctx) => ctx.db.query("discoveredAssets").collect())).toHaveLength(0);
    expect((await as(t).query(api.v1.connections.get, { connectionId })).lastError?.kind).toBe(
      "internal",
    );
  });

  it("health sweep: expires states and grants, flags expired tokens, deletes revoked credentials", async () => {
    const t = await setup();
    const { connectionId } = await connect(t);
    await begin(t); // leaves a pending state
    // Leaves an unclaimed grant (consent completed, never claimed).
    const { authorizeUrl } = await begin(t);
    expect(redirectParams(await followCallback(t, authorizeUrl)).get("status")).toBe("pending");
    await t.run(async (ctx) => {
      for (const s of await ctx.db.query("oauthStates").collect())
        await ctx.db.patch(s._id, { expiresAt: Date.now() - 2 * 3_600_000 });
      for (const g of await ctx.db.query("oauthGrants").collect())
        await ctx.db.patch(g._id, { expiresAt: Date.now() - 1 });
      await ctx.db.patch(connectionId as Id<"connections">, { tokenExpiresAt: Date.now() - 1 });
    });
    const first = await t.mutation(internal.connections.maintenance.sweep, {});
    expect(first).toMatchObject({ statesDeleted: 3, grantsDeleted: 1, expired: 1 });
    expect(await t.run((ctx) => ctx.db.query("oauthGrants").collect())).toHaveLength(0);
    expect(await audit(t)).toContain("connection.grant_expired");
    expect((await as(t).query(api.v1.connections.get, { connectionId })).status).toBe(
      "needs_reauth",
    );

    // Backstop: a revoked connection that still has a credential.
    await t.run((ctx) => ctx.db.patch(connectionId as Id<"connections">, { status: "revoked" }));
    const second = await t.mutation(internal.connections.maintenance.sweep, {});
    expect(second.credentialsDeleted).toBe(1);
    expect(await t.run((ctx) => ctx.db.query("credentials").collect())).toHaveLength(0);
  });
});
