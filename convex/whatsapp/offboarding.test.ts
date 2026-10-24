import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { isMarketingError } from "../lib/errors";
import {
  as,
  expectMarketingError,
  ISSUER_CRM,
  ISSUER_ERP,
  newBackend,
  seedOrg,
  type Backend,
} from "../test.helpers";
import { MAX_OFFBOARDING_ATTEMPTS, WHATSAPP_REVOKED_CREDENTIAL_GRACE_MS } from "./config";
import { graphError, installFakeWhatsAppGraph, type FakeWhatsAppGraph } from "./fakeGraph.fixtures";
import {
  CUSTOMER_1,
  PHONE_A,
  PHONE_B,
  WABA_A,
  WABA_B,
  delivery,
  entry,
  postDelivery,
} from "./fakeWebhook.fixtures";

// ADR 0014 B4: disconnecting a WhatsApp Business Account. Routing stops and the connection is
// revoked in one transaction; then our app is unsubscribed from the WABA at Meta (fake Graph),
// unless the WABA is still used, with scheduled retries; the token is deleted when that ends.

const TOKEN_A = "EAAG-test-business-token-org-a";
const TOKEN_B = "EAAG-test-business-token-org-b";
const PHONE_A2 = "200000000000003";
const USER_A = "user_1";

let graph: FakeWhatsAppGraph;

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

const asB = (t: Backend, role = "admin") =>
  as(t, { issuer: ISSUER_CRM, org: "77", sub: "user_b", role });

async function connectA(t: Backend, token = TOKEN_A) {
  const result = await as(t).action(api.v1.whatsapp.completeSignup, {
    code: graph.issueCode({ token, sharedWabas: [WABA_A] }),
    wabaId: WABA_A,
    phoneNumberId: PHONE_A,
  });
  expect(result.status).toBe("connected");
  return result.accountId as Id<"whatsappBusinessAccounts">;
}

const disconnect = (caller: ReturnType<typeof as>, accountId: string) =>
  caller.action(api.v1.whatsapp.disconnectAccount, { accountId });

async function state(t: Backend) {
  return await t.run(async (ctx) => ({
    connections: await ctx.db.query("connections").collect(),
    credentials: await ctx.db.query("credentials").collect(),
    accounts: await ctx.db.query("whatsappBusinessAccounts").collect(),
    numbers: await ctx.db.query("whatsappPhoneNumbers").collect(),
    audits: await ctx.db.query("auditLog").collect(),
  }));
}

async function reason(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isMarketingError(error)) return error.data.details?.reason ?? error.data.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

function routes() {
  return graph.log.map((call) => call.route);
}

describe("disconnectAccount", () => {
  it("stops routing, revokes the connection, unsubscribes at Meta, then deletes the token", async () => {
    const { t, orgA } = await setup();
    const accountId = await connectA(t);
    expect(graph.subscribed.has(WABA_A)).toBe(true);
    graph.log.length = 0;

    expect(await disconnect(as(t), accountId)).toEqual({ accountId, cleanup: "done" });

    expect(routes()).toEqual(["unsubscribe"]);
    const call = graph.log[0]!;
    expect(call.method).toBe("DELETE");
    expect(call.path).toBe(`${WABA_A}/subscribed_apps`);
    expect(call.authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(call.params.appsecret_proof).toMatch(/^[0-9a-f]{64}$/);
    expect(call.url).not.toContain(TOKEN_A);
    expect(graph.subscribed.has(WABA_A)).toBe(false);

    const { connections, credentials, accounts, numbers, audits } = await state(t);
    expect(accounts[0]).toMatchObject({
      status: "disconnected",
      disconnectedBySubject: USER_A,
      disconnectedAt: expect.any(Number),
      offboarding: { status: "done", result: "unsubscribed", attempts: 1 },
    });
    expect(accounts[0]!.subscribedAt).toBeUndefined();
    expect(numbers).toEqual([expect.objectContaining({ orgId: orgA, status: "disconnected" })]);
    expect(connections[0]).toMatchObject({ status: "revoked", revokedAt: expect.any(Number) });
    expect(credentials).toEqual([]);
    const actions = audits.filter((a) => a.subject === USER_A).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        "whatsapp.number_disconnected",
        "connection.disconnected",
        "credential.deleted",
        "whatsapp.offboarding_completed",
      ]),
    );
    expect(JSON.stringify(audits)).not.toContain(TOKEN_A);

    const [listed] = await as(t, { role: "viewer" }).query(api.v1.whatsapp.listAccounts, {});
    expect(listed).toMatchObject({
      status: "disconnected",
      setupStatus: "disconnected",
      cleanup: { status: "done" },
    });
  });

  it("is admin-only and tenant-scoped: nothing changes for anyone else", async () => {
    const { t } = await setup();
    const accountId = await connectA(t);
    const before = await state(t);
    graph.log.length = 0;
    await expectMarketingError(
      t.action(api.v1.whatsapp.disconnectAccount, { accountId }),
      "UNAUTHENTICATED",
    );
    for (const role of ["editor", "viewer"]) {
      await expectMarketingError(disconnect(as(t, { role }), accountId), "FORBIDDEN");
    }
    await expectMarketingError(disconnect(asB(t), accountId), "NOT_FOUND");
    await expectMarketingError(disconnect(as(t), "not-an-id"), "NOT_FOUND");
    expect(graph.calls()).toBe(0);
    expect(await state(t)).toEqual(before);
  });

  it("is idempotent", async () => {
    const { t } = await setup();
    const accountId = await connectA(t);
    await disconnect(as(t), accountId);
    const after = await state(t);
    graph.log.length = 0;
    expect(await disconnect(as(t), accountId)).toEqual({ accountId, cleanup: "done" });
    expect(graph.calls()).toBe(0);
    expect(await state(t)).toEqual(after);
  });
});

describe("routing and history", () => {
  it("drops deliveries after the disconnect, applies those accepted before, keeps history", async () => {
    vi.useFakeTimers();
    const { t } = await setup();
    const now = Date.now();
    vi.setSystemTime(now - 60 * 60 * 1000);
    const accountId = await connectA(t);
    vi.setSystemTime(now);
    const first = await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.before-1", from: CUSTOMER_1, text: "one" }] })),
    );
    expect(first.status).toBe(200);
    // Accepted while routed; still queued when the disconnect commits.
    await disconnect(as(t), accountId);
    const late = await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.after-1", from: CUSTOMER_1, text: "two" }] })),
    );
    expect(late.status).toBe(200); // acknowledged, dropped
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const messages = await t.run(async (ctx) => await ctx.db.query("whatsappMessages").collect());
    expect(messages.map((m) => m.wamid)).toEqual(["wamid.before-1"]);
    const events = await t.run(
      async (ctx) => await ctx.db.query("whatsappWebhookEvents").collect(),
    );
    expect(events.map((e) => e.wamid)).toEqual(["wamid.before-1"]);
    // History stays readable for the org's members.
    const viewer = as(t, { role: "viewer" });
    const conversations = await viewer.query(api.v1.whatsapp.listConversations, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(conversations.page).toHaveLength(1);
    const listed = await viewer.query(api.v1.whatsapp.listMessages, {
      conversationId: conversations.page[0]!.id,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(listed.page.map((m) => m.text)).toEqual(["one"]);
  });
});

describe("shared WABAs", () => {
  it("never unsubscribes a WABA another org still uses through an operator-managed number", async () => {
    vi.useFakeTimers();
    const { t, orgB } = await setup();
    const now = Date.now();
    vi.setSystemTime(now - 60 * 60 * 1000);
    const accountId = await connectA(t);
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgB,
      wabaId: WABA_A,
      phoneNumberId: PHONE_A2,
      actorSubject: "operator:test",
    });
    vi.setSystemTime(now);
    graph.log.length = 0;

    expect(await disconnect(as(t), accountId)).toEqual({ accountId, cleanup: "done" });
    expect(graph.calls()).toBe(0);
    expect(graph.subscribed.has(WABA_A)).toBe(true);
    const { accounts, credentials, numbers } = await state(t);
    expect(accounts[0]!.offboarding).toMatchObject({ status: "done", result: "skipped_shared" });
    expect(credentials).toEqual([]);
    expect(numbers.find((n) => n.phoneNumberId === PHONE_A2)).toMatchObject({
      orgId: orgB,
      status: "active",
      source: "operator",
    });
    // Org B's operator-managed number still receives its messages.
    await postDelivery(
      t,
      delivery(
        entry({
          phoneNumberId: PHONE_A2,
          messages: [{ id: "wamid.org-b-1", from: CUSTOMER_1, text: "hi B" }],
        }),
      ),
    );
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    const messages = await t.run(async (ctx) => await ctx.db.query("whatsappMessages").collect());
    expect(messages).toEqual([expect.objectContaining({ orgId: orgB, wamid: "wamid.org-b-1" })]);
  });

  it("never unsubscribes a WABA this org still uses through an operator-managed number, and leaves it routed", async () => {
    const { t, orgA } = await setup();
    const accountId = await connectA(t);
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgA,
      wabaId: WABA_A,
      phoneNumberId: PHONE_A2,
      actorSubject: "operator:test",
    });
    graph.log.length = 0;
    await disconnect(as(t), accountId);
    expect(graph.calls()).toBe(0);
    const operator = (await state(t)).numbers.find((n) => n.phoneNumberId === PHONE_A2)!;
    expect(operator).toMatchObject({ status: "active", source: "operator" });
    expect(operator.accountId).toBeUndefined();
  });
});

describe("cleanup retries", () => {
  it("retries a failed unsubscribe on schedule and deletes the token when it succeeds", async () => {
    vi.useFakeTimers();
    const { t } = await setup();
    const accountId = await connectA(t);
    graph.failNext("unsubscribe", { status: 503 }, 2);
    graph.log.length = 0;

    const result = await disconnect(as(t), accountId);
    expect(result).toEqual({
      accountId,
      cleanup: "pending",
      retryAfter: new Date(Date.now() + 60_000).toISOString(),
    });
    let rows = await state(t);
    expect(rows.accounts[0]!.offboarding).toMatchObject({
      status: "pending",
      attempts: 1,
      lastFailure: "http_503",
    });
    expect(rows.credentials).toHaveLength(1); // kept for the retries
    expect(rows.numbers[0]).toMatchObject({ status: "disconnected" }); // routing already stopped
    const [listed] = await as(t).query(api.v1.whatsapp.listAccounts, {});
    expect(listed!.cleanup).toEqual({
      status: "pending",
      retryAfter: new Date(Date.now() + 60_000).toISOString(),
    });

    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(graph.calls("unsubscribe")).toBe(3);
    rows = await state(t);
    expect(rows.accounts[0]!.offboarding).toMatchObject({
      status: "done",
      result: "unsubscribed",
      attempts: 3,
    });
    expect(rows.credentials).toEqual([]);
    expect(rows.audits.find((a) => a.action === "whatsapp.offboarding_completed")!.subject).toBe(
      "system:whatsapp-offboarding",
    );
  });

  it("gives up after the last attempt, deleting the token anyway", async () => {
    vi.useFakeTimers();
    const { t } = await setup();
    const accountId = await connectA(t);
    graph.failNext("unsubscribe", "network", 50);
    graph.log.length = 0;
    expect((await disconnect(as(t), accountId)).cleanup).toBe("pending");
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(graph.calls("unsubscribe")).toBe(MAX_OFFBOARDING_ATTEMPTS);
    const { accounts, credentials, audits } = await state(t);
    expect(accounts[0]!.offboarding).toMatchObject({
      status: "failed",
      attempts: MAX_OFFBOARDING_ATTEMPTS,
      lastFailure: "network",
    });
    expect(credentials).toEqual([]);
    expect(audits.map((a) => a.action)).toContain("whatsapp.offboarding_failed");
    const [listed] = await as(t).query(api.v1.whatsapp.listAccounts, {});
    expect(listed!.cleanup).toEqual({ status: "failed" });
  });

  it("treats a refused token as finished: nothing can unsubscribe with it", async () => {
    const { t } = await setup();
    const accountId = await connectA(t);
    graph.failNext("unsubscribe", graphError(190, 400, 463));
    graph.log.length = 0;
    expect((await disconnect(as(t), accountId)).cleanup).toBe("done");
    expect(graph.calls("unsubscribe")).toBe(1);
    const { accounts, credentials } = await state(t);
    expect(accounts[0]!.offboarding).toMatchObject({ status: "done", result: "token_invalid" });
    expect(credentials).toEqual([]);
  });

  it("runs one cleanup attempt at a time", async () => {
    const { t } = await setup();
    const accountId = await connectA(t);
    const inner = graph.fetch;
    let arrived = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, 500);
    });
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "DELETE") {
        arrived += 1;
        if (arrived >= 2) release();
        await gate;
      }
      return await inner(input, init);
    });
    graph.log.length = 0;
    const results = await Promise.all([disconnect(as(t), accountId), disconnect(as(t), accountId)]);
    expect(graph.calls("unsubscribe")).toBe(1);
    // The caller whose claim won reports done; the other one saw the attempt still running.
    expect(results.map((r) => r.cleanup)).toContain("done");
    for (const result of results) expect(["done", "pending"]).toContain(result.cleanup);
    expect((await state(t)).accounts[0]!.offboarding).toMatchObject({
      status: "done",
      attempts: 1,
    });
  });
});

describe("reconnect", () => {
  it("refuses any org's signup for the WABA while the cleanup is pending, then allows it", async () => {
    vi.useFakeTimers();
    const { t } = await setup();
    const accountId = await connectA(t);
    graph.failNext("unsubscribe", { status: 503 });
    await disconnect(as(t), accountId);
    const before = await state(t);
    graph.log.length = 0;

    expect(
      await reason(
        as(t).action(api.v1.whatsapp.completeSignup, {
          code: graph.issueCode({ token: TOKEN_B, sharedWabas: [WABA_A] }),
          wabaId: WABA_A,
          phoneNumberId: PHONE_A,
        }),
      ),
    ).toBe("disconnect_in_progress");
    expect(
      await reason(
        asB(t).action(api.v1.whatsapp.completeSignup, {
          code: graph.issueCode({ token: TOKEN_B, sharedWabas: [WABA_A] }),
          wabaId: WABA_A,
          phoneNumberId: PHONE_A2,
        }),
      ),
    ).toBe("disconnect_in_progress");
    expect(routes()).not.toContain("subscribe");
    expect(await state(t)).toEqual(before);

    await t.finishAllScheduledFunctions(vi.runAllTimers); // the retry unsubscribes
    expect((await state(t)).accounts[0]!.offboarding!.status).toBe("done");

    graph.log.length = 0;
    const again = await connectA(t, TOKEN_B);
    expect(again).toBe(accountId);
    const after = await state(t);
    expect(after.accounts[0]).toMatchObject({ status: "active" });
    expect(after.accounts[0]!.offboarding).toBeUndefined();
    expect(after.accounts[0]!.disconnectedBySubject).toBeUndefined();
    expect(after.connections[0]).toMatchObject({ status: "active" });
    expect(after.numbers[0]).toMatchObject({ status: "active" });
    expect(after.numbers[0]!.activatedAt).toBeGreaterThan(before.numbers[0]!.activatedAt!);
    expect(after.credentials).toHaveLength(1);
    expect(routes()).toContain("subscribe");
    expect(routes()).not.toContain("register"); // still registered at Meta
    expect(graph.subscribed.has(WABA_A)).toBe(true);
  });

  it("lets another org connect the WABA once the cleanup is done, and leaves its webhooks alone", async () => {
    const { t } = await setup();
    const accountId = await connectA(t);
    await disconnect(as(t), accountId);
    const b = await asB(t).action(api.v1.whatsapp.completeSignup, {
      code: graph.issueCode({ token: TOKEN_B, sharedWabas: [WABA_A] }),
      wabaId: WABA_A,
      phoneNumberId: PHONE_A2,
    });
    expect(b.status).toBe("connected");
    expect(graph.subscribed.has(WABA_A)).toBe(true);
    graph.log.length = 0;
    await disconnect(as(t), accountId); // org A again: already done, nothing at Meta
    expect(graph.calls()).toBe(0);
  });

  it("undoes a subscription that lands at Meta after the disconnect", async () => {
    const { t } = await setup();
    graph.failNext("subscribe", { status: 503 });
    const first = await as(t).action(api.v1.whatsapp.completeSignup, {
      code: graph.issueCode({ token: TOKEN_A, sharedWabas: [WABA_A] }),
      wabaId: WABA_A,
      phoneNumberId: PHONE_A,
    });
    expect(first).toMatchObject({ status: "action_required", nextStep: "subscribe" });

    // Hold the retry's subscribe call at Meta while the admin disconnects.
    const inner = graph.fetch;
    let holding = false;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if ((init?.method ?? "GET") === "POST" && url.includes("/subscribed_apps")) {
        holding = true;
        await held;
      }
      return await inner(input, init);
    });
    const retry = as(t).action(api.v1.whatsapp.retrySetup, { accountId: first.accountId });
    await vi.waitFor(() => expect(holding).toBe(true));
    expect((await disconnect(as(t), first.accountId)).cleanup).toBe("done");
    release();
    await retry;

    expect(graph.subscribed.has(WABA_A)).toBe(false);
    expect(routes().filter((r) => r === "unsubscribe")).toHaveLength(2);
    expect(routes()).not.toContain("register");
  });
});

describe("connection sweep", () => {
  async function revokedWithCredential(
    t: Backend,
    orgId: Id<"organizations">,
    provider: "whatsapp" | "meta",
    revokedAt: number,
  ) {
    return await t.run(async (ctx) => {
      const connectionId = await ctx.db.insert("connections", {
        orgId,
        provider,
        externalUserId: `ext-${provider}`,
        status: "revoked",
        grantedScopes: [],
        credentialVersion: 1,
        connectedBySubject: USER_A,
        connectedAt: revokedAt,
        revokedAt,
        createdAt: revokedAt,
        updatedAt: revokedAt,
      });
      await ctx.db.insert("credentials", {
        orgId,
        connectionId,
        ciphertext: new Uint8Array([1, 2, 3]).buffer,
        iv: new Uint8Array(12).buffer,
        keyVersion: 1,
        algorithm: "AES-256-GCM",
        createdAt: revokedAt,
        updatedAt: revokedAt,
      });
      return connectionId;
    });
  }

  it("keeps a revoked WhatsApp credential for the grace period, other providers as before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const { t, orgA } = await setup();
    const now = Date.now();
    const whatsapp = await revokedWithCredential(t, orgA, "whatsapp", now);
    const meta = await revokedWithCredential(t, orgA, "meta", now);
    const remaining = async () =>
      (await t.run(async (ctx) => await ctx.db.query("credentials").collect())).map(
        (c) => c.connectionId,
      );

    expect(await t.mutation(internal.connections.maintenance.sweep, {})).toMatchObject({
      credentialsDeleted: 1,
    });
    expect(await remaining()).toEqual([whatsapp]); // Meta Ads: deleted at once, as before

    vi.setSystemTime(now + WHATSAPP_REVOKED_CREDENTIAL_GRACE_MS + 1);
    expect(await t.mutation(internal.connections.maintenance.sweep, {})).toMatchObject({
      credentialsDeleted: 1,
    });
    expect(await remaining()).toEqual([]);
    void meta;
  });
});
