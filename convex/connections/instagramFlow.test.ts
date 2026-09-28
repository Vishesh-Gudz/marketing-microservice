import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  createFakeInstagram,
  FAKE_IG_APP_SECRET,
  FAKE_IG_CODE_MARKER,
  FAKE_IG_TOKEN_MARKER,
  type FakeInstagram,
} from "../providers/instagram/fakeInstagram.fixtures";
import { mockInstagramAccountId } from "../providers/social/mock";
import schema from "../schema";
import {
  as,
  connectInstagramFake,
  connectMock,
  connectMockInstagram,
  drainScheduler,
  expectMarketingError,
  ISSUER_CRM,
  linkMock,
  linkSocial,
  newBackend,
  planAndDrain,
  RETURN_URL,
  setupSyncOrg,
  stubLiveInstagram,
  type Backend,
} from "../test.helpers";

// Phase 10 Stage A, end to end on convex-test: the REAL connect flow with the Instagram
// OAuthSpec + SDK-free discovery (PROVIDER_MODE=live) against the fake Instagram API, the
// discoveredSocialAccounts -> socialAccounts link path, lifecycle, tenant isolation and
// leak scans. The fake models documented behavior only (not real-account evidence).

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-09-28T12:00:00Z");
const CRM = { issuer: ISSUER_CRM };

let fake: FakeInstagram;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = createFakeInstagram();
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

/** Secrets that must never appear anywhere outside the encrypted credential blob. */
const SECRET_MARKERS = [
  FAKE_IG_TOKEN_MARKER,
  FAKE_IG_CODE_MARKER,
  FAKE_IG_APP_SECRET,
  "access_token",
  "client_secret",
  "graph.instagram.com",
  "api.instagram.com",
  "Fake error",
  "FakeTraceId",
  "biography",
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

describe("Instagram connect flow (live, fake API)", () => {
  it("beginConnect builds an Instagram Login URL without PKCE and stores only the nonce hash", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
      provider: "instagram",
      returnUrl: RETURN_URL,
    });
    const url = new URL(authorizeUrl);
    expect(`${url.origin}${url.pathname}`).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_insights",
    );
    expect(url.searchParams.get("code_challenge")).toBeNull();
    const states = await t.run((ctx) => ctx.db.query("oauthStates").collect());
    expect(states).toHaveLength(1);
    expect(states[0]!.provider).toBe("instagram");
    expect(states[0]!.codeVerifier).toBeUndefined();
    expect(JSON.stringify(states)).not.toContain(url.searchParams.get("state")!);
  });

  it("connects, encrypts the long-lived token and discovers the account from the identity", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectInstagramFake(t, fake, "business");
    expect(params.get("status")).toBe("connected");
    expect(params.get("warning")).toBeNull();

    const user = fake.users.business!;
    const rows = await allRows(t);
    expect(rows.connections).toHaveLength(1);
    expect(rows.connections![0]).toMatchObject({
      provider: "instagram",
      externalUserId: user.userId,
      displayName: user.username,
      status: "active",
      grantedScopes: ["instagram_business_basic", "instagram_business_manage_insights"],
      tokenExpiresAt: NOW.getTime() + 5_184_000_000,
      credentialVersion: 1,
    });
    expect(rows.discoveredSocialAccounts).toHaveLength(1);
    expect(rows.discoveredSocialAccounts![0]).toMatchObject({
      platform: "instagram",
      externalId: user.userId,
      username: user.username,
      accountType: "business",
    });
    expect(rows.discoveredAssets).toEqual([]); // never ad-account discovery
    expect(rows.socialAccounts).toEqual([]); // discovery alone links nothing

    // Plaintext never reaches the database: only ciphertext, and no secret anywhere else.
    const credentials = await t.run((ctx) => ctx.db.query("credentials").collect());
    expect(new TextDecoder("latin1").decode(credentials[0]!.ciphertext)).not.toContain(
      FAKE_IG_TOKEN_MARKER,
    );
    const { credentials: _ciphertext, ...rest } = rows;
    expectNoSecrets(rest);

    // 3 OAuth requests (code, long-lived, identity) + 1 discovery request (/me).
    expect(fake.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
      "POST /oauth/access_token",
      "GET /access_token",
      "GET /v25.0/me",
      "GET /v25.0/me",
    ]);
    expect((await auditActions(t)).map((e) => e.action)).toEqual([
      "org.provisioned",
      "connection.oauth_started",
      "connection.connected",
      "connection.assets_discovered",
    ]);
  });

  it.each([
    [
      "an unsupported (personal) account",
      "personal",
      undefined,
      {
        failureKind: "permission",
        failureStage: "identity",
        providerCode: "account_type_unsupported",
      },
    ],
    [
      "an invalid code",
      "business",
      "code_exchange",
      { failureKind: "auth", failureStage: "token_exchange", providerCode: "400" },
    ],
    [
      "an expired short-lived token",
      "business",
      "long_lived_exchange",
      { failureKind: "auth", failureStage: "long_lived_exchange", providerCode: "190" },
    ],
  ] as const)(
    "fails closed on %s with sanitized D28b diagnostics",
    async (_label, user, route, expected) => {
      stubLiveInstagram(fake);
      if (route === "code_exchange") {
        fake.fail(route, {
          status: 400,
          body: { error_type: "OAuthException", code: 400, error_message: "Fake error" },
        });
      } else if (route === "long_lived_exchange") {
        fake.fail(route, {
          status: 400,
          body: { error: { code: 190, message: "Fake error", fbtrace_id: "FakeTraceId" } },
        });
      }
      const t = newBackend();
      await setupSyncOrg(t);
      const params = await connectInstagramFake(t, fake, user);
      expect(params.get("status")).toBe("error");
      expect(params.get("error")).toBe("exchange_failed");
      const rows = await allRows(t);
      expect(rows.connections).toEqual([]);
      expect(rows.credentials).toEqual([]);
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

  it("rejects replayed states and denied consent", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
      provider: "instagram",
      returnUrl: RETURN_URL,
    });
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const call = (query: string) =>
      t.fetch(`/oauth/callback?${query}`, { method: "GET", redirect: "manual" });
    const denied = await call(`state=${state}&error=access_denied`);
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe(
      "access_denied",
    );
    // A replayed state is unknown: static failure page, the return URL is not revealed.
    const replay = await call(`state=${state}&code=${fake.issueCode()}`);
    expect(replay.status).toBe(200);
    expect(replay.headers.get("location")).toBeNull();
    expect(await replay.text()).toContain("Connection failed");
    expect(fake.requests).toHaveLength(0);
  });

  it("cannot connect Instagram when it is not configured (live mode)", async () => {
    vi.stubEnv("PROVIDER_MODE", "live");
    vi.stubGlobal("fetch", fake.fetch);
    const t = newBackend();
    await setupSyncOrg(t);
    await expectMarketingError(
      as(t).action(api.v1.connections.beginConnect, { provider: "instagram" }),
      "INVALID_ARGUMENT",
    );
  });

  it("reconnecting a different Instagram account into a connection is an identity mismatch", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = (await connectInstagramFake(t, fake, "business")).get("connection")!;
    const params = await connectInstagramFake(
      t,
      fake,
      "creator",
      {},
      { reconnectConnectionId: connectionId },
    );
    expect(params.get("error")).toBe("identity_mismatch");
    const again = await connectInstagramFake(
      t,
      fake,
      "business",
      {},
      { reconnectConnectionId: connectionId },
    );
    expect(again.get("status")).toBe("connected");
    const connection = await t.run((ctx) => ctx.db.query("connections").first());
    expect(connection!.credentialVersion).toBe(2);
  });
});

describe("linking social accounts", () => {
  async function connected(t: Backend, who = {}) {
    await setupSyncOrg(t, who);
    const params = await connectInstagramFake(t, fake, "business", who);
    return params.get("connection")!;
  }

  it("links a discovered account through the canonical write path and creates its sync state", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    const connectionId = await connected(t);
    const user = fake.users.business!;

    const discovered = await as(t).query(api.v1.connections.listDiscoveredSocialAccounts, {
      connectionId,
    });
    expect(discovered).toEqual([
      {
        externalId: user.userId,
        platform: "instagram",
        username: user.username,
        accountType: "business",
        linked: false,
        discoveredAt: NOW.toISOString(),
      },
    ]);

    const [account] = await linkSocial(t, connectionId, [user.userId]);
    expect(account).toMatchObject({
      platform: "instagram",
      externalId: user.userId,
      username: user.username,
      name: user.username, // a label until the first sync preflight (Stage B)
      accountType: "business",
      status: "active",
      linked: true,
      connectionId,
      linkedAt: NOW.toISOString(),
    });
    expect(Object.keys(account!)).not.toContain("profilePictureUrl");

    const state = await t.run((ctx) => ctx.db.query("syncAccounts").collect());
    expect(state).toHaveLength(1);
    expect(state[0]).toMatchObject({
      socialAccountId: account!.id,
      state: "idle",
      backfillHorizon: "2026-07-01",
    });
    expect(state[0]!.adAccountId).toBeUndefined();

    // Idempotent: relinking the same account to the same connection writes no audit entry.
    await linkSocial(t, connectionId, [user.userId]);
    const actions = (await auditActions(t)).map((e) => e.action);
    expect(actions.filter((a) => a === "socialAccount.linked")).toHaveLength(1);
    expect(
      (await as(t).query(api.v1.connections.listDiscoveredSocialAccounts, { connectionId }))[0]!
        .linked,
    ).toBe(true);
  });

  it("only discovered ids are linkable; ad and social link paths cannot be crossed", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    const connectionId = await connected(t);
    await expectMarketingError(linkSocial(t, connectionId, ["17841400000000999"]), "NOT_FOUND");
    await expectMarketingError(linkSocial(t, connectionId, []), "INVALID_ARGUMENT");
    // An Instagram connection never links ad accounts.
    await expectMarketingError(
      linkMock(t, connectionId, [fake.users.business!.userId]),
      "NOT_FOUND",
    );
    expect(await as(t).query(api.v1.connections.listDiscoveredAssets, { connectionId })).toEqual(
      [],
    );
  });

  it("is admin-only and tenant-isolated", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    const connectionId = await connected(t);
    const [account] = await linkSocial(t, connectionId, [fake.users.business!.userId]);
    await setupSyncOrg(t, CRM);

    await expectMarketingError(
      as(t, { role: "viewer" }).mutation(api.v1.connections.linkSocialAccounts, {
        connectionId,
        externalIds: [fake.users.business!.userId],
      }),
      "FORBIDDEN",
    );
    await expectMarketingError(
      as(t, { role: "viewer" }).query(api.v1.connections.listDiscoveredSocialAccounts, {
        connectionId,
      }),
      "FORBIDDEN",
    );
    // Another org can neither see, link nor unlink.
    await expectMarketingError(
      as(t, CRM).query(api.v1.connections.listDiscoveredSocialAccounts, { connectionId }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      linkSocial(t, connectionId, [fake.users.business!.userId], CRM),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t, CRM).mutation(api.v1.connections.unlinkSocialAccount, { socialAccountId: account!.id }),
      "NOT_FOUND",
    );
  });

  it("the same Instagram account connected by two orgs gives two independent rows", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    const erp = await connected(t);
    const crm = await connected(t, CRM);
    const id = fake.users.business!.userId;
    const [a] = await linkSocial(t, erp, [id]);
    const [b] = await linkSocial(t, crm, [id], CRM);
    expect(a!.id).not.toBe(b!.id);
    const rows = await t.run((ctx) => ctx.db.query("socialAccounts").collect());
    expect(new Set(rows.map((r) => r.orgId)).size).toBe(2);
  });

  it("unlink keeps the row; disconnect unlinks, drops discovery and deletes the credential", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    const connectionId = await connected(t);
    const id = fake.users.business!.userId;
    const [account] = await linkSocial(t, connectionId, [id]);

    const unlinked = await as(t).mutation(api.v1.connections.unlinkSocialAccount, {
      socialAccountId: account!.id,
    });
    expect(unlinked.linked).toBe(false);
    await linkSocial(t, connectionId, [id]);

    const disconnected = await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    expect(disconnected.status).toBe("revoked");
    await drainScheduler(t);
    const rows = await allRows(t);
    expect(rows.socialAccounts).toHaveLength(1);
    expect((rows.socialAccounts![0] as { connectionId?: string }).connectionId).toBeUndefined();
    expect(rows.discoveredSocialAccounts).toEqual([]);
    expect(rows.credentials).toEqual([]);
    const actions = (await auditActions(t)).map((e) => e.action);
    expect(actions).toContain("socialAccount.unlinked");
    expect(actions).toContain("credential.deleted");
    // The sync state is parked by the planner (no connection), never synced.
    await planAndDrain(t);
    const state = await t.run((ctx) => ctx.db.query("syncAccounts").first());
    expect(state!.state).toBe("parked");
    expectNoSecrets(rows);
  });
});

describe("mock mode", () => {
  it("connects and links a mock Instagram account; the Meta and Instagram paths stay separate", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectMockInstagram(t, "1");
    expect(params.get("status")).toBe("connected");
    const connectionId = params.get("connection")!;
    const [account] = await linkSocial(t, connectionId, [mockInstagramAccountId("1")]);
    expect(account).toMatchObject({ accountType: "business", linked: true });

    const metaConnection = await connectMock(t, "meta");
    await expectMarketingError(
      linkSocial(t, metaConnection, [mockInstagramAccountId("1")]),
      "INVALID_ARGUMENT",
    );
    expect(
      await as(t).query(api.v1.connections.listDiscoveredSocialAccounts, {
        connectionId: metaConnection,
      }),
    ).toEqual([]);
    const list = await as(t).query(api.v1.connections.list, {});
    expect(list.map((c) => c.provider).sort()).toEqual(["instagram", "meta"]);
    expect(list.find((c) => c.provider === "instagram")!.missingScopes).toEqual([]);
  });

  it("an unsupported account type is never discovered; the connection reports discovery_failed", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectMockInstagram(t, "personal");
    expect(params.get("status")).toBe("connected");
    expect(params.get("warning")).toBe("discovery_failed");
    expect(await t.run((ctx) => ctx.db.query("discoveredSocialAccounts").collect())).toEqual([]);
    const connection = await t.run((ctx) => ctx.db.query("connections").first());
    expect(connection!.lastError).toMatchObject({ kind: "permission" });
  });

  it("refreshAssets re-runs social discovery", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = (await connectMockInstagram(t, "creator")).get("connection")!;
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("discoveredSocialAccounts").collect())
        await ctx.db.delete(row._id);
    });
    await as(t).mutation(api.v1.connections.refreshAssets, { connectionId });
    await drainScheduler(t);
    const rows = await t.run((ctx) => ctx.db.query("discoveredSocialAccounts").collect());
    expect(rows.map((r) => r.accountType)).toEqual(["creator"]);
    await t.mutation(internal.connections.maintenance.sweep, {});
  });
});
