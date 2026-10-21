import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  adsError,
  createFakeGoogleAds,
  type FakeGoogleAds,
} from "../providers/google/fakeGoogleAds.fixtures";
import {
  as,
  connectGoogleFake,
  connectMock,
  drainScheduler,
  expectMarketingError,
  ISSUER_CRM,
  newBackend,
  setupSyncOrg,
  stubLiveGoogle,
  type Backend,
} from "../test.helpers";

// Google Ads discovery failures on a connection carry an allowlisted public `reason`
// (sync/publicStatus.ts) next to the sanitized kind + generic message. The platform code is
// never stored or returned; unknown codes, non-provider errors and other providers record no
// reason. Real Google connect flow + provider against the fake Google Ads API (in-process
// PROVIDER_MODE=live; no network).

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-03-08T15:00:00Z");
const GENERIC = "The platform request failed";
const CRM = { issuer: ISSUER_CRM, org: "77" };

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

async function connect(t: Backend, identity = {}) {
  stubLiveGoogle(fake);
  await setupSyncOrg(t, identity);
  return await connectGoogleFake(t, fake, "u1", identity);
}

async function connected(t: Backend) {
  const params = await connect(t);
  expect(params.get("status"), params.get("error") ?? "").toBe("connected");
  expect(params.get("warning")).toBeNull();
  return params.get("connection")!;
}

async function refresh(t: Backend, connectionId: string) {
  await as(t).mutation(api.v1.connections.refreshAssets, { connectionId });
  await drainScheduler(t);
}

/** The connection as v1 returns it, plus its raw JSON (for leak checks). */
async function publicConnection(t: Backend, connectionId: string) {
  const one = await as(t).query(api.v1.connections.get, { connectionId });
  const list = await as(t).query(api.v1.connections.list, {});
  return { one, json: JSON.stringify([one, list]) };
}

describe("Google Ads discovery failures: allowlisted reasons", () => {
  it("a Test-level Cloud project explains itself: cloud_project_not_approved_for_production", async () => {
    fake.setAccessLevel("test");
    const t = newBackend();
    const params = await connect(t);
    expect(params.get("status")).toBe("connected");
    expect(params.get("warning")).toBe("discovery_failed");

    const { one, json } = await publicConnection(t, params.get("connection")!);
    expect(one.status).toBe("active");
    expect(one.lastError).toEqual({
      kind: "unknown",
      message: GENERIC,
      reason: "cloud_project_not_approved_for_production",
      at: NOW.toISOString(),
    });
    expect(json).not.toContain("CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION");
  });

  it("quota exhaustion during discovery is rate_limited", async () => {
    fake.inject({
      match: (e) => e.kind === "search",
      response: adsError(429, "RESOURCE_EXHAUSTED", "quotaError", "RESOURCE_EXHAUSTED", "30s"),
    });
    const t = newBackend();
    const params = await connect(t);
    expect(params.get("warning")).toBe("discovery_failed");

    const { one, json } = await publicConnection(t, params.get("connection")!);
    expect(one.lastError).toMatchObject({ message: GENERIC, reason: "rate_limited" });
    expect(json).not.toContain("RESOURCE_EXHAUSTED");
  });

  it("a Google account that lost Ads access is not_ads_user on refresh", async () => {
    const t = newBackend();
    const connectionId = await connected(t);
    fake.inject({
      match: (e) => e.kind === "accessible",
      response: adsError(401, "UNAUTHENTICATED", "authenticationError", "NOT_ADS_USER"),
    });
    await refresh(t, connectionId);

    const { one, json } = await publicConnection(t, connectionId);
    expect(one.lastError).toMatchObject({ kind: "auth", message: GENERIC, reason: "not_ads_user" });
    expect(json).not.toContain("NOT_ADS_USER");
  });

  it("a revoked Google grant is reauth_required on refresh", async () => {
    const t = newBackend();
    const connectionId = await connected(t);
    fake.revoke("u1");
    await refresh(t, connectionId);

    const { one, json } = await publicConnection(t, connectionId);
    expect(one.lastError).toMatchObject({ reason: "reauth_required" });
    expect(json).not.toContain("invalid_grant");
  });
});

describe("Google Ads discovery failures: no reason unless allowlisted", () => {
  it.each([
    ["an unlisted Google error enum", adsError(500, "INTERNAL", "internalError", "INTERNAL_ERROR")],
    ["a transport failure", "network" as const],
  ])("%s keeps only kind + generic message", async (_label, response) => {
    fake.inject({ match: (e) => e.kind === "search", response });
    const t = newBackend();
    const params = await connect(t);
    expect(params.get("warning")).toBe("discovery_failed");

    const { one, json } = await publicConnection(t, params.get("connection")!);
    expect(one.lastError).toBeDefined();
    expect(Object.keys(one.lastError!).sort()).toEqual(["at", "kind", "message"]);
    expect(one.lastError!.message).toBe(GENERIC);
    expect(json).not.toContain("INTERNAL_ERROR");
  });

  it("only allowlisted Google codes become a reason; other providers never get one", async () => {
    // Mock mode: one Google Ads and one Meta connection through the real connect flow.
    const t = newBackend();
    await setupSyncOrg(t);
    const googleId = (await connectMock(t, "google_ads")) as Id<"connections">;
    const metaId = (await connectMock(t, "meta")) as Id<"connections">;
    const record = async (connectionId: Id<"connections">, providerCode?: string) => {
      await t.mutation(internal.connections.assets.recordConnectionError, {
        connectionId,
        kind: "unknown",
        message: GENERIC,
        ...(providerCode !== undefined ? { providerCode } : {}),
      });
      return (await as(t).query(api.v1.connections.get, { connectionId })).lastError;
    };

    expect(await record(googleId, "api_access:NOT_ADS_USER")).toMatchObject({
      reason: "not_ads_user",
    });
    for (const code of [undefined, "", "SOMETHING_NEW", "toString", "__proto__", "req-12345"]) {
      expect(await record(googleId, code)).not.toHaveProperty("reason");
    }
    expect(await record(metaId, "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION")).not.toHaveProperty(
      "reason",
    );
  });
});

describe("DTO behavior", () => {
  it("a successful re-discovery clears the error and its reason", async () => {
    fake.setAccessLevel("test");
    const t = newBackend();
    const params = await connect(t);
    const connectionId = params.get("connection")!;
    expect((await publicConnection(t, connectionId)).one.lastError?.reason).toBe(
      "cloud_project_not_approved_for_production",
    );

    fake.setAccessLevel("explorer");
    await refresh(t, connectionId);
    const { one } = await publicConnection(t, connectionId);
    expect(one).not.toHaveProperty("lastError");
    expect(
      (await as(t).query(api.v1.connections.listDiscoveredAssets, { connectionId })).length,
    ).toBeGreaterThan(0);
  });

  it("a stored value outside the allowlist never leaves the server", async () => {
    const t = newBackend();
    const connectionId = (await connected(t)) as Id<"connections">;
    await t.run(async (ctx) => {
      await ctx.db.patch(connectionId, {
        lastError: { kind: "unknown", message: GENERIC, reason: "RAW_PLATFORM_CODE", at: 1 },
      });
    });
    const { one, json } = await publicConnection(t, connectionId);
    expect(one.lastError).toEqual({
      kind: "unknown",
      message: GENERIC,
      at: new Date(1).toISOString(),
    });
    expect(json).not.toContain("RAW_PLATFORM_CODE");
  });
});

describe("tenant isolation", () => {
  it("another org can neither see nor refresh the connection or its reason", async () => {
    fake.setAccessLevel("test");
    const t = newBackend();
    const params = await connect(t);
    const connectionId = params.get("connection")!;
    await setupSyncOrg(t, CRM);

    expect(await as(t, CRM).query(api.v1.connections.list, {})).toEqual([]);
    await expectMarketingError(
      as(t, CRM).query(api.v1.connections.get, { connectionId }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t, CRM).mutation(api.v1.connections.refreshAssets, { connectionId }),
      "NOT_FOUND",
    );
    // The owner still sees it.
    expect((await publicConnection(t, connectionId)).one.lastError?.reason).toBe(
      "cloud_project_not_approved_for_production",
    );
  });
});
