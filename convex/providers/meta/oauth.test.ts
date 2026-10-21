import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FAKE_APP_CONFIG,
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  graphError,
  installFakeGraph,
  paramsObject,
} from "./fakeGraph.fixtures";
import { createMetaOAuthSpec } from "./oauth";

const REDIRECT = "https://marketing-tests.convex.site/oauth/callback";
const NOW = 1_790_000_000_000;

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const graph = installFakeGraph();
  return { graph, spec: createMetaOAuthSpec() };
}

async function exchange(user: string, setupResult = setup()) {
  const { graph, spec } = setupResult;
  return await spec.exchangeCode({
    code: graph.issueCode(user),
    redirectUri: REDIRECT,
    config: FAKE_APP_CONFIG,
    now: NOW,
  });
}

describe("Meta OAuth spec: authorization URL", () => {
  it("builds the FLfB dialog URL with config_id and ads_read only (D4/D9)", () => {
    const { spec } = setup();
    expect(spec.requestedScopes).toEqual(["ads_read"]);
    expect(spec.requiredScopes).toEqual(["ads_read"]);
    expect(spec.usesPkce).toBe(false);
    expect(spec.refresh).toBeUndefined();
    expect(spec.revoke).toBeUndefined();

    const url = new URL(
      spec.buildAuthorizationUrl({ state: "st", redirectUri: REDIRECT, config: FAKE_APP_CONFIG }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://www.facebook.com/v26.0/dialog/oauth");
    expect(paramsObject(url.searchParams)).toEqual({
      client_id: FAKE_APP_ID,
      redirect_uri: REDIRECT,
      state: "st",
      response_type: "code",
      config_id: FAKE_APP_CONFIG.extra.configId,
      auth_type: "rerequest",
    });
    expect(url.toString()).not.toContain(FAKE_APP_SECRET);
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("fails closed with config:meta_config_invalid before any network call", async () => {
    const { graph, spec } = setup();
    for (const config of [
      {},
      { clientId: FAKE_APP_ID, clientSecret: FAKE_APP_SECRET },
      { clientId: "abc", clientSecret: FAKE_APP_SECRET, extra: { configId: "1" } },
    ]) {
      expect(() =>
        spec.buildAuthorizationUrl({ state: "s", redirectUri: REDIRECT, config }),
      ).toThrow(
        expect.objectContaining({ kind: "unknown", providerCode: "config:meta_config_invalid" }),
      );
      await expect(
        spec.exchangeCode({ code: "c", redirectUri: REDIRECT, config, now: NOW }),
      ).rejects.toMatchObject({ kind: "unknown", providerCode: "config:meta_config_invalid" });
    }
    expect(graph.calls()).toBe(0);
  });

  it("reports whether the app settings are complete and valid (checked before any OAuth state)", () => {
    const { graph, spec } = setup();
    expect(spec.isConfigured?.(FAKE_APP_CONFIG)).toBe(true);
    const extra = FAKE_APP_CONFIG.extra;
    for (const config of [
      {},
      { clientSecret: FAKE_APP_SECRET, extra },
      { clientId: FAKE_APP_ID, extra },
      { clientId: FAKE_APP_ID, clientSecret: FAKE_APP_SECRET },
      { clientId: "my-app", clientSecret: FAKE_APP_SECRET, extra },
      { clientId: FAKE_APP_ID, clientSecret: "short", extra },
      { clientId: FAKE_APP_ID, clientSecret: FAKE_APP_SECRET, extra: { configId: "cfg" } },
    ]) {
      expect(spec.isConfigured?.(config)).toBe(false);
    }
    // An invalid version override is a configuration error too.
    expect(createMetaOAuthSpec({ version: "v26" }).isConfigured?.(FAKE_APP_CONFIG)).toBe(false);
    expect(graph.calls()).toBe(0);
  });
});

describe("Meta OAuth spec: code exchange", () => {
  it("runs code → short → long → debug_token → /me and returns a tenant-free grant", async () => {
    const s = setup();
    const grant = await exchange("u1", s);
    expect(s.graph.log.map((e) => `${e.method} ${e.path}`)).toEqual([
      "POST oauth/access_token",
      "POST oauth/access_token",
      "GET debug_token",
      "GET me",
    ]);
    expect(s.graph.log.every((e) => !e.secretInUrl)).toBe(true);
    expect(s.graph.log[2]!.auth).toBe("app");
    expect(s.graph.log[3]).toMatchObject({ auth: "user", hasProof: true });
    expect(grant).toEqual({
      credential: {
        kind: "meta",
        v: 1,
        accessToken: "test-long-u1",
        tokenType: "user",
        appId: FAKE_APP_ID,
        issuedAt: NOW,
        expiresAt: 1_800_000_000_000,
        dataAccessExpiresAt: 1_797_000_000_000,
        grantedAdAccountIds: ["1001", "1002", "1003"],
      },
      identity: { externalUserId: "1000000001", displayName: "Fake User" },
      grantedScopes: ["ads_read", "public_profile"],
      // D5: the minimum of the finite expiries.
      expiresAt: 1_797_000_000_000,
      refreshable: false,
    });
  });

  it("treats expires_at / data_access_expires_at = 0 as 'never' (no expiry, not immediate)", async () => {
    const grant = await exchange("noexpiry");
    expect(grant.expiresAt).toBeUndefined();
    expect(grant.credential).not.toHaveProperty("expiresAt");
    expect(grant.credential).not.toHaveProperty("dataAccessExpiresAt");
  });

  it("surfaces missing ads_read as granted scopes (missingScopes), not an error", async () => {
    const grant = await exchange("limited");
    expect(grant.grantedScopes).toEqual(["public_profile"]);
  });

  it.each([
    [
      "invalid code",
      "code_exchange:100/36007",
      "auth",
      async (s: ReturnType<typeof setup>) =>
        s.spec.exchangeCode({
          code: "nope",
          redirectUri: REDIRECT,
          config: FAKE_APP_CONFIG,
          now: NOW,
        }),
    ],
    [
      "reused code",
      "code_exchange:100/36009",
      "auth",
      async (s: ReturnType<typeof setup>) => {
        const code = s.graph.issueCode("u1");
        await s.spec.exchangeCode({
          code,
          redirectUri: REDIRECT,
          config: FAKE_APP_CONFIG,
          now: NOW,
        });
        return s.spec.exchangeCode({
          code,
          redirectUri: REDIRECT,
          config: FAKE_APP_CONFIG,
          now: NOW,
        });
      },
    ],
    [
      "token of another app",
      "debug_token:app_id_mismatch",
      "auth",
      (s: ReturnType<typeof setup>) => exchange("otherapp", s),
    ],
    [
      "invalid token",
      "debug_token:190",
      "auth",
      (s: ReturnType<typeof setup>) => exchange("invalid", s),
    ],
  ])("%s → %s (%s, non-retryable)", async (_label, providerCode, kind, run) => {
    const s = setup();
    await expect(run(s)).rejects.toMatchObject({ kind, providerCode, retryable: false });
  });

  it("classifies an unavailable token endpoint as transient with a staged code", async () => {
    const s = setup();
    s.graph.inject({
      match: (e) => e.path === "oauth/access_token",
      response: graphError(2, undefined, 503),
    });
    await expect(exchange("u1", s)).rejects.toMatchObject({
      kind: "transient",
      providerCode: "code_exchange:2",
    });
  });

  it("stages failures of the later steps", async () => {
    const s = setup();
    s.graph.inject({ match: (e) => e.path === "me", response: graphError(190, 460, 401) });
    await expect(exchange("u1", s)).rejects.toMatchObject({
      kind: "auth",
      providerCode: "identity:190/460",
    });

    const t = setup();
    t.graph.inject({ match: (e) => e.path === "debug_token", response: "network" });
    await expect(exchange("u1", t)).rejects.toMatchObject({
      kind: "transient",
      providerCode: "debug_token:network",
    });
  });

  it("never puts tokens, codes or secrets into error messages", async () => {
    const s = setup();
    let caught: unknown;
    try {
      await s.spec.exchangeCode({
        code: "secret-code-value",
        redirectUri: REDIRECT,
        config: FAKE_APP_CONFIG,
        now: NOW,
      });
    } catch (error) {
      caught = error;
    }
    const text = `${(caught as Error).message} ${JSON.stringify(caught)}`;
    expect(text).not.toContain("secret-code-value");
    expect(text).not.toContain(FAKE_APP_SECRET);
  });

  it("uses the version override on every OAuth call", async () => {
    const graph = installFakeGraph();
    const spec = createMetaOAuthSpec({ version: "v27.0" });
    expect(
      spec.buildAuthorizationUrl({ state: "s", redirectUri: REDIRECT, config: FAKE_APP_CONFIG }),
    ).toContain("/v27.0/dialog/oauth");
    await spec.exchangeCode({
      code: graph.issueCode("u1"),
      redirectUri: REDIRECT,
      config: FAKE_APP_CONFIG,
      now: NOW,
    });
    expect(new Set(graph.log.map((e) => e.version))).toEqual(new Set(["v27.0"]));
    expect(spec.providerId).toBe("meta-marketing-api/v27.0");
  });
});
