import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import {
  adsError,
  createFakeGoogleAds,
  FAKE_GOOGLE_CLIENT_SECRET,
  oauthErrorResponse,
  type FakeGoogleAds,
} from "../providers/google/fakeGoogleAds.fixtures";
import schema from "../schema";
import {
  as,
  connectGoogleFake,
  connectMock,
  expectMarketingError,
  ISSUER_CRM,
  linkMock,
  newBackend,
  planAndDrain,
  RETURN_URL,
  setupSyncOrg,
  stubLiveGoogle,
  type Backend,
} from "../test.helpers";

// Phase 9 Stage A, end to end on convex-test: the REAL connect flow with the Google OAuthSpec
// + Google Ads provider (PROVIDER_MODE=live) against the fake Google Ads API. Covers the
// refresh-token credential, discovery, linking, Stage A sync behavior (getAccount works,
// everything semantic fails closed), invalid_grant → needs_reauth, D28b diagnostics + leak
// scans and tenant isolation.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-03-08T15:00:00Z");
const ADWORDS = "https://www.googleapis.com/auth/adwords";

let fake: FakeGoogleAds;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = createFakeGoogleAds();
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
    return out;
  });
}

/** Values that must never be stored anywhere (the encrypted credential blob included). */
const SECRET_MARKERS = [
  "test-refresh-",
  "test-access-",
  "test-gcode-",
  FAKE_GOOGLE_CLIENT_SECRET,
  "oauth2.googleapis.com",
  "googleads.googleapis.com",
  "openidconnect",
  "Fake Google Ads error",
  "Fake error message",
  "Fake OAuth error description",
  "fakeRequestId",
  "fake-id-token",
  "email",
  "@",
];

function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value, (_k, v) => {
    if (typeof v === "bigint") return `${v}n`;
    if (v instanceof ArrayBuffer) return "<bytes>";
    return v;
  });
  for (const marker of SECRET_MARKERS) expect(text, marker).not.toContain(marker);
}

/** The stored credential is ciphertext only: no plaintext token or credential fields. */
async function expectOpaqueCredentials(t: Backend) {
  const credentials = await t.run((ctx) => ctx.db.query("credentials").collect());
  for (const credential of credentials) {
    const bytes = new TextDecoder("latin1").decode(credential.ciphertext);
    for (const marker of ["test-refresh-", "test-access-", "refreshToken", "google", "adwords"]) {
      expect(bytes, marker).not.toContain(marker);
    }
  }
  return credentials;
}

async function snapshot(t: Backend) {
  return await t.run(async (ctx) => ({
    runs: await ctx.db.query("syncRuns").collect(),
    tasks: await ctx.db.query("syncTasks").collect(),
    states: await ctx.db.query("syncAccounts").collect(),
    connections: await ctx.db.query("connections").collect(),
    accounts: await ctx.db.query("adAccounts").collect(),
    campaigns: await ctx.db.query("campaigns").collect(),
    metrics: await ctx.db.query("metricsDaily").collect(),
    audit: await ctx.db.query("auditLog").collect(),
  }));
}

async function connectU1(t: Backend) {
  stubLiveGoogle(fake);
  await setupSyncOrg(t);
  const params = await connectGoogleFake(t, fake, "u1");
  expect(params.get("status"), params.get("error") ?? "").toBe("connected");
  return params.get("connection")!;
}

describe("Google connect flow (live mode, fake Google Ads API)", () => {
  it("connects with a refresh-token credential, the OpenID sub only, and discovers accounts", async () => {
    const t = newBackend();
    const connectionId = await connectU1(t);

    const connection = await as(t).query(api.v1.connections.get, { connectionId });
    expect(connection).toMatchObject({
      provider: "google_ads",
      status: "active",
      grantedScopes: [ADWORDS, "openid"],
      missingScopes: [],
    });
    expect(connection).not.toHaveProperty("displayName");
    expect(connection).not.toHaveProperty("tokenExpiresAt");
    const [stored] = await t.run((ctx) => ctx.db.query("connections").collect());
    expect(stored!.externalUserId).toBe("100000000000000000001");

    const assets = await as(t).query(api.v1.connections.listDiscoveredAssets, { connectionId });
    expect(assets.map((a) => [a.externalId, a.name, a.currency, a.isManager, a.status])).toEqual([
      ["1110000001", "Fake Manager", "USD", true, "active"],
      ["2220000001", "Fake Shop USD", "USD", false, "active"],
      ["2220000002", "Fake Shop JPY", "JPY", false, "active"],
      ["3330000001", "Fake Sub-manager", "EUR", true, "active"],
      ["4440000001", "Fake Shop EUR", "EUR", false, "active"],
      ["6660000001", "Fake Cancelled", "USD", false, "closed"],
      ["7770000001", "777-000-0001", "GBP", false, "active"],
    ]);
    // The routing manager (also exposed as parentExternalId in the discovered-asset DTO).
    const discovered = await t.run((ctx) => ctx.db.query("discoveredAssets").collect());
    expect(
      Object.fromEntries(discovered.map((a) => [a.externalId, a.parentExternalId ?? null])),
    ).toEqual({
      "1110000001": null,
      "2220000001": "1110000001",
      "2220000002": "1110000001",
      "3330000001": "1110000001",
      "4440000001": "1110000001",
      "6660000001": "1110000001",
      "7770000001": null,
    });

    // Transport: exchange (code → tokens, sub, API access), then discovery with a freshly
    // minted access token; nothing secret in any URL.
    expect(fake.log.map((e) => e.kind)).toEqual([
      "token_exchange",
      "userinfo",
      "accessible",
      "token_refresh",
      "accessible",
      "search",
      "search",
      "search",
    ]);
    expect(fake.log.every((e) => !e.secretInUrl)).toBe(true);
    // Developer tokens were sunset on 2026-09-09: the flow needs none and never sends one.
    expect(fake.log.every((e) => !e.developerTokenHeader)).toBe(true);
    // No stored access token, no plaintext refresh token, no email — anywhere.
    expectNoSecrets(await allRows(t));
    expect(await expectOpaqueCredentials(t)).toHaveLength(1);
  });

  it("links client accounts; managers are not linkable", async () => {
    const t = newBackend();
    const connectionId = await connectU1(t);
    const linked = await linkMock(t, connectionId, ["2220000001", "4440000001"]);
    expect(linked).toMatchObject([
      { platform: "google_ads", externalId: "2220000001", currency: "USD", linked: true },
      { platform: "google_ads", externalId: "4440000001", currency: "EUR", linked: true },
    ]);
    await expectMarketingError(linkMock(t, connectionId, ["1110000001"]), "INVALID_ARGUMENT");
    await expectMarketingError(linkMock(t, connectionId, ["5550000001"]), "NOT_FOUND");
  });

  it("reconnect patches the same connection; another Google user is identity_mismatch", async () => {
    const t = newBackend();
    const first = await connectU1(t);
    expect((await connectGoogleFake(t, fake, "u1")).get("connection")).toBe(first);

    const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
      provider: "google_ads",
      returnUrl: RETURN_URL,
      reconnectConnectionId: first,
    });
    const params = new URL(authorizeUrl).searchParams;
    const code = fake.issueCode("u2", params.get("code_challenge")!, params.get("redirect_uri")!);
    const response = await t.fetch(`/oauth/callback?state=${params.get("state")}&code=${code}`, {
      method: "GET",
      redirect: "manual",
    });
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe(
      "identity_mismatch",
    );
  });

  it("a discovery failure keeps the connection with a warning and a sanitized error", async () => {
    stubLiveGoogle(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    fake.inject({
      match: (e) => e.kind === "search",
      response: adsError(429, "RESOURCE_EXHAUSTED", "quotaError", "RESOURCE_EXHAUSTED", "30s"),
    });
    const params = await connectGoogleFake(t, fake, "u1");
    expect(params.get("status")).toBe("connected");
    expect(params.get("warning")).toBe("discovery_failed");
    expectNoSecrets(await allRows(t));
  });

  it("a Test-level Cloud project fails discovery visibly: no partial account list, no reauth", async () => {
    fake.setAccessLevel("test");
    stubLiveGoogle(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectGoogleFake(t, fake, "u1");
    // The consent itself succeeds (the user did nothing wrong) ...
    expect(params.get("status")).toBe("connected");
    // ... but discovery reports the project-level failure instead of silently listing fewer
    // (or zero) accounts.
    expect(params.get("warning")).toBe("discovery_failed");
    const connectionId = params.get("connection")!;
    expect(await as(t).query(api.v1.connections.listDiscoveredAssets, { connectionId })).toEqual(
      [],
    );
    const connection = await as(t).query(api.v1.connections.get, { connectionId });
    expect(connection).toMatchObject({ status: "active", lastError: { kind: "unknown" } });
    expect(fake.log.every((e) => !e.developerTokenHeader)).toBe(true);
    expectNoSecrets(await allRows(t));
  });
});

describe("sync through the connection (Stage B)", () => {
  it("syncs linked accounts through their manager route and stores no secret", async () => {
    const t = newBackend();
    const connectionId = await connectU1(t);
    await linkMock(t, connectionId, ["2220000001", "4440000001"]);
    const before = fake.log.length;
    await planAndDrain(t);

    const db = await snapshot(t);
    expect(db.runs).toHaveLength(2);
    expect(db.runs.every((r) => r.providerId === "google-ads-api/v25")).toBe(true);
    expect(db.runs.every((r) => r.status === "succeeded")).toBe(true);
    expect(db.tasks.every((task) => task.status === "succeeded")).toBe(true);
    expect(db.connections[0]!.status).toBe("active");
    expect(db.campaigns).toHaveLength(4);
    expect(db.metrics.length).toBeGreaterThan(0);
    for (const state of db.states) expect(state.coveredThrough).toBeDefined();

    // Both accounts are reached through the manager (login-customer-id), never directly.
    const sync = fake.log.slice(before);
    const searches = sync.filter((e) => e.kind === "search");
    expect(searches.every((e) => e.loginCustomerId === "1110000001")).toBe(true);
    expect(new Set(searches.map((e) => e.customerId))).toEqual(
      new Set(["1110000001", "2220000001", "4440000001"]),
    );
    expect(sync.every((e) => !e.secretInUrl)).toBe(true);
    expectNoSecrets(await allRows(t));
  });

  it("a revoked refresh token (invalid_grant) moves the connection to needs_reauth", async () => {
    const t = newBackend();
    const connectionId = await connectU1(t);
    await linkMock(t, connectionId, ["2220000001"]);
    fake.revoke("u1");
    const before = fake.log.length;
    await planAndDrain(t);

    const db = await snapshot(t);
    expect(db.connections[0]!.status).toBe("needs_reauth");
    expect(db.runs[0]!.status).toBe("failed");
    expect(db.tasks.find((task) => task.operation === "getAccount")!.lastError).toMatchObject({
      kind: "auth",
      code: "invalid_grant",
    });
    expect(db.audit.filter((a) => a.action === "connection.needs_reauth")).toHaveLength(1);
    expect(fake.log.slice(before).map((e) => e.kind)).toEqual(["token_refresh"]);
    expectNoSecrets(await allRows(t));
  });

  it("a Test-level Cloud project fails the run as configuration: no reauth, no account block", async () => {
    const t = newBackend();
    const connectionId = await connectU1(t);
    await linkMock(t, connectionId, ["2220000001"]);
    // The project's production access is missing (never approved, or lost).
    fake.setAccessLevel("test");
    await planAndDrain(t);

    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("failed");
    const failed = db.tasks.find((task) => task.status === "failed")!;
    expect(failed.lastError).toMatchObject({
      kind: "unknown",
      code: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
    });
    // Not the user's fault and not the account's: the connection stays active and the
    // account is not blocked; it is retried with the standard failure backoff.
    expect(db.connections[0]!.status).toBe("active");
    expect(db.states.every((state) => state.state !== "blocked")).toBe(true);
    // Retry semantics: the failure is counted and the next plan is scheduled (backoff).
    const [state] = db.states;
    expect(state!.consecutiveFailures).toBeGreaterThanOrEqual(1);
    expect(state!.nextPlanAt).toBeGreaterThan(db.runs[0]!.createdAt);
    expect(
      db.audit.filter((a) =>
        ["connection.needs_reauth", "sync.account_blocked"].includes(a.action),
      ),
    ).toEqual([]);
    expect(db.campaigns).toHaveLength(0);
    expectNoSecrets(await allRows(t));
  });

  it("leftover mock Google connections move to needs_reauth with no Google call", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "google_ads", "1");
    await linkMock(t, connectionId, ["1112223333"]);
    stubLiveGoogle(fake);
    await planAndDrain(t);

    const db = await snapshot(t);
    expect(db.connections[0]!.status).toBe("needs_reauth");
    expect(db.runs[0]!.providerId).toBe("google-ads-api/v25");
    expect(db.tasks.find((task) => task.operation === "getAccount")!.lastError).toMatchObject({
      kind: "auth",
      code: "credential_invalid",
    });
    expect(db.campaigns).toHaveLength(0);
    expect(fake.log).toHaveLength(0);
  });
});

describe("D28b: sanitized Google OAuth-failure diagnostics", () => {
  async function oauthFailures(t: Backend) {
    return await t.run((ctx) =>
      ctx.db
        .query("auditLog")
        .collect()
        .then((rows) => rows.filter((row) => row.action === "connection.oauth_failed")),
    );
  }

  async function failWith(setup: (f: FakeGoogleAds) => void, user = "u1") {
    stubLiveGoogle(fake);
    setup(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectGoogleFake(t, fake, user);
    expect(params.get("status")).toBe("error");
    expect(params.get("error")).toBe("exchange_failed");
    const failures = await oauthFailures(t);
    expect(failures).toHaveLength(1);
    const flat = Object.fromEntries(
      Object.entries(failures[0]!.changes ?? {}).map(([k, v]) => [k, v.to]),
    );
    return { t, flat };
  }

  it.each([
    [
      "invalid/expired code",
      (f: FakeGoogleAds) =>
        f.inject({
          match: (e) => e.kind === "token_exchange",
          response: oauthErrorResponse(400, "invalid_grant"),
        }),
      "u1",
      { failureKind: "auth", failureStage: "token_exchange", providerCode: "invalid_grant" },
    ],
    [
      "wrong OAuth client secret",
      (f: FakeGoogleAds) =>
        f.inject({
          match: (e) => e.kind === "token_exchange",
          response: oauthErrorResponse(401, "invalid_client"),
        }),
      "u1",
      { failureKind: "unknown", failureStage: "token_exchange", providerCode: "invalid_client" },
    ],
    [
      "token endpoint 5xx (transport code is not allowlisted)",
      (f: FakeGoogleAds) =>
        f.inject({ match: (e) => e.kind === "token_exchange", response: { status: 503 } }),
      "u1",
      { failureKind: "transient", failureStage: "token_exchange" },
    ],
    [
      "no refresh token issued",
      () => {},
      "norefresh",
      { failureKind: "auth", failureStage: "token_exchange", providerCode: "no_refresh_token" },
    ],
    [
      "userinfo network failure",
      (f: FakeGoogleAds) => f.inject({ match: (e) => e.kind === "userinfo", response: "network" }),
      "u1",
      { failureKind: "transient", failureStage: "identity" },
    ],
    [
      "a Google account without Google Ads",
      () => {},
      "noads",
      { failureKind: "auth", failureStage: "api_access", providerCode: "NOT_ADS_USER" },
    ],
    [
      "a Google Cloud project without production access",
      (f: FakeGoogleAds) =>
        f.inject({
          match: (e) => e.kind === "accessible",
          response: adsError(
            403,
            "PERMISSION_DENIED",
            "authorizationError",
            "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
          ),
        }),
      "u1",
      {
        failureKind: "unknown",
        failureStage: "api_access",
        providerCode: "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
      },
    ],
    [
      "a non-allowlisted OAuth error code",
      (f: FakeGoogleAds) =>
        f.inject({
          match: (e) => e.kind === "token_exchange",
          response: oauthErrorResponse(400, "invalid_scope"),
        }),
      "u1",
      { failureKind: "unknown", failureStage: "token_exchange" },
    ],
    [
      "an OAuth error carrying free text / an email (not even parsed as a code)",
      (f: FakeGoogleAds) =>
        f.inject({
          match: (e) => e.kind === "token_exchange",
          response: oauthErrorResponse(400, "blocked for someone@example.com"),
        }),
      "u1",
      { failureKind: "invalid_request", failureStage: "token_exchange" },
    ],
  ])("%s → only allowlisted fields are audited", async (_label, setup, user, expected) => {
    const { t, flat } = await failWith(setup, user);
    expect(flat).toEqual({ reason: "exchange_failed", ...expected });
    expectNoSecrets(await allRows(t));
    const text = JSON.stringify(await allRows(t));
    expect(text).not.toContain("example.com");
    expect(await t.run((ctx) => ctx.db.query("credentials").collect())).toHaveLength(0);
  });

  it("a configuration error between beginConnect and the callback is audited as config", async () => {
    stubLiveGoogle(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
      provider: "google_ads",
      returnUrl: RETURN_URL,
    });
    vi.stubEnv("GOOGLE_CLIENT_SECRET", "");
    const params = new URL(authorizeUrl).searchParams;
    const code = fake.issueCode("u1", params.get("code_challenge")!);
    await t.fetch(`/oauth/callback?state=${params.get("state")}&code=${code}`, {
      method: "GET",
      redirect: "manual",
    });
    const [failure] = await oauthFailures(t);
    expect(
      Object.fromEntries(Object.entries(failure!.changes ?? {}).map(([k, v]) => [k, v.to])),
    ).toEqual({
      reason: "exchange_failed",
      failureKind: "unknown",
      failureStage: "config",
      providerCode: "google_config_invalid",
    });
    expect(fake.log).toHaveLength(0);
  });

  it("beginConnect is refused while Google is misconfigured", async () => {
    stubLiveGoogle(fake, { GOOGLE_CLIENT_ID: "not-a-google-client" });
    const t = newBackend();
    await setupSyncOrg(t);
    await expect(
      as(t).action(api.v1.connections.beginConnect, {
        provider: "google_ads",
        returnUrl: RETURN_URL,
      }),
    ).rejects.toThrow();
    expect(fake.log).toHaveLength(0);
  });
});

describe("tenant isolation with real Google connections", () => {
  it("two orgs connecting the same Google user get separate connections and accounts", async () => {
    stubLiveGoogle(fake);
    const t = newBackend();
    const crm = { issuer: ISSUER_CRM };
    await setupSyncOrg(t);
    await setupSyncOrg(t, crm);
    const a = (await connectGoogleFake(t, fake, "u1")).get("connection")!;
    const b = (await connectGoogleFake(t, fake, "u1", crm)).get("connection")!;
    expect(a).not.toBe(b);
    const [linkedA] = await linkMock(t, a, ["2220000001"]);
    const [linkedB] = await linkMock(t, b, ["2220000001"], crm);
    expect(linkedA!.id).not.toBe(linkedB!.id);

    // Each org sees only its own connection, assets and accounts.
    await expectMarketingError(
      as(t, crm).query(api.v1.connections.get, { connectionId: a }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t, crm).query(api.v1.connections.listDiscoveredAssets, { connectionId: a }),
      "NOT_FOUND",
    );
    await expectMarketingError(linkMock(t, a, ["2220000001"], crm), "NOT_FOUND");

    await as(t).mutation(api.v1.connections.disconnect, { connectionId: a });
    await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
    expect((await as(t, crm).query(api.v1.connections.get, { connectionId: b })).status).toBe(
      "active",
    );
    // No platform revoke (G-D6): disconnect never calls Google.
    expect(fake.log.some((e) => e.kind === "other")).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("credentials").collect())).toHaveLength(1);

    // Org B still syncs; org A's disconnected account is not synced.
    const before = fake.log.length;
    await planAndDrain(t);
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    expect(runs.map((r) => r.adAccountId)).toEqual([linkedB!.id]);
    expect(runs[0]!.status).toBe("succeeded");
    expect(
      fake.log
        .slice(before)
        .filter((e) => e.kind === "search")
        .every((e) => e.customerId === "2220000001" || e.customerId === "1110000001"),
    ).toBe(true);
    expectNoSecrets(await allRows(t));
  });
});
