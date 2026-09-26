import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetaAdsProvider, META_CAPABILITIES } from ".";
import { expectProviderError } from "../contract.suite";
import { collectAll } from "../pagination";
import { createGraphClient } from "./client";
import type { MetaCredential } from "./credential";
import { META_MAPPING, META_MAPPING_PENDING } from "./mapping";
import {
  createFakeGraph,
  FAKE_APP_CONFIG,
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  graphError,
  fakeMetaDataset,
  installFakeGraph,
} from "./fakeGraph.fixtures";
import { createMetaOAuthSpec } from "./oauth";

const credential = (user = "u1", appId = FAKE_APP_ID): MetaCredential => ({
  kind: "meta",
  v: 1,
  accessToken: `test-long-${user}`,
  tokenType: "user",
  appId,
  issuedAt: 1,
});

const ctx = (user?: string) => ({ credential: credential(user), attempt: 1 });

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The production factory exactly as the registry calls it; the fake Graph is the global fetch. */
function production(graph = createFakeGraph(), extra: { version?: string } = {}) {
  installFakeGraph(graph);
  return {
    graph,
    provider: createMetaAdsProvider({
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
      ...extra,
    }),
  };
}

const metrics = {
  accountExternalId: "1001",
  level: "campaign" as const,
  from: "2026-03-01",
  to: "2026-03-07",
  breakdown: "none" as const,
};

describe("Stage B capabilities (declared from the implemented mapping)", () => {
  it("declares conversions, action metrics, placements and fixed windows; no allConversions", () => {
    expect(META_CAPABILITIES.reportedMetrics).toEqual(
      expect.arrayContaining(["conversions", "conversionValueMicros", "reach", "linkClicks"]),
    );
    expect(META_CAPABILITIES.reportedMetrics).not.toContain("allConversions");
    expect(META_CAPABILITIES.actionMetrics).toBe(true);
    expect(META_CAPABILITIES.attributionWindows).toEqual(["1d_click", "7d_click", "1d_view"]);
    expect(META_CAPABILITIES.placements).toEqual([
      "all",
      "facebook",
      "instagram",
      "audience_network",
      "messenger",
      "threads",
      "other",
    ]);
    expect(META_CAPABILITIES.incrementalEntities).toBe(false);
    expect(Object.isFrozen(META_CAPABILITIES)).toBe(true);
  });
});

describe("an operation without a mapping entry fails closed", () => {
  it("unknown/meta_mapping_pending_g1, never unsupported, without calling Meta", async () => {
    vi.resetModules();
    vi.doMock("./mapping", async (importOriginal) => ({
      ...(await importOriginal<Record<string, unknown>>()),
      META_MAPPING: Object.freeze({}),
    }));
    const { createMetaAdsProvider: createWithoutMapping } = await import(".");
    vi.doUnmock("./mapping");
    const graph = installFakeGraph();
    const provider = createWithoutMapping({ appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET });
    for (const call of [
      () => provider.listCampaigns(ctx(), { accountExternalId: "1001" }),
      () => provider.listAdGroups(ctx(), { accountExternalId: "1001" }),
      () => provider.listAds(ctx(), { accountExternalId: "1001" }),
      () => provider.listCreatives(ctx(), { accountExternalId: "1001" }),
      () => provider.fetchDailyMetrics(ctx(), metrics),
      () => provider.fetchActionMetrics(ctx(), metrics),
    ]) {
      await expect(call()).rejects.toMatchObject({
        kind: "unknown",
        providerCode: META_MAPPING_PENDING,
        retryable: false,
      });
    }
    expect(graph.calls()).toBe(0);
  });
});

describe("configuration and credential checks (D22)", () => {
  it("missing or invalid app config fails 'unknown' (never 'auth') without calling Meta", async () => {
    const graph = installFakeGraph();
    for (const options of [
      {},
      { appId: FAKE_APP_ID },
      { appSecret: FAKE_APP_SECRET },
      { appId: "not-numeric", appSecret: FAKE_APP_SECRET },
      { appId: FAKE_APP_ID, appSecret: "short" },
      { appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET, version: "26" },
    ]) {
      const provider = createMetaAdsProvider(options);
      await expect(provider.listAccounts(ctx(), {})).rejects.toMatchObject({
        kind: "unknown",
        providerCode: "meta_config_invalid",
      });
    }
    expect(graph.calls()).toBe(0);
  });

  it("a non-Meta credential or a token of another app is 'auth'", async () => {
    const { provider } = production();
    await expect(
      provider.listAccounts({ credential: { kind: "mock", token: "x" } as never, attempt: 1 }, {}),
    ).rejects.toMatchObject({ kind: "auth", providerCode: "credential_invalid" });
    await expect(
      provider.listAccounts({ credential: credential("u1", "999999"), attempt: 1 }, {}),
    ).rejects.toMatchObject({ kind: "auth", providerCode: "app_id_mismatch" });
  });

  it("construction never throws, even with garbage configuration", () => {
    expect(() =>
      createMetaAdsProvider({ version: "garbage", appId: "x", appSecret: "" }),
    ).not.toThrow();
  });
});

describe("account discovery and preflight (D10)", () => {
  it("maps accounts: canonical id, status table, business parent, stable attributes", async () => {
    const { provider } = production();
    const { items } = await collectAll((cursor) =>
      provider.listAccounts(ctx(), cursor ? { cursor } : {}),
    );
    expect(items).toEqual([
      {
        platform: "meta",
        externalId: "1001",
        name: "Fake Shop USD",
        currency: "USD",
        timezone: "America/New_York",
        status: "active",
        rawStatus: "1",
        isManager: false,
        parentExternalId: "7770001",
      },
      {
        platform: "meta",
        externalId: "1002",
        name: "Fake Shop JPY",
        currency: "JPY",
        timezone: "Asia/Tokyo",
        status: "disabled",
        rawStatus: "2",
        isManager: false,
        attributes: { disableReason: "3" },
      },
      {
        platform: "meta",
        externalId: "1003",
        name: "Fake Closed EUR",
        currency: "EUR",
        timezone: "Europe/Berlin",
        status: "closed",
        rawStatus: "101",
        isManager: false,
      },
    ]);
    for (const account of items) {
      expect(await provider.getAccount(ctx(), { accountExternalId: account.externalId })).toEqual(
        account,
      );
    }
  });

  it.each([
    [1, "active"],
    [2, "disabled"],
    [3, "disabled"],
    [7, "pending"],
    [8, "pending"],
    [9, "active"],
    [100, "disabled"],
    [101, "closed"],
    [201, "unknown"],
    [42, "unknown"],
  ])("account_status %i → %s", async (code, status) => {
    const dataset = fakeMetaDataset();
    dataset.accounts[0]!.account_status = code;
    const { provider } = production(createFakeGraph({ dataset }));
    expect(await provider.getAccount(ctx(), { accountExternalId: "1001" })).toMatchObject({
      status,
      rawStatus: String(code),
    });
  });

  it("paginates discovery with request-bound cursors and uses the discovery transport", async () => {
    const { graph, provider } = production();
    const pages = await collectAll((cursor) =>
      provider.listAccounts(ctx(), { pageSize: 1, ...(cursor ? { cursor } : {}) }),
    );
    expect(pages.pages).toBe(3);
    expect(graph.log.every((e) => e.method === "GET" && !e.secretInUrl && e.hasProof)).toBe(true);
    expect(graph.log.every((e) => e.version === "v26.0")).toBe(true);
  });

  it("classifies malformed account payloads as 'data'", async () => {
    const graph = createFakeGraph();
    graph.inject({
      match: (e) => e.path === "act_1001",
      response: { status: 200, body: { id: "act_1001" } },
    });
    const { provider } = production(graph);
    await expectProviderError(provider.getAccount(ctx(), { accountExternalId: "1001" }), "data");
  });

  it("rejects non-numeric account ids before calling Meta", async () => {
    const { graph, provider } = production();
    await expectProviderError(
      provider.getAccount(ctx(), { accountExternalId: "act_1001" }),
      "invalid_request",
    );
    expect(graph.calls()).toBe(0);
  });
});

describe("permission probe (D22)", () => {
  it("token-wide loss of ads_read is 'auth' (reconnect)", async () => {
    const { provider } = production();
    await expect(provider.listAccounts(ctx("limited"), {})).rejects.toMatchObject({
      kind: "auth",
      providerCode: "200",
    });
  });

  it("an account-scoped permission error with ads_read granted is 'permission'", async () => {
    const graph = createFakeGraph();
    graph.inject({ match: (e) => e.path === "act_1001", response: graphError(10, undefined, 403) });
    const { provider } = production(graph);
    await expect(provider.getAccount(ctx(), { accountExternalId: "1001" })).rejects.toMatchObject({
      kind: "permission",
      providerCode: "10",
    });
    expect(graph.log.map((e) => e.path)).toEqual(["act_1001", "me/permissions"]);
  });

  it("an unreadable probe keeps 'permission' (never escalates to reauth on doubt)", async () => {
    const graph = createFakeGraph();
    graph.inject({ match: (e) => e.path === "act_1001", response: graphError(200) });
    graph.inject({
      match: (e) => e.path === "me/permissions",
      response: graphError(2, undefined, 500),
    });
    const { provider } = production(graph);
    await expectProviderError(
      provider.getAccount(ctx(), { accountExternalId: "1001" }),
      "permission",
    );
  });
});

describe("version identity (D1)", () => {
  it("providerId carries the effective version; platform stays 'meta'", () => {
    expect(production().provider.providerId).toBe("meta-marketing-api/v26.0");
    const overridden = production(createFakeGraph(), { version: "v27.0" }).provider;
    expect(overridden.providerId).toBe("meta-marketing-api/v27.0");
    expect(overridden.platform).toBe("meta");
  });

  it("uses the override version on the wire", async () => {
    const { graph, provider } = production(createFakeGraph(), { version: "v27.0" });
    await provider.listAccounts(ctx(), {});
    expect(graph.log[0]!.version).toBe("v27.0");
  });
});

describe("transport errors surface as typed ProviderErrors", () => {
  it.each([
    [graphError(17), "rate_limited"],
    [graphError(190, 463), "auth"],
    [graphError(100, 33), "not_found"],
    [graphError(2635), "invalid_request"],
    [graphError(1, undefined, 500), "transient"],
  ] as const)("%j → %s", async (response, kind) => {
    const graph = createFakeGraph();
    graph.inject({ match: (e) => e.path === "act_1001", response });
    const { provider } = production(graph);
    await expectProviderError(provider.getAccount(ctx(), { accountExternalId: "1001" }), kind);
  });

  it("never leaks the token, secret or URL in errors", async () => {
    const graph = createFakeGraph();
    graph.inject({ match: () => true, response: "network" });
    const { provider } = production(graph);
    let caught: unknown;
    try {
      await provider.getAccount(ctx(), { accountExternalId: "1001" });
    } catch (error) {
      caught = error;
    }
    const text = JSON.stringify({
      caught,
      message: (caught as Error).message,
      cause: (caught as Error).cause,
    });
    expect(text).not.toContain("test-long-u1");
    expect(text).not.toContain(FAKE_APP_SECRET);
    expect(text).not.toContain("graph.facebook.com");
  });
});

describe("no test-only injection paths (Revision 3: no test hooks in production code)", () => {
  it("the production mapping is the module's frozen META_MAPPING, covering every operation", () => {
    expect(Object.keys(META_MAPPING).sort()).toEqual([
      "actionMetrics",
      "adGroups",
      "ads",
      "campaigns",
      "creatives",
      "dailyMetrics",
    ]);
    expect(Object.isFrozen(META_MAPPING)).toBe(true);
  });

  it("createMetaAdsProvider takes no fetch: every call goes to the runtime's global fetch", async () => {
    const graph = installFakeGraph();
    const injected = vi.fn();
    const provider = createMetaAdsProvider({
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
      // @ts-expect-error: not an option; tests stub the global fetch instead.
      fetch: injected,
    });
    await provider.getAccount(ctx(), { accountExternalId: "1001" });
    expect(injected).not.toHaveBeenCalled();
    expect(graph.calls()).toBe(1);
  });

  it("createMetaAdsProvider takes no mapping: structure and metrics always use META_MAPPING", async () => {
    installFakeGraph();
    const provider = createMetaAdsProvider({
      appId: FAKE_APP_ID,
      appSecret: FAKE_APP_SECRET,
      // @ts-expect-error: not an option; the mapping is mapping.ts META_MAPPING.
      mapping: Object.freeze({}),
    });
    const page = await provider.listCampaigns(ctx(), { accountExternalId: "1001" });
    expect(page.items.map((c) => [c.externalId, c.status])).toEqual([
      ["2001", "active"],
      ["2002", "paused"],
      ["2003", "archived"],
      ["2004", "removed"],
    ]);
  });

  it("createMetaOAuthSpec and createGraphClient take no fetch either", async () => {
    const graph = installFakeGraph();
    const injected = vi.fn();
    const spec = createMetaOAuthSpec({
      // @ts-expect-error: not an option; tests stub the global fetch instead.
      fetch: injected,
    });
    await spec.exchangeCode({
      code: graph.issueCode("u1"),
      redirectUri: "https://marketing-tests.convex.site/oauth/callback",
      config: FAKE_APP_CONFIG,
      now: 1_790_000_000_000,
    });
    const client = createGraphClient({
      version: "v26.0",
      timeoutMs: 1_000,
      // @ts-expect-error: not an option; tests stub the global fetch instead.
      fetch: injected,
    });
    await client.get("me", {}, { accessToken: "test-long-u1", appSecret: FAKE_APP_SECRET });
    expect(injected).not.toHaveBeenCalled();
    expect(graph.calls()).toBe(5);
  });
});
