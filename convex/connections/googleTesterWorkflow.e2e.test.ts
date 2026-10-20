import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import {
  createFakeGoogleAds,
  FAKE_GOOGLE_RANGE,
  fakeGoogleDataset,
  type FakeGoogleAds,
} from "../providers/google/fakeGoogleAds.fixtures";
import {
  as,
  connectGoogleFake,
  expectMarketingError,
  ISSUER_CRM,
  linkMock,
  newBackend,
  planAndDrain,
  redirectParams,
  RETURN_URL,
  setupSyncOrg,
  stubLiveGoogle,
  type Backend,
} from "../test.helpers";

// Tester workflow, end to end on convex-test with the REAL Google connect flow and provider
// against the fake Google Ads API (PROVIDER_MODE=live in-process only): OAuth callback
// success/failure, discovery with three-way manager / test-account status (unknown kept),
// exactly-one-account linking, read-only sync status with allowlisted error reasons, the v1
// analytics the dashboard reads, and cross-tenant isolation. Mock data only.

vi.setConfig({ testTimeout: 180_000 });
/** New York 10:00 on 2026-03-08: the initial window covers the fake delivery. */
const NOW = new Date("2026-03-08T15:00:00Z");
const CRM = { issuer: ISSUER_CRM, org: "77" };

let fake: FakeGoogleAds;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  const dataset = fakeGoogleDataset();
  for (const customer of dataset.customers) {
    // Google did not report the test-account flag for this client, nor the manager flag for
    // this directly accessible customer: both must surface as "unknown".
    if (customer.id === "4440000001") customer.omitTestAccount = true;
    if (customer.id === "7770000001") customer.omitManager = true;
  }
  fake = createFakeGoogleAds({ dataset });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function connect(t: Backend, identity = {}) {
  stubLiveGoogle(fake);
  await setupSyncOrg(t, identity);
  const params = await connectGoogleFake(t, fake, "u1", identity);
  expect(params.get("status"), params.get("error") ?? "").toBe("connected");
  return params.get("connection")!;
}

async function beginGoogle(t: Backend) {
  const { authorizeUrl } = await as(t).action(api.v1.connections.beginConnect, {
    provider: "google_ads",
    returnUrl: RETURN_URL,
  });
  return new URL(authorizeUrl).searchParams;
}

async function callback(t: Backend, query: Record<string, string>) {
  const qs = new URLSearchParams(query).toString();
  return redirectParams(
    await t.fetch(`/oauth/callback?${qs}`, { method: "GET", redirect: "manual" }),
  );
}

describe("OAuth callback", () => {
  it("success creates exactly one active connection", async () => {
    const t = newBackend();
    const connectionId = await connect(t);
    const connections = await as(t).query(api.v1.connections.list, {});
    expect(connections.map((c) => ({ id: c.id, status: c.status }))).toEqual([
      { id: connectionId, status: "active" },
    ]);
  });

  it.each([
    ["denied consent", "access_denied"],
    ["an expired sign-in request", "expired_state"],
    ["an account without Google Ads", "exchange_failed"],
  ])("%s → status=error&error=%s and no connection", async (_label, expected) => {
    stubLiveGoogle(fake);
    const t = newBackend();
    await setupSyncOrg(t);
    const params = await beginGoogle(t);
    const state = params.get("state")!;
    let result: URLSearchParams;
    if (expected === "access_denied") {
      result = await callback(t, { state, error: "access_denied" });
    } else if (expected === "expired_state") {
      await t.run(async (ctx) => {
        for (const s of await ctx.db.query("oauthStates").collect())
          await ctx.db.patch(s._id, { expiresAt: Date.now() - 1 });
      });
      result = await callback(t, {
        state,
        code: fake.issueCode("u1", params.get("code_challenge")!),
      });
    } else {
      result = await callback(t, {
        state,
        code: fake.issueCode("noads", params.get("code_challenge")!),
      });
    }
    expect(result.get("status")).toBe("error");
    expect(result.get("error")).toBe(expected);
    expect(await as(t).query(api.v1.connections.list, {})).toEqual([]);
  });
});

describe("discovery keeps Google's three-way manager / test-account status", () => {
  it("reports manager/client/unknown and test/not_test/unknown, with the manager relation", async () => {
    const t = newBackend();
    const connectionId = await connect(t);
    const assets = await as(t).query(api.v1.connections.listDiscoveredAssets, { connectionId });
    const byId = Object.fromEntries(
      assets.map((a) => [
        a.externalId,
        {
          isManager: a.isManager,
          managerStatus: a.managerStatus,
          testAccountStatus: a.testAccountStatus,
          parent: a.parentExternalId ?? null,
        },
      ]),
    );
    expect(byId).toMatchObject({
      "1110000001": { isManager: true, managerStatus: "manager", parent: null },
      "2220000001": {
        isManager: false,
        managerStatus: "client",
        testAccountStatus: "not_test",
        parent: "1110000001",
      },
      "2220000002": {
        isManager: false,
        managerStatus: "client",
        testAccountStatus: "test",
        parent: "1110000001",
      },
      // Omitted test_account: unknown, never not_test.
      "4440000001": { managerStatus: "client", testAccountStatus: "unknown" },
      // Omitted manager: unknown, never client; isManager stays false (not explicit).
      "7770000001": { isManager: false, managerStatus: "unknown", parent: null },
    });
  });

  it("a stored google_ads row without a manager status (older discovery) is unknown", async () => {
    const t = newBackend();
    const connectionId = await connect(t);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("discoveredAssets").collect()).find(
        (a) => a.externalId === "2220000001",
      )!;
      await ctx.db.patch(row._id, { managerStatus: undefined, testAccountStatus: undefined });
    });
    const asset = (
      await as(t).query(api.v1.connections.listDiscoveredAssets, { connectionId })
    ).find((a) => a.externalId === "2220000001")!;
    expect(asset).toMatchObject({ managerStatus: "unknown", testAccountStatus: "unknown" });
    await expectMarketingError(linkMock(t, connectionId, ["2220000001"]), "INVALID_ARGUMENT");
  });
});

describe("linking is opt-in and exactly one confirmed client", () => {
  it("links the one selected account; the others stay unlinked", async () => {
    const t = newBackend();
    const connectionId = await connect(t);
    const linked = await linkMock(t, connectionId, ["2220000002"]);
    expect(linked.map((a) => a.externalId)).toEqual(["2220000002"]);
    const accounts = await as(t).query(api.v1.adAccounts.list, {});
    expect(accounts.filter((a) => a.linked).map((a) => a.externalId)).toEqual(["2220000002"]);
    const assets = await as(t).query(api.v1.connections.listDiscoveredAssets, { connectionId });
    expect(assets.filter((a) => a.linked).map((a) => a.externalId)).toEqual(["2220000002"]);
  });

  it.each([
    ["an explicit manager", "1110000001", "INVALID_ARGUMENT"],
    ["an unknown manager status", "7770000001", "INVALID_ARGUMENT"],
    ["an account that was not discovered", "9990000001", "NOT_FOUND"],
  ] as const)("refuses %s", async (_label, externalId, code) => {
    const t = newBackend();
    const connectionId = await connect(t);
    await expectMarketingError(linkMock(t, connectionId, [externalId]), code);
    const accounts = await as(t).query(api.v1.adAccounts.list, {});
    expect(accounts.filter((a) => a.linked)).toEqual([]);
  });
});

describe("read-only sync status and the analytics the dashboard reads", () => {
  it("a successful sync exposes state, coverage and data in v1 analytics", async () => {
    const t = newBackend();
    const connectionId = await connect(t);
    const [account] = await linkMock(t, connectionId, ["2220000001"]);
    await planAndDrain(t);

    const [listed] = await as(t).query(api.v1.adAccounts.list, {});
    expect(listed!.sync).toMatchObject({
      syncState: "idle",
      lastRunStatus: "succeeded",
      consecutiveFailures: 0,
    });
    expect(listed!.sync!.lastSuccessAt).toBeDefined();
    expect(listed!.sync!.coveredThrough).toBeDefined();
    expect(listed!.sync).not.toHaveProperty("lastError");

    const overview = await as(t).query(api.v1.analytics.overview, { range: FAKE_GOOGLE_RANGE });
    expect(overview.accountCount).toBe(1);
    expect(overview.totals.metrics.impressions).toBeGreaterThan(0);
    const campaigns = await as(t).query(api.v1.analytics.performance, {
      level: "campaign",
      range: FAKE_GOOGLE_RANGE,
      parent: { accountId: account!.id },
      paginationOpts: { numItems: 50, cursor: null },
    });
    expect(campaigns.page.length).toBeGreaterThan(0);
  });

  it("a Cloud project without production access shows an allowlisted reason: no block, no reauth", async () => {
    const t = newBackend();
    const connectionId = await connect(t);
    await linkMock(t, connectionId, ["2220000001"]);
    fake.setAccessLevel("test");
    await planAndDrain(t);

    const [listed] = await as(t).query(api.v1.adAccounts.list, {});
    expect(listed!.sync).toMatchObject({
      lastRunStatus: "failed",
      lastError: { kind: "unknown", reason: "cloud_project_not_approved_for_production" },
    });
    expect(listed!.sync!.syncState).not.toBe("blocked");
    // The internal platform code never leaves the server.
    expect(JSON.stringify(listed)).not.toContain("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION");
    const [connection] = await as(t).query(api.v1.connections.list, {});
    expect(connection!.status).toBe("active");
  });
});

describe("cross-tenant isolation", () => {
  it("another org cannot see or link this org's discovery, accounts, sync status or analytics", async () => {
    const t = newBackend();
    const connectionId = await connect(t);
    await linkMock(t, connectionId, ["2220000001"]);
    await planAndDrain(t);
    await setupSyncOrg(t, CRM);

    await expectMarketingError(
      as(t, CRM).query(api.v1.connections.listDiscoveredAssets, { connectionId }),
      "NOT_FOUND",
    );
    await expectMarketingError(linkMock(t, connectionId, ["2220000002"], CRM), "NOT_FOUND");
    expect(await as(t, CRM).query(api.v1.adAccounts.list, {})).toEqual([]);
    expect(await as(t, CRM).query(api.v1.connections.list, {})).toEqual([]);
    const overview = await as(t, CRM).query(api.v1.analytics.overview, {
      range: FAKE_GOOGLE_RANGE,
    });
    expect(overview.accountCount).toBe(0);
  });
});
