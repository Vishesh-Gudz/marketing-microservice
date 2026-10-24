import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { as, ISSUER_CRM, ISSUER_ERP, newBackend, seedOrg, type Backend } from "../test.helpers";
import { MAX_PARTNER_REMOVAL_CHECKS } from "./config";
import {
  graphError,
  installFakeWhatsAppGraph,
  type FakeFailure,
  type FakeSignup,
  type FakeWhatsAppGraph,
} from "./fakeGraph.fixtures";
import {
  CUSTOMER_1,
  PHONE_A,
  PHONE_B,
  WABA_A,
  WABA_B,
  delivery,
  entry,
  partnerRemovedEntry,
  postDelivery,
} from "./fakeWebhook.fixtures";

// ADR 0014 B4b: Meta's account_update PARTNER_REMOVED. The event alone changes nothing; the
// webhook reads the WABA with the org's own stored token (fake Graph) and disconnects the account
// only when Meta refuses. No Meta write call is ever made.

const TOKEN_A = "EAAG-test-business-token-org-a";
const TOKEN_B = "EAAG-test-business-token-org-b";
const PHONE_A2 = "200000000000003";
const PHONE_A3 = "200000000000004";
const USER_A = "user_1";
const WEBHOOK = "system:whatsapp-webhook";

let graph: FakeWhatsAppGraph;

beforeEach(() => {
  graph = installFakeWhatsAppGraph();
  graph.addWaba({
    id: WABA_A,
    name: "Org A Business",
    numbers: [
      { id: PHONE_A, display_phone_number: "+1 555-000-0001" },
      { id: PHONE_A2, display_phone_number: "+1 555-000-0003" },
      { id: PHONE_A3, display_phone_number: "+1 555-000-0004" },
    ],
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function setup() {
  const t = newBackend();
  const orgA = await seedOrg(t, ISSUER_ERP, "42");
  const orgB = await seedOrg(t, ISSUER_CRM, "77");
  return { t, orgA, orgB };
}

const asB = (t: Backend) => as(t, { issuer: ISSUER_CRM, org: "77", sub: "user_b", role: "admin" });

/** Org A connects WABA_A. `signup` is what the customer shared with us (tests change it). */
async function connectA(t: Backend, token = TOKEN_A) {
  const signup: FakeSignup = { token, sharedWabas: [WABA_A] };
  const result = await as(t).action(api.v1.whatsapp.completeSignup, {
    code: graph.issueCode(signup),
    wabaId: WABA_A,
    phoneNumberId: PHONE_A,
  });
  expect(result.status).toBe("connected");
  return { accountId: result.accountId as Id<"whatsappBusinessAccounts">, signup };
}

/** The customer removes us in Meta: the token can no longer read the WABA (fake: 100/33). */
function unshare(signup: FakeSignup) {
  signup.sharedWabas = [];
}

const removal = (wabaId = WABA_A) => delivery(partnerRemovedEntry(wabaId));

async function state(t: Backend) {
  return await t.run(async (ctx) => ({
    connections: await ctx.db.query("connections").collect(),
    credentials: await ctx.db.query("credentials").collect(),
    accounts: await ctx.db.query("whatsappBusinessAccounts").collect(),
    numbers: await ctx.db.query("whatsappPhoneNumbers").collect(),
    audits: await ctx.db.query("auditLog").collect(),
    events: await ctx.db.query("whatsappWebhookEvents").collect(),
    messages: await ctx.db.query("whatsappMessages").collect(),
  }));
}

/** Holds Graph GETs made with `token` until `release()`; `holding()` once one arrived. */
function holdGets(token: string) {
  const inner = graph.fetch;
  let arrived = false;
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get("authorization");
    if ((init?.method ?? "GET") === "GET" && authorization === `Bearer ${token}`) {
      arrived = true;
      await held;
    }
    return await inner(input, init);
  });
  return { holding: () => arrived, release: () => release() };
}

describe("a removal Meta confirms", () => {
  it("disconnects the account: routing stops, the connection is revoked, the token deleted, nothing written at Meta", async () => {
    vi.useFakeTimers();
    const { t, orgA } = await setup();
    const now = Date.now();
    vi.setSystemTime(now - 60 * 60 * 1000);
    const { accountId, signup } = await connectA(t);
    vi.setSystemTime(now);
    await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.before", from: CUSTOMER_1, text: "one" }] })),
    );
    unshare(signup);
    graph.log.length = 0;

    const response = await postDelivery(t, removal());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("EVENT_RECEIVED");

    expect(graph.log.map((call) => [call.method, call.route])).toEqual([["GET", "waba"]]);
    const call = graph.log[0]!;
    expect(call.path).toBe(WABA_A);
    expect(call.authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(call.params.appsecret_proof).toMatch(/^[0-9a-f]{64}$/);
    expect(call.url).not.toContain(TOKEN_A);
    expect(graph.subscribed.has(WABA_A)).toBe(true); // nothing unsubscribed by us

    const { accounts, numbers, connections, credentials, audits } = await state(t);
    expect(accounts[0]).toMatchObject({
      _id: accountId,
      status: "disconnected",
      disconnectedBySubject: WEBHOOK,
      disconnectedAt: expect.any(Number),
    });
    expect(accounts[0]!.offboarding).toBeUndefined();
    expect(numbers).toEqual([expect.objectContaining({ orgId: orgA, status: "disconnected" })]);
    expect(connections[0]).toMatchObject({ status: "revoked", revokedAt: expect.any(Number) });
    expect(credentials).toEqual([]);
    const byWebhook = audits.filter((a) => a.subject === WEBHOOK);
    expect(byWebhook.map((a) => a.action).sort()).toEqual([
      "connection.disconnected",
      "credential.deleted",
      "whatsapp.number_disconnected",
      "whatsapp.partner_removed",
    ]);
    expect(byWebhook.every((a) => a.orgId === orgA && a.issuer === ISSUER_ERP)).toBe(true);
    expect(byWebhook.find((a) => a.action === "whatsapp.partner_removed")).toMatchObject({
      targetType: "whatsappBusinessAccount",
      targetId: accountId,
      changes: {
        status: { from: "active", to: "disconnected" },
        routedNumbers: { from: 1, to: 0 },
      },
    });
    expect(JSON.stringify(audits)).not.toContain(TOKEN_A);

    // Later deliveries for the number are dropped; what arrived before is applied and kept.
    await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.after", from: CUSTOMER_1, text: "two" }] })),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await state(t)).messages.map((m) => m.wamid)).toEqual(["wamid.before"]);
    const [listed] = await as(t, { role: "viewer" }).query(api.v1.whatsapp.listAccounts, {});
    expect(listed).toMatchObject({ status: "disconnected", setupStatus: "disconnected" });
    expect(listed!.cleanup).toBeUndefined();
  });

  it("lets the customer connect the WABA again afterwards", async () => {
    const { t } = await setup();
    const { accountId, signup } = await connectA(t);
    unshare(signup);
    await postDelivery(t, removal());
    const again = await connectA(t, TOKEN_B);
    expect(again.accountId).toBe(accountId);
    const { accounts, connections, credentials, numbers } = await state(t);
    expect(accounts[0]).toMatchObject({ status: "active" });
    expect(accounts[0]!.disconnectedBySubject).toBeUndefined();
    expect(connections[0]).toMatchObject({ status: "active", credentialVersion: 2 });
    expect(credentials).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ status: "active" });
  });

  it.each([
    ["a refused token (190)", graphError(190, 400, 463)],
    ["an expired session (102)", graphError(102, 400)],
    ["HTTP 401 without a Meta error", { status: 401 }],
    ["missing permission (200)", graphError(200, 403)],
    ["missing permission (10)", graphError(10, 403)],
    ["an unknown alias (803)", graphError(803, 404)],
    ["an object that cannot be loaded (100/33)", graphError(100, 400, 33)],
  ] as [string, FakeFailure][])("treats %s as access lost", async (_label, failure) => {
    const { t } = await setup();
    await connectA(t);
    graph.failNext("waba", failure);
    expect((await postDelivery(t, removal())).status).toBe(200);
    const { accounts, credentials } = await state(t);
    expect(accounts[0]!.status).toBe("disconnected");
    expect(credentials).toEqual([]);
  });

  it("disconnects a connection Meta already refused (needs_reauth) without calling Meta", async () => {
    const { t } = await setup();
    await connectA(t);
    const [connection] = (await state(t)).connections;
    await t.mutation(internal.connections.lifecycle.markNeedsReauth, {
      connectionId: connection!._id,
      reason: "whatsapp_token_invalid",
      actorSubject: "system:test",
    });
    graph.log.length = 0;
    expect((await postDelivery(t, removal())).status).toBe(200);
    expect(graph.calls()).toBe(0);
    const { accounts, connections, credentials } = await state(t);
    expect(accounts[0]!.status).toBe("disconnected");
    expect(connections[0]!.status).toBe("revoked");
    expect(credentials).toEqual([]);
  });
});

describe("removals that change nothing", () => {
  it("leaves the account alone while Meta still lets its token read the WABA", async () => {
    const { t } = await setup();
    await connectA(t);
    const before = await state(t);
    graph.log.length = 0;
    expect((await postDelivery(t, removal())).status).toBe(200);
    expect(graph.log.map((call) => [call.method, call.route])).toEqual([["GET", "waba"]]);
    expect(await state(t)).toEqual(before);
  });

  it("ignores a late copy of a removal after the customer connected again", async () => {
    const { t } = await setup();
    const { accountId, signup } = await connectA(t);
    unshare(signup);
    await postDelivery(t, removal());
    await connectA(t, TOKEN_B);
    const before = await state(t);
    graph.log.length = 0;
    expect((await postDelivery(t, removal())).status).toBe(200); // Meta retries the old event
    expect(graph.log.map((call) => call.authorization)).toEqual([`Bearer ${TOKEN_B}`]);
    expect(await state(t)).toEqual(before);
    expect(before.accounts[0]).toMatchObject({ _id: accountId, status: "active" });
  });

  it("checks and applies a duplicated removal once", async () => {
    const { t } = await setup();
    const { signup } = await connectA(t);
    unshare(signup);
    graph.log.length = 0;
    const twice = delivery(partnerRemovedEntry(WABA_A), partnerRemovedEntry(WABA_A));
    expect((await postDelivery(t, twice)).status).toBe(200);
    expect((await postDelivery(t, twice)).status).toBe(200);
    expect(graph.calls()).toBe(1);
    const { audits } = await state(t);
    expect(audits.filter((a) => a.action === "whatsapp.partner_removed")).toHaveLength(1);
  });

  it("never calls Meta or writes anything for a WABA no org has active", async () => {
    const { t, orgB } = await setup();
    const { accountId } = await connectA(t);
    await as(t).action(api.v1.whatsapp.disconnectAccount, { accountId }); // WABA_A: disconnected
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgB,
      wabaId: WABA_B,
      phoneNumberId: PHONE_B,
      actorSubject: "operator:test",
    }); // WABA_B: an operator-managed number only
    const before = await state(t);
    graph.log.length = 0;
    const body = delivery(
      partnerRemovedEntry(WABA_A),
      partnerRemovedEntry(WABA_B),
      partnerRemovedEntry("100000000000099"),
    );
    expect((await postDelivery(t, body)).status).toBe(200);
    expect(graph.calls()).toBe(0);
    expect(await state(t)).toEqual(before);
  });

  it("rejects an unsigned or wrongly signed removal (401) without calling Meta", async () => {
    const { t } = await setup();
    const { signup } = await connectA(t);
    unshare(signup);
    const before = await state(t);
    graph.log.length = 0;
    expect((await postDelivery(t, removal(), { secret: "another-app-secret" })).status).toBe(401);
    expect((await postDelivery(t, removal(), { signature: null })).status).toBe(401);
    expect(graph.calls()).toBe(0);
    expect(await state(t)).toEqual(before);
  });
});

describe("tenant isolation", () => {
  it("writes only the org holding the WABA active; other orgs' rows and operator numbers stay", async () => {
    vi.useFakeTimers();
    const { t, orgA, orgB } = await setup();
    const now = Date.now();
    vi.setSystemTime(now - 60 * 60 * 1000);
    const { accountId } = await connectA(t);
    await as(t).action(api.v1.whatsapp.disconnectAccount, { accountId });
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgA,
      wabaId: WABA_A,
      phoneNumberId: PHONE_A3,
      actorSubject: "operator:test",
    });
    const signupB: FakeSignup = { token: TOKEN_B, sharedWabas: [WABA_A] };
    const b = await asB(t).action(api.v1.whatsapp.completeSignup, {
      code: graph.issueCode(signupB),
      wabaId: WABA_A,
      phoneNumberId: PHONE_A2,
    });
    expect(b.status).toBe("connected");
    vi.setSystemTime(now);
    const before = await state(t);
    unshare(signupB);
    graph.log.length = 0;

    expect((await postDelivery(t, removal())).status).toBe(200);
    expect(graph.log.map((call) => call.authorization)).toEqual([`Bearer ${TOKEN_B}`]);
    const after = await state(t);
    expect(after.accounts.find((a) => a.orgId === orgB)).toMatchObject({
      status: "disconnected",
      disconnectedBySubject: WEBHOOK,
    });
    expect(after.numbers.find((n) => n.phoneNumberId === PHONE_A2)).toMatchObject({
      orgId: orgB,
      status: "disconnected",
    });
    // Org A's rows are exactly as before: its old account and connection, its operator number.
    const ofA = <R extends { orgId: Id<"organizations"> }>(rows: R[]) =>
      rows.filter((row) => row.orgId === orgA);
    expect(ofA(after.accounts)).toEqual(ofA(before.accounts));
    expect(ofA(after.connections)).toEqual(ofA(before.connections));
    expect(ofA(after.numbers)).toEqual(ofA(before.numbers));
    expect(after.numbers.find((n) => n.phoneNumberId === PHONE_A3)).toMatchObject({
      orgId: orgA,
      status: "active",
      source: "operator",
    });
    const byWebhook = after.audits.filter((a) => a.subject === WEBHOOK);
    expect(byWebhook.length).toBeGreaterThan(0);
    expect(byWebhook.every((a) => a.orgId === orgB && a.issuer === ISSUER_CRM)).toBe(true);

    // The operator-managed number still receives its messages.
    await postDelivery(
      t,
      delivery(
        entry({
          phoneNumberId: PHONE_A3,
          messages: [{ id: "wamid.operator", text: "still here" }],
        }),
      ),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await state(t)).messages).toEqual([
      expect.objectContaining({ orgId: orgA, wamid: "wamid.operator" }),
    ]);
  });

  it("does nothing for a WABA that two accounts hold active (never, by the invariant)", async () => {
    const { t, orgB } = await setup();
    const { signup } = await connectA(t);
    unshare(signup);
    await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("connections", {
        orgId: orgB,
        provider: "whatsapp",
        externalUserId: WABA_A,
        status: "active",
        grantedScopes: [],
        credentialVersion: 1,
        connectedBySubject: "user_b",
        connectedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      });
      await ctx.db.insert("whatsappBusinessAccounts", {
        orgId: orgB,
        connectionId,
        wabaId: WABA_A,
        onboardingType: "cloud_api",
        status: "active",
        connectedBySubject: "user_b",
        createdAt: 1,
        updatedAt: 1,
      });
    });
    const before = await state(t);
    graph.log.length = 0;
    expect((await postDelivery(t, removal())).status).toBe(200);
    expect(graph.calls()).toBe(0);
    expect(await state(t)).toEqual(before);
  });

  it("refuses a write whose org, account or connection does not match", async () => {
    const { t, orgA, orgB } = await setup();
    const { accountId } = await connectA(t);
    const { connections } = await state(t);
    const connection = connections[0]!;
    const otherConnection = await t.run(
      async (ctx) =>
        await ctx.db.insert("connections", {
          orgId: orgA,
          provider: "whatsapp",
          externalUserId: WABA_B,
          status: "active",
          grantedScopes: [],
          credentialVersion: connection.credentialVersion,
          connectedBySubject: USER_A,
          connectedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        }),
    );
    const before = await state(t);
    const apply = (args: { orgId: Id<"organizations">; connectionId: Id<"connections"> }) =>
      t.mutation(internal.whatsapp.partnerRemoval.applyPartnerRemoval, {
        ...args,
        accountId,
        credentialVersion: connection.credentialVersion,
      });
    expect(await apply({ orgId: orgB, connectionId: connection._id })).toBe("superseded");
    expect(await apply({ orgId: orgA, connectionId: otherConnection })).toBe("superseded");
    expect(await state(t)).toEqual(before);
  });
});

describe("cross-org links (never, by construction)", () => {
  it("never writes across orgs, even through a corrupt account-to-connection link", async () => {
    const { t, orgA, orgB } = await setup();
    const rows = await t.run(async (ctx) => {
      const connection = async (orgId: Id<"organizations">, externalUserId: string) =>
        await ctx.db.insert("connections", {
          orgId,
          provider: "whatsapp",
          externalUserId,
          status: "active",
          grantedScopes: [],
          credentialVersion: 1,
          connectedBySubject: USER_A,
          connectedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        });
      const account = async (
        orgId: Id<"organizations">,
        connectionId: Id<"connections">,
        wabaId: string,
      ) =>
        await ctx.db.insert("whatsappBusinessAccounts", {
          orgId,
          connectionId,
          wabaId,
          onboardingType: "cloud_api",
          status: "active",
          connectedBySubject: USER_A,
          createdAt: 1,
          updatedAt: 1,
        });
      const connA = await connection(orgA, WABA_A);
      const connB = await connection(orgB, WABA_B);
      // Org A's account linked to org B's connection, and the reverse.
      return {
        connA,
        connB,
        accountA: await account(orgA, connB, WABA_A),
        accountB: await account(orgB, connA, WABA_B),
      };
    });
    const before = await state(t);
    const apply = internal.whatsapp.partnerRemoval.applyPartnerRemoval;
    expect(
      await t.mutation(apply, {
        orgId: orgB,
        accountId: rows.accountA,
        connectionId: rows.connB,
        credentialVersion: 1,
      }),
    ).toBe("superseded");
    expect(
      await t.mutation(apply, {
        orgId: orgB,
        accountId: rows.accountB,
        connectionId: rows.connA,
        credentialVersion: 1,
      }),
    ).toBe("superseded");
    expect(await state(t)).toEqual(before);
  });
});

describe("retries and races", () => {
  it.each([
    ["a network failure", "network"],
    ["a Meta outage (503)", { status: 503 }],
    ["a transient Meta error (2)", graphError(2, 500)],
    ["a rate limit (4)", graphError(4, 400)],
    ["an invalid request (100 without subcode 33)", graphError(100, 400)],
    ["an answer that is not JSON", "invalid_json"],
  ] as [string, FakeFailure][])(
    "answers 500 after %s, changes nothing, and applies Meta's retry once",
    async (_label, failure) => {
      const { t } = await setup();
      const { signup } = await connectA(t);
      unshare(signup);
      const before = await state(t);
      graph.failNext("waba", failure);
      expect((await postDelivery(t, removal())).status).toBe(500);
      expect(await state(t)).toEqual(before);
      expect((await postDelivery(t, removal())).status).toBe(200);
      const { accounts, audits } = await state(t);
      expect(accounts[0]!.status).toBe("disconnected");
      expect(audits.filter((a) => a.action === "whatsapp.partner_removed")).toHaveLength(1);
    },
  );

  it("stores the messages beside a removal that must wait once, across Meta's retry", async () => {
    vi.useFakeTimers();
    const { t } = await setup();
    const now = Date.now();
    vi.setSystemTime(now - 60 * 60 * 1000);
    const { signup } = await connectA(t);
    vi.setSystemTime(now);
    unshare(signup);
    graph.failNext("waba", { status: 503 });
    const mixed = delivery(
      entry({ messages: [{ id: "wamid.mixed", text: "hello" }] }),
      partnerRemovedEntry(WABA_A),
    );
    expect((await postDelivery(t, mixed)).status).toBe(500);
    expect((await postDelivery(t, mixed)).status).toBe(200);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const { messages, events, accounts } = await state(t);
    expect(messages.map((m) => m.wamid)).toEqual(["wamid.mixed"]);
    expect(events).toHaveLength(1);
    expect(accounts[0]!.status).toBe("disconnected");
  });

  it("answers 500 and changes nothing when the stored token cannot be decrypted", async () => {
    const { t } = await setup();
    const { signup } = await connectA(t);
    unshare(signup);
    const before = await state(t);
    graph.log.length = 0;
    vi.stubEnv("TOKEN_ENCRYPTION_KEYS", "not-a-key-ring");
    expect((await postDelivery(t, removal())).status).toBe(500);
    expect(graph.calls()).toBe(0);
    expect(await state(t)).toEqual(before);
  });

  it("never undoes a reconnect made while Meta answered the check", async () => {
    const { t } = await setup();
    const { accountId, signup } = await connectA(t);
    unshare(signup); // the old token lost access...
    const hold = holdGets(TOKEN_A);
    const webhook = postDelivery(t, removal());
    await vi.waitFor(() => expect(hold.holding()).toBe(true));
    await connectA(t, TOKEN_B); // ...and the customer connected again meanwhile
    hold.release();
    expect((await webhook).status).toBe(200);
    const { accounts, connections, credentials, numbers, audits } = await state(t);
    expect(accounts[0]).toMatchObject({ _id: accountId, status: "active" });
    expect(connections[0]).toMatchObject({ status: "active", credentialVersion: 2 });
    expect(credentials).toHaveLength(1);
    expect(numbers[0]).toMatchObject({ status: "active" });
    expect(audits.map((a) => a.action)).not.toContain("whatsapp.partner_removed");
  });

  it("leaves an admin disconnect made during the check, and its cleanup, alone", async () => {
    const { t } = await setup();
    const { accountId } = await connectA(t);
    graph.failNext("waba", graphError(190, 400, 463)); // the check's answer, once released
    const hold = holdGets(TOKEN_A);
    const webhook = postDelivery(t, removal());
    await vi.waitFor(() => expect(hold.holding()).toBe(true));
    expect((await as(t).action(api.v1.whatsapp.disconnectAccount, { accountId })).cleanup).toBe(
      "done",
    );
    hold.release();
    expect((await webhook).status).toBe(200);
    const { accounts, audits } = await state(t);
    expect(accounts[0]).toMatchObject({
      status: "disconnected",
      disconnectedBySubject: USER_A,
      offboarding: { status: "done", result: "unsubscribed" },
    });
    expect(audits.map((a) => a.action)).not.toContain("whatsapp.partner_removed");
  });

  it(`checks at most ${MAX_PARTNER_REMOVAL_CHECKS} WABAs per delivery; Meta's retry settles the rest`, async () => {
    const { t, orgA } = await setup();
    const wabas = Array.from({ length: MAX_PARTNER_REMOVAL_CHECKS + 1 }, (_, i) =>
      String(110_000_000_000_000 + i),
    );
    await t.run(async (ctx) => {
      for (const wabaId of wabas) {
        const connectionId = await ctx.db.insert("connections", {
          orgId: orgA,
          provider: "whatsapp",
          externalUserId: wabaId,
          status: "needs_reauth",
          grantedScopes: [],
          credentialVersion: 1,
          connectedBySubject: USER_A,
          connectedAt: 1,
          createdAt: 1,
          updatedAt: 1,
        });
        await ctx.db.insert("whatsappBusinessAccounts", {
          orgId: orgA,
          connectionId,
          wabaId,
          onboardingType: "cloud_api",
          status: "active",
          connectedBySubject: USER_A,
          createdAt: 1,
          updatedAt: 1,
        });
      }
    });
    // WABAs no org has active do not count towards the limit.
    const unknown = Array.from({ length: 5 }, (_, i) => String(120_000_000_000_000 + i));
    const body = delivery(...[...unknown, ...wabas].map((id) => partnerRemovedEntry(id)));
    const active = async () =>
      (await state(t)).accounts.filter((a) => a.status === "active").length;

    expect((await postDelivery(t, body)).status).toBe(500);
    expect(await active()).toBe(1);
    expect((await postDelivery(t, body)).status).toBe(200);
    expect(await active()).toBe(0);
    expect(graph.calls()).toBe(0); // Meta had refused these connections already
  });
});
