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
import { SERVICE_WINDOW_MS } from "./config";
import {
  graphError,
  installFakeWhatsAppGraph,
  type FakeFailure,
  type FakeWhatsAppGraph,
} from "./fakeGraph.fixtures";
import {
  CUSTOMER_1,
  CUSTOMER_2,
  PHONE_A,
  PHONE_B,
  WABA_A,
  WABA_B,
  delivery,
  entry,
  nowSeconds,
  postDelivery,
} from "./fakeWebhook.fixtures";

// Outbound text replies (ADR 0013 stage 5) end to end against the fake Graph: an inbound message
// opens a conversation, an editor replies, Meta accepts it, and status webhooks move it on.

const TOKEN_A = "EAAG-test-business-token-org-a";
const PHONE_A2 = "200000000000003";
const USER_A = "user_1";
const PAGE = { paginationOpts: { numItems: 20, cursor: null } };
const CLIENT_ID = "client-msg-0001";

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
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const asB = (t: Backend) => as(t, { issuer: ISSUER_CRM, org: "77", sub: "user_b", role: "admin" });

const run = (t: Backend) => t.finishAllScheduledFunctions(vi.runAllTimers);

/**
 * Org A connected WABA_A an hour ago (Embedded Signup: PHONE_A routed and registered at Meta),
 * and CUSTOMER_1 just wrote to PHONE_A: one conversation with an open service window.
 */
async function setup(options: { failRegister?: boolean } = {}) {
  const t = newBackend();
  const orgA = await seedOrg(t, ISSUER_ERP, "42");
  const orgB = await seedOrg(t, ISSUER_CRM, "77");
  const now = Date.now();
  vi.setSystemTime(now - 60 * 60 * 1000);
  if (options.failRegister) graph.failNext("register", graphError(100, 400), 10);
  const signup = await as(t).action(api.v1.whatsapp.completeSignup, {
    code: graph.issueCode({ token: TOKEN_A, sharedWabas: [WABA_A] }),
    wabaId: WABA_A,
    phoneNumberId: PHONE_A,
  });
  vi.setSystemTime(now);
  await inbound(t, "wamid.in-1", CUSTOMER_1);
  const conversationId = (await conversations(t))[0]!.id;
  graph.log.length = 0;
  return { t, orgA, orgB, now, conversationId, accountId: signup.accountId };
}

async function inbound(t: Backend, wamid: string, from: string, phoneNumberId = PHONE_A) {
  const response = await postDelivery(
    t,
    delivery(entry({ phoneNumberId, messages: [{ id: wamid, from, text: "Where is my order?" }] })),
  );
  expect(response.status).toBe(200);
  await run(t);
}

async function conversations(t: Backend) {
  return (await as(t, { role: "viewer" }).query(api.v1.whatsapp.listConversations, PAGE)).page;
}

async function messages(t: Backend, conversationId: string) {
  return (
    await as(t, { role: "viewer" }).query(api.v1.whatsapp.listMessages, {
      conversationId,
      ...PAGE,
    })
  ).page;
}

async function rows(t: Backend) {
  return await t.run(async (ctx) => ({
    messages: await ctx.db.query("whatsappMessages").collect(),
    events: await ctx.db.query("whatsappWebhookEvents").collect(),
    connections: await ctx.db.query("connections").collect(),
    audits: await ctx.db.query("auditLog").collect(),
  }));
}

const reply = (
  caller: ReturnType<typeof as>,
  conversationId: string,
  text = "On its way!",
  clientMessageId = CLIENT_ID,
) => caller.mutation(api.v1.whatsapp.sendText, { conversationId, text, clientMessageId });

async function reason(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isMarketingError(error)) return error.data.details?.reason ?? error.data.code;
    throw error;
  }
  throw new Error("expected the call to fail");
}

async function statuses(t: Backend, wamid: string, list: { status: string; at: number }[]) {
  const response = await postDelivery(
    t,
    delivery(
      entry({ statuses: list.map((s) => ({ id: wamid, status: s.status, timestamp: s.at })) }),
    ),
  );
  expect(response.status).toBe(200);
  await run(t);
}

describe("sendText", () => {
  it("stores the reply pending, sends it once from the org's own number, then records Meta's wamid", async () => {
    const { t, conversationId, now } = await setup();
    const queued = await reply(as(t, { role: "editor" }), conversationId);
    expect(queued).toMatchObject({
      conversationId,
      direction: "outbound",
      type: "text",
      text: "On its way!",
      status: "pending",
    });
    expect(graph.calls()).toBe(0); // the Meta call is scheduled, not made in the mutation

    await run(t);
    expect(graph.sent).toHaveLength(1);
    expect(graph.sent[0]).toMatchObject({
      phoneNumberId: PHONE_A,
      wamid: "wamid.fake-1",
      body: { to: `+${CUSTOMER_1}`, type: "text", text: { body: "On its way!" } },
    });
    expect(graph.log[0]!.authorization).toBe(`Bearer ${TOKEN_A}`);

    const thread = await messages(t, conversationId);
    expect(thread.map((m) => [m.direction, m.status])).toEqual([
      ["outbound", "submitted"],
      ["inbound", "received"],
    ]);
    const { messages: stored } = await rows(t);
    const outbound = stored.find((m) => m.direction === "outbound")!;
    expect(outbound).toMatchObject({
      wamid: "wamid.fake-1",
      clientMessageId: CLIENT_ID,
      sentBySubject: USER_A,
      sendAttemptedAt: expect.any(Number),
    });
    const [conversation] = await conversations(t);
    expect(new Date(conversation!.lastMessageAt).getTime()).toBeGreaterThanOrEqual(now);
    // The DTO carries no internal send fields, and nothing anywhere carries the token.
    expect(Object.keys(thread[0]!)).not.toEqual(
      expect.arrayContaining(["clientMessageId", "sentBySubject", "sendAttemptedAt"]),
    );
    expect(JSON.stringify(await rows(t))).not.toContain(TOKEN_A);
  });

  it("moves forward on status webhooks; repeats change nothing, a late failure no status", async () => {
    const { t, conversationId } = await setup();
    await reply(as(t), conversationId);
    await run(t);
    const base = nowSeconds();
    await statuses(t, "wamid.fake-1", [
      { status: "sent", at: base + 1 },
      { status: "delivered", at: base + 2 },
    ]);
    await statuses(t, "wamid.fake-1", [{ status: "read", at: base + 3 }]);
    const read = (await messages(t, conversationId))[0]!;
    expect(read).toMatchObject({
      status: "read",
      sentAt: new Date((base + 1) * 1000).toISOString(),
      deliveredAt: new Date((base + 2) * 1000).toISOString(),
      readAt: new Date((base + 3) * 1000).toISOString(),
    });
    // A repeated report changes nothing.
    await statuses(t, "wamid.fake-1", [{ status: "read", at: base + 3 }]);
    expect((await messages(t, conversationId))[0]).toEqual(read);
    // A failure reported after delivery keeps the message read; only its time is recorded
    // (convex/whatsapp/status.ts: failed applies before delivery only).
    await statuses(t, "wamid.fake-1", [{ status: "failed", at: base + 4 }]);
    expect((await messages(t, conversationId))[0]).toEqual({
      ...read,
      failedAt: new Date((base + 4) * 1000).toISOString(),
    });
  });

  it("applies statuses that arrived before the send result when that result is recorded", async () => {
    const { t, orgA, conversationId } = await setup();
    const queued = await reply(as(t), conversationId);
    const messageId = queued.id as Id<"whatsappMessages">;
    // Meta took the message; its webhooks arrive before our call has recorded the answer.
    const claim = await t.mutation(internal.whatsapp.outbound.claimDelivery, {
      orgId: orgA,
      messageId,
    });
    expect(claim).toMatchObject({ phoneNumberId: PHONE_A, to: `+${CUSTOMER_1}` });
    const base = nowSeconds();
    await statuses(t, "wamid.late-1", [
      { status: "sent", at: base + 1 },
      { status: "delivered", at: base + 2 },
    ]);
    let { events } = await rows(t);
    expect(events.filter((e) => e.kind === "status").map((e) => e.status)).toEqual([
      "unmatched",
      "unmatched",
    ]);
    // The scheduled delivery found the claim taken: it made no second call.
    expect(graph.calls("send")).toBe(0);

    await t.mutation(internal.whatsapp.outbound.recordSendResult, {
      orgId: orgA,
      messageId,
      connectionId: claim!.connectionId,
      outcome: { kind: "accepted", wamid: "wamid.late-1" },
    });
    expect((await messages(t, conversationId))[0]).toMatchObject({
      status: "delivered",
      sentAt: new Date((base + 1) * 1000).toISOString(),
      deliveredAt: new Date((base + 2) * 1000).toISOString(),
    });
    ({ events } = await rows(t));
    for (const event of events.filter((e) => e.kind === "status")) {
      expect(event.status).toBe("processed");
      expect(event.event).toBeUndefined();
    }
  });

  it("never lets another org's status reports reach the message", async () => {
    const { t, orgB, conversationId } = await setup();
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgB,
      wabaId: WABA_B,
      phoneNumberId: PHONE_B,
      actorSubject: "operator:test",
    });
    await reply(as(t), conversationId);
    await run(t);
    // A report for the same wamid on org B's number lands in org B only.
    await postDelivery(
      t,
      delivery(
        entry({
          wabaId: WABA_B,
          phoneNumberId: PHONE_B,
          statuses: [{ id: "wamid.fake-1", status: "delivered" }],
        }),
      ),
    );
    await run(t);
    expect((await messages(t, conversationId))[0]!.status).toBe("submitted");
    const { events } = await rows(t);
    expect(events.find((e) => e.kind === "status")).toMatchObject({
      orgId: orgB,
      status: "unmatched",
    });
  });

  it("sends a repeated submit once and returns the same message", async () => {
    const { t, conversationId } = await setup();
    const first = await reply(as(t), conversationId);
    const again = await reply(as(t), conversationId, "On its way!");
    expect(again.id).toBe(first.id);
    await run(t);
    expect(await reply(as(t), conversationId)).toMatchObject({ id: first.id, status: "submitted" });
    await run(t);
    expect(graph.sent).toHaveLength(1);
    expect((await rows(t)).messages.filter((m) => m.direction === "outbound")).toHaveLength(1);

    // The same id for another conversation is refused.
    await inbound(t, "wamid.in-2", CUSTOMER_2);
    const other = (await conversations(t)).find((c) => c.contactWaId === CUSTOMER_2)!;
    expect(await reason(reply(as(t), other.id))).toBe("client_message_id_reused");
  });

  it("validates the text and the client id before anything is stored", async () => {
    const { t, conversationId } = await setup();
    for (const text of ["", "   \n ", "x".repeat(4097)]) {
      await expectMarketingError(reply(as(t), conversationId, text), "INVALID_ARGUMENT");
    }
    for (const id of ["short", "has spaces in it", "x".repeat(65), "bad/char-0001"]) {
      await expectMarketingError(reply(as(t), conversationId, "hi", id), "INVALID_ARGUMENT");
    }
    expect((await rows(t)).messages.filter((m) => m.direction === "outbound")).toEqual([]);
    expect(await reply(as(t), conversationId, "x".repeat(4096))).toMatchObject({
      status: "pending",
    });
  });
});

describe("who may send, and where", () => {
  it("refuses viewers, signed-out callers and other orgs, storing and sending nothing", async () => {
    const { t, conversationId } = await setup();
    await expectMarketingError(reply(as(t, { role: "viewer" }), conversationId), "FORBIDDEN");
    await expectMarketingError(
      t.mutation(api.v1.whatsapp.sendText, {
        conversationId,
        text: "hi",
        clientMessageId: CLIENT_ID,
      }),
      "UNAUTHENTICATED",
    );
    await expectMarketingError(reply(asB(t), conversationId), "NOT_FOUND");
    await expectMarketingError(reply(as(t), "not-an-id"), "NOT_FOUND");
    await run(t);
    expect((await rows(t)).messages.filter((m) => m.direction === "outbound")).toEqual([]);
    expect(graph.calls()).toBe(0);
  });

  it("refuses once the customer's 24-hour window has closed (a template is needed)", async () => {
    const { t, now, conversationId } = await setup();
    vi.setSystemTime(now + SERVICE_WINDOW_MS - 1000);
    expect((await reply(as(t), conversationId, "just in time", "client-msg-0002")).status).toBe(
      "pending",
    );
    vi.setSystemTime(now + SERVICE_WINDOW_MS + 1000);
    expect(await reason(reply(as(t), conversationId, "too late", "client-msg-0003"))).toBe(
      "service_window_closed",
    );
    await run(t);
    expect(graph.sent.map((s) => (s.body.text as { body: string }).body)).toEqual(["just in time"]);
  });

  it("refuses a number set up by support: it has no stored token", async () => {
    const { t, orgA } = await setup();
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgA,
      wabaId: WABA_A,
      phoneNumberId: PHONE_A2,
      actorSubject: "operator:test",
    });
    await inbound(t, "wamid.in-op", CUSTOMER_2, PHONE_A2);
    const conversation = (await conversations(t)).find((c) => c.phoneNumberId === PHONE_A2)!;
    expect(await reason(reply(as(t), conversation.id))).toBe("number_cannot_send");
    expect(graph.calls()).toBe(0);
  });

  it("refuses a connection Meta no longer accepts, and a number not registered yet", async () => {
    const { t, conversationId } = await setup();
    const [connection] = (await rows(t)).connections;
    await t.mutation(internal.connections.lifecycle.markNeedsReauth, {
      connectionId: connection!._id,
      reason: "whatsapp_token_invalid",
      actorSubject: "system:test",
    });
    expect(await reason(reply(as(t), conversationId))).toBe("reconnect_required");

    const unregistered = await setup({ failRegister: true });
    expect(await reason(reply(as(unregistered.t), unregistered.conversationId))).toBe(
      "number_not_ready",
    );
    expect(graph.calls("send")).toBe(0);
  });

  it("fails a queued reply without calling Meta when the account is disconnected first", async () => {
    const { t, accountId, conversationId } = await setup();
    await reply(as(t), conversationId);
    await as(t).action(api.v1.whatsapp.disconnectAccount, { accountId });
    await run(t);
    expect(graph.calls("send")).toBe(0);
    expect((await messages(t, conversationId))[0]).toMatchObject({
      status: "failed",
      failureReason: "number_unavailable",
    });
  });
});

describe("Meta's answer", () => {
  it.each([
    ["outside the window (131047)", graphError(131047, 400), 131047],
    ["an undeliverable recipient (131026)", graphError(131026, 400), 131026],
    ["a rate limit (130429)", graphError(130429, 400), 130429],
  ] as [string, FakeFailure, number][])(
    "fails the reply on a refusal: %s",
    async (_label, failure, code) => {
      const { t, conversationId } = await setup();
      graph.failNext("send", failure);
      await reply(as(t), conversationId);
      await run(t);
      expect((await messages(t, conversationId))[0]).toMatchObject({
        status: "failed",
        errorCode: code,
        failureReason: `meta_${code}`,
        failedAt: expect.any(String),
      });
      expect(graph.calls("send")).toBe(1);
    },
  );

  it("fails the reply and asks for a reconnect when Meta refuses the token", async () => {
    const { t, conversationId } = await setup();
    graph.failNext("send", graphError(190, 401, 463));
    await reply(as(t), conversationId);
    await run(t);
    expect((await messages(t, conversationId))[0]).toMatchObject({
      status: "failed",
      failureReason: "meta_190",
    });
    const { connections, audits } = await rows(t);
    expect(connections[0]!.status).toBe("needs_reauth");
    expect(audits.find((a) => a.action === "connection.needs_reauth")).toMatchObject({
      subject: USER_A,
    });
    expect(await reason(reply(as(t), conversationId, "again", "client-msg-0002"))).toBe(
      "reconnect_required",
    );
  });

  it.each([
    ["a network failure", "network", "network"],
    ["a timeout", "hang", "timeout"],
    ["a Meta outage (503)", { status: 503 }, "http_503"],
    ["a Meta server error (131000)", graphError(131000, 500), "meta_131000"],
    ["an answer without a wamid", { status: 200, body: { messages: [] } }, "invalid_json"],
    ["an answer that is not JSON", "invalid_json", "invalid_json"],
  ] as [string, FakeFailure, string][])(
    "marks the reply unknown after %s and never sends it again",
    async (_label, failure, failureReason) => {
      const { t, orgA, conversationId } = await setup();
      graph.failNext("send", failure);
      const queued = await reply(as(t), conversationId);
      await run(t);
      expect((await messages(t, conversationId))[0]).toMatchObject({
        status: "unknown",
        failureReason,
      });
      expect(graph.calls("send")).toBe(1);
      // Neither another delivery run nor a repeated submit sends it again.
      await t.action(internal.whatsapp.outbound.deliver, {
        orgId: orgA,
        messageId: queued.id as Id<"whatsappMessages">,
      });
      expect(await reply(as(t), conversationId)).toMatchObject({ status: "unknown" });
      await run(t);
      expect(graph.calls("send")).toBe(1);
    },
  );

  it("claims each message once: a second delivery run makes no Meta call", async () => {
    const { t, orgA, conversationId } = await setup();
    const queued = await reply(as(t), conversationId);
    const args = { orgId: orgA, messageId: queued.id as Id<"whatsappMessages"> };
    await t.action(internal.whatsapp.outbound.deliver, args);
    await t.action(internal.whatsapp.outbound.deliver, args);
    await run(t);
    expect(graph.calls("send")).toBe(1);
    // A recorded result is final: a later one for the same message changes nothing.
    const [connection] = (await rows(t)).connections;
    await t.mutation(internal.whatsapp.outbound.recordSendResult, {
      ...args,
      connectionId: connection!._id,
      outcome: { kind: "refused", reason: "meta_131047", metaCode: 131047, tokenRefused: false },
    });
    expect((await messages(t, conversationId))[0]).toMatchObject({ status: "submitted" });
    expect((await messages(t, conversationId))[0]!.failureReason).toBeUndefined();
  });
});
