import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProviderError, type ProviderError } from "../errors";
import { REFRESH_MIN_AGE_MS } from "./config";
import type { InstagramCredential } from "./credential";
import { createInstagramDiscovery } from "./discovery";
import {
  createFakeInstagram,
  FAKE_IG_APP_ID,
  FAKE_IG_APP_SECRET,
  FAKE_IG_CODE_MARKER,
  FAKE_IG_REDIRECT_URI,
  FAKE_IG_TOKEN_MARKER,
  type FakeInstagram,
} from "./fakeInstagram.fixtures";
import { createInstagramOAuthSpec, INSTAGRAM_SCOPES } from "./oauth";

// Instagram OAuthSpec + discovery against the fake Instagram API (documented behavior only).

const NOW = Date.UTC(2026, 8, 28, 12);
const config = { clientId: FAKE_IG_APP_ID, clientSecret: FAKE_IG_APP_SECRET };
let fake: FakeInstagram;

beforeEach(() => {
  fake = createFakeInstagram();
  vi.stubGlobal("fetch", fake.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.catch((e: unknown) => e);
  if (!isProviderError(error)) throw new Error(`expected ProviderError, got ${String(error)}`);
  return error;
}

function exchange(code = fake.issueCode("business")) {
  return createInstagramOAuthSpec().exchangeCode({
    code,
    redirectUri: FAKE_IG_REDIRECT_URI,
    config,
    now: NOW,
  });
}

/** Nothing secret in an error: no token, code, app secret or URL. */
function expectSanitized(error: ProviderError) {
  const text = JSON.stringify({ message: error.message, code: error.providerCode, error });
  for (const marker of [
    FAKE_IG_TOKEN_MARKER,
    FAKE_IG_CODE_MARKER,
    FAKE_IG_APP_SECRET,
    "https://",
    "graph.instagram",
  ]) {
    expect(text).not.toContain(marker);
  }
  expect(error.cause).toBeUndefined();
}

describe("authorization URL", () => {
  it("requests exactly the two approved scopes, no PKCE, with the state", () => {
    const spec = createInstagramOAuthSpec();
    expect(spec.platform).toBe("instagram");
    expect(spec.usesPkce).toBe(false);
    expect([...spec.requestedScopes]).toEqual([
      "instagram_business_basic",
      "instagram_business_manage_insights",
    ]);
    const url = new URL(
      spec.buildAuthorizationUrl({ state: "st4te", redirectUri: FAKE_IG_REDIRECT_URI, config }),
    );
    expect(`${url.origin}${url.pathname}`).toBe("https://www.instagram.com/oauth/authorize");
    const params: Record<string, string> = {};
    url.searchParams.forEach((value, name) => (params[name] = value));
    expect(params).toEqual({
      client_id: FAKE_IG_APP_ID,
      redirect_uri: FAKE_IG_REDIRECT_URI,
      response_type: "code",
      scope: INSTAGRAM_SCOPES.join(","),
      state: "st4te",
    });
    expect(url.toString()).not.toContain(FAKE_IG_APP_SECRET);
  });

  it("fails closed (config, not auth) without a valid app configuration", async () => {
    const spec = createInstagramOAuthSpec();
    const error = await failure(
      Promise.resolve().then(() =>
        spec.buildAuthorizationUrl({ state: "s", redirectUri: FAKE_IG_REDIRECT_URI, config: {} }),
      ),
    );
    expect(error.kind).toBe("unknown");
    expect(error.providerCode).toBe("config:instagram_config_invalid");
    const exchangeError = await failure(
      spec.exchangeCode({
        code: "x",
        redirectUri: FAKE_IG_REDIRECT_URI,
        config: { clientId: "abc" },
        now: NOW,
      }),
    );
    expect(exchangeError.providerCode).toBe("config:instagram_config_invalid");
    expect(fake.requests).toHaveLength(0);
  });
});

describe("code exchange", () => {
  it("returns a long-lived credential, the professional account identity and the granted scopes", async () => {
    const grant = await exchange();
    const user = fake.users.business!;
    expect(grant.credential).toMatchObject({
      kind: "instagram",
      v: 1,
      tokenType: "long_lived",
      appId: FAKE_IG_APP_ID,
      userId: user.userId,
      issuedAt: NOW,
      expiresAt: NOW + 5_184_000_000,
    });
    expect(grant.credential.accessToken).toMatch(new RegExp(`^${FAKE_IG_TOKEN_MARKER}long`));
    expect(grant.identity).toEqual({ externalUserId: user.userId, displayName: user.username });
    expect(grant.grantedScopes).toEqual([
      "instagram_business_basic",
      "instagram_business_manage_insights",
    ]);
    expect(grant.expiresAt).toBe(NOW + 5_184_000_000);
    expect(grant.refreshable).toBe(true);
    // The short-lived token is never returned.
    expect(JSON.stringify(grant)).not.toContain(`${FAKE_IG_TOKEN_MARKER}short`);
  });

  it("makes exactly three allowlisted requests; secrets only in the approved exception URL", async () => {
    await exchange();
    expect(fake.requests.map((r) => `${r.method} ${r.host}${r.path}`)).toEqual([
      "POST api.instagram.com/oauth/access_token",
      "GET graph.instagram.com/access_token",
      "GET graph.instagram.com/v25.0/me",
    ]);
    const [codeExchange, longLived, me] = fake.requests;
    expect(codeExchange!.params).toEqual([]);
    expect(longLived!.params).toEqual(["access_token", "client_secret", "grant_type"]);
    expect(me!.params).toEqual(["fields"]);
    expect(me!.bearer).toBe(true);
    expect(me!.url).not.toContain(FAKE_IG_TOKEN_MARKER);
  });

  it("reports scopes from `permissions` and never invents missing ones", async () => {
    const grant = await exchange(fake.issueCode("basic_only"));
    expect(grant.grantedScopes).toEqual(["instagram_business_basic"]);
  });

  it("maps business and creator accounts; any other account type fails closed", async () => {
    expect((await exchange(fake.issueCode("creator"))).identity.externalUserId).toBe(
      fake.users.creator!.userId,
    );
    const error = await failure(exchange(fake.issueCode("personal")));
    expect(error.kind).toBe("permission");
    expect(error.providerCode).toBe("identity:account_type_unsupported");
    expectSanitized(error);
  });

  it.each([
    [
      "an invalid or reused code",
      "token_exchange",
      { status: 400, body: { error_type: "OAuthException", code: 400, error_message: "used" } },
      "auth",
      "token_exchange:400",
    ],
    [
      "a token endpoint outage",
      "token_exchange",
      { status: 503 },
      "transient",
      "token_exchange:http_503",
    ],
    [
      "an expired short-lived token",
      "long_lived_exchange",
      { status: 400, body: { error: { code: 190, message: "expired" } } },
      "auth",
      "long_lived_exchange:190",
    ],
    [
      "throttling on identity",
      "identity",
      { status: 400, body: { error: { code: 4 } } },
      "rate_limited",
      "identity:4",
    ],
  ] as const)(
    "classifies %s with its D28b stage",
    async (_label, stage, response, kind, providerCode) => {
      fake.fail(
        stage === "token_exchange"
          ? "code_exchange"
          : stage === "identity"
            ? "me"
            : "long_lived_exchange",
        response,
      );
      const error = await failure(exchange());
      expect(error.kind).toBe(kind);
      expect(error.providerCode).toBe(providerCode);
      expectSanitized(error);
    },
  );

  it("rejects unexpected payloads as data errors", async () => {
    fake.fail("code_exchange", { status: 200, body: { data: [] } });
    expect((await failure(exchange())).providerCode).toBe("token_exchange:schema");
    fake.fail("long_lived_exchange", { status: 200, body: { token: "x" } });
    expect((await failure(exchange())).providerCode).toBe("long_lived_exchange:schema");
    fake.fail("me", { status: 200, body: { user_id: "not-numeric", account_type: "Business" } });
    expect((await failure(exchange())).providerCode).toBe("identity:identity_invalid");
  });

  it("accepts the flat token response of older docs", async () => {
    fake.fail("code_exchange", {
      status: 200,
      body: { access_token: `${FAKE_IG_TOKEN_MARKER}flat`, user_id: "17841400000000101" },
    });
    // The flat token is unknown to the fake, so the long-lived exchange fails: the point is
    // that the flat envelope itself parses.
    expect((await failure(exchange())).providerCode).toBe("long_lived_exchange:190");
  });

  it("fails closed on ids that lost precision as JSON numbers (17-digit ids > 2^53)", async () => {
    fake.fail("code_exchange", {
      status: 200,
      body: { data: [{ access_token: `${FAKE_IG_TOKEN_MARKER}x`, user_id: 17841400000000101 }] },
    });
    expect((await failure(exchange())).providerCode).toBe("token_exchange:identity_invalid");
  });
});

describe("token refresh", () => {
  const spec = createInstagramOAuthSpec();
  const credential = (overrides: Partial<InstagramCredential> = {}): InstagramCredential => ({
    kind: "instagram",
    v: 1,
    accessToken: fake.issueLongLivedToken("business"),
    tokenType: "long_lived",
    appId: FAKE_IG_APP_ID,
    userId: fake.users.business!.userId,
    issuedAt: NOW - REFRESH_MIN_AGE_MS,
    expiresAt: NOW + 86_400_000,
    ...overrides,
  });

  it("returns a new long-lived token with the same identity and NO scopes", async () => {
    const old = credential();
    const grant = await spec.refresh!(old, config, NOW);
    expect(grant.credential.accessToken).not.toBe(old.accessToken);
    expect(grant.credential).toMatchObject({
      userId: old.userId,
      appId: FAKE_IG_APP_ID,
      issuedAt: NOW,
    });
    expect(grant.expiresAt).toBe(NOW + 5_184_000_000);
    expect(grant.identity).toEqual({ externalUserId: old.userId });
    expect(grant.grantedScopes).toEqual([]);
    expect(fake.requests.map((r) => `${r.method} ${r.path} ${r.params.join(",")}`)).toEqual([
      "GET /refresh_access_token access_token,grant_type",
    ]);
  });

  it("refuses tokens younger than 24 hours before any request", async () => {
    const error = await failure(spec.refresh!(credential({ issuedAt: NOW - 1_000 }), config, NOW));
    expect(error.providerCode).toBe("token_refresh:token_too_new");
    expect(fake.requests).toHaveLength(0);
  });

  it("fails closed on unusable credentials and foreign apps", async () => {
    const invalid = await failure(spec.refresh!({ kind: "meta" } as never, config, NOW));
    expect([invalid.kind, invalid.providerCode]).toEqual([
      "auth",
      "token_refresh:credential_invalid",
    ]);
    const foreign = await failure(
      spec.refresh!(credential({ appId: "1790000000000999" }), config, NOW),
    );
    expect([foreign.kind, foreign.providerCode]).toEqual(["auth", "token_refresh:app_id_mismatch"]);
    expect(fake.requests).toHaveLength(0);
  });

  it("classifies an invalid refresh token as auth, without leaking it", async () => {
    const old = credential({ accessToken: `${FAKE_IG_TOKEN_MARKER}revoked` });
    const error = await failure(spec.refresh!(old, config, NOW));
    expect([error.kind, error.providerCode]).toEqual(["auth", "token_refresh:190"]);
    expectSanitized(error);
  });
});

describe("discovery (default runtime, Graph reader /me)", () => {
  const discovery = createInstagramDiscovery();

  it("returns exactly the connected professional account, minimum identity only", async () => {
    const grant = await exchange();
    fake.reset();
    const page = await discovery.listAccounts({ credential: grant.credential, attempt: 1 }, {});
    expect(page).toEqual({
      items: [
        {
          platform: "instagram",
          externalId: fake.users.business!.userId,
          username: fake.users.business!.username,
          accountType: "business",
        },
      ],
    });
    expect(fake.requests).toHaveLength(1); // budget: one request per discovery
  });

  it("fails closed on foreign credentials, cursors and identity changes", async () => {
    const auth = await failure(
      discovery.listAccounts({ credential: { kind: "mock" }, attempt: 1 }, {}),
    );
    expect([auth.kind, auth.providerCode]).toEqual(["auth", "credential_invalid"]);
    const grant = await exchange();
    const cursor = await failure(
      discovery.listAccounts({ credential: grant.credential, attempt: 1 }, { cursor: "x" }),
    );
    expect(cursor.kind).toBe("invalid_request");
    const mismatch = await failure(
      discovery.listAccounts(
        { credential: { ...grant.credential, userId: "17841400000000999" }, attempt: 1 },
        {},
      ),
    );
    expect([mismatch.kind, mismatch.providerCode]).toEqual(["data", "identity_mismatch"]);
  });

  it("never discovers personal accounts", async () => {
    const personal = {
      kind: "instagram",
      v: 1,
      accessToken: fake.issueLongLivedToken("personal"),
      tokenType: "long_lived",
      appId: FAKE_IG_APP_ID,
      userId: fake.users.personal!.userId,
      issuedAt: NOW,
    } satisfies InstagramCredential;
    const error = await failure(discovery.listAccounts({ credential: personal, attempt: 1 }, {}));
    expect([error.kind, error.providerCode]).toEqual(["permission", "account_type_unsupported"]);
  });
});
