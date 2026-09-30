import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  createFakeGraph,
  FAKE_APP_SECRET,
  type FakeGraph,
} from "../providers/meta/fakeGraph.fixtures";
import schema from "../schema";
import {
  as,
  connectMetaFake,
  connectMock,
  expectMarketingError,
  ISSUER_CRM,
  linkMock,
  newBackend,
  planAndDrain,
  RETURN_URL,
  setupSyncOrg,
  stubLiveMeta,
  type Backend,
} from "../test.helpers";

// Phase 8 Stage A, end to end on convex-test: the REAL connect flow with the Meta
// OAuthSpec + Meta ads provider (PROVIDER_MODE=live) against the fake Graph.
// Covers D28b diagnostics + leak scans, tenant isolation, D8 fail-closed modes and
// D1 version identity.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-09-26T12:00:00Z");

let graph: FakeGraph;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  graph = createFakeGraph();
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

/** Secrets that must never appear anywhere outside the encrypted credential blob. */
const SECRET_MARKERS = [
  "test-long-",
  "test-short-",
  "test-code-",
  FAKE_APP_SECRET,
  "graph.facebook.com",
  "Fake Graph error",
  "fbtrace",
];

function expectNoSecrets(value: unknown) {
  const text = JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? `${v}n` : v));
  for (const marker of SECRET_MARKERS) expect(text, marker).not.toContain(marker);
}

async function oauthFailures(t: Backend) {
  return await t.run((ctx) =>
    ctx.db
      .query("auditLog")
      .collect()
      .then((rows) => rows.filter((row) => row.action === "connection.oauth_failed")),
  );
}

describe("Meta connect flow (live mode, fake Graph)", () => {
  it("connects, stores an encrypted FLfB credential and discovers accounts", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectMetaFake(t, graph, "u1");
    expect(params.get("status")).toBe("connected");
    expect(params.get("warning")).toBeNull();
    const connectionId = params.get("connection")!;

    const connection = await as(t).query(api.v1.connections.get, { connectionId });
    expect(connection).toMatchObject({
      provider: "meta",
      status: "active",
      displayName: "Fake User",
      grantedScopes: ["ads_read", "public_profile"],
      missingScopes: [],
      tokenExpiresAt: new Date(1_797_000_000_000).toISOString(),
    });
    const assets = await as(t).query(api.v1.connections.listDiscoveredAssets, { connectionId });
    expect(assets.map((a) => a.externalId).sort()).toEqual(["1001", "1002", "1003"]);

    // Transport invariants over the whole flow.
    for (const entry of graph.log) {
      expect(entry.secretInUrl, entry.path).toBe(false);
      expect(entry.version).toBe("v26.0");
      if (entry.path !== "oauth/access_token") expect(entry.method).toBe("GET");
      if (entry.auth === "user") expect(entry.hasProof).toBe(true);
    }
    expectNoSecrets(await allRows(t).then(({ credentials: _c, ...rest }) => rest));
  });

  it("links discovered Meta accounts through the public API", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = (await connectMetaFake(t, graph, "u1")).get("connection")!;
    const linked = await linkMock(t, connectionId, ["1001"]);
    expect(linked).toMatchObject([
      { platform: "meta", externalId: "1001", currency: "USD", linked: true },
    ]);
  });

  it("reconnect patches the same connection; another Meta user is identity_mismatch", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const first = (await connectMetaFake(t, graph, "u1")).get("connection")!;
    expect((await connectMetaFake(t, graph, "u1")).get("connection")).toBe(first);

    const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
      provider: "meta",
      returnUrl: RETURN_URL,
      reconnectConnectionId: first,
    });
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    const response = await t.fetch(`/oauth/callback?state=${state}&code=${graph.issueCode("u2")}`, {
      method: "GET",
      redirect: "manual",
    });
    expect(new URL(response.headers.get("location")!).searchParams.get("error")).toBe(
      "identity_mismatch",
    );
  });

  it("a grant without ads_read connects with missingScopes and a discovery warning", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectMetaFake(t, graph, "limited");
    expect(params.get("status")).toBe("connected");
    expect(params.get("warning")).toBe("discovery_failed");
    const connection = await as(t).query(api.v1.connections.get, {
      connectionId: params.get("connection")!,
    });
    expect(connection.missingScopes).toEqual(["ads_read"]);
  });
});

describe("D28b: sanitized OAuth-failure diagnostics", () => {
  async function failWith(setup: (g: FakeGraph) => void, user = "u1") {
    stubLiveMeta(graph);
    setup(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await connectMetaFake(t, graph, user);
    expect(params.get("status")).toBe("error");
    expect(params.get("error")).toBe("exchange_failed");
    const failures = await oauthFailures(t);
    expect(failures).toHaveLength(1);
    return { t, changes: failures[0]!.changes };
  }

  it.each([
    [
      "invalid/expired code",
      (g: FakeGraph) =>
        g.inject({
          match: (e) => e.path === "oauth/access_token",
          response: {
            status: 400,
            body: {
              error: {
                code: 100,
                error_subcode: 36007,
                message: "Invalid code test-code-1",
                fbtrace_id: "AbCdEf",
              },
            },
          },
        }),
      "u1",
      { failureKind: "auth", failureStage: "code_exchange", providerCode: "100/36007" },
    ],
    [
      "token endpoint 5xx",
      (g: FakeGraph) =>
        g.inject({
          match: (e) => e.path === "oauth/access_token",
          response: { status: 503, body: { error: { code: 2, message: "Service unavailable" } } },
        }),
      "u1",
      { failureKind: "transient", failureStage: "code_exchange", providerCode: "2" },
    ],
    [
      "network failure (transport marker is not allowlisted)",
      (g: FakeGraph) => g.inject({ match: (e) => e.path === "debug_token", response: "network" }),
      "u1",
      { failureKind: "transient", failureStage: "debug_token" },
    ],
    [
      "token of another app",
      () => {},
      "otherapp",
      { failureKind: "auth", failureStage: "debug_token", providerCode: "app_id_mismatch" },
    ],
    [
      "identity lookup rejected",
      (g: FakeGraph) =>
        g.inject({
          match: (e) => e.path === "me",
          response: {
            status: 401,
            body: {
              error: {
                code: 190,
                error_subcode: 460,
                message: "Session invalidated: test-long-u1",
              },
            },
          },
        }),
      "u1",
      { failureKind: "auth", failureStage: "identity", providerCode: "190/460" },
    ],
  ])("%s → only allowlisted fields are audited", async (_label, setup, user, expected) => {
    const { t, changes } = await failWith(setup, user);
    const flat = Object.fromEntries(Object.entries(changes ?? {}).map(([k, v]) => [k, v.to]));
    expect(flat).toEqual({ reason: "exchange_failed", ...expected });
    expectNoSecrets(await allRows(t).then(({ credentials: _c, ...rest }) => rest));
  });

  it("a configuration error between beginConnect and the callback is audited as config", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
      provider: "meta",
      returnUrl: RETURN_URL,
    });
    vi.stubEnv("META_APP_SECRET", "");
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    await t.fetch(`/oauth/callback?state=${state}&code=${graph.issueCode("u1")}`, {
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
      providerCode: "meta_config_invalid",
    });
  });

  it("a denied consent keeps the pre-Phase-8 audit shape (no diagnostics)", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
      provider: "meta",
      returnUrl: RETURN_URL,
    });
    const state = new URL(authorizeUrl).searchParams.get("state")!;
    await t.fetch(`/oauth/callback?state=${state}&error=access_denied`, {
      method: "GET",
      redirect: "manual",
    });
    const [failure] = await oauthFailures(t);
    expect(failure!.changes).toEqual({ reason: { from: null, to: "access_denied" } });
  });
});

describe("tenant isolation with real Meta connections", () => {
  it("two orgs connecting the same Meta user get separate connections; disconnecting one leaves the other", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    const crm = { issuer: ISSUER_CRM };
    await setupSyncOrg(t);
    await setupSyncOrg(t, crm);
    const a = (await connectMetaFake(t, graph, "u1")).get("connection")!;
    const b = (await connectMetaFake(t, graph, "u1", crm)).get("connection")!;
    expect(a).not.toBe(b);

    await as(t).mutation(api.v1.connections.disconnect, { connectionId: a });
    await t.finishAllScheduledFunctions(vi.runAllTimers, 1_000);
    expect((await as(t, crm).query(api.v1.connections.get, { connectionId: b })).status).toBe(
      "active",
    );
    await expectMarketingError(
      as(t, crm).query(api.v1.connections.get, { connectionId: a }),
      "NOT_FOUND",
    );
    // Disconnect never calls Meta (no platform revoke, D7).
    expect(
      graph.log.every(
        (e) => e.method === "GET" || (e.method === "POST" && e.path === "oauth/access_token"),
      ),
    ).toBe(true);
    const credentials = await t.run((ctx) => ctx.db.query("credentials").collect());
    expect(credentials).toHaveLength(1);
  });
});

describe("D8: fail-closed provider mode end to end", () => {
  it("cloud deployment without PROVIDER_MODE: no Meta calls, no mock data, no reauth; connect refused", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    // Connected and linked while local (mock mode) ...
    const connectionId = await connectMock(t, "meta", "1");
    await linkMock(t, connectionId, ["1001"]);
    // ... then deployed to the cloud without PROVIDER_MODE.
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    vi.stubGlobal("fetch", graph.fetch);
    await planAndDrain(t);

    const db = await t.run(async (ctx) => ({
      runs: await ctx.db.query("syncRuns").collect(),
      tasks: await ctx.db.query("syncTasks").collect(),
      connections: await ctx.db.query("connections").collect(),
      campaigns: await ctx.db.query("campaigns").collect(),
      metrics: await ctx.db.query("metricsDaily").collect(),
    }));
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]!.status).toBe("failed");
    expect(db.runs[0]!.providerId).toBe("unavailable");
    expect(db.tasks.find((task) => task.operation === "getAccount")!.lastError).toMatchObject({
      kind: "unknown",
      code: "provider_mode_missing",
    });
    expect(db.connections[0]!.status).toBe("active");
    expect(db.campaigns).toHaveLength(0);
    expect(db.metrics).toHaveLength(0);
    expect(graph.calls()).toBe(0);

    await expectMarketingError(
      as(t).action(api.v1.connections.beginConnect, { provider: "meta", returnUrl: RETURN_URL }),
      "INVALID_ARGUMENT",
    );
  });

  it("an invalid PROVIDER_MODE fails closed the same way", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "meta", "1");
    await linkMock(t, connectionId, ["1001"]);
    vi.stubEnv("PROVIDER_MODE", "Live");
    vi.stubGlobal("fetch", graph.fetch);
    await planAndDrain(t);
    const tasks = await t.run((ctx) => ctx.db.query("syncTasks").collect());
    expect(tasks.find((task) => task.operation === "getAccount")!.lastError).toMatchObject({
      kind: "unknown",
      code: "provider_mode_invalid",
    });
    expect(graph.calls()).toBe(0);
  });
});

describe("D1: API version is run metadata, not identity", () => {
  it("a version override keeps the connection, account, sync state and rows; only providerId changes", async () => {
    stubLiveMeta(graph);
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = (await connectMetaFake(t, graph, "u1")).get("connection")!;
    const [account] = await linkMock(t, connectionId, ["1001"]);
    await planAndDrain(t);

    vi.stubEnv("META_GRAPH_API_VERSION", "v27.0");
    expect((await connectMetaFake(t, graph, "u1")).get("connection")).toBe(connectionId);
    vi.advanceTimersByTime(60 * 60_000);
    await planAndDrain(t);

    const db = await t.run(async (ctx) => ({
      runs: await ctx.db.query("syncRuns").collect(),
      syncAccounts: await ctx.db.query("syncAccounts").collect(),
      adAccounts: await ctx.db.query("adAccounts").collect(),
      connections: await ctx.db.query("connections").collect(),
    }));
    expect(db.connections).toHaveLength(1);
    expect(db.adAccounts).toHaveLength(1);
    expect(db.adAccounts[0]!._id).toBe(account!.id as Id<"adAccounts">);
    expect(db.syncAccounts).toHaveLength(1);
    expect(db.runs.every((r) => r.adAccountId === db.adAccounts[0]!._id)).toBe(true);
    expect(
      db.runs.every((r) => r.platform === "meta" && r.connectionId === db.connections[0]!._id),
    ).toBe(true);
    expect(db.runs.map((r) => r.providerId)).toEqual([
      "meta-marketing-api/v26.0",
      "meta-marketing-api/v27.0",
    ]);
    expect(graph.log.some((e) => e.version === "v27.0")).toBe(true);
  });
});
