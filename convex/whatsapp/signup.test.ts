import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import {
  CredentialUnavailableError,
  encryptCredential,
  withConnectionCredential,
} from "../connections/credentialStore";
import { credentialAad, decryptJson, loadKeyRing } from "../lib/crypto";
import { isMarketingError, type MarketingErrorCode } from "../lib/errors";
import { REFRESH_WINDOW_MS } from "../providers/instagram/config";
import {
  as,
  expectMarketingError,
  ISSUER_CRM,
  ISSUER_ERP,
  newBackend,
  seedOrg,
  type Backend,
} from "../test.helpers";
import { REGISTRATION_COOLDOWN_MS, SIGNUP_TIMEOUT_MS, WHATSAPP_ENV } from "./config";
import {
  createFakeWhatsAppGraph,
  FAKE_WA_APP_ID,
  FAKE_WA_CONFIG_ID,
  graphError,
  installFakeWhatsAppGraph,
  type FakeSignup,
  type FakeWhatsAppGraph,
} from "./fakeGraph.fixtures";
import {
  CUSTOMER_1,
  FAKE_WA_APP_SECRET,
  PHONE_A,
  PHONE_B,
  WABA_A,
  WABA_B,
  delivery,
  entry,
  postDelivery,
} from "./fakeWebhook.fixtures";
import { readWaba, subscribeApp } from "./graph";
import { failureReason } from "./signup";

// ADR 0014 (B2): WhatsApp Embedded Signup, server side, against a fake Graph that serves the
// onboarding calls as Meta documents them (convex/whatsapp/fakeGraph.fixtures.ts). Nothing here
// calls Meta. The org and actor always come from the test identity (a verified JWT stand-in).

const TOKEN_A = "EAAG-test-business-token-org-a";
const TOKEN_B = "EAAG-test-business-token-org-b";
const PHONE_A2 = "200000000000003";
const CLOUD_URL = "https://happy-otter-123.convex.cloud";
const USER_A = "user_1"; // the default test identity's subject
const SECRET_VALUES = [TOKEN_A, TOKEN_B, FAKE_WA_APP_SECRET];

let graph: FakeWhatsAppGraph;
let consoleCalls: unknown[][];

beforeEach(() => {
  graph = installFakeWhatsAppGraph();
  graph.addWaba({
    id: WABA_A,
    name: "Org A Business",
    numbers: [
      { id: PHONE_A, display_phone_number: "+1 555-000-0001" },
      { id: PHONE_A2, display_phone_number: "+1 555-000-0003" },
    ],
  });
  graph.addWaba({
    id: WABA_B,
    name: "Org B Business",
    numbers: [{ id: PHONE_B, display_phone_number: "+1 555-000-0002" }],
  });
  consoleCalls = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleCalls.push(args);
    });
  }
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup() {
  const t = newBackend();
  const orgA = await seedOrg(t, ISSUER_ERP, "42");
  const orgB = await seedOrg(t, ISSUER_CRM, "77");
  return { t, orgA, orgB };
}

type Caller = ReturnType<typeof as>;
const asB = (t: Backend, role = "admin") =>
  as(t, { issuer: ISSUER_CRM, org: "77", sub: "user_b", role });

function codeFor(overrides: Partial<FakeSignup> = {}): string {
  return graph.issueCode({ token: TOKEN_A, sharedWabas: [WABA_A], ...overrides });
}

async function complete(
  caller: Caller,
  input: Partial<{ code: string; wabaId: string; phoneNumberId: string }> = {},
) {
  return await caller.action(api.v1.whatsapp.completeSignup, {
    code: input.code ?? codeFor(),
    wabaId: input.wabaId ?? WABA_A,
    phoneNumberId: input.phoneNumberId ?? PHONE_A,
  });
}

/** The MarketingError a call fails with (code and sanitized details). */
async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isMarketingError(error)) throw error;
    return error.data;
  }
  throw new Error("expected the call to fail");
}

async function expectRefused(
  promise: Promise<unknown>,
  code: MarketingErrorCode,
  reason: string,
): Promise<void> {
  const data = await refusal(promise);
  expect(data.code).toBe(code);
  expect(data.details?.reason).toBe(reason);
  const text = JSON.stringify(data);
  for (const secret of SECRET_VALUES) expect(text).not.toContain(secret);
}

/** Every row a refused call must leave unchanged. */
async function state(t: Backend) {
  return await t.run(async (ctx) => ({
    connections: await ctx.db.query("connections").collect(),
    credentials: await ctx.db.query("credentials").collect(),
    accounts: await ctx.db.query("whatsappBusinessAccounts").collect(),
    numbers: await ctx.db.query("whatsappPhoneNumbers").collect(),
    audits: await ctx.db.query("auditLog").collect(),
  }));
}

async function storedCredential(t: Backend, connectionId: Id<"connections">) {
  const row = await t.query(internal.connections.credentialStore.loadForUse, { connectionId });
  if (row === null || row.encrypted === null) throw new Error("no credential");
  return (await decryptJson(
    await loadKeyRing(),
    row.encrypted,
    credentialAad(row.orgId, row.provider, row.externalUserId),
  )) as { kind: string; v: number; accessToken: string; pin: string };
}

function routes() {
  return graph.log.map((call) => call.route);
}

describe("completeSignup", () => {
  it("verifies the assets with Meta, stores the token encrypted, subscribes, then registers", async () => {
    const { t, orgA } = await setup();
    const result = await complete(as(t));
    expect(result).toEqual({ accountId: expect.any(String), status: "connected" });

    // Meta's documented order: exchange, inspect, verify assets, subscribe, register.
    expect(routes()).toEqual([
      "exchange",
      "debug_token",
      "waba",
      "phone_numbers",
      "subscribe",
      "register",
    ]);
    expect(graph.subscribed).toEqual(new Set([WABA_A]));

    const { connections, accounts, numbers, audits } = await state(t);
    expect(connections).toEqual([
      expect.objectContaining({
        orgId: orgA,
        provider: "whatsapp",
        externalUserId: WABA_A,
        displayName: "Org A Business",
        status: "active",
        grantedScopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
        connectedBySubject: USER_A,
      }),
    ]);
    expect(accounts).toEqual([
      expect.objectContaining({
        _id: result.accountId,
        orgId: orgA,
        wabaId: WABA_A,
        status: "active",
        subscribedAt: expect.any(Number),
        connectedBySubject: USER_A,
      }),
    ]);
    expect(accounts[0]!.setupError).toBeUndefined();
    expect(numbers).toEqual([
      expect.objectContaining({
        orgId: orgA,
        wabaId: WABA_A,
        phoneNumberId: PHONE_A,
        displayPhoneNumber: "+1 555-000-0001",
        status: "active",
        source: "embedded_signup",
        accountId: result.accountId,
        platformRegisteredAt: expect.any(Number),
        registrationAttempts: 1,
        registeredBySubject: USER_A,
      }),
    ]);
    expect(audits.map((a) => [a.action, a.subject])).toEqual(
      expect.arrayContaining([
        ["connection.connected", USER_A],
        ["whatsapp.number_registered", USER_A],
      ]),
    );

    // The stored credential: the business token and the PIN Meta registered the number with.
    const credential = await storedCredential(t, connections[0]!._id);
    expect(credential).toEqual({
      kind: "whatsapp",
      v: 1,
      accessToken: TOKEN_A,
      pin: expect.any(String),
    });
    expect(credential.pin).toMatch(/^\d{6}$/);
    expect(graph.registered.get(PHONE_A)).toBe(credential.pin);
  });

  it("routes webhook deliveries for the new number to the org", async () => {
    vi.useFakeTimers();
    const { t, orgA } = await setup();
    const now = Date.now();
    vi.setSystemTime(now - 60 * 60 * 1000); // connected an hour before the delivery
    await complete(as(t));
    vi.setSystemTime(now);
    const response = await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.signup-1", from: CUSTOMER_1, text: "hi" }] })),
    );
    expect(response.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const messages = await t.run(async (ctx) => await ctx.db.query("whatsappMessages").collect());
    expect(messages).toEqual([expect.objectContaining({ orgId: orgA, wamid: "wamid.signup-1" })]);
  });

  it("keeps the code, the token and the app secret out of storage, results, errors and logs", async () => {
    const { t } = await setup();
    const code = codeFor({ expiresAt: 1_900_000_000 });
    const result = await complete(as(t), { code });
    const failed = await refusal(complete(as(t), { code })); // single use: refused

    const rows = await state(t);
    const other = await t.run(async (ctx) => ({
      events: await ctx.db.query("whatsappWebhookEvents").collect(),
      states: await ctx.db.query("oauthStates").collect(),
      grants: await ctx.db.query("oauthGrants").collect(),
      jobs: await ctx.db.system.query("_scheduled_functions").collect(),
    }));
    const listed = await as(t, { role: "viewer" }).query(api.v1.whatsapp.listAccounts, {});
    const credential = await storedCredential(t, rows.connections[0]!._id);
    const surfaces = JSON.stringify({ rows, other, result, failed, listed, consoleCalls });
    for (const value of [...SECRET_VALUES, code]) expect(surfaces).not.toContain(value);
    // The PIN as a value (a bare 6-digit substring could occur inside a timestamp).
    expect(surfaces).not.toContain(`"${credential.pin}"`);
    expect(surfaces).not.toMatch(/"pin"/);
    expect(rows.connections[0]!.tokenExpiresAt).toBe(1_900_000_000_000);
  });

  it("sends the code and app secret only to the exchange, the token only as documented", async () => {
    const { t } = await setup();
    const code = codeFor();
    await complete(as(t), { code });
    for (const call of graph.log) {
      expect(call.version).toBe("v26.0");
      expect(call.url.startsWith("https://graph.facebook.com/v26.0/")).toBe(true);
      if (call.route === "exchange") {
        expect(call.params).toEqual({
          client_id: FAKE_WA_APP_ID,
          client_secret: FAKE_WA_APP_SECRET,
          code,
        });
        expect(call.authorization).toBe("");
        continue;
      }
      expect(call.url).not.toContain(code);
      expect(call.url).not.toContain(FAKE_WA_APP_SECRET);
      expect(call.params).not.toHaveProperty("access_token");
      if (call.route === "debug_token") {
        // Meta documents the inspected token in the query, authorized by the app token.
        expect(call.params).toEqual({ input_token: TOKEN_A });
        expect(call.authorization).toBe(`Bearer ${FAKE_WA_APP_ID}|${FAKE_WA_APP_SECRET}`);
        continue;
      }
      expect(call.url).not.toContain(TOKEN_A);
      expect(call.authorization).toBe(`Bearer ${TOKEN_A}`);
      expect(call.params.appsecret_proof).toMatch(/^[0-9a-f]{64}$/);
    }
    const register = graph.log.find((call) => call.route === "register")!;
    expect(register.body).toEqual({
      messaging_product: "whatsapp",
      pin: expect.stringMatching(/^\d{6}$/),
    });
  });

  it("finds the number on a later page of the WABA's numbers", async () => {
    const { t } = await setup();
    const many = Array.from({ length: 150 }, (_, i) => ({
      id: String(300000000000000 + i),
      display_phone_number: `+1 555-100-${String(i).padStart(4, "0")}`,
    }));
    graph.addWaba({ id: WABA_A, name: "Org A Business", numbers: many });
    const result = await complete(as(t), { phoneNumberId: many[149]!.id });
    expect(result.status).toBe("connected");
    expect(graph.calls("phone_numbers")).toBe(2);
  });

  it("records no expiry for a non-expiring token", async () => {
    const { t } = await setup();
    await complete(as(t));
    const [connection] = (await state(t)).connections;
    expect(connection!.tokenExpiresAt).toBeUndefined();
  });
});

describe("authorization and tenancy", () => {
  it("requires a signed-in admin: no Meta call, no code consumed, nothing written", async () => {
    const { t } = await setup();
    const code = codeFor();
    const before = await state(t);
    await expectMarketingError(
      t.action(api.v1.whatsapp.completeSignup, { code, wabaId: WABA_A, phoneNumberId: PHONE_A }),
      "UNAUTHENTICATED",
    );
    for (const role of ["editor", "viewer"]) {
      await expectMarketingError(complete(as(t, { role }), { code }), "FORBIDDEN");
      await expectMarketingError(
        as(t, { role }).action(api.v1.whatsapp.retrySetup, { accountId: "x" }),
        "FORBIDDEN",
      );
      await expectMarketingError(
        as(t, { role }).query(api.v1.whatsapp.getSignupConfig, {}),
        "FORBIDDEN",
      );
    }
    expect(graph.calls()).toBe(0);
    expect(await state(t)).toEqual(before);
    // The code was not consumed: the admin can still use it.
    expect((await complete(as(t), { code })).status).toBe("connected");
  });

  it("never accepts an organization from the browser", async () => {
    const { t, orgB } = await setup();
    await expect(
      as(t).action(api.v1.whatsapp.completeSignup, {
        code: codeFor(),
        wabaId: WABA_A,
        phoneNumberId: PHONE_A,
        // @ts-expect-error -- the org comes from the verified JWT only; the validator refuses it.
        orgId: orgB,
      }),
    ).rejects.toThrow(/Validator error/);
    expect(graph.calls()).toBe(0);
  });

  it("refuses a WABA the signup did not share with us (another org's WABA id)", async () => {
    const { t } = await setup();
    const before = await state(t);
    await expectRefused(
      complete(as(t), { wabaId: WABA_B, phoneNumberId: PHONE_B }),
      "INVALID_ARGUMENT",
      "waba_not_granted",
    );
    expect(routes()).toEqual(["exchange", "debug_token"]);
    expect(await state(t)).toEqual(before);
  });

  it("refuses a number that is not one of the WABA's numbers", async () => {
    const { t } = await setup();
    const before = await state(t);
    await expectRefused(
      complete(as(t), { phoneNumberId: PHONE_B }),
      "INVALID_ARGUMENT",
      "phone_number_not_in_waba",
    );
    expect(routes()).toEqual(["exchange", "debug_token", "waba", "phone_numbers"]);
    expect(await state(t)).toEqual(before);
  });

  it("refuses a WABA another org has active, before any write or setup call", async () => {
    const { t } = await setup();
    await complete(as(t)); // org A connects WABA_A with PHONE_A
    const before = await state(t);
    graph.log.length = 0;
    // Org B holds a genuine grant for the same WABA and picks its other number.
    const code = graph.issueCode({ token: TOKEN_B, sharedWabas: [WABA_A] });
    await expectRefused(
      complete(asB(t), { code, phoneNumberId: PHONE_A2 }),
      "CONFLICT",
      "waba_in_use",
    );
    expect(routes()).not.toContain("subscribe");
    expect(routes()).not.toContain("register");
    expect(await state(t)).toEqual(before);
  });

  it("refuses a number another org has active, before any write or setup call", async () => {
    const { t, orgB } = await setup();
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgB,
      wabaId: WABA_A,
      phoneNumberId: PHONE_A,
      actorSubject: "operator:test",
    });
    const before = await state(t);
    await expectRefused(complete(as(t)), "CONFLICT", "phone_number_in_use");
    expect(routes()).toEqual(["exchange", "debug_token", "waba", "phone_numbers"]);
    expect(await state(t)).toEqual(before);
  });

  it("keeps accounts per org: listAccounts and retrySetup never reach another org's account", async () => {
    const { t } = await setup();
    const a = await complete(as(t));
    const code = graph.issueCode({ token: TOKEN_B, sharedWabas: [WABA_B] });
    const b = await complete(asB(t), { code, wabaId: WABA_B, phoneNumberId: PHONE_B });

    const listA = await as(t, { role: "viewer" }).query(api.v1.whatsapp.listAccounts, {});
    const listB = await asB(t, "viewer").query(api.v1.whatsapp.listAccounts, {});
    expect(listA.map((account) => account.id)).toEqual([a.accountId]);
    expect(listB.map((account) => account.id)).toEqual([b.accountId]);

    graph.log.length = 0;
    await expectMarketingError(
      as(t).action(api.v1.whatsapp.retrySetup, { accountId: b.accountId }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t).action(api.v1.whatsapp.retrySetup, { accountId: "not-an-id" }),
      "NOT_FOUND",
    );
    expect(graph.calls()).toBe(0);
  });
});

describe("invalid or missing Meta assets", () => {
  it("refuses malformed input without calling Meta", async () => {
    const { t } = await setup();
    const before = await state(t);
    for (const code of ["", "has space", "x".repeat(4097), "código"]) {
      await expectRefused(complete(as(t), { code }), "INVALID_ARGUMENT", "invalid_code");
    }
    for (const ids of [{ wabaId: "waba" }, { phoneNumberId: "1e5" }, { wabaId: "" }]) {
      await expectRefused(complete(as(t), ids), "INVALID_ARGUMENT", "invalid_id");
    }
    expect(graph.calls()).toBe(0);
    expect(await state(t)).toEqual(before);
  });

  it("refuses an unknown, expired or reused code", async () => {
    const { t } = await setup();
    await expectRefused(
      complete(as(t), { code: "AQ-unknown" }),
      "INVALID_ARGUMENT",
      "signup_code_invalid",
    );
    const code = codeFor();
    await complete(as(t), { code });
    const before = await state(t);
    await expectRefused(complete(as(t), { code }), "INVALID_ARGUMENT", "signup_code_invalid");
    expect(await state(t)).toEqual(before);
  });

  it("reports Meta outages before anything is stored as retryable provider errors", async () => {
    const { t } = await setup();
    const before = await state(t);
    graph.failNext("exchange", { status: 503 });
    let data = await refusal(complete(as(t)));
    expect(data).toMatchObject({
      code: "PROVIDER_ERROR",
      details: { stage: "code_exchange", reason: "http_503", retryable: true },
    });
    graph.failNext("exchange", { status: 200, body: { token_type: "bearer" } });
    data = await refusal(complete(as(t)));
    expect(data).toMatchObject({ code: "PROVIDER_ERROR", details: { stage: "code_exchange" } });
    graph.failNext("debug_token", "network");
    data = await refusal(complete(as(t)));
    expect(data).toMatchObject({
      code: "PROVIDER_ERROR",
      details: { stage: "token_inspection", reason: "network", retryable: true },
    });
    graph.failNext("phone_numbers", "invalid_json");
    data = await refusal(complete(as(t)));
    expect(data).toMatchObject({ code: "PROVIDER_ERROR", details: { stage: "phone_numbers" } });
    expect(await state(t)).toEqual(before);
  });

  it("refuses tokens that are invalid, for another app or missing a permission", async () => {
    const { t } = await setup();
    const before = await state(t);
    await expectRefused(
      complete(as(t), { code: codeFor({ isValid: false }) }),
      "INVALID_ARGUMENT",
      "token_invalid",
    );
    await expectRefused(
      complete(as(t), { code: codeFor({ appId: "999" }) }),
      "INVALID_ARGUMENT",
      "token_wrong_app",
    );
    await expectRefused(
      complete(as(t), { code: codeFor({ scopes: ["whatsapp_business_management"] }) }),
      "INVALID_ARGUMENT",
      "scopes_missing",
    );
    expect(await state(t)).toEqual(before);
  });

  it("refuses a WABA the token cannot read, or one Meta answers with another id", async () => {
    const { t } = await setup();
    const before = await state(t);
    graph.failNext("waba", graphError(100, 400, 33));
    await expectRefused(complete(as(t)), "INVALID_ARGUMENT", "waba_not_accessible");
    graph.failNext("waba", { status: 200, body: { id: WABA_B, name: "Other" } });
    await expectRefused(complete(as(t)), "INVALID_ARGUMENT", "waba_not_accessible");
    expect(await state(t)).toEqual(before);
  });
});

describe("partial failures and retries", () => {
  it("keeps the connection when the subscription fails, and registers only after it", async () => {
    const { t } = await setup();
    graph.failNext("subscribe", { status: 503 });
    const result = await complete(as(t));
    expect(result).toEqual({
      accountId: result.accountId,
      status: "action_required",
      nextStep: "subscribe",
      reason: "http_503",
    });
    expect(routes()).not.toContain("register");
    const { connections, numbers } = await state(t);
    expect(connections[0]).toMatchObject({ status: "active" });
    expect(numbers[0]).toMatchObject({ status: "active" }); // inbound routing already works
    expect(numbers[0]!.platformRegisteredAt).toBeUndefined();

    graph.log.length = 0;
    const retried = await as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId });
    expect(retried).toEqual({ accountId: result.accountId, status: "connected" });
    expect(routes()).toEqual(["subscribe", "register"]);
    const [account] = (await state(t)).accounts;
    expect(account!.setupError).toBeUndefined();
  });

  it("treats a subscription answer without success:true as a failure", async () => {
    const { t } = await setup();
    graph.failNext("subscribe", { status: 200, body: { success: false } });
    const result = await complete(as(t));
    expect(result).toMatchObject({ status: "action_required", reason: "unexpected_response" });
  });

  it("records a failed registration, and retries only the registration with the stored PIN", async () => {
    const { t } = await setup();
    graph.failNext("register", { status: 503 });
    const result = await complete(as(t));
    expect(result).toMatchObject({
      status: "action_required",
      nextStep: "register",
      reason: "http_503",
    });
    expect((await state(t)).numbers[0]).toMatchObject({ registrationAttempts: 1 });

    graph.log.length = 0;
    const retried = await as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId });
    expect(retried.status).toBe("connected");
    expect(routes()).toEqual(["register"]);
    const { numbers, connections } = await state(t);
    expect(numbers[0]).toMatchObject({
      registrationAttempts: 2,
      platformRegisteredAt: expect.any(Number),
    });
    expect(graph.registered.get(PHONE_A)).toBe(
      (await storedCredential(t, connections[0]!._id)).pin,
    );
  });

  it("makes no registration call for 72 hours after Meta's rate limit (133016)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { t } = await setup();
    graph.failNext("register", graphError(133016));
    const result = await complete(as(t));
    expect(result).toMatchObject({ status: "action_required", reason: "meta_133016" });
    const [number] = (await state(t)).numbers;
    expect(number!.registrationBlockedUntil).toBe(Date.now() + REGISTRATION_COOLDOWN_MS);
    const [listed] = await as(t).query(api.v1.whatsapp.listAccounts, {});
    expect(listed!.numbers[0]!.registrationRetryAfter).toBe(
      new Date(number!.registrationBlockedUntil!).toISOString(),
    );

    graph.log.length = 0;
    vi.setSystemTime(Date.now() + REGISTRATION_COOLDOWN_MS - 1000);
    const early = await as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId });
    expect(early).toMatchObject({
      status: "action_required",
      nextStep: "register",
      reason: "registration_rate_limited",
    });
    expect(graph.calls()).toBe(0);
    expect((await state(t)).numbers[0]).toMatchObject({ registrationAttempts: 1 });

    vi.setSystemTime(number!.registrationBlockedUntil! + 1);
    const later = await as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId });
    expect(later.status).toBe("connected");
    expect(routes()).toEqual(["register"]);
    expect((await state(t)).numbers[0]!.registrationBlockedUntil).toBeUndefined();
  });

  it("does not support numbers with an existing two-step PIN: registration fails and is recorded", async () => {
    const { t } = await setup();
    graph.failNext("register", graphError(100)); // the fake does not model Meta's exact code
    const result = await complete(as(t));
    expect(result).toMatchObject({
      status: "action_required",
      nextStep: "register",
      reason: "meta_100",
    });
    const listed = await as(t).query(api.v1.whatsapp.listAccounts, {});
    expect(listed[0]).toMatchObject({
      setupStatus: "action_required",
      nextStep: "register",
      setupReason: "meta_100",
      numbers: [expect.objectContaining({ phoneNumberId: PHONE_A, registered: false })],
    });
  });

  it("stops registering after the attempt cap", async () => {
    const { t } = await setup();
    graph.failNext("register", { status: 503 });
    const result = await complete(as(t));
    await t.run(async (ctx) => {
      const number = (await ctx.db.query("whatsappPhoneNumbers").collect())[0]!;
      await ctx.db.patch(number._id, { registrationAttempts: 5 });
    });
    graph.log.length = 0;
    const retried = await as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId });
    expect(retried).toMatchObject({
      status: "action_required",
      nextStep: "register",
      reason: "registration_attempts_exhausted",
    });
    expect(graph.calls()).toBe(0);
  });

  it("does nothing at Meta when retrying a connected account", async () => {
    const { t } = await setup();
    const result = await complete(as(t));
    graph.log.length = 0;
    const retried = await as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId });
    expect(retried).toEqual({ accountId: result.accountId, status: "connected" });
    expect(graph.calls()).toBe(0);
  });

  it("refuses a retry for a disconnected account or a missing credential", async () => {
    const { t } = await setup();
    graph.failNext("subscribe", "network");
    const result = await complete(as(t));
    expect(result).toMatchObject({ reason: "network" });

    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("credentials").collect()) await ctx.db.delete(row._id);
    });
    await expectRefused(
      as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId }),
      "CONFLICT",
      "reconnect_required",
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(result.accountId as Id<"whatsappBusinessAccounts">, {
        status: "disconnected",
      });
    });
    await expectRefused(
      as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId }),
      "CONFLICT",
      "account_disconnected",
    );
    expect(routes()).not.toContain("register");
  });
});

describe("duplicate signup", () => {
  it("reconnects the same WABA: one connection, new token, same PIN, no second registration", async () => {
    const { t } = await setup();
    const first = await complete(as(t));
    const before = await state(t);
    const firstPin = (await storedCredential(t, before.connections[0]!._id)).pin;

    graph.log.length = 0;
    const second = await complete(as(t), {
      code: graph.issueCode({ token: TOKEN_B, sharedWabas: [WABA_A] }),
    });
    expect(second).toEqual({ accountId: first.accountId, status: "connected" });
    expect(routes()).not.toContain("register"); // already registered at Meta
    const after = await state(t);
    expect(after.connections).toHaveLength(1);
    expect(after.accounts).toHaveLength(1);
    expect(after.numbers).toHaveLength(1);
    expect(after.connections[0]).toMatchObject({ credentialVersion: 2 });
    const credential = await storedCredential(t, after.connections[0]!._id);
    expect(credential).toMatchObject({ accessToken: TOKEN_B, pin: firstPin });
    expect(after.audits.map((a) => a.action)).toContain("connection.reconnected");
  });

  it("refuses to replace a stored PIN it cannot read, and writes nothing", async () => {
    const { t } = await setup();
    await complete(as(t));
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("credentials").first())!;
      const bytes = new Uint8Array(row.ciphertext.slice(0));
      bytes[0] = bytes[0]! ^ 0xff;
      await ctx.db.patch(row._id, { ciphertext: bytes.buffer });
    });
    const before = await state(t);
    graph.log.length = 0;
    await expectRefused(
      complete(as(t), { code: graph.issueCode({ token: TOKEN_B, sharedWabas: [WABA_A] }) }),
      "CONFLICT",
      "stored_pin_unavailable",
    );
    expect(routes()).toEqual(["exchange", "debug_token", "waba", "phone_numbers"]);
    expect(await state(t)).toEqual(before);
  });
});

describe("operator-managed numbers", () => {
  async function operatorRegister(t: Backend, orgId: Id<"organizations">) {
    const result = await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId,
      wabaId: WABA_A,
      phoneNumberId: PHONE_A,
      actorSubject: "operator:test",
    });
    if (!result.ok) throw new Error(result.reason);
    return result.numberId;
  }

  it("refuses this org's operator-managed number: no write, no Meta write, routing unchanged", async () => {
    vi.useFakeTimers();
    const { t, orgA } = await setup();
    const now = Date.now();
    vi.setSystemTime(now - 60 * 60 * 1000); // routed by the operator an hour ago
    await operatorRegister(t, orgA);
    vi.setSystemTime(now);
    const before = await state(t);

    await expectRefused(complete(as(t)), "CONFLICT", "phone_number_operator_managed");
    expect(routes()).toEqual(["exchange", "debug_token", "waba", "phone_numbers"]);
    expect(graph.subscribed.size).toBe(0);
    expect(graph.registered.size).toBe(0);
    const after = await state(t);
    expect(after).toEqual(before);
    expect(after.numbers).toEqual([
      expect.objectContaining({ orgId: orgA, source: "operator", status: "active" }),
    ]);
    expect(after.numbers[0]!.accountId).toBeUndefined();

    // Inbound messages for the number still reach the org through the operator routing.
    const response = await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.operator-1", from: CUSTOMER_1, text: "hi" }] })),
    );
    expect(response.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const messages = await t.run(async (ctx) => await ctx.db.query("whatsappMessages").collect());
    expect(messages).toEqual([expect.objectContaining({ orgId: orgA, wamid: "wamid.operator-1" })]);
  });

  it("also refuses it once the operator disconnected it (its two-step PIN is not ours)", async () => {
    const { t, orgA } = await setup();
    const numberId = await operatorRegister(t, orgA);
    await t.mutation(internal.whatsapp.phoneNumbers.disconnect, {
      numberId,
      actorSubject: "operator:test",
    });
    const before = await state(t);
    await expectRefused(complete(as(t)), "CONFLICT", "phone_number_operator_managed");
    expect(graph.registered.size).toBe(0);
    expect(await state(t)).toEqual(before);
  });
});

describe("token expiry and reauthorization", () => {
  it("moves the connection to needs_reauth when Meta refuses the token, and never retries with it", async () => {
    const { t } = await setup();
    graph.failNext("subscribe", graphError(190, 400, 463));
    const result = await complete(as(t));
    expect(result).toEqual({
      accountId: result.accountId,
      status: "reauthorization_required",
      reason: "token_invalid",
    });
    expect(routes()).not.toContain("register");
    const { connections, audits } = await state(t);
    expect(connections[0]).toMatchObject({
      status: "needs_reauth",
      lastError: { kind: "auth", message: "Re-authorization required" },
    });
    expect(audits.find((a) => a.action === "connection.needs_reauth")).toMatchObject({
      subject: USER_A,
      changes: { reason: { from: null, to: "whatsapp_token_invalid" } },
    });
    const pin = (await storedCredential(t, connections[0]!._id)).pin;

    graph.log.length = 0;
    await expectRefused(
      as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId }),
      "CONFLICT",
      "reconnect_required",
    );
    expect(graph.calls()).toBe(0);
    const [listed] = await as(t, { role: "viewer" }).query(api.v1.whatsapp.listAccounts, {});
    expect(listed).toMatchObject({
      setupStatus: "reauthorization_required",
      setupReason: "token_invalid",
    });
    expect(listed!.nextStep).toBeUndefined();

    // A new signup reconnects: active again, the stored PIN kept.
    const again = await complete(as(t), {
      code: graph.issueCode({ token: TOKEN_B, sharedWabas: [WABA_A] }),
    });
    expect(again.status).toBe("connected");
    const after = await state(t);
    expect(after.connections[0]).toMatchObject({ status: "active" });
    expect(after.connections[0]!.lastError).toBeUndefined();
    expect((await storedCredential(t, after.connections[0]!._id)).pin).toBe(pin);
    expect(graph.registered.get(PHONE_A)).toBe(pin);
  });

  it("treats an HTTP 401 on registration as a refused token", async () => {
    const { t } = await setup();
    graph.failNext("register", { status: 401, body: {} });
    const result = await complete(as(t));
    expect(result).toMatchObject({ status: "reauthorization_required", reason: "token_invalid" });
    const { connections, numbers } = await state(t);
    expect(connections[0]).toMatchObject({ status: "needs_reauth" });
    expect(numbers[0]).toMatchObject({ registrationAttempts: 1 });
  });

  it("expires WhatsApp tokens like the others, never refreshes them, and leaves Meta Ads, Google Ads and Instagram unchanged", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { t, orgA } = await setup();
    const now = Date.now();
    const expiresAt = Math.floor((now + 5 * 24 * 60 * 60 * 1000) / 1000) * 1000;
    expect(expiresAt - now).toBeLessThan(REFRESH_WINDOW_MS);
    const result = await complete(as(t), { code: codeFor({ expiresAt: expiresAt / 1000 }) });
    const others = await t.run(async (ctx) => {
      const ids: Record<string, Id<"connections">> = {};
      for (const provider of ["meta", "google_ads", "instagram"] as const) {
        ids[provider] = await ctx.db.insert("connections", {
          orgId: orgA,
          provider,
          externalUserId: `ext-${provider}`,
          status: "active",
          grantedScopes: [],
          credentialVersion: 1,
          tokenExpiresAt: expiresAt,
          connectedBySubject: USER_A,
          connectedAt: now,
          createdAt: now,
          updatedAt: now,
        });
      }
      return ids;
    });
    const whatsapp = (await state(t)).connections.find((c) => c.provider === "whatsapp")!;
    expect(whatsapp.tokenExpiresAt).toBe(expiresAt);

    // The generic refresh job: Instagram only, as before; WhatsApp never reaches it.
    expect(
      await t.query(internal.connections.tokenRefresh.refreshCandidates, { now: Date.now() }),
    ).toEqual([others.instagram]);
    graph.log.length = 0;
    expect(await t.action(internal.connections.tokenRefresh.refreshExpiringTokens, {})).toEqual({
      refreshed: 0,
      superseded: 0,
      skipped: 1, // the seeded Instagram row has no credential
      reauth: 0,
      failed: 0,
    });
    expect(graph.calls()).toBe(0);
    expect((await t.run(async (ctx) => await ctx.db.get(whatsapp._id)))!).toEqual(whatsapp);

    // The health sweep after expiry: every provider moves to needs_reauth the same way.
    vi.setSystemTime(expiresAt + 1);
    expect(await t.mutation(internal.connections.maintenance.sweep, {})).toMatchObject({
      expired: 4,
    });
    const { connections, audits, numbers } = await state(t);
    for (const connection of connections) {
      expect(connection, connection.provider).toMatchObject({
        status: "needs_reauth",
        lastError: { kind: "auth", message: "Access token expired" },
      });
    }
    expect(
      audits
        .filter((a) => a.action === "connection.needs_reauth")
        .map((a) => a.changes?.reason?.to),
    ).toEqual(["token_expired", "token_expired", "token_expired", "token_expired"]);
    expect(numbers[0]).toMatchObject({ status: "active" }); // inbound routing is unaffected

    const [listed] = await as(t).query(api.v1.whatsapp.listAccounts, {});
    expect(listed!.setupStatus).toBe("reauthorization_required");
    await expectRefused(
      as(t).action(api.v1.whatsapp.retrySetup, { accountId: result.accountId }),
      "CONFLICT",
      "reconnect_required",
    );
    expect(graph.calls()).toBe(0);
  });

  it("reads a needs_reauth credential only when asked to (the PIN on reconnect)", async () => {
    const binding = {
      orgId: "org" as Id<"organizations">,
      provider: "whatsapp" as const,
      externalUserId: WABA_A,
    };
    const encrypted = await encryptCredential(binding, {
      kind: "whatsapp",
      v: 1,
      accessToken: TOKEN_A,
      pin: "123456",
    });
    let status = "needs_reauth";
    const ctx = {
      runQuery: async () => ({ ...binding, status, credentialVersion: 1, encrypted }),
    } as unknown as ActionCtx;
    const id = "c" as Id<"connections">;
    const pinOf = async (credential: unknown) => (credential as { pin: string }).pin;

    await expect(withConnectionCredential(ctx, id, pinOf)).rejects.toBeInstanceOf(
      CredentialUnavailableError,
    );
    await expect(
      withConnectionCredential(ctx, id, pinOf, { allowRevoked: true }),
    ).rejects.toBeInstanceOf(CredentialUnavailableError);
    expect(await withConnectionCredential(ctx, id, pinOf, { allowNeedsReauth: true })).toBe(
      "123456",
    );
    status = "revoked";
    await expect(
      withConnectionCredential(ctx, id, pinOf, { allowNeedsReauth: true }),
    ).rejects.toBeInstanceOf(CredentialUnavailableError);
  });
});

describe("concurrent setup calls", () => {
  /**
   * Holds every register call until `expected` have arrived or `ms` passed, so concurrent
   * actions that would both call Meta really overlap there.
   */
  function holdRegisterCalls(expected: number, ms = 500) {
    const inner = graph.fetch;
    let arrived = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, ms);
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("/register")) {
        arrived += 1;
        if (arrived >= expected) release();
        await gate;
      }
      return await inner(input, init);
    });
  }

  it("registers a number once when two retries run at the same time", async () => {
    const { t } = await setup();
    graph.failNext("register", { status: 503 });
    const first = await complete(as(t));
    expect(first).toMatchObject({ status: "action_required", nextStep: "register" });
    graph.log.length = 0;
    holdRegisterCalls(2);

    const results = await Promise.all([
      as(t).action(api.v1.whatsapp.retrySetup, { accountId: first.accountId }),
      as(t).action(api.v1.whatsapp.retrySetup, { accountId: first.accountId }),
    ]);
    expect(graph.calls("register")).toBe(1);
    expect(results.map((r) => r.status)).toContain("connected");
    for (const result of results) {
      if (result.status !== "connected") {
        expect(result).toMatchObject({ nextStep: "register", reason: "registration_in_progress" });
      }
    }
    const [number] = (await state(t)).numbers;
    expect(number).toMatchObject({
      registrationAttempts: 2, // the first signup's attempt and exactly one retry
      platformRegisteredAt: expect.any(Number),
    });
    expect(number!.registrationClaimedUntil).toBeUndefined();
  });

  it("lets only one of two concurrent first signups store a PIN and register", async () => {
    const { t } = await setup();
    holdRegisterCalls(2);
    const settled = await Promise.allSettled([
      complete(as(t), { code: graph.issueCode({ token: TOKEN_A, sharedWabas: [WABA_A] }) }),
      complete(as(t), { code: graph.issueCode({ token: TOKEN_B, sharedWabas: [WABA_A] }) }),
    ]);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    const rejected = settled.filter((s) => s.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const error = (rejected[0] as PromiseRejectedResult).reason as unknown;
    expect(isMarketingError(error) && error.data).toMatchObject({
      code: "CONFLICT",
      details: { reason: "signup_in_progress" },
    });

    const register = graph.log.filter((call) => call.route === "register");
    expect(register).toHaveLength(1);
    const { connections } = await state(t);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ credentialVersion: 1 });
    const stored = await storedCredential(t, connections[0]!._id);
    expect((register[0]!.body as { pin: string }).pin).toBe(stored.pin);
    expect(graph.registered.get(PHONE_A)).toBe(stored.pin);
  });

  it("does not call Meta while another call's claim is live, and resumes once it expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { t } = await setup();
    graph.failNext("register", { status: 503 });
    const first = await complete(as(t));
    // As if a registration call were in flight (or its action had crashed mid-call).
    await t.run(async (ctx) => {
      const number = (await ctx.db.query("whatsappPhoneNumbers").first())!;
      await ctx.db.patch(number._id, { registrationClaimedUntil: Date.now() + 10_000 });
    });
    graph.log.length = 0;
    const held = await as(t).action(api.v1.whatsapp.retrySetup, { accountId: first.accountId });
    expect(held).toMatchObject({
      status: "action_required",
      nextStep: "register",
      reason: "registration_in_progress",
    });
    expect(graph.calls()).toBe(0);

    vi.setSystemTime(Date.now() + 10_001);
    const resumed = await as(t).action(api.v1.whatsapp.retrySetup, { accountId: first.accountId });
    expect(resumed.status).toBe("connected");
    expect(routes()).toEqual(["register"]);
  });

  it("never subscribes an account that has no active number", async () => {
    const { t, orgA } = await setup();
    const encrypted = await encryptCredential(
      { orgId: orgA, provider: "whatsapp", externalUserId: WABA_A },
      { kind: "whatsapp", v: 1, accessToken: TOKEN_A, pin: "123456" },
    );
    const recorded = await t.mutation(internal.whatsapp.accounts.recordConnection, {
      orgId: orgA,
      issuer: ISSUER_ERP,
      actorSubject: USER_A,
      wabaId: WABA_A,
      onboardingType: "cloud_api",
      grantedScopes: ["whatsapp_business_management", "whatsapp_business_messaging"],
      encrypted,
    });
    if (!recorded.ok) throw new Error(recorded.reason);

    const retried = await as(t).action(api.v1.whatsapp.retrySetup, {
      accountId: recorded.accountId,
    });
    expect(retried).toEqual({
      accountId: recorded.accountId,
      status: "action_required",
      reason: "no_active_number",
    });
    expect(graph.calls()).toBe(0);
    expect(graph.subscribed.size).toBe(0);
    const [listed] = await as(t).query(api.v1.whatsapp.listAccounts, {});
    expect(listed).toMatchObject({
      setupStatus: "action_required",
      setupReason: "no_active_number",
    });
    expect(listed!.nextStep).toBeUndefined();
  });
});

describe("feature gate and configuration", () => {
  it("stays closed on cloud deployments until WHATSAPP_CONNECTIONS_ENABLED is exactly true", async () => {
    const { t } = await setup();
    vi.stubEnv("CONVEX_CLOUD_URL", CLOUD_URL);
    const before = await state(t);
    for (const value of [undefined, "", "TRUE", "1"]) {
      vi.stubEnv(WHATSAPP_ENV.connectionsEnabled, value);
      await expectRefused(complete(as(t)), "INVALID_ARGUMENT", "connections_disabled");
      await expectRefused(
        as(t).action(api.v1.whatsapp.retrySetup, { accountId: "x" }),
        "INVALID_ARGUMENT",
        "connections_disabled",
      );
      expect(await as(t).query(api.v1.whatsapp.getSignupConfig, {})).toEqual({
        available: false,
        graphApiVersion: "v26.0",
        embeddedSignupVersion: "v4",
      });
    }
    expect(graph.calls()).toBe(0);
    expect(await state(t)).toEqual(before);

    vi.stubEnv(WHATSAPP_ENV.connectionsEnabled, "true");
    expect(await as(t).query(api.v1.whatsapp.getSignupConfig, {})).toMatchObject({
      available: true,
    });
    expect((await complete(as(t))).status).toBe("connected");
  });

  it("fails closed without the Meta app configuration", async () => {
    const { t } = await setup();
    for (const name of [WHATSAPP_ENV.appId, WHATSAPP_ENV.signupConfigId, WHATSAPP_ENV.appSecret]) {
      vi.stubEnv(name, undefined);
      await expectRefused(complete(as(t)), "INTERNAL", "not_configured");
      expect(await as(t).query(api.v1.whatsapp.getSignupConfig, {})).toMatchObject({
        available: false,
      });
      installFakeWhatsAppGraph(graph);
    }
    expect(graph.calls()).toBe(0);
  });

  it("gives admins the public values Embedded Signup needs, and nothing else", async () => {
    const { t } = await setup();
    const config = await as(t).query(api.v1.whatsapp.getSignupConfig, {});
    expect(config).toEqual({
      available: true,
      appId: FAKE_WA_APP_ID,
      configId: FAKE_WA_CONFIG_ID,
      graphApiVersion: "v26.0",
      embeddedSignupVersion: "v4",
    });
    expect(JSON.stringify(config)).not.toContain(FAKE_WA_APP_SECRET);
  });
});

describe("Graph client", () => {
  const auth = { accessToken: TOKEN_A, appSecret: FAKE_WA_APP_SECRET };

  it("times out a hanging call and reports only the failure kind", async () => {
    const fake = createFakeWhatsAppGraph();
    vi.stubGlobal("fetch", fake.fetch);
    vi.useFakeTimers();
    fake.failNext("subscribe", "hang");
    const pending = subscribeApp(WABA_A, auth);
    await vi.waitFor(() => expect(fake.calls()).toBe(1));
    await vi.advanceTimersByTimeAsync(SIGNUP_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, failure: { kind: "timeout" } });
  });

  it("returns Meta's numeric codes only, never message text", async () => {
    const fake = createFakeWhatsAppGraph();
    vi.stubGlobal("fetch", fake.fetch);
    fake.failNext("waba", graphError(190, 401, 463));
    expect(await readWaba(WABA_A, auth)).toEqual({
      ok: false,
      failure: { kind: "http", status: 401, metaCode: 190, metaSubcode: 463 },
    });
    expect(failureReason({ kind: "http", status: 401, metaCode: 190 })).toBe("meta_190");
    expect(failureReason({ kind: "http", status: 502 })).toBe("http_502");
    expect(failureReason({ kind: "timeout" })).toBe("timeout");
  });

  it("never puts a non-numeric id into a Graph path", async () => {
    const fake = createFakeWhatsAppGraph();
    vi.stubGlobal("fetch", fake.fetch);
    await expect(readWaba("../me", auth)).rejects.toThrow("Invalid Graph node id");
    expect(fake.calls()).toBe(0);
  });
});
