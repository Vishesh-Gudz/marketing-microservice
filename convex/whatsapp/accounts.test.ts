import { afterEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { encryptCredential } from "../connections/credentialStore";
import { credentialAad, decryptJson, loadKeyRing } from "../lib/crypto";
import {
  as,
  expectMarketingError,
  ISSUER_CRM,
  ISSUER_ERP,
  newBackend,
  RETURN_URL,
  seedOrg,
  type Backend,
} from "../test.helpers";
import { REGISTRATION_CLAIM_MS } from "./accounts";
import { whatsappConnectionsEnabled } from "./config";
import {
  CUSTOMER_1,
  PHONE_A,
  PHONE_B,
  WABA_A,
  WABA_B,
  delivery,
  entry,
  postDelivery,
  stubWhatsAppEnv,
} from "./fakeWebhook.fixtures";

// ADR 0014: the database side of WhatsApp connections (one connection and account per
// (org, WABA); the WABA id is the connection key). Everything is in-process (convex-test); the
// Embedded Signup action is tested in convex/whatsapp/signup.test.ts.

const ADMIN = "user_admin_1";
const SCOPES = ["whatsapp_business_management", "whatsapp_business_messaging"];
const CLOUD_URL = "https://happy-otter-123.convex.cloud";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function setup() {
  const t = newBackend();
  const orgA = await seedOrg(t, ISSUER_ERP, "42");
  const orgB = await seedOrg(t, ISSUER_CRM, "77");
  return { t, orgA, orgB };
}

/** What the signup action stores: the business token and PIN, encrypted for (org, WABA). */
async function encryptedToken(orgId: Id<"organizations">, wabaId: string, token: string) {
  return await encryptCredential(
    { orgId, provider: "whatsapp", externalUserId: wabaId },
    { kind: "whatsapp", v: 1, accessToken: token, pin: "123456" },
  );
}

async function record(
  t: Backend,
  orgId: Id<"organizations">,
  overrides: Partial<{
    wabaId: string;
    actorSubject: string;
    token: string;
    issuer: string;
    expectedCredentialVersion: number | null;
    phoneNumberId: string;
  }> = {},
) {
  const wabaId = overrides.wabaId ?? WABA_A;
  return await t.mutation(internal.whatsapp.accounts.recordConnection, {
    orgId,
    issuer: overrides.issuer ?? ISSUER_ERP,
    actorSubject: overrides.actorSubject ?? ADMIN,
    wabaId,
    onboardingType: "cloud_api",
    displayName: "Test Business",
    grantedScopes: SCOPES,
    encrypted: await encryptedToken(orgId, wabaId, overrides.token ?? "token-1"),
    ...(overrides.expectedCredentialVersion !== undefined
      ? { expectedCredentialVersion: overrides.expectedCredentialVersion }
      : {}),
    ...(overrides.phoneNumberId !== undefined
      ? { number: { phoneNumberId: overrides.phoneNumberId, displayPhoneNumber: "+000001" } }
      : {}),
  });
}

async function connected(t: Backend, orgId: Id<"organizations">, wabaId = WABA_A) {
  const result = await record(t, orgId, { wabaId });
  if (!result.ok) throw new Error(`recordConnection failed: ${result.reason}`);
  return result;
}

/** Everything a refused call must leave unchanged. */
async function state(t: Backend) {
  return await t.run(async (ctx) => ({
    connections: await ctx.db.query("connections").collect(),
    credentials: await ctx.db.query("credentials").collect(),
    accounts: await ctx.db.query("whatsappBusinessAccounts").collect(),
    numbers: await ctx.db.query("whatsappPhoneNumbers").collect(),
    audits: await ctx.db.query("auditLog").collect(),
  }));
}

async function decryptStored(t: Backend, connectionId: Id<"connections">, aad?: string) {
  const row = await t.query(internal.connections.credentialStore.loadForUse, { connectionId });
  if (row === null || row.encrypted === null) throw new Error("no credential");
  return await decryptJson(
    await loadKeyRing(),
    row.encrypted,
    aad ?? credentialAad(row.orgId, row.provider, row.externalUserId),
  );
}

describe("recordConnection", () => {
  it("creates the whatsapp connection, its credential and the account, audited as the admin", async () => {
    const { t, orgA } = await setup();
    const result = await connected(t, orgA);
    expect(result.reconnected).toBe(false);

    const { connections, credentials, accounts, audits } = await state(t);
    expect(connections).toEqual([
      expect.objectContaining({
        orgId: orgA,
        provider: "whatsapp",
        externalUserId: WABA_A,
        displayName: "Test Business",
        status: "active",
        grantedScopes: SCOPES,
        credentialVersion: 1,
        connectedBySubject: ADMIN,
      }),
    ]);
    expect(connections[0]!.tokenExpiresAt).toBeUndefined();
    expect(credentials).toHaveLength(1);
    expect(credentials[0]).toMatchObject({ orgId: orgA, connectionId: result.connectionId });
    expect(accounts).toEqual([
      expect.objectContaining({
        _id: result.accountId,
        orgId: orgA,
        connectionId: result.connectionId,
        wabaId: WABA_A,
        onboardingType: "cloud_api",
        status: "active",
        connectedBySubject: ADMIN,
      }),
    ]);
    expect(audits.filter((entry) => entry.action === "connection.connected")).toEqual([
      expect.objectContaining({
        orgId: orgA,
        subject: ADMIN,
        targetId: result.connectionId,
        changes: { provider: { from: null, to: "whatsapp" } },
      }),
    ]);
    expect(JSON.stringify(audits)).not.toContain("token-1");
  });

  it("binds the stored token to (org, whatsapp, WABA): it decrypts only under that binding", async () => {
    const { t, orgA, orgB } = await setup();
    const { connectionId } = await connected(t, orgA);

    expect(await decryptStored(t, connectionId)).toEqual({
      kind: "whatsapp",
      v: 1,
      accessToken: "token-1",
      pin: "123456",
    });
    for (const aad of [
      credentialAad(orgB, "whatsapp", WABA_A),
      credentialAad(orgA, "meta", WABA_A),
      credentialAad(orgA, "whatsapp", WABA_B),
    ]) {
      await expect(decryptStored(t, connectionId, aad)).rejects.toThrow();
    }
  });

  it("reconnects the same WABA in the same org: replaces the token, keeps one connection", async () => {
    const { t, orgA } = await setup();
    const first = await connected(t, orgA);
    // As if it had been disconnected meanwhile.
    await t.run(async (ctx) => {
      await ctx.db.patch(first.connectionId, { status: "revoked", revokedAt: Date.now() });
      await ctx.db.patch(first.accountId, { status: "disconnected", disconnectedAt: Date.now() });
    });

    const second = await record(t, orgA, { token: "token-2" });
    expect(second).toEqual({
      ok: true,
      connectionId: first.connectionId,
      accountId: first.accountId,
      reconnected: true,
    });
    const { connections, credentials, accounts, audits } = await state(t);
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({ status: "active", credentialVersion: 2 });
    expect(connections[0]!.revokedAt).toBeUndefined();
    expect(credentials).toHaveLength(1);
    expect(await decryptStored(t, first.connectionId)).toMatchObject({ accessToken: "token-2" });
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ status: "active" });
    expect(accounts[0]!.disconnectedAt).toBeUndefined();
    expect(audits.map((entry) => entry.action)).toContain("connection.reconnected");
  });

  it("reconnects while still active (the org's own active WABA never blocks it)", async () => {
    const { t, orgA } = await setup();
    const first = await connected(t, orgA);
    const second = await record(t, orgA, { token: "token-3" });
    expect(second).toEqual({
      ok: true,
      connectionId: first.connectionId,
      accountId: first.accountId,
      reconnected: true,
    });
    expect(await decryptStored(t, first.connectionId)).toMatchObject({ accessToken: "token-3" });
  });

  it("refuses a WABA that another org has active, and changes nothing", async () => {
    const { t, orgA, orgB } = await setup();
    await connected(t, orgA);
    const before = await state(t);

    expect(await record(t, orgB, { issuer: ISSUER_CRM })).toEqual({
      ok: false,
      reason: "waba_in_use",
    });
    expect(await state(t)).toEqual(before);
  });

  it("allows the WABA in another org once the first org's account is disconnected", async () => {
    const { t, orgA, orgB } = await setup();
    const first = await connected(t, orgA);
    await t.run(async (ctx) => {
      await ctx.db.patch(first.accountId, { status: "disconnected", disconnectedAt: Date.now() });
    });
    const result = await record(t, orgB, { issuer: ISSUER_CRM });
    expect(result).toMatchObject({ ok: true, reconnected: false });
  });

  it("keeps one connection and one account per (org, WABA)", async () => {
    const { t, orgA, orgB } = await setup();
    const a = await connected(t, orgA, WABA_A);
    const b = await connected(t, orgA, WABA_B);
    expect(b.connectionId).not.toBe(a.connectionId);
    expect(b.accountId).not.toBe(a.accountId);
    // Another org connects its own WABA independently.
    const other = await record(t, orgB, { issuer: ISSUER_CRM, wabaId: "100000000000009" });
    expect(other).toMatchObject({ ok: true, reconnected: false });
    const { connections, accounts } = await state(t);
    expect(connections.map((c) => c.externalUserId).sort()).toEqual(
      [WABA_A, WABA_B, "100000000000009"].sort(),
    );
    expect(accounts).toHaveLength(3);
  });

  it("refuses non-numeric ids and unknown orgs, writing nothing", async () => {
    const { t, orgA } = await setup();
    const before = await state(t);
    expect(await record(t, orgA, { wabaId: "waba" })).toEqual({ ok: false, reason: "invalid_id" });
    const gone = await seedOrg(t, ISSUER_ERP, "gone");
    await t.run(async (ctx) => await ctx.db.delete(gone));
    expect(await record(t, gone)).toEqual({ ok: false, reason: "no_org" });
    expect(await state(t)).toEqual(before);
  });

  it("requires a signed-in user's subject, never an operator or system label", async () => {
    const { t, orgA } = await setup();
    const before = await state(t);
    for (const actorSubject of [
      "",
      "   ",
      "operator:alice",
      "system:connection-sweep",
      "x".repeat(257),
    ]) {
      await expectMarketingError(record(t, orgA, { actorSubject }), "INVALID_ARGUMENT");
    }
    expect(await state(t)).toEqual(before);
  });

  it("stays closed on cloud deployments until WHATSAPP_CONNECTIONS_ENABLED is exactly true", async () => {
    const { t, orgA } = await setup();
    vi.stubEnv("CONVEX_CLOUD_URL", CLOUD_URL);
    const before = await state(t);
    for (const value of [undefined, "", "TRUE", "1", "yes"]) {
      if (value === undefined) vi.stubEnv("WHATSAPP_CONNECTIONS_ENABLED", undefined);
      else vi.stubEnv("WHATSAPP_CONNECTIONS_ENABLED", value);
      expect(await record(t, orgA)).toEqual({ ok: false, reason: "connections_disabled" });
    }
    expect(await state(t)).toEqual(before);
    vi.stubEnv("WHATSAPP_CONNECTIONS_ENABLED", "true");
    expect(await record(t, orgA)).toMatchObject({ ok: true });
  });
});

describe("recordConnection: one transaction with the signup's number and PIN", () => {
  it("routes the number in the same call, linked to the account", async () => {
    const { t, orgA } = await setup();
    const result = await record(t, orgA, { phoneNumberId: PHONE_A });
    if (!result.ok) throw new Error(result.reason);
    expect(result.numberId).toBeDefined();
    const { numbers, audits } = await state(t);
    expect(numbers).toEqual([
      expect.objectContaining({
        _id: result.numberId,
        orgId: orgA,
        wabaId: WABA_A,
        phoneNumberId: PHONE_A,
        status: "active",
        source: "embedded_signup",
        accountId: result.accountId,
        registeredBySubject: ADMIN,
      }),
    ]);
    expect(audits.map((a) => a.action)).toEqual(
      expect.arrayContaining(["connection.connected", "whatsapp.number_registered"]),
    );
  });

  it("writes nothing when another org took the number (no connection or account left behind)", async () => {
    const { t, orgA, orgB } = await setup();
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgB,
      wabaId: WABA_A,
      phoneNumberId: PHONE_A,
      actorSubject: "operator:race",
    });
    const before = await state(t);
    expect(await record(t, orgA, { phoneNumberId: PHONE_A })).toEqual({
      ok: false,
      reason: "phone_number_in_use",
    });
    expect(await state(t)).toEqual(before);
  });

  it("writes nothing for this org's operator-managed number", async () => {
    const { t, orgA } = await setup();
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgA,
      wabaId: WABA_A,
      phoneNumberId: PHONE_A,
      actorSubject: "operator:test",
    });
    const before = await state(t);
    expect(await record(t, orgA, { phoneNumberId: PHONE_A })).toEqual({
      ok: false,
      reason: "phone_number_operator_managed",
    });
    expect(await state(t)).toEqual(before);
  });

  it("refuses to replace a credential that changed since the PIN was read", async () => {
    const { t, orgA } = await setup();
    // A first signup that saw no connection loses to one that stored a credential meanwhile.
    expect(await record(t, orgA, { expectedCredentialVersion: null })).toMatchObject({ ok: true });
    const stored = await state(t);
    for (const expectedCredentialVersion of [null, 0, 2]) {
      expect(await record(t, orgA, { token: "token-2", expectedCredentialVersion })).toEqual({
        ok: false,
        reason: "credential_changed",
      });
    }
    expect(await state(t)).toEqual(stored);
    // The version it was read at: accepted (a reconnect keeping that PIN).
    expect(await record(t, orgA, { token: "token-2", expectedCredentialVersion: 1 })).toMatchObject(
      { ok: true, reconnected: true },
    );
    expect((await state(t)).connections[0]).toMatchObject({ credentialVersion: 2 });
  });
});

describe("claimRegistration", () => {
  async function numberOfAccount(t: Backend, orgA: Id<"organizations">) {
    const result = await record(t, orgA, { phoneNumberId: PHONE_A });
    if (!result.ok || result.numberId === undefined) throw new Error("no number");
    return { accountId: result.accountId, numberId: result.numberId };
  }
  const claim = (
    t: Backend,
    orgId: Id<"organizations">,
    ids: { accountId: Id<"whatsappBusinessAccounts">; numberId: Id<"whatsappPhoneNumbers"> },
  ) => t.mutation(internal.whatsapp.accounts.claimRegistration, { orgId, ...ids });
  const numberRow = async (t: Backend) => (await state(t)).numbers[0]!;

  it("lets one call at a time register, counts the attempt at claim time, and expires", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { t, orgA } = await setup();
    const ids = await numberOfAccount(t, orgA);
    expect(await claim(t, orgA, ids)).toEqual({ ok: true });
    expect(await numberRow(t)).toMatchObject({
      registrationAttempts: 1,
      registrationClaimedUntil: Date.now() + REGISTRATION_CLAIM_MS,
    });
    expect(await claim(t, orgA, ids)).toEqual({ ok: false, reason: "registration_in_progress" });
    expect((await numberRow(t)).registrationAttempts).toBe(1);

    // A crashed call's claim expires on its own.
    vi.setSystemTime(Date.now() + REGISTRATION_CLAIM_MS + 1);
    expect(await claim(t, orgA, ids)).toEqual({ ok: true });
    expect((await numberRow(t)).registrationAttempts).toBe(2);

    // The result releases the claim; a failure leaves the number claimable again.
    await t.mutation(internal.whatsapp.accounts.recordRegisterResult, {
      orgId: orgA,
      ...ids,
      failure: "http_503",
    });
    expect((await numberRow(t)).registrationClaimedUntil).toBeUndefined();
    expect((await numberRow(t)).registrationAttempts).toBe(2);
    expect(await claim(t, orgA, ids)).toEqual({ ok: true });
    await t.mutation(internal.whatsapp.accounts.recordRegisterResult, { orgId: orgA, ...ids });
    expect(await claim(t, orgA, ids)).toEqual({ ok: false, reason: "registered" });
  });

  it("refuses at the attempt cap and inside Meta's rate-limit window, without counting", async () => {
    const { t, orgA } = await setup();
    const ids = await numberOfAccount(t, orgA);
    await t.run(async (ctx) => await ctx.db.patch(ids.numberId, { registrationAttempts: 5 }));
    expect(await claim(t, orgA, ids)).toEqual({
      ok: false,
      reason: "registration_attempts_exhausted",
    });
    await t.run(
      async (ctx) =>
        await ctx.db.patch(ids.numberId, {
          registrationAttempts: 1,
          registrationBlockedUntil: Date.now() + 60_000,
        }),
    );
    expect(await claim(t, orgA, ids)).toEqual({ ok: false, reason: "registration_rate_limited" });
    expect(await numberRow(t)).toMatchObject({ registrationAttempts: 1 });
    expect((await numberRow(t)).registrationClaimedUntil).toBeUndefined();
    expect((await state(t)).accounts[0]!.setupError).toMatchObject({
      step: "register",
      reason: "registration_rate_limited",
    });
  });

  it("refuses another org's account or number", async () => {
    const { t, orgA, orgB } = await setup();
    const ids = await numberOfAccount(t, orgA);
    const before = await state(t);
    expect(await claim(t, orgB, ids)).toEqual({ ok: false, reason: "gone" });
    expect(await state(t)).toEqual(before);
  });
});

describe("whatsappConnectionsEnabled", () => {
  it("is open locally and closed in the cloud unless the flag is exactly true", () => {
    expect(whatsappConnectionsEnabled({})).toBe(true);
    expect(whatsappConnectionsEnabled({ cloudUrl: "http://127.0.0.1:3210" })).toBe(true);
    expect(whatsappConnectionsEnabled({ cloudUrl: CLOUD_URL })).toBe(false);
    expect(whatsappConnectionsEnabled({ cloudUrl: CLOUD_URL, enabled: "TRUE" })).toBe(false);
    expect(whatsappConnectionsEnabled({ cloudUrl: CLOUD_URL, enabled: "true" })).toBe(true);
  });
});

describe("registerForConnection", () => {
  async function registerFor(
    t: Backend,
    orgId: Id<"organizations">,
    accountId: Id<"whatsappBusinessAccounts">,
    overrides: Partial<{ phoneNumberId: string; actorSubject: string }> = {},
  ) {
    return await t.mutation(internal.whatsapp.phoneNumbers.registerForConnection, {
      orgId,
      accountId,
      phoneNumberId: overrides.phoneNumberId ?? PHONE_A,
      displayPhoneNumber: "+000001",
      actorSubject: overrides.actorSubject ?? ADMIN,
    });
  }

  it("registers a number of the connected WABA, linked and audited as the admin", async () => {
    const { t, orgA } = await setup();
    const { accountId } = await connected(t, orgA);
    const result = await registerFor(t, orgA, accountId);
    if (!result.ok) throw new Error(result.reason);

    const { numbers, audits } = await state(t);
    expect(numbers).toEqual([
      expect.objectContaining({
        _id: result.numberId,
        orgId: orgA,
        wabaId: WABA_A,
        phoneNumberId: PHONE_A,
        status: "active",
        source: "embedded_signup",
        accountId,
        registeredBySubject: ADMIN,
      }),
    ]);
    expect(numbers[0]!.activatedAt).toBe(numbers[0]!.createdAt);
    expect(audits.filter((entry) => entry.action === "whatsapp.number_registered")).toEqual([
      expect.objectContaining({ orgId: orgA, subject: ADMIN, targetId: result.numberId }),
    ]);
  });

  it("refuses another org's account, a disconnected account, and changes nothing", async () => {
    const { t, orgA, orgB } = await setup();
    const { accountId } = await connected(t, orgA);
    const before = await state(t);
    expect(await registerFor(t, orgB, accountId)).toEqual({ ok: false, reason: "no_account" });

    await t.run(async (ctx) => await ctx.db.patch(accountId, { status: "disconnected" }));
    const disconnected = await state(t);
    expect(await registerFor(t, orgA, accountId)).toEqual({ ok: false, reason: "no_account" });
    expect(await state(t)).toEqual(disconnected);
    expect(disconnected.numbers).toEqual(before.numbers);
  });

  it("requires a signed-in user's subject, never an operator or system label", async () => {
    const { t, orgA } = await setup();
    const { accountId } = await connected(t, orgA);
    const before = await state(t);
    for (const actorSubject of ["", "operator:alice", "system:sync"]) {
      await expectMarketingError(
        registerFor(t, orgA, accountId, { actorSubject }),
        "INVALID_ARGUMENT",
      );
    }
    expect(await state(t)).toEqual(before);
  });

  it("refuses a number that another org has active, and a non-numeric id", async () => {
    const { t, orgA, orgB } = await setup();
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgB,
      wabaId: WABA_B,
      phoneNumberId: PHONE_B,
      actorSubject: "operator:test",
    });
    const { accountId } = await connected(t, orgA);
    const before = await state(t);
    expect(await registerFor(t, orgA, accountId, { phoneNumberId: PHONE_B })).toEqual({
      ok: false,
      reason: "in_use",
    });
    expect(await registerFor(t, orgA, accountId, { phoneNumberId: "phone" })).toEqual({
      ok: false,
      reason: "invalid_id",
    });
    expect(await state(t)).toEqual(before);
  });

  it("never takes over a number this org has from the operator path, active or not", async () => {
    const { t, orgA } = await setup();
    const operator = await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgA,
      wabaId: WABA_A,
      phoneNumberId: PHONE_A,
      actorSubject: "operator:test",
    });
    if (!operator.ok) throw new Error(operator.reason);
    const { accountId } = await connected(t, orgA);
    const before = await state(t);
    expect(await registerFor(t, orgA, accountId)).toEqual({
      ok: false,
      reason: "operator_managed",
    });
    expect(await state(t)).toEqual(before);

    // Also once disconnected: its two-step PIN at Meta is still not ours.
    await t.mutation(internal.whatsapp.phoneNumbers.disconnect, {
      numberId: operator.numberId,
      actorSubject: "operator:test",
    });
    const disconnected = await state(t);
    expect(await registerFor(t, orgA, accountId)).toEqual({
      ok: false,
      reason: "operator_managed",
    });
    expect(await state(t)).toEqual(disconnected);
    // A row from before ADR 0014 (no source) counts as operator-managed too.
    await t.run(async (ctx) => await ctx.db.patch(operator.numberId, { source: undefined }));
    expect(await registerFor(t, orgA, accountId)).toMatchObject({ reason: "operator_managed" });
  });

  it("keeps the WABA link when an operator later updates an Embedded Signup number", async () => {
    const { t, orgA } = await setup();
    const { accountId } = await connected(t, orgA);
    const result = await registerFor(t, orgA, accountId);
    if (!result.ok) throw new Error(result.reason);
    // E.g. a display number fix through the operator path.
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgA,
      wabaId: WABA_A,
      phoneNumberId: PHONE_A,
      displayPhoneNumber: "+999999",
      actorSubject: "operator:test",
    });
    const [number] = (await state(t)).numbers;
    expect(number).toMatchObject({
      _id: result.numberId,
      source: "embedded_signup",
      accountId,
      displayPhoneNumber: "+999999",
    });
  });

  it("routes webhook deliveries for an Embedded Signup number to its org", async () => {
    vi.useFakeTimers();
    stubWhatsAppEnv();
    const { t, orgA } = await setup();
    const now = Date.now();
    vi.setSystemTime(now - 60 * 60 * 1000); // registered an hour before the delivery
    const { accountId } = await connected(t, orgA);
    await registerFor(t, orgA, accountId);
    vi.setSystemTime(now);

    const response = await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.es-1", from: CUSTOMER_1, text: "hello" }] })),
    );
    expect(response.status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const messages = await t.run(async (ctx) => await ctx.db.query("whatsappMessages").collect());
    expect(messages).toEqual([expect.objectContaining({ orgId: orgA, wamid: "wamid.es-1" })]);
  });
});

describe("generic OAuth connection paths never handle WhatsApp", () => {
  async function setupWithConnection() {
    const { t, orgA, orgB } = await setup();
    await as(t).mutation(api.v1.orgs.ensure, {});
    const result = await connected(t, orgA);
    return { t, orgA, orgB, ...result };
  }

  it("refuses beginConnect for provider whatsapp before any OAuth state exists", async () => {
    const { t } = await setupWithConnection();
    await expect(
      as(t).action(api.v1.connections.beginConnect, {
        // @ts-expect-error -- "whatsapp" is not an OAuth provider; the validator must refuse it.
        provider: "whatsapp",
        returnUrl: RETURN_URL,
      }),
    ).rejects.toThrow(/Validator error/);
    const states = await t.run(async (ctx) => await ctx.db.query("oauthStates").collect());
    expect(states).toEqual([]);
  });

  it("refuses the generic disconnect and asset refresh, leaving the connection untouched", async () => {
    const { t, connectionId } = await setupWithConnection();
    const before = await state(t);
    await expectMarketingError(
      as(t).mutation(api.v1.connections.disconnect, { connectionId }),
      "INVALID_ARGUMENT",
    );
    await expectMarketingError(
      as(t).mutation(api.v1.connections.refreshAssets, { connectionId }),
      "INVALID_ARGUMENT",
    );
    expect(await state(t)).toEqual(before);
    const jobs = await t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs).toEqual([]);
  });

  it("lists the connection with provider whatsapp and no secret material", async () => {
    const { t, connectionId } = await setupWithConnection();
    const list = await as(t, { role: "viewer" }).query(api.v1.connections.list, {});
    expect(list).toEqual([
      expect.objectContaining({
        id: connectionId,
        provider: "whatsapp",
        status: "active",
        missingScopes: [],
        expiresSoon: false,
      }),
    ]);
    expect(JSON.stringify(list)).not.toContain("token-1");
  });

  it("revokeAtPlatform deletes a WhatsApp credential without any OAuth revoke call", async () => {
    const { t, connectionId } = await setupWithConnection();
    const job = { connectionId, actorSubject: ADMIN, credentialVersion: 1 };
    // IM7.0: never the credential of a connection that is not revoked on that version.
    await t.action(internal.connections.oauthFlow.revokeAtPlatform, job);
    expect((await state(t)).credentials).toHaveLength(1);
    await t.run((ctx) => ctx.db.patch(connectionId, { status: "revoked" }));
    await t.action(internal.connections.oauthFlow.revokeAtPlatform, job);
    const { credentials } = await state(t);
    expect(credentials).toEqual([]);
  });
});
