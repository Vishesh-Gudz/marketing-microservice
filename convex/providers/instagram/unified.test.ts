import { afterEach, describe, expect, it, vi } from "vitest";
import { isProviderError } from "../errors";
import {
  hasInstagramMessagingPermission,
  INSTAGRAM_MESSAGING_SCOPE,
  INSTAGRAM_SUBSCRIBED_FIELDS,
  isUnifiedInstagramGrant,
} from "./config";
import {
  isInstagramCredential,
  isInstagramMessagingCredential,
  isInstagramUnifiedCredential,
} from "./credential";
import { createInstagramDiscovery } from "./discovery";
import {
  createFakeUnified,
  FAKE_UNIFIED_APP_ID,
  FAKE_UNIFIED_APP_SECRET,
  FAKE_UNIFIED_CODE_MARKER,
  FAKE_UNIFIED_CONFIG_ID,
  FAKE_UNIFIED_TOKEN_MARKER,
  type FakeUnified,
} from "./fakeUnified.fixtures";
import { createInstagramOAuthSpec } from "./oauth";
import { assertAllowedRequest, TransportBlockedError, type InstagramCaller } from "./transport";

// Instagram API with Unified Login (config.ts): the transport routes, the OAuth spec's Unified
// mode, discovery and the credential separation, against a fake of the documented endpoints.
// Instagram Login behavior is covered, unchanged, by the existing suites.

const F = "https://graph.facebook.com";
const BEARER = { authorization: "Bearer EAAGunifiedfake-x" };
const REDIRECT = "https://marketing-tests.convex.site/oauth/callback";
const CONFIG = {
  clientId: FAKE_UNIFIED_APP_ID,
  clientSecret: FAKE_UNIFIED_APP_SECRET,
  extra: { configId: FAKE_UNIFIED_CONFIG_ID },
};
const NOW = 1_800_000_000_000;

function check(
  caller: InstagramCaller,
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: boolean } = {},
) {
  try {
    assertAllowedRequest(caller, {
      method: options.method ?? "GET",
      url: new URL(url),
      headers: new Headers({
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...options.headers,
      }),
      hasBody: options.body ?? false,
    });
    return "allowed";
  } catch (error) {
    if (error instanceof TransportBlockedError) return error.reason;
    throw error;
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("transport: Unified Login routes on graph.facebook.com/v26.0 only", () => {
  const EXCHANGE = `${F}/v26.0/oauth/access_token?client_id=1&client_secret=s&code=c&redirect_uri=${encodeURIComponent(REDIRECT)}`;
  const DEBUG = `${F}/v26.0/debug_token?input_token=t&access_token=1%7Cs`;

  it("allows exactly the documented requests", () => {
    expect(check("oauth", EXCHANGE)).toBe("allowed");
    expect(check("oauth", DEBUG)).toBe("allowed");
    expect(
      check("graph_reader", `${F}/v26.0/me/assigned_instagram_accounts?fields=id,username`, {
        headers: BEARER,
      }),
    ).toBe("allowed");
    expect(
      check(
        "messaging",
        `${F}/v26.0/17841400000000301/subscribed_apps?subscribed_fields=messages,messaging_seen`,
        {
          method: "POST",
          headers: BEARER,
        },
      ),
    ).toBe("allowed");
    expect(
      check("messaging", `${F}/v26.0/17841400000000301/messages`, {
        method: "POST",
        headers: BEARER,
        body: true,
      }),
    ).toBe("allowed");
  });

  it.each([
    ["an extra parameter", `${EXCHANGE}&debug=all`],
    ["no redirect_uri", `${F}/v26.0/oauth/access_token?client_id=1&client_secret=s&code=c`],
    [
      "an empty secret",
      `${F}/v26.0/oauth/access_token?client_id=1&client_secret=&code=c&redirect_uri=x`,
    ],
    [
      "another version",
      `${F}/v25.0/oauth/access_token?client_id=1&client_secret=s&code=c&redirect_uri=x`,
    ],
    ["debug_token with an extra parameter", `${DEBUG}&fields=scopes`],
    ["debug_token without the app token", `${F}/v26.0/debug_token?input_token=t`],
  ])("refuses the code exchange or debug_token with %s", (_label, url) => {
    expect(check("oauth", url)).not.toBe("allowed");
  });

  it("refuses the exception forms with a POST, a body or an Authorization header", () => {
    expect(check("oauth", EXCHANGE, { method: "POST" })).toBe("method");
    expect(check("oauth", EXCHANGE, { body: true })).toBe("body");
    expect(check("oauth", EXCHANGE, { headers: BEARER })).toBe("authorization");
  });

  it.each([
    [
      "a token in the query",
      "graph_reader",
      `${F}/v26.0/me/assigned_instagram_accounts?fields=id,username&access_token=t`,
      "GET",
    ],
    [
      "other account fields",
      "graph_reader",
      `${F}/v26.0/me/assigned_instagram_accounts?fields=id,username,name`,
      "GET",
    ],
    ["/me itself", "graph_reader", `${F}/v26.0/me?fields=id`, "GET"],
    [
      "Instagram Login's field list",
      "messaging",
      `${F}/v26.0/17841400000000301/subscribed_apps?subscribed_fields=${INSTAGRAM_SUBSCRIBED_FIELDS}`,
      "POST",
    ],
    ["the conversations edge", "messaging", `${F}/v26.0/17841400000000301/conversations`, "GET"],
    ["an ads endpoint", "graph_reader", `${F}/v26.0/act_1/insights`, "GET"],
    ["the SDK caller", "sdk", `${F}/v26.0/17841400000000301?fields=id`, "GET"],
  ] as const)("refuses %s", (_label, caller, url, method) => {
    expect(check(caller, url, { method, headers: BEARER })).not.toBe("allowed");
  });

  it("requires the Bearer header on Graph calls", () => {
    expect(
      check("graph_reader", `${F}/v26.0/me/assigned_instagram_accounts?fields=id,username`),
    ).toBe("authorization");
  });
});

describe("OAuth spec in Unified mode", () => {
  const spec = createInstagramOAuthSpec({ timeoutMs: 5_000 });

  function stub(fake: FakeUnified) {
    vi.stubGlobal("fetch", fake.fetch);
  }

  async function failure(promise: Promise<unknown>) {
    try {
      await promise;
    } catch (error) {
      if (isProviderError(error)) return { kind: error.kind, code: error.providerCode };
      throw error;
    }
    throw new Error("expected a failure");
  }

  it("authorizes through the Facebook Login for Business dialog with config_id and no scope", () => {
    const url = new URL(
      spec.buildAuthorizationUrl({
        state: "state-1",
        redirectUri: REDIRECT,
        config: CONFIG,
        extraScopes: [INSTAGRAM_MESSAGING_SCOPE],
      }),
    );
    expect(url.origin + url.pathname).toBe("https://www.facebook.com/dialog/oauth");
    const names: string[] = [];
    url.searchParams.forEach((_value, name) => names.push(name));
    expect(names.sort()).toEqual([
      "client_id",
      "config_id",
      "redirect_uri",
      "response_type",
      "state",
    ]);
    expect(url.searchParams.get("config_id")).toBe(FAKE_UNIFIED_CONFIG_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
  });

  it("keeps Instagram Login unchanged without a configuration id", () => {
    const url = new URL(
      spec.buildAuthorizationUrl({
        state: "s",
        redirectUri: REDIRECT,
        config: { clientId: FAKE_UNIFIED_APP_ID, clientSecret: FAKE_UNIFIED_APP_SECRET },
      }),
    );
    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe(
      "instagram_business_basic,instagram_business_manage_insights",
    );
  });

  it("refuses an invalid configuration id instead of falling back", () => {
    expect(() =>
      spec.buildAuthorizationUrl({
        state: "s",
        redirectUri: REDIRECT,
        config: { ...CONFIG, extra: { configId: "not-a-number" } },
      }),
    ).toThrow();
  });

  it("exchanges code -> system-user token -> debug_token -> the one assigned account", async () => {
    const fake = createFakeUnified();
    stub(fake);
    const code = fake.issueCode();
    const grant = await spec.exchangeCode({
      code,
      redirectUri: REDIRECT,
      config: CONFIG,
      now: NOW,
    });

    expect(
      fake.requests.map((r) => `${r.method} ${r.path} [${r.params.join(",")}] ${r.bearer}`),
    ).toEqual([
      "GET /v26.0/oauth/access_token [client_id,client_secret,code,redirect_uri] false",
      "GET /v26.0/debug_token [access_token,input_token] false",
      "GET /v26.0/me/assigned_instagram_accounts [fields] true",
    ]);
    expect(isInstagramUnifiedCredential(grant.credential)).toBe(true);
    expect(grant.credential).toMatchObject({
      setup: "unified",
      tokenType: "system_user",
      appId: FAKE_UNIFIED_APP_ID,
      userId: "17841400000000301",
      issuedAt: NOW,
    });
    expect(grant.identity).toEqual({
      externalUserId: "17841400000000301",
      displayName: "fake_unified",
    });
    expect(grant.grantedScopes).toEqual(["instagram_basic", "instagram_manage_messages"]);
    expect(grant.refreshable).toBe(false);
    expect(grant.expiresAt).toBeUndefined();
  });

  it.each([
    [
      "an invalid code",
      { failures: { code_exchange: { status: 400, code: 100, subcode: 36007 } } },
      "auth",
      "token_exchange:",
    ],
    [
      "an invalid token",
      {
        clients: {
          messaging: { accounts: [{ id: "1" }], scopes: ["instagram_basic"], valid: false },
        },
      },
      "auth",
      "debug_token:invalid",
    ],
    [
      "another app's token",
      {
        clients: {
          messaging: { accounts: [{ id: "1" }], scopes: ["instagram_basic"], appId: "999" },
        },
      },
      "auth",
      "debug_token:app_id_mismatch",
    ],
    [
      "no instagram_basic",
      {
        clients: { messaging: { accounts: [{ id: "1" }], scopes: ["instagram_manage_messages"] } },
      },
      "permission",
      "debug_token:permission_missing",
    ],
    [
      "no assigned account",
      { clients: { messaging: { accounts: [], scopes: ["instagram_basic"] } } },
      "data",
      "identity:no_account",
    ],
    [
      "two assigned accounts",
      {
        clients: {
          messaging: { accounts: [{ id: "1" }, { id: "2" }], scopes: ["instagram_basic"] },
        },
      },
      "data",
      "identity:multiple_accounts",
    ],
  ] as const)("fails closed on %s", async (_label, options, kind, code) => {
    const fake = createFakeUnified(options as Parameters<typeof createFakeUnified>[0]);
    stub(fake);
    const result = await failure(
      spec.exchangeCode({
        code: fake.issueCode(),
        redirectUri: REDIRECT,
        config: CONFIG,
        now: NOW,
      }),
    );
    expect(result.kind).toBe(kind);
    expect(result.code?.startsWith(code)).toBe(true);
  });

  it("never puts the token, secret or code into an error", async () => {
    const fake = createFakeUnified({ failures: { accounts: { status: 500, code: 1 } } });
    stub(fake);
    const code = fake.issueCode();
    try {
      await spec.exchangeCode({ code, redirectUri: REDIRECT, config: CONFIG, now: NOW });
      throw new Error("expected a failure");
    } catch (error) {
      const text = JSON.stringify({
        error,
        message: (error as Error).message,
        stack: (error as Error).stack,
      });
      for (const secret of [
        FAKE_UNIFIED_TOKEN_MARKER,
        FAKE_UNIFIED_APP_SECRET,
        FAKE_UNIFIED_CODE_MARKER,
      ]) {
        expect(text).not.toContain(secret);
      }
    }
  });

  it("refuses to refresh a Unified Login token without any request", async () => {
    const fake = createFakeUnified();
    stub(fake);
    const result = await failure(
      spec.refresh!(
        {
          kind: "instagram",
          v: 1,
          setup: "unified",
          accessToken: `${FAKE_UNIFIED_TOKEN_MARKER}-x`,
          tokenType: "system_user",
          appId: FAKE_UNIFIED_APP_ID,
          userId: "17841400000000301",
          issuedAt: NOW,
        },
        CONFIG,
        NOW,
      ),
    );
    expect(result).toEqual({ kind: "invalid_request", code: "token_refresh:not_refreshable" });
    expect(fake.requests).toHaveLength(0);
  });
});

describe("discovery and credential separation", () => {
  const unified = {
    kind: "instagram",
    v: 1,
    setup: "unified",
    accessToken: "",
    tokenType: "system_user",
    appId: FAKE_UNIFIED_APP_ID,
    userId: "17841400000000301",
    issuedAt: NOW,
  } as const;
  const legacy = {
    kind: "instagram",
    v: 1,
    accessToken: "IGAAfake-1",
    tokenType: "long_lived",
    appId: "1790000000000001",
    userId: "17841400000000101",
    issuedAt: NOW,
  } as const;

  it("keeps the two credential types apart (organic sync and refresh accept Instagram Login only)", () => {
    const token = { ...unified, accessToken: `${FAKE_UNIFIED_TOKEN_MARKER}-1` };
    expect(isInstagramCredential(token)).toBe(false);
    expect(isInstagramUnifiedCredential(token)).toBe(true);
    expect(isInstagramMessagingCredential(token)).toBe(true);
    expect(isInstagramCredential(legacy)).toBe(true);
    expect(isInstagramUnifiedCredential(legacy)).toBe(false);
    expect(isInstagramMessagingCredential(legacy)).toBe(true);
    // A legacy-shaped token carrying `setup` is not an Instagram Login credential.
    expect(isInstagramCredential({ ...legacy, setup: "unified" })).toBe(false);
  });

  it("discovers the credential's account from the assigned accounts (business, PROVISIONAL)", async () => {
    const fake = createFakeUnified();
    stub(fake);
    const code = fake.issueCode();
    const grant = await createInstagramOAuthSpec().exchangeCode({
      code,
      redirectUri: REDIRECT,
      config: CONFIG,
      now: NOW,
    });
    fake.reset();
    const page = await createInstagramDiscovery().listAccounts(
      { credential: grant.credential } as never,
      {},
    );
    expect(page.items).toEqual([
      {
        platform: "instagram",
        externalId: "17841400000000301",
        username: "fake_unified",
        accountType: "business",
      },
    ]);
    expect(fake.requests.map((r) => r.path)).toEqual(["/v26.0/me/assigned_instagram_accounts"]);
  });

  it("refuses discovery when the account is no longer assigned", async () => {
    const fake = createFakeUnified();
    stub(fake);
    const grant = await createInstagramOAuthSpec().exchangeCode({
      code: fake.issueCode(),
      redirectUri: REDIRECT,
      config: CONFIG,
      now: NOW,
    });
    fake.clients.messaging!.accounts = [{ id: "17841400000000999" }];
    await expect(
      createInstagramDiscovery().listAccounts({ credential: grant.credential } as never, {}),
    ).rejects.toMatchObject({ kind: "data", providerCode: "identity_mismatch" });
  });

  function stub(fake: FakeUnified) {
    vi.stubGlobal("fetch", fake.fetch);
  }
});

describe("permission helpers", () => {
  it("accepts either setup's messaging permission", () => {
    expect(hasInstagramMessagingPermission(["instagram_business_manage_messages"])).toBe(true);
    expect(hasInstagramMessagingPermission(["instagram_manage_messages"])).toBe(true);
    expect(hasInstagramMessagingPermission(["instagram_basic"])).toBe(false);
  });

  it("recognizes a Unified Login grant by its permission names", () => {
    expect(isUnifiedInstagramGrant(["instagram_basic", "instagram_manage_messages"])).toBe(true);
    expect(
      isUnifiedInstagramGrant(["instagram_business_basic", "instagram_business_manage_insights"]),
    ).toBe(false);
    expect(isUnifiedInstagramGrant([])).toBe(false);
  });
});
