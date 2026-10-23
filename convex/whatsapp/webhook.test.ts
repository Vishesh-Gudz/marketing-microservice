import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  as,
  expectMarketingError,
  ISSUER_CRM,
  ISSUER_ERP,
  newBackend,
  seedOrg,
  type Backend,
} from "../test.helpers";
import { MAX_WEBHOOK_BODY_BYTES, WHATSAPP_ENV, WHATSAPP_WEBHOOK_PATH } from "./config";
import {
  CUSTOMER_1,
  CUSTOMER_2,
  FAKE_WA_APP_SECRET,
  FAKE_WA_VERIFY_TOKEN,
  PHONE_A,
  PHONE_B,
  WABA_A,
  WABA_B,
  delivery,
  entry,
  nowSeconds,
  postDelivery,
  signBody,
  signBytes,
  stubWhatsAppEnv,
} from "./fakeWebhook.fixtures";

// Webhook vertical slice: GET verification, signed POST deliveries, tenant routing through the
// registered phone_number_id, idempotent persistence, async processing and tenant-scoped reads.
// Everything is in-process (convex-test) with signed fake payloads; nothing reaches Meta.

const ORG_A = { issuer: ISSUER_ERP, org: "42" };
const ORG_B = { issuer: ISSUER_CRM, org: "77" };
const PAGE = { paginationOpts: { numItems: 50, cursor: null } };

beforeEach(() => {
  vi.useFakeTimers();
  stubWhatsAppEnv();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function register(t: Backend, orgId: Id<"organizations">, wabaId: string, phone: string) {
  const result = await t.mutation(internal.whatsapp.phoneNumbers.register, {
    orgId,
    wabaId,
    phoneNumberId: phone,
    displayPhoneNumber: `+${phone.slice(-6)}`,
    actorSubject: "test:setup",
  });
  if (!result.ok) throw new Error(`register failed: ${result.reason}`);
  return result.numberId;
}

async function setup() {
  const t = newBackend();
  const orgA = await seedOrg(t, ORG_A.issuer, ORG_A.org);
  const orgB = await seedOrg(t, ORG_B.issuer, ORG_B.org);
  const numberA = await register(t, orgA, WABA_A, PHONE_A);
  const numberB = await register(t, orgB, WABA_B, PHONE_B);
  return { t, orgA, orgB, numberA, numberB };
}

async function processAll(t: Backend) {
  await t.finishAllScheduledFunctions(vi.runAllTimers);
}

async function conversations(t: Backend, who: typeof ORG_A) {
  return (await as(t, { ...who, role: "viewer" }).query(api.v1.whatsapp.listConversations, PAGE))
    .page;
}

async function messages(t: Backend, who: typeof ORG_A, conversationId: string) {
  return (
    await as(t, { ...who, role: "viewer" }).query(api.v1.whatsapp.listMessages, {
      conversationId,
      ...PAGE,
    })
  ).page;
}

async function table<
  T extends "whatsappWebhookEvents" | "whatsappMessages" | "whatsappConversations",
>(t: Backend, name: T) {
  return await t.run(async (ctx) => await ctx.db.query(name).collect());
}

async function seedOutbound(
  t: Backend,
  orgId: Id<"organizations">,
  numberId: Id<"whatsappPhoneNumbers">,
  wamid: string,
) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const conversationId = await ctx.db.insert("whatsappConversations", {
      orgId,
      numberId,
      contactWaId: CUSTOMER_1,
      lastMessageAt: now,
      createdAt: now,
      updatedAt: now,
    });
    return await ctx.db.insert("whatsappMessages", {
      orgId,
      conversationId,
      numberId,
      direction: "outbound",
      wamid,
      messageType: "text",
      text: "Your order shipped",
      status: "submitted",
      platformAt: now,
      createdAt: now,
      updatedAt: now,
    });
  });
}

// ---------------------------------------------------------------------------
// GET verification
// ---------------------------------------------------------------------------

describe("GET /whatsapp/webhook (verification)", () => {
  const verify = (t: Backend, params: Record<string, string>) =>
    t.fetch(`${WHATSAPP_WEBHOOK_PATH}?${new URLSearchParams(params)}`, { method: "GET" });
  const good = {
    "hub.mode": "subscribe",
    "hub.verify_token": FAKE_WA_VERIFY_TOKEN,
    "hub.challenge": "1158201444",
  };

  it("echoes the challenge for subscribe + the configured verify token", async () => {
    const response = await verify(newBackend(), good);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("1158201444");
  });

  it.each([
    ["a wrong verify token", { ...good, "hub.verify_token": "wrong-token-value" }],
    ["another mode", { ...good, "hub.mode": "unsubscribe" }],
    ["no challenge", { "hub.mode": "subscribe", "hub.verify_token": FAKE_WA_VERIFY_TOKEN }],
    ["a non-token challenge", { ...good, "hub.challenge": "<script>alert(1)</script>" }],
    ["no parameters", {}],
  ])("refuses %s with 403 and never echoes", async (_label, params) => {
    const response = await verify(newBackend(), params as Record<string, string>);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("1158201444");
  });

  it("refuses everything when no verify token is configured (fail closed)", async () => {
    vi.stubEnv(WHATSAPP_ENV.verifyToken, undefined);
    expect((await verify(newBackend(), good)).status).toBe(403);
    vi.stubEnv(WHATSAPP_ENV.verifyToken, "short");
    expect((await verify(newBackend(), { ...good, "hub.verify_token": "short" })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST authentication and validation
// ---------------------------------------------------------------------------

describe("POST /whatsapp/webhook (authentication and validation)", () => {
  const valid = () => delivery(entry({ messages: [{ id: "wamid.auth", text: "secret plan" }] }));

  async function expectNothingStored(t: Backend) {
    await processAll(t);
    expect(await table(t, "whatsappWebhookEvents")).toEqual([]);
    expect(await table(t, "whatsappMessages")).toEqual([]);
  }

  it("accepts a correctly signed delivery with 200", async () => {
    const { t } = await setup();
    const response = await postDelivery(t, valid());
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("EVENT_RECEIVED");
  });

  it.each([
    ["signed with another secret", { secret: "another-app-secret" }],
    ["unsigned", { signature: null }],
    ["with a malformed signature header", { signature: "sha256=nothex" }],
    ["with a sha1 signature", { signature: `sha1=${"0".repeat(40)}` }],
  ])("rejects a delivery %s with 401 and stores nothing", async (_label, options) => {
    const { t } = await setup();
    expect((await postDelivery(t, valid(), options)).status).toBe(401);
    await expectNothingStored(t);
  });

  it("verifies the exact raw bytes: a re-serialized body fails", async () => {
    const { t } = await setup();
    const payload = valid();
    const signature = await signBytes(new TextEncoder().encode(JSON.stringify(payload)));
    const pretty = JSON.stringify(payload, null, 2);
    expect((await postDelivery(t, payload, { signature, rawBody: pretty })).status).toBe(401);
    await expectNothingStored(t);
  });

  it("returns 503 (Meta retries later) while the app secret is not configured", async () => {
    const { t } = await setup();
    vi.stubEnv(WHATSAPP_ENV.appSecret, undefined);
    expect((await postDelivery(t, valid())).status).toBe(503);
    await expectNothingStored(t);
  });

  it("refuses bodies over the size limit with 413", async () => {
    const { t } = await setup();
    const rawBody = `{"object":"whatsapp_business_account","pad":"${"x".repeat(MAX_WEBHOOK_BODY_BYTES)}"}`;
    expect((await postDelivery(t, null, { rawBody })).status).toBe(413);
    await expectNothingStored(t);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["a JSON array", "[]"],
    ["another webhook object", JSON.stringify({ object: "instagram", entry: [] })],
    [
      "a change without phone_number_id",
      JSON.stringify(
        delivery({
          id: WABA_A,
          changes: [{ field: "messages", value: { messaging_product: "whatsapp", messages: [] } }],
        }),
      ),
    ],
  ])("rejects a signed delivery with %s as 400", async (_label, rawBody) => {
    const { t } = await setup();
    expect((await postDelivery(t, null, { rawBody })).status).toBe(400);
    await expectNothingStored(t);
  });

  it("rejects signed bytes that are not valid UTF-8 as 400", async () => {
    const { t } = await setup();
    const bytes = new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d]);
    const response = await t.fetch(WHATSAPP_WEBHOOK_PATH, {
      method: "POST",
      headers: { "x-hub-signature-256": await signBytes(bytes) },
      body: bytes,
    });
    expect(response.status).toBe(400);
    await expectNothingStored(t);
  });

  it("stores the valid items of a delivery and skips invalid ones", async () => {
    const { t } = await setup();
    const payload = delivery(entry({ messages: [{ id: "wamid.good" }, { id: "has space" }] }));
    expect((await postDelivery(t, payload)).status).toBe(200);
    await processAll(t);
    expect((await table(t, "whatsappMessages")).map((m) => m.wamid)).toEqual(["wamid.good"]);
  });

  it("never logs message content, signatures or secrets", async () => {
    const { t } = await setup();
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    );
    try {
      const payload = delivery(
        entry({ messages: [{ id: "wamid.private", text: "my card is 4111 1111 1111 1111" }] }),
      );
      await postDelivery(t, payload);
      await postDelivery(t, payload, { secret: "wrong-secret-value" });
      await postDelivery(t, null, { rawBody: "{bad json" });
      await processAll(t);
      const logged = JSON.stringify(spies.map((spy) => spy.mock.calls));
      expect(logged).not.toContain("4111");
      expect(logged).not.toContain(FAKE_WA_APP_SECRET);
      expect(logged).not.toContain("sha256=");
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// Inbound messages: persistence, async processing, reads
// ---------------------------------------------------------------------------

describe("inbound messages", () => {
  it("creates the conversation and message asynchronously, readable by the org", async () => {
    const { t } = await setup();
    const sentAt = nowSeconds() - 60;
    await postDelivery(
      t,
      delivery(
        entry({
          messages: [
            { id: "wamid.in1", text: "Is my order ready?", name: "Ana", timestamp: sentAt },
          ],
        }),
      ),
    );
    // Acknowledged before processing: the event is stored, not yet applied.
    const [stored] = await table(t, "whatsappWebhookEvents");
    expect(stored).toMatchObject({ status: "pending", dedupeKey: "message:wamid.in1" });
    expect(await table(t, "whatsappMessages")).toEqual([]);

    await processAll(t);
    const [conversation] = await conversations(t, ORG_A);
    expect(conversation).toMatchObject({
      phoneNumberId: PHONE_A,
      contactWaId: CUSTOMER_1,
      contactName: "Ana",
      lastInboundAt: new Date(sentAt * 1000).toISOString(),
      serviceWindowExpiresAt: new Date(sentAt * 1000 + 24 * 3600 * 1000).toISOString(),
    });
    expect(await messages(t, ORG_A, conversation!.id)).toEqual([
      expect.objectContaining({
        direction: "inbound",
        type: "text",
        text: "Is my order ready?",
        status: "received",
        at: new Date(sentAt * 1000).toISOString(),
      }),
    ]);
    // The processed event no longer holds the message body.
    const [processed] = await table(t, "whatsappWebhookEvents");
    expect(processed).toMatchObject({ status: "processed" });
    expect(processed!.event).toBeUndefined();
  });

  it("threads messages per customer and orders them newest first", async () => {
    const { t } = await setup();
    const base = nowSeconds() - 600;
    await postDelivery(
      t,
      delivery(
        entry({
          messages: [
            { id: "wamid.c1a", from: CUSTOMER_1, text: "first", timestamp: base },
            { id: "wamid.c2a", from: CUSTOMER_2, text: "other customer", timestamp: base + 1 },
            { id: "wamid.c1b", from: CUSTOMER_1, text: "second", timestamp: base + 2 },
          ],
        }),
      ),
    );
    await processAll(t);
    const threads = await conversations(t, ORG_A);
    expect(threads.map((c) => c.contactWaId)).toEqual([CUSTOMER_1, CUSTOMER_2]);
    expect((await messages(t, ORG_A, threads[0]!.id)).map((m) => m.text)).toEqual([
      "second",
      "first",
    ]);
  });

  it("clamps a future platform timestamp so it cannot extend the service window", async () => {
    const { t } = await setup();
    await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.future", timestamp: nowSeconds() + 86_400 }] })),
    );
    await processAll(t);
    const [conversation] = await conversations(t, ORG_A);
    expect(Date.parse(conversation!.lastInboundAt!)).toBeLessThanOrEqual(Date.now());
  });

  it("stores non-text messages by type only", async () => {
    const { t } = await setup();
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.img", type: "image" }] })));
    await processAll(t);
    const [message] = await table(t, "whatsappMessages");
    expect(message).toMatchObject({ messageType: "image", status: "received" });
    expect(message!.text).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Idempotency: duplicates and retries
// ---------------------------------------------------------------------------

describe("duplicate deliveries and retries", () => {
  const payload = () => delivery(entry({ messages: [{ id: "wamid.dup", text: "once" }] }));

  it("stores and processes a redelivered event once (redelivery before processing)", async () => {
    const { t } = await setup();
    await postDelivery(t, payload());
    expect((await postDelivery(t, payload())).status).toBe(200);
    expect(await table(t, "whatsappWebhookEvents")).toHaveLength(1);
    await processAll(t);
    expect(await table(t, "whatsappMessages")).toHaveLength(1);
  });

  it("ignores a retry that arrives after processing", async () => {
    const { t } = await setup();
    await postDelivery(t, payload());
    await processAll(t);
    expect((await postDelivery(t, payload())).status).toBe(200);
    await processAll(t);
    expect(await table(t, "whatsappWebhookEvents")).toHaveLength(1);
    expect(await table(t, "whatsappMessages")).toHaveLength(1);
  });

  it("deduplicates the same event repeated inside one delivery", async () => {
    const { t } = await setup();
    await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.twice" }, { id: "wamid.twice" }] })),
    );
    await processAll(t);
    expect(await table(t, "whatsappWebhookEvents")).toHaveLength(1);
    expect(await table(t, "whatsappMessages")).toHaveLength(1);
  });

  it("re-running processing for already processed events changes nothing", async () => {
    const { t } = await setup();
    await postDelivery(t, payload());
    await processAll(t);
    const eventIds = (await table(t, "whatsappWebhookEvents")).map((e) => e._id);
    const again = await t.mutation(internal.whatsapp.processing.processEvents, { eventIds });
    expect(again).toEqual({ processed: 0, unmatched: 0, ignored: 0, skipped: 1 });
    expect(await table(t, "whatsappMessages")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Tenant routing and cross-tenant isolation
// ---------------------------------------------------------------------------

describe("tenant routing and isolation", () => {
  it("acknowledges but drops deliveries for an unknown phone_number_id", async () => {
    const { t } = await setup();
    const response = await postDelivery(
      t,
      delivery(entry({ phoneNumberId: "209999999999999", messages: [{ id: "wamid.unknown" }] })),
    );
    expect(response.status).toBe(200);
    await processAll(t);
    expect(await table(t, "whatsappWebhookEvents")).toEqual([]);
    expect(await table(t, "whatsappConversations")).toEqual([]);
  });

  it("drops a change whose WABA id does not match the registered number", async () => {
    const { t } = await setup();
    await postDelivery(
      t,
      delivery(entry({ wabaId: WABA_B, phoneNumberId: PHONE_A, messages: [{ id: "wamid.x" }] })),
    );
    await processAll(t);
    expect(await table(t, "whatsappWebhookEvents")).toEqual([]);
  });

  it("routes each change to its own org and ignores org ids in the payload", async () => {
    const { t, orgB } = await setup();
    const payload = delivery(
      entry({
        wabaId: WABA_A,
        phoneNumberId: PHONE_A,
        messages: [{ id: "wamid.forA", text: "for A" }],
        extraValue: { orgId: orgB, org_id: ORG_B.org },
      }),
      entry({
        wabaId: WABA_B,
        phoneNumberId: PHONE_B,
        messages: [{ id: "wamid.forB", text: "for B" }],
      }),
    );
    (payload as Record<string, unknown>).orgId = orgB;
    await postDelivery(t, payload);
    await processAll(t);

    const [threadA] = await conversations(t, ORG_A);
    const [threadB] = await conversations(t, ORG_B);
    expect((await conversations(t, ORG_A)).length).toBe(1);
    expect((await conversations(t, ORG_B)).length).toBe(1);
    expect((await messages(t, ORG_A, threadA!.id)).map((m) => m.text)).toEqual(["for A"]);
    expect((await messages(t, ORG_B, threadB!.id)).map((m) => m.text)).toEqual(["for B"]);

    // Another org's ids are NOT_FOUND, never readable.
    const viewerA = as(t, { ...ORG_A, role: "viewer" });
    await expectMarketingError(
      viewerA.query(api.v1.whatsapp.getConversation, { conversationId: threadB!.id }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      viewerA.query(api.v1.whatsapp.listMessages, { conversationId: threadB!.id, ...PAGE }),
      "NOT_FOUND",
    );
  });

  it("stops routing to an org after its number is disconnected; history stays with it", async () => {
    const { t, orgB, numberA } = await setup();
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.before", text: "old" }] })));
    await processAll(t);
    await t.mutation(internal.whatsapp.phoneNumbers.disconnect, {
      numberId: numberA,
      actorSubject: "test:admin",
    });

    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.after1" }] })));
    await processAll(t);
    expect((await table(t, "whatsappMessages")).map((m) => m.wamid)).toEqual(["wamid.before"]);

    // The same number registered by another org now routes there, not to the old owner.
    await register(t, orgB, WABA_A, PHONE_A);
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.after2", text: "new" }] })));
    await processAll(t);
    const [threadA] = await conversations(t, ORG_A);
    expect((await messages(t, ORG_A, threadA!.id)).map((m) => m.text)).toEqual(["old"]);
    const threadsB = await conversations(t, ORG_B);
    expect(threadsB.map((c) => c.phoneNumberId)).toEqual([PHONE_A]);
    expect((await messages(t, ORG_B, threadsB[0]!.id)).map((m) => m.text)).toEqual(["new"]);
  });

  it("fails closed when a phone_number_id somehow maps to two active orgs", async () => {
    const { t, orgA, orgB } = await setup();
    // register() makes this impossible; inserted directly to prove the webhook never picks one.
    await t.run(async (ctx) => {
      const now = Date.now();
      for (const orgId of [orgA, orgB]) {
        await ctx.db.insert("whatsappPhoneNumbers", {
          orgId,
          wabaId: WABA_A,
          phoneNumberId: "299999999999999",
          status: "active",
          registeredBySubject: "test",
          createdAt: now,
          updatedAt: now,
        });
      }
    });
    const response = await postDelivery(
      t,
      delivery(entry({ phoneNumberId: "299999999999999", messages: [{ id: "wamid.amb" }] })),
    );
    expect(response.status).toBe(200);
    await processAll(t);
    expect(await table(t, "whatsappWebhookEvents")).toEqual([]);
  });

  it("refuses to register a number that another org holds active", async () => {
    const { t, orgB } = await setup();
    expect(
      await t.mutation(internal.whatsapp.phoneNumbers.register, {
        orgId: orgB,
        wabaId: WABA_A,
        phoneNumberId: PHONE_A,
        actorSubject: "test",
      }),
    ).toEqual({ ok: false, reason: "in_use" });
  });

  it("refuses non-numeric ids on register", async () => {
    const { t, orgA } = await setup();
    expect(
      await t.mutation(internal.whatsapp.phoneNumbers.register, {
        orgId: orgA,
        wabaId: "waba",
        phoneNumberId: PHONE_A,
        actorSubject: "test",
      }),
    ).toEqual({ ok: false, reason: "invalid_id" });
  });

  it("keeps a status for another org's message away from that org", async () => {
    const { t, orgB, numberB } = await setup();
    const messageB = await seedOutbound(t, orgB, numberB, "wamid.ofB");
    // Delivered on org A's number: routed to A, where that wamid is unknown.
    await postDelivery(t, delivery(entry({ statuses: [{ id: "wamid.ofB", status: "read" }] })));
    await processAll(t);
    const [event] = await table(t, "whatsappWebhookEvents");
    expect(event).toMatchObject({ status: "unmatched" });
    expect(await t.run(async (ctx) => (await ctx.db.get(messageB))!.status)).toBe("submitted");
  });
});

// ---------------------------------------------------------------------------
// Delivery statuses
// ---------------------------------------------------------------------------

describe("delivery statuses", () => {
  async function statusOf(t: Backend, id: Id<"whatsappMessages">) {
    return await t.run(async (ctx) => (await ctx.db.get(id))!);
  }

  it("applies sent, delivered and read in order", async () => {
    const { t, orgA, numberA } = await setup();
    const id = await seedOutbound(t, orgA, numberA, "wamid.out");
    const base = nowSeconds();
    for (const [status, offset] of [
      ["sent", 1],
      ["delivered", 2],
      ["read", 3],
    ] as const) {
      await postDelivery(
        t,
        delivery(entry({ statuses: [{ id: "wamid.out", status, timestamp: base + offset }] })),
      );
      await processAll(t);
    }
    expect(await statusOf(t, id)).toMatchObject({
      status: "read",
      sentAt: (base + 1) * 1000,
      deliveredAt: (base + 2) * 1000,
      readAt: (base + 3) * 1000,
    });
  });

  it("handles out-of-order statuses in one delivery and across deliveries", async () => {
    const { t, orgA, numberA } = await setup();
    const id = await seedOutbound(t, orgA, numberA, "wamid.ooo");
    const base = nowSeconds();
    await postDelivery(
      t,
      delivery(
        entry({
          statuses: [
            { id: "wamid.ooo", status: "read", timestamp: base + 3 },
            { id: "wamid.ooo", status: "delivered", timestamp: base + 2 },
          ],
        }),
      ),
    );
    await processAll(t);
    await postDelivery(
      t,
      delivery(entry({ statuses: [{ id: "wamid.ooo", status: "sent", timestamp: base + 1 }] })),
    );
    await processAll(t);
    expect(await statusOf(t, id)).toMatchObject({
      status: "read",
      sentAt: (base + 1) * 1000,
      deliveredAt: (base + 2) * 1000,
      readAt: (base + 3) * 1000,
    });
  });

  it("records a failure with its code only, and a later delivered does not revive it", async () => {
    const { t, orgA, numberA } = await setup();
    const id = await seedOutbound(t, orgA, numberA, "wamid.fail");
    await postDelivery(
      t,
      delivery(entry({ statuses: [{ id: "wamid.fail", status: "failed", errorCode: 131026 }] })),
    );
    await processAll(t);
    await postDelivery(
      t,
      delivery(entry({ statuses: [{ id: "wamid.fail", status: "delivered" }] })),
    );
    await processAll(t);
    const message = await statusOf(t, id);
    expect(message).toMatchObject({ status: "failed", errorCode: 131026 });
    expect(JSON.stringify(message)).not.toContain("Fake error title");
  });

  it("deduplicates a repeated status report", async () => {
    const { t, orgA, numberA } = await setup();
    await seedOutbound(t, orgA, numberA, "wamid.rep");
    const payload = delivery(entry({ statuses: [{ id: "wamid.rep", status: "delivered" }] }));
    await postDelivery(t, payload);
    await postDelivery(t, payload);
    await processAll(t);
    expect(await table(t, "whatsappWebhookEvents")).toHaveLength(1);
  });

  it("keeps a status for an unknown message as unmatched, with its body", async () => {
    const { t } = await setup();
    await postDelivery(t, delivery(entry({ statuses: [{ id: "wamid.later", status: "sent" }] })));
    await processAll(t);
    const [event] = await table(t, "whatsappWebhookEvents");
    expect(event).toMatchObject({ status: "unmatched", wamid: "wamid.later" });
    expect(event!.event).toMatchObject({ kind: "status", status: "sent" });
  });

  it("ignores statuses that point at an inbound message", async () => {
    const { t } = await setup();
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.inbound" }] })));
    await processAll(t);
    await postDelivery(t, delivery(entry({ statuses: [{ id: "wamid.inbound", status: "read" }] })));
    await processAll(t);
    const [message] = await table(t, "whatsappMessages");
    expect(message).toMatchObject({ status: "received" });
    expect(message!.readAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tenant isolation of the read API (hardening step 1)
// ---------------------------------------------------------------------------

describe("v1/whatsapp tenant isolation", () => {
  /** Same external org id as ORG_A under another issuer: a different tenant. */
  const ORG_C = { issuer: ISSUER_CRM, org: ORG_A.org };

  /** Org A gets two customers' messages; org B gets one; org C has no WhatsApp at all. */
  async function seeded() {
    const ctx = await setup();
    await seedOrg(ctx.t, ORG_C.issuer, ORG_C.org);
    await postDelivery(
      ctx.t,
      delivery(
        entry({
          messages: [
            { id: "wamid.a1", from: CUSTOMER_1, text: "a one" },
            { id: "wamid.a2", from: CUSTOMER_2, text: "a two" },
          ],
        }),
        entry({ wabaId: WABA_B, phoneNumberId: PHONE_B, messages: [{ id: "wamid.b1" }] }),
      ),
    );
    await processAll(ctx.t);
    const threadsA = await conversations(ctx.t, ORG_A);
    expect(threadsA).toHaveLength(2);
    return { ...ctx, threadsA };
  }

  it("lists none of another org's conversations, at any page size", async () => {
    const { t, threadsA } = await seeded();
    const idsA = new Set(threadsA.map((c) => c.id));
    for (const who of [ORG_B, ORG_C]) {
      const page = (
        await as(t, { ...who, role: "admin" }).query(api.v1.whatsapp.listConversations, {
          paginationOpts: { numItems: 100, cursor: null },
        })
      ).page;
      expect(page.some((c) => idsA.has(c.id))).toBe(false);
    }
    expect(await conversations(t, ORG_B)).toHaveLength(1);
    expect(await conversations(t, ORG_C)).toEqual([]);
  });

  it.each(["viewer", "editor", "admin", "org:admin"])(
    "returns NOT_FOUND for another org's conversation and messages (role %s)",
    async (role) => {
      const { t, threadsA } = await seeded();
      for (const who of [ORG_B, ORG_C]) {
        const other = as(t, { ...who, role });
        for (const thread of threadsA) {
          await expectMarketingError(
            other.query(api.v1.whatsapp.getConversation, { conversationId: thread.id }),
            "NOT_FOUND",
          );
          await expectMarketingError(
            other.query(api.v1.whatsapp.listMessages, { conversationId: thread.id, ...PAGE }),
            "NOT_FOUND",
          );
        }
      }
    },
  );

  it("returns NOT_FOUND for malformed ids and ids of other tables", async () => {
    const { t, numberA } = await seeded();
    const [message] = await table(t, "whatsappMessages");
    const viewerA = as(t, { ...ORG_A, role: "viewer" });
    for (const conversationId of ["not-an-id", message!._id, numberA]) {
      await expectMarketingError(
        viewerA.query(api.v1.whatsapp.getConversation, { conversationId }),
        "NOT_FOUND",
      );
      await expectMarketingError(
        viewerA.query(api.v1.whatsapp.listMessages, { conversationId, ...PAGE }),
        "NOT_FOUND",
      );
    }
  });

  it("refuses unauthenticated callers", async () => {
    const { t, threadsA } = await seeded();
    const conversationId = threadsA[0]!.id;
    await expectMarketingError(t.query(api.v1.whatsapp.listConversations, PAGE), "UNAUTHENTICATED");
    await expectMarketingError(
      t.query(api.v1.whatsapp.getConversation, { conversationId }),
      "UNAUTHENTICATED",
    );
    await expectMarketingError(
      t.query(api.v1.whatsapp.listMessages, { conversationId, ...PAGE }),
      "UNAUTHENTICATED",
    );
  });

  it("accepts Clerk's org:viewer and refuses org:member and unknown roles", async () => {
    const { t } = await seeded();
    const read = (role: string) =>
      as(t, { ...ORG_A, role }).query(api.v1.whatsapp.listConversations, PAGE);
    expect((await read("org:viewer")).page).toHaveLength(2);
    await expectMarketingError(read("org:member"), "INVALID_TOKEN_CLAIMS");
    await expectMarketingError(read("owner"), "INVALID_TOKEN_CLAIMS");
  });
});

// ---------------------------------------------------------------------------
// Replay protection (hardening step 1)
// ---------------------------------------------------------------------------

describe("exact signed replays", () => {
  async function counts(t: Backend) {
    return {
      events: (await table(t, "whatsappWebhookEvents")).length,
      conversations: (await table(t, "whatsappConversations")).length,
      messages: (await table(t, "whatsappMessages")).length,
    };
  }

  /** The exact bytes and signature Meta would send again on a retry. */
  async function signed(payload: unknown) {
    const rawBody = JSON.stringify(payload);
    return { rawBody, signature: await signBody(rawBody) };
  }

  it("changes no event, conversation or message when the same bytes arrive again", async () => {
    const { t } = await setup();
    const replay = await signed(
      delivery(entry({ messages: [{ id: "wamid.replay", text: "only once", name: "Ana" }] })),
    );
    expect((await postDelivery(t, null, replay)).status).toBe(200);
    await processAll(t);
    const before = {
      conversations: await table(t, "whatsappConversations"),
      messages: await table(t, "whatsappMessages"),
    };

    for (let i = 0; i < 3; i++) {
      expect((await postDelivery(t, null, replay)).status).toBe(200);
    }
    await processAll(t);

    expect(await counts(t)).toEqual({ events: 1, conversations: 1, messages: 1 });
    expect(await table(t, "whatsappConversations")).toEqual(before.conversations);
    expect(await table(t, "whatsappMessages")).toEqual(before.messages);
  });

  it("stores only the new message when a retry is re-batched with new events", async () => {
    const { t } = await setup();
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.first" }] })));
    await processAll(t);
    await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.first" }, { id: "wamid.second" }] })),
    );
    await processAll(t);
    expect(await counts(t)).toEqual({ events: 2, conversations: 1, messages: 2 });
  });

  it("keeps replays of a two-org delivery separate per org", async () => {
    const { t } = await setup();
    const replay = await signed(
      delivery(
        entry({ messages: [{ id: "wamid.forA" }] }),
        entry({ wabaId: WABA_B, phoneNumberId: PHONE_B, messages: [{ id: "wamid.forB" }] }),
      ),
    );
    await postDelivery(t, null, replay);
    await postDelivery(t, null, replay);
    await processAll(t);
    await postDelivery(t, null, replay);
    await processAll(t);
    expect(await counts(t)).toEqual({ events: 2, conversations: 2, messages: 2 });
    expect(await conversations(t, ORG_A)).toHaveLength(1);
    expect(await conversations(t, ORG_B)).toHaveLength(1);
  });

  it("leaves an applied status untouched when it is replayed", async () => {
    const { t, orgA, numberA } = await setup();
    const id = await seedOutbound(t, orgA, numberA, "wamid.out-replay");
    const replay = await signed(
      delivery(entry({ statuses: [{ id: "wamid.out-replay", status: "read" }] })),
    );
    await postDelivery(t, null, replay);
    await processAll(t);
    const applied = await t.run(async (ctx) => await ctx.db.get(id));
    await postDelivery(t, null, replay);
    await processAll(t);
    expect(await t.run(async (ctx) => await ctx.db.get(id))).toEqual(applied);
    expect(await table(t, "whatsappWebhookEvents")).toHaveLength(1);
  });

  it("stores one of each when pending events are processed twice", async () => {
    const { t } = await setup();
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.twice-processed" }] })));
    const eventIds = (await table(t, "whatsappWebhookEvents")).map((e) => e._id);
    // A manual run before the scheduled one, then the scheduled one.
    await t.mutation(internal.whatsapp.processing.processEvents, { eventIds });
    await processAll(t);
    expect(await counts(t)).toEqual({ events: 1, conversations: 1, messages: 1 });
  });
});
