import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  as,
  expectMarketingError,
  ISSUER_CRM,
  ISSUER_ERP,
  newBackend,
  seedOrg,
  type Backend,
} from "../test.helpers";
import crons from "../crons";
import {
  EVENT_RETENTION_MS,
  MAX_RECOVERY_ATTEMPTS,
  MAX_RETENTION_CONTINUATIONS,
  MAX_WEBHOOK_BODY_BYTES,
  RECOVERY_INTERVAL_MINUTES,
  RETENTION_BATCH_SIZE,
  RETRY_GIVE_UP_AFTER_MS,
  STUCK_EVENT_AFTER_MS,
  WHATSAPP_ENV,
  WHATSAPP_WEBHOOK_PATH,
} from "./config";
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
  type MessageInput,
} from "./fakeWebhook.fixtures";

// Webhook vertical slice: GET verification, signed POST deliveries, tenant routing through the
// registered phone_number_id, idempotent persistence, async processing and tenant-scoped reads.
// Everything is in-process (convex-test) with signed fake payloads; nothing reaches Meta.

const ORG_A = { issuer: ISSUER_ERP, org: "42" };
const ORG_B = { issuer: ISSUER_CRM, org: "77" };
const PAGE = { paginationOpts: { numItems: 50, cursor: null } };
const HOUR_MS = 60 * 60 * 1000;

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
  // Numbers are registered well before the deliveries a test sends: the activation cutoff
  // drops events from before a number's registration.
  const now = Date.now();
  vi.setSystemTime(now - HOUR_MS);
  const numberA = await register(t, orgA, WABA_A, PHONE_A);
  const numberB = await register(t, orgB, WABA_B, PHONE_B);
  vi.setSystemTime(now);
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

// ---------------------------------------------------------------------------
// Number activation cutoff (hardening step 2)
// ---------------------------------------------------------------------------

describe("number activation cutoff", () => {
  /** Activation instant used by these tests: mid-second, as a real registration would be. */
  const ACTIVATED_AT = Date.UTC(2026, 9, 23, 12, 0, 0, 700);
  const ACTIVATED_S = Math.floor(ACTIVATED_AT / 1000);

  async function orgsAt(time: number) {
    vi.setSystemTime(time);
    const t = newBackend();
    const orgA = await seedOrg(t, ORG_A.issuer, ORG_A.org);
    const orgB = await seedOrg(t, ORG_B.issuer, ORG_B.org);
    return { t, orgA, orgB };
  }

  async function wamidsOf(t: Backend, orgId: Id<"organizations">) {
    return (await table(t, "whatsappMessages"))
      .filter((m) => m.orgId === orgId)
      .map((m) => m.wamid)
      .sort();
  }

  async function numberRow(t: Backend, id: Id<"whatsappPhoneNumbers">) {
    return (await t.run(async (ctx) => await ctx.db.get(id)))!;
  }

  it("drops events from before activation and keeps those at and after it", async () => {
    const { t, orgA } = await orgsAt(ACTIVATED_AT);
    const numberId = await register(t, orgA, WABA_A, PHONE_A);
    expect((await numberRow(t, numberId)).activatedAt).toBe(ACTIVATED_AT);

    await postDelivery(
      t,
      delivery(
        entry({
          messages: [
            { id: "wamid.before", timestamp: ACTIVATED_S - 1 },
            { id: "wamid.at", timestamp: ACTIVATED_S },
            { id: "wamid.after", timestamp: ACTIVATED_S + 60 },
          ],
          statuses: [{ id: "wamid.status-before", status: "sent", timestamp: ACTIVATED_S - 1 }],
        }),
      ),
    );
    await processAll(t);
    expect(await wamidsOf(t, orgA)).toEqual(["wamid.after", "wamid.at"]);
    expect((await table(t, "whatsappWebhookEvents")).map((e) => e.wamid).sort()).toEqual([
      "wamid.after",
      "wamid.at",
    ]);
  });

  it("moves the cutoff on re-activation: the disconnected gap is dropped, history is kept", async () => {
    const { t, orgA } = await orgsAt(ACTIVATED_AT);
    const numberId = await register(t, orgA, WABA_A, PHONE_A);
    await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.first", timestamp: ACTIVATED_S + 10 }] })),
    );
    await processAll(t);

    vi.setSystemTime(ACTIVATED_AT + HOUR_MS);
    await t.mutation(internal.whatsapp.phoneNumbers.disconnect, { numberId, actorSubject: "test" });
    const reactivatedAt = ACTIVATED_AT + 2 * HOUR_MS;
    vi.setSystemTime(reactivatedAt);
    expect(await register(t, orgA, WABA_A, PHONE_A)).toBe(numberId);
    expect((await numberRow(t, numberId)).activatedAt).toBe(reactivatedAt);

    const reactivatedS = Math.floor(reactivatedAt / 1000);
    await postDelivery(
      t,
      delivery(
        entry({
          messages: [
            { id: "wamid.first", timestamp: ACTIVATED_S + 10 }, // late retry of the first
            { id: "wamid.gap", timestamp: reactivatedS - 1800 }, // sent while disconnected
            { id: "wamid.back", timestamp: reactivatedS + 10 },
          ],
        }),
      ),
    );
    await processAll(t);
    expect(await wamidsOf(t, orgA)).toEqual(["wamid.back", "wamid.first"]);
    expect(await table(t, "whatsappConversations")).toHaveLength(1);
  });

  it("keeps the activation when an already active number is registered again", async () => {
    const { t, orgA } = await orgsAt(ACTIVATED_AT);
    const numberId = await register(t, orgA, WABA_A, PHONE_A);
    vi.setSystemTime(ACTIVATED_AT + HOUR_MS);
    expect(await register(t, orgA, WABA_A, PHONE_A)).toBe(numberId);
    expect((await numberRow(t, numberId)).activatedAt).toBe(ACTIVATED_AT);

    await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.between", timestamp: ACTIVATED_S + 1800 }] })),
    );
    await processAll(t);
    expect(await wamidsOf(t, orgA)).toEqual(["wamid.between"]);
  });

  it("falls back to createdAt for numbers registered before activatedAt existed", async () => {
    const { t, orgA } = await orgsAt(ACTIVATED_AT);
    await t.run(async (ctx) => {
      await ctx.db.insert("whatsappPhoneNumbers", {
        orgId: orgA,
        wabaId: WABA_A,
        phoneNumberId: PHONE_A,
        status: "active",
        registeredBySubject: "legacy",
        createdAt: ACTIVATED_AT,
        updatedAt: ACTIVATED_AT,
      });
    });
    await postDelivery(
      t,
      delivery(
        entry({
          messages: [
            { id: "wamid.legacy-before", timestamp: ACTIVATED_S - 1 },
            { id: "wamid.legacy-at", timestamp: ACTIVATED_S },
            { id: "wamid.legacy-after", timestamp: ACTIVATED_S + 1 },
          ],
        }),
      ),
    );
    await processAll(t);
    expect(await wamidsOf(t, orgA)).toEqual(["wamid.legacy-after", "wamid.legacy-at"]);
  });

  it("never gives the new owner a reassigned number's earlier deliveries", async () => {
    const { t, orgA, orgB } = await orgsAt(ACTIVATED_AT);
    const numberA = await register(t, orgA, WABA_A, PHONE_A);
    const forA = delivery(
      entry({ messages: [{ id: "wamid.for-a", text: "for A", timestamp: ACTIVATED_S + 10 }] }),
    );
    await postDelivery(t, forA);
    await processAll(t);

    vi.setSystemTime(ACTIVATED_AT + HOUR_MS);
    await t.mutation(internal.whatsapp.phoneNumbers.disconnect, {
      numberId: numberA,
      actorSubject: "test",
    });
    const movedAt = ACTIVATED_AT + 2 * HOUR_MS;
    vi.setSystemTime(movedAt);
    const numberB = await register(t, orgB, WABA_A, PHONE_A);
    expect(numberB).not.toBe(numberA);

    const movedS = Math.floor(movedAt / 1000);
    await postDelivery(t, forA); // Meta's late retry of A's message
    await postDelivery(
      t,
      delivery(
        entry({
          messages: [
            { id: "wamid.unowned", timestamp: movedS - 1800 }, // sent while nobody owned it
            { id: "wamid.for-b", text: "for B", timestamp: movedS + 5 },
          ],
        }),
      ),
    );
    await processAll(t);

    expect(await wamidsOf(t, orgA)).toEqual(["wamid.for-a"]);
    expect(await wamidsOf(t, orgB)).toEqual(["wamid.for-b"]);
    expect((await table(t, "whatsappConversations")).map((c) => c.orgId).sort()).toEqual(
      [orgA, orgB].sort(),
    );
  });

  it("documents the limit: a later status for the old owner's message reaches the new owner as unmatched", async () => {
    const { t, orgA, orgB } = await orgsAt(ACTIVATED_AT);
    const numberA = await register(t, orgA, WABA_A, PHONE_A);
    const outboundA = await seedOutbound(t, orgA, numberA, "wamid.out-a");
    await t.mutation(internal.whatsapp.phoneNumbers.disconnect, {
      numberId: numberA,
      actorSubject: "test",
    });
    const movedAt = ACTIVATED_AT + HOUR_MS;
    vi.setSystemTime(movedAt);
    await register(t, orgB, WABA_A, PHONE_A);

    // The customer reads A's message after the move: the status is newer than B's activation.
    await postDelivery(
      t,
      delivery(
        entry({
          statuses: [
            { id: "wamid.out-a", status: "read", timestamp: Math.floor(movedAt / 1000) + 60 },
          ],
        }),
      ),
    );
    await processAll(t);

    const [event] = await table(t, "whatsappWebhookEvents");
    expect(event).toMatchObject({ orgId: orgB, status: "unmatched", kind: "status" });
    // A's message is never touched from B's side, and B gets no message or conversation.
    expect(await t.run(async (ctx) => (await ctx.db.get(outboundA))!.status)).toBe("submitted");
    expect(await wamidsOf(t, orgB)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Stuck-event recovery (hardening step 3)
// ---------------------------------------------------------------------------

describe("stuck-event recovery", () => {
  /**
   * A poison event, as data drift would create one: two conversation rows for the same contact
   * make processing that contact's message throw (`.unique()`), which rolls back its batch.
   */
  async function poisonContact(
    t: Backend,
    orgId: Id<"organizations">,
    numberId: Id<"whatsappPhoneNumbers">,
    contactWaId: string,
  ) {
    return await t.run(async (ctx) => {
      const now = Date.now();
      const row = { orgId, numberId, contactWaId, lastMessageAt: now, createdAt: now };
      await ctx.db.insert("whatsappConversations", { ...row, updatedAt: now });
      return await ctx.db.insert("whatsappConversations", { ...row, updatedAt: now });
    });
  }

  async function sweep(t: Backend) {
    return await t.mutation(internal.whatsapp.recovery.recoverStuckEvents, {});
  }

  async function eventsByWamid(t: Backend) {
    return new Map((await table(t, "whatsappWebhookEvents")).map((e) => [e.wamid, e]));
  }

  /** Processing jobs that have not run yet (pending in Convex's scheduler). */
  async function queuedProcessingJobs(t: Backend) {
    const jobs = await t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
    );
    return jobs.filter((j) => j.name.includes("processEvents") && j.state.kind === "pending");
  }

  async function requeue(
    t: Backend,
    eventId: Id<"whatsappWebhookEvents">,
    actorSubject = "operator:test",
  ) {
    return await t.mutation(internal.whatsapp.recovery.requeueFailedEvent, {
      eventId,
      actorSubject,
    });
  }

  /** Cancels every processing job that has not run yet (original batch or retry). */
  async function cancelQueuedProcessing(t: Backend) {
    const queued = await queuedProcessingJobs(t);
    await t.run(async (ctx) => {
      for (const job of queued) await ctx.scheduler.cancel(job._id);
    });
    return queued.length;
  }

  async function requeueAudits(t: Backend) {
    return (await t.run(async (ctx) => await ctx.db.query("auditLog").collect())).filter(
      (entry) => entry.action === "whatsapp.event_requeued",
    );
  }

  function later(ms: number) {
    vi.setSystemTime(Date.now() + ms);
  }

  /** Lets the poison event fail its original attempt and every retry, then marks it failed. */
  async function untilFailed(t: Backend) {
    await processAll(t);
    for (let attempt = 0; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      later(STUCK_EVENT_AFTER_MS + 1000);
      await sweep(t);
      await processAll(t);
    }
  }

  let errors: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // convex-test logs every failing scheduled function; the failures here are deliberate.
    errors = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => errors.mockRestore());

  it("is scheduled by cron every RECOVERY_INTERVAL_MINUTES", () => {
    expect(crons.crons["whatsapp stuck event recovery"]?.schedule).toEqual({
      type: "interval",
      minutes: RECOVERY_INTERVAL_MINUTES,
    });
  });

  it("retries a failed batch event by event, so healthy events are processed", async () => {
    const { t, orgA, numberA } = await setup();
    await poisonContact(t, orgA, numberA, CUSTOMER_2);
    await postDelivery(
      t,
      delivery(
        entry({
          messages: [
            { id: "wamid.healthy", from: CUSTOMER_1 },
            { id: "wamid.poison", from: CUSTOMER_2 },
          ],
        }),
      ),
    );
    await processAll(t); // the batch throws and rolls back: both stay pending
    expect([...(await eventsByWamid(t)).values()].map((e) => e.status)).toEqual([
      "pending",
      "pending",
    ]);
    expect(await table(t, "whatsappMessages")).toEqual([]);

    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 2, failed: 0, waiting: 0 });
    await processAll(t);

    let events = await eventsByWamid(t);
    expect(events.get("wamid.healthy")).toMatchObject({ status: "processed", attempts: 0 });
    expect(events.get("wamid.poison")).toMatchObject({ status: "pending", attempts: 0 });
    expect((await table(t, "whatsappMessages")).map((m) => m.wamid)).toEqual(["wamid.healthy"]);

    // Only now, with its retry job recorded as failed, does the poison event's failure count.
    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 1, failed: 0, waiting: 0 });
    events = await eventsByWamid(t);
    expect(events.get("wamid.poison")).toMatchObject({ status: "pending", attempts: 1 });
  });

  it(`marks an event failed after ${MAX_RECOVERY_ATTEMPTS} failed retries and keeps its body`, async () => {
    const { t, orgA, numberA } = await setup();
    await poisonContact(t, orgA, numberA, CUSTOMER_1);
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.poison", text: "kept" }] })));
    await processAll(t);

    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      later(STUCK_EVENT_AFTER_MS + 1000);
      expect(await sweep(t)).toEqual({ retried: 1, failed: 0, waiting: 0 });
      await processAll(t);
    }
    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 0, failed: 1, waiting: 0 });

    const failed = (await eventsByWamid(t)).get("wamid.poison")!;
    expect(failed).toMatchObject({ status: "failed", attempts: MAX_RECOVERY_ATTEMPTS });
    expect(failed.failedAt).toBe(Date.now());
    expect(failed.event).toMatchObject({ kind: "message", text: "kept" });
    // Failed events are not retried again by the sweep.
    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 0, failed: 0, waiting: 0 });
    expect(await table(t, "whatsappMessages")).toEqual([]);
  });

  it("leaves events alone until they have been pending for the threshold", async () => {
    const { t, orgA, numberA } = await setup();
    await poisonContact(t, orgA, numberA, CUSTOMER_1);
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.poison" }] })));
    await processAll(t);
    expect(await sweep(t)).toEqual({ retried: 0, failed: 0, waiting: 0 });
    later(STUCK_EVENT_AFTER_MS - 1000);
    expect(await sweep(t)).toEqual({ retried: 0, failed: 0, waiting: 0 });
    later(2000);
    expect(await sweep(t)).toEqual({ retried: 1, failed: 0, waiting: 0 });
  });

  it("never counts or duplicates a retry that is still queued (scheduler backlog)", async () => {
    const { t, orgA, numberA } = await setup();
    await poisonContact(t, orgA, numberA, CUSTOMER_1);
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.backlog" }] })));
    await processAll(t); // the original attempt fails

    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 1, failed: 0, waiting: 0 });
    // The retry does not run (backlog) for many sweeps: far longer than all retries combined.
    for (let sweepRun = 0; sweepRun < 2 * MAX_RECOVERY_ATTEMPTS + 2; sweepRun++) {
      later(STUCK_EVENT_AFTER_MS + 1000);
      expect(await sweep(t)).toEqual({ retried: 0, failed: 0, waiting: 1 });
    }
    expect(await queuedProcessingJobs(t)).toHaveLength(1);
    expect((await eventsByWamid(t)).get("wamid.backlog")).toMatchObject({
      status: "pending",
      attempts: 0,
    });

    // Once the queued retry runs and fails, exactly one failure is counted.
    await processAll(t);
    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 1, failed: 0, waiting: 0 });
    expect((await eventsByWamid(t)).get("wamid.backlog")).toMatchObject({ attempts: 1 });
  });

  it("schedules a retry beside a still-queued original batch without duplicating anything", async () => {
    const { t } = await setup();
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.slow", text: "once" }] })));
    // The original batch has not run yet when the sweep finds the event.
    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 1, failed: 0, waiting: 0 });
    expect(await queuedProcessingJobs(t)).toHaveLength(2);

    await processAll(t); // both run: the first applies the event, the second skips it
    expect(await table(t, "whatsappWebhookEvents")).toHaveLength(1);
    expect(await table(t, "whatsappConversations")).toHaveLength(1);
    expect((await table(t, "whatsappMessages")).map((m) => m.text)).toEqual(["once"]);
    expect((await eventsByWamid(t)).get("wamid.slow")).toMatchObject({
      status: "processed",
      attempts: 0,
    });
    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 0, failed: 0, waiting: 0 });
  });

  it("never retries processed events", async () => {
    const { t } = await setup();
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.ok" }] })));
    await processAll(t);
    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 0, failed: 0, waiting: 0 });
    expect(await table(t, "whatsappMessages")).toHaveLength(1);
  });

  it("keeps each org's events in that org when a mixed batch is recovered", async () => {
    const { t, orgA, orgB, numberA } = await setup();
    await poisonContact(t, orgA, numberA, CUSTOMER_1);
    await postDelivery(
      t,
      delivery(
        entry({ messages: [{ id: "wamid.poison-a" }] }),
        entry({ wabaId: WABA_B, phoneNumberId: PHONE_B, messages: [{ id: "wamid.for-b" }] }),
      ),
    );
    await processAll(t); // one batch for both orgs: rolled back together
    later(STUCK_EVENT_AFTER_MS + 1000);
    await sweep(t);
    await processAll(t);

    const events = await eventsByWamid(t);
    expect(events.get("wamid.for-b")).toMatchObject({ orgId: orgB, status: "processed" });
    expect(events.get("wamid.poison-a")).toMatchObject({ orgId: orgA, status: "pending" });
    const [message] = await table(t, "whatsappMessages");
    expect(message).toMatchObject({ orgId: orgB, wamid: "wamid.for-b" });
    expect(await conversations(t, ORG_A)).toHaveLength(2); // only the two poison rows
  });

  it("lets an admin requeue a failed event once the cause is fixed, and audits it", async () => {
    const { t, orgA, numberA } = await setup();
    const duplicate = await poisonContact(t, orgA, numberA, CUSTOMER_1);
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.requeue", text: "back" }] })));
    await untilFailed(t);
    const failed = (await eventsByWamid(t)).get("wamid.requeue")!;
    expect(failed).toMatchObject({ status: "failed", attempts: MAX_RECOVERY_ATTEMPTS });

    await t.run(async (ctx) => await ctx.db.delete(duplicate)); // the fix
    expect(await requeue(t, failed._id)).toBe(true);
    const [audit] = await requeueAudits(t);
    expect(audit).toMatchObject({
      orgId: orgA,
      subject: "operator:test",
      targetType: "whatsappWebhookEvent",
      targetId: failed._id,
      changes: {
        status: { from: "failed", to: "pending" },
        attempts: { from: MAX_RECOVERY_ATTEMPTS, to: 0 },
      },
    });
    expect(JSON.stringify(audit)).not.toContain("back");
    await processAll(t);

    const requeued = (await eventsByWamid(t)).get("wamid.requeue")!;
    expect(requeued).toMatchObject({ status: "processed", attempts: 0 });
    expect(requeued.event).toBeUndefined();
    expect(requeued.failedAt).toBeUndefined();
    const [message] = await table(t, "whatsappMessages");
    expect(message).toMatchObject({ orgId: orgA, text: "back" });
  });

  it("refuses to requeue events that are not failed, leaves them unchanged and unaudited", async () => {
    const { t } = await setup();
    // processed (body cleared), unmatched (body kept) and pending (body kept, not yet run)
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.done" }] })));
    await postDelivery(t, delivery(entry({ statuses: [{ id: "wamid.unknown", status: "sent" }] })));
    await processAll(t);
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.waiting" }] })));

    const before = await table(t, "whatsappWebhookEvents");
    expect(before.map((e) => e.status).sort()).toEqual(["pending", "processed", "unmatched"]);
    for (const event of before) {
      expect(await requeue(t, event._id)).toBe(false);
    }
    expect(await table(t, "whatsappWebhookEvents")).toEqual(before);
    expect(await requeueAudits(t)).toEqual([]);
  });

  it("requires an operator: subject for requeue and changes nothing otherwise", async () => {
    const { t, orgA, numberA } = await setup();
    await poisonContact(t, orgA, numberA, CUSTOMER_1);
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.attribution" }] })));
    await untilFailed(t);
    const failed = (await eventsByWamid(t)).get("wamid.attribution")!;
    expect(failed.status).toBe("failed");

    // Empty, JWT-style, system-style, unnamed, spaced and overlong subjects are all refused.
    for (const actorSubject of [
      "",
      "user_2abc",
      "system:connection-sweep",
      "operator:",
      "operator:has space",
      `operator:${"x".repeat(65)}`,
    ]) {
      await expectMarketingError(requeue(t, failed._id, actorSubject), "INVALID_ARGUMENT");
    }
    expect((await eventsByWamid(t)).get("wamid.attribution")).toEqual(failed);
    expect(await requeueAudits(t)).toEqual([]);
  });

  // Job-record lifecycle: Convex keeps finished scheduled jobs for 7 days only, and jobs can be
  // canceled. None of that may let an event be retried forever.

  it("counts a canceled retry, so an event whose retries keep getting canceled still fails", async () => {
    const { t } = await setup();
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.canceled" }] })));
    expect(await cancelQueuedProcessing(t)).toBe(1); // the original batch never runs

    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      later(STUCK_EVENT_AFTER_MS + 1000);
      expect(await sweep(t)).toEqual({ retried: 1, failed: 0, waiting: 0 });
      expect(await cancelQueuedProcessing(t)).toBe(1);
      expect((await eventsByWamid(t)).get("wamid.canceled")).toMatchObject({
        status: "pending",
        attempts: attempt - 1,
      });
    }
    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 0, failed: 1, waiting: 0 });
    expect((await eventsByWamid(t)).get("wamid.canceled")).toMatchObject({
      status: "failed",
      attempts: MAX_RECOVERY_ATTEMPTS,
    });
    expect(await table(t, "whatsappMessages")).toEqual([]);
  });

  it("counts a retry whose job record has expired, so missing records still end in failed", async () => {
    const { t, orgA, numberA } = await setup();
    await poisonContact(t, orgA, numberA, CUSTOMER_1);
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.expired" }] })));
    await processAll(t);

    for (let attempt = 1; attempt <= MAX_RECOVERY_ATTEMPTS; attempt++) {
      later(STUCK_EVENT_AFTER_MS + 1000);
      expect(await sweep(t)).toEqual({ retried: 1, failed: 0, waiting: 0 });
      await processAll(t); // the retry fails...
      const { retryJobId } = (await eventsByWamid(t)).get("wamid.expired")!;
      // ...and its record is gone before the next sweep (as after Convex's 7-day retention).
      // Functions cannot delete system records in Convex; convex-test can, which simulates expiry.
      // @ts-expect-error -- deleting a _scheduled_functions record is test-only.
      await t.run(async (ctx) => await ctx.db.delete(retryJobId!));
      expect(await t.run(async (ctx) => await ctx.db.system.get(retryJobId!))).toBeNull();
    }
    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 0, failed: 1, waiting: 0 });
    expect((await eventsByWamid(t)).get("wamid.expired")).toMatchObject({
      status: "failed",
      attempts: MAX_RECOVERY_ATTEMPTS,
    });
  });

  it("gives up on a retry still queued a day after it was scheduled, and cancels it", async () => {
    const { t, orgA, numberA } = await setup();
    await poisonContact(t, orgA, numberA, CUSTOMER_1);
    await postDelivery(t, delivery(entry({ messages: [{ id: "wamid.stuck-queue" }] })));
    await processAll(t);
    later(STUCK_EVENT_AFTER_MS + 1000);
    expect(await sweep(t)).toEqual({ retried: 1, failed: 0, waiting: 0 });
    const { retryJobId } = (await eventsByWamid(t)).get("wamid.stuck-queue")!;

    later(RETRY_GIVE_UP_AFTER_MS - 1000); // still within the limit: keep waiting
    expect(await sweep(t)).toEqual({ retried: 0, failed: 0, waiting: 1 });
    later(2000);
    expect(await sweep(t)).toEqual({ retried: 0, failed: 1, waiting: 0 });

    expect((await eventsByWamid(t)).get("wamid.stuck-queue")).toMatchObject({
      status: "failed",
      attempts: 0, // the queued retry never ran, so it never counted
    });
    const job = await t.run(async (ctx) => await ctx.db.system.get(retryJobId!));
    expect(job?.state.kind).toBe("canceled");
    await processAll(t); // the canceled job never runs
    expect(await table(t, "whatsappMessages")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Webhook-event retention (hardening step 4)
// ---------------------------------------------------------------------------

describe("webhook event retention", () => {
  const DAY_MS = 24 * HOUR_MS;
  type EventStatus = Doc<"whatsappWebhookEvents">["status"];
  const STATUSES: EventStatus[] = ["pending", "processed", "unmatched", "ignored", "failed"];

  async function purge(t: Backend, continuation?: number) {
    return await t.mutation(
      internal.whatsapp.retention.purgeExpiredEvents,
      continuation === undefined ? {} : { continuation },
    );
  }

  /** Stores event rows received `ageMs` before now and left in `status`. */
  async function seedEvents(
    t: Backend,
    orgId: Id<"organizations">,
    numberId: Id<"whatsappPhoneNumbers">,
    options: { prefix: string; status: EventStatus; ageMs: number; count?: number },
  ) {
    await t.run(async (ctx) => {
      const receivedAt = Date.now() - options.ageMs;
      const final =
        options.status === "pending"
          ? {}
          : options.status === "failed"
            ? { failedAt: receivedAt }
            : { processedAt: receivedAt };
      for (let i = 0; i < (options.count ?? 1); i++) {
        const wamid = options.count === undefined ? options.prefix : `${options.prefix}.${i}`;
        await ctx.db.insert("whatsappWebhookEvents", {
          orgId,
          numberId,
          dedupeKey: `message:${wamid}`,
          kind: "message",
          wamid,
          status: options.status,
          receivedAt,
          ...final,
        });
      }
    });
  }

  async function wamids(t: Backend) {
    return (await table(t, "whatsappWebhookEvents")).map((e) => e.wamid).sort();
  }

  /** Retention runs queued in Convex's scheduler that have not run yet. */
  async function queuedPurges(t: Backend) {
    const jobs = await t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
    );
    return jobs.filter((j) => j.name.includes("purgeExpiredEvents") && j.state.kind === "pending");
  }

  function later(ms: number) {
    vi.setSystemTime(Date.now() + ms);
  }

  async function requeue(t: Backend, eventId: Id<"whatsappWebhookEvents">) {
    return await t.mutation(internal.whatsapp.recovery.requeueFailedEvent, {
      eventId,
      actorSubject: "operator:test",
    });
  }

  it("is scheduled by cron every hour", () => {
    expect(crons.crons["whatsapp event retention"]).toMatchObject({
      name: "whatsapp/retention:purgeExpiredEvents",
      schedule: { type: "hourly", minuteUTC: 37 },
    });
  });

  it("deletes every event no longer pending once 30 days old, never a pending one", async () => {
    const { t, orgA, numberA } = await setup();
    const ages = {
      year: 365 * DAY_MS,
      exactly: EVENT_RETENTION_MS,
      younger: EVENT_RETENTION_MS - 1,
      fresh: HOUR_MS,
    };
    const all: string[] = [];
    for (const status of STATUSES) {
      for (const [label, ageMs] of Object.entries(ages)) {
        await seedEvents(t, orgA, numberA, { prefix: `${status}.${label}`, status, ageMs });
        all.push(`${status}.${label}`);
      }
    }
    const expired = [
      "processed.year",
      "processed.exactly",
      "ignored.year",
      "ignored.exactly",
      "unmatched.year",
      "unmatched.exactly",
      "failed.year",
      "failed.exactly",
    ];

    expect(await purge(t)).toEqual({ deleted: expired.length, waiting: 0, continued: false });
    expect(await wamids(t)).toEqual(all.filter((wamid) => !expired.includes(wamid)).sort());
  });

  it("never deletes a pending event or its queued retry, however old; it still recovers", async () => {
    const { t } = await setup();
    await postDelivery(
      t,
      delivery(entry({ messages: [{ id: "wamid.waiting", text: "still pending" }] })),
    );
    // As recovery leaves it while its retry is queued.
    const [event] = await table(t, "whatsappWebhookEvents");
    await t.run(async (ctx) => {
      const retryJobId = await ctx.scheduler.runAfter(
        0,
        internal.whatsapp.processing.processEvents,
        { eventIds: [event!._id] },
      );
      await ctx.db.patch(event!._id, { attempts: 1, retryJobId, lastAttemptAt: Date.now() });
    });
    const before = await table(t, "whatsappWebhookEvents");

    later(365 * DAY_MS);
    expect(await purge(t)).toEqual({ deleted: 0, waiting: 0, continued: false });
    expect(await table(t, "whatsappWebhookEvents")).toEqual(before);
    const retryJobId = before[0]!.retryJobId!;
    const job = await t.run(async (ctx) => await ctx.db.system.get(retryJobId));
    expect(job?.state.kind).toBe("pending");

    await processAll(t);
    const kept = await table(t, "whatsappMessages");
    expect(kept.map((m) => [m.wamid, m.text])).toEqual([["wamid.waiting", "still pending"]]);
    // Processed now, and long past retention: the next run deletes the event, not the message.
    expect(await purge(t)).toEqual({ deleted: 1, waiting: 0, continued: false });
    expect(await table(t, "whatsappWebhookEvents")).toEqual([]);
    expect(await table(t, "whatsappMessages")).toEqual(kept);
  });

  it("lets a failed event be requeued until 30 days after receipt; then it is deleted for good", async () => {
    const { t, orgA } = await setup();
    await postDelivery(
      t,
      delivery(
        entry({
          messages: [
            { id: "wamid.in-time", text: "requeued in time" },
            { id: "wamid.too-late", from: CUSTOMER_2, text: "requeued too late" },
          ],
        }),
      ),
    );
    // As recovery leaves them: failed, with their body. Their original processing job is not
    // tracked and is still queued; it runs at the end.
    const received = new Map((await table(t, "whatsappWebhookEvents")).map((e) => [e.wamid, e]));
    const inTime = received.get("wamid.in-time")!;
    const tooLate = received.get("wamid.too-late")!;
    await t.run(async (ctx) => {
      for (const id of [inTime._id, tooLate._id]) {
        await ctx.db.patch(id, {
          status: "failed",
          attempts: MAX_RECOVERY_ATTEMPTS,
          failedAt: Date.now(),
        });
      }
    });

    later(EVENT_RETENTION_MS - 1);
    expect(await purge(t)).toEqual({ deleted: 0, waiting: 0, continued: false });
    expect(await requeue(t, inTime._id)).toBe(true);

    later(1); // both 30 days old: the failed one is deleted, the requeued one is pending again
    expect(await purge(t)).toEqual({ deleted: 1, waiting: 0, continued: false });
    expect(await table(t, "whatsappWebhookEvents")).toMatchObject([
      { wamid: "wamid.in-time", status: "pending" },
    ]);
    expect(await requeue(t, tooLate._id)).toBe(false); // nothing left to requeue

    // The original job skips the deleted event; the requeued one is processed.
    await processAll(t);
    const jobs = await t.run(
      async (ctx) => await ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(jobs.map((job) => [job.name, job.state.kind])).toEqual([
      ["whatsapp/processing:processEvents", "success"], // original batch: one event gone
      ["whatsapp/processing:processEvents", "success"], // the requeue's retry
    ]);
    expect((await table(t, "whatsappMessages")).map((m) => [m.wamid, m.text])).toEqual([
      ["wamid.in-time", "requeued in time"],
    ]);
    const audits = (await t.run(async (ctx) => await ctx.db.query("auditLog").collect())).filter(
      (entry) => entry.action === "whatsapp.event_requeued",
    );
    expect(audits.map((entry) => [entry.orgId, entry.targetId])).toEqual([[orgA, inTime._id]]);
    expect(await purge(t)).toEqual({ deleted: 1, waiting: 0, continued: false });
    expect(await table(t, "whatsappWebhookEvents")).toEqual([]);
  });

  it("never deletes an event whose recovery retry is still queued", async () => {
    const { t, orgA, numberA } = await setup();
    const old = EVENT_RETENTION_MS + DAY_MS;
    for (const [prefix, status] of [
      ["queued.processed", "processed"],
      ["queued.failed", "failed"],
      ["canceled.failed", "failed"],
    ] as const) {
      await seedEvents(t, orgA, numberA, { prefix, status, ageMs: old });
    }
    // A retry still queued 30 days after receipt would take a scheduler stall of weeks; the
    // guard keeps retention safe even then. A canceled retry is not queued.
    const ids = new Map((await table(t, "whatsappWebhookEvents")).map((e) => [e.wamid, e._id]));
    await t.run(async (ctx) => {
      for (const [wamid, id] of ids) {
        const retryJobId = await ctx.scheduler.runAfter(
          0,
          internal.whatsapp.processing.processEvents,
          { eventIds: [id] },
        );
        if (wamid.startsWith("canceled")) await ctx.scheduler.cancel(retryJobId);
        await ctx.db.patch(id, { retryJobId });
      }
    });

    expect(await purge(t)).toEqual({ deleted: 1, waiting: 2, continued: false });
    expect(await wamids(t)).toEqual(["queued.failed", "queued.processed"]);

    await processAll(t); // the retries run, find nothing pending and change nothing
    expect(await table(t, "whatsappMessages")).toEqual([]);
    expect(await purge(t)).toEqual({ deleted: 2, waiting: 0, continued: false });
    expect(await table(t, "whatsappWebhookEvents")).toEqual([]);
  });

  it("never touches messages or conversations; a redelivery after expiry changes nothing", async () => {
    const { t, orgA, numberA } = await setup();
    await seedOutbound(t, orgA, numberA, "wamid.out");
    const inbound = delivery(
      entry({ messages: [{ id: "wamid.in.a", text: "hello A" }] }),
      entry({
        wabaId: WABA_B,
        phoneNumberId: PHONE_B,
        messages: [{ id: "wamid.in.b", from: CUSTOMER_2, text: "hello B" }],
      }),
    );
    const statuses = delivery(
      entry({
        statuses: [
          { id: "wamid.out", status: "read" },
          { id: "wamid.unknown", status: "sent" },
          { id: "wamid.in.a", status: "read" },
        ],
      }),
    );
    await postDelivery(t, inbound);
    await processAll(t);
    await postDelivery(t, statuses);
    await processAll(t);
    const eventStates = async () =>
      (await table(t, "whatsappWebhookEvents")).map((e) => [e.dedupeKey, e.status]);
    expect(await eventStates()).toEqual([
      ["message:wamid.in.a", "processed"],
      ["message:wamid.in.b", "processed"],
      ["status:wamid.out:read", "processed"],
      ["status:wamid.unknown:sent", "unmatched"],
      ["status:wamid.in.a:read", "ignored"],
    ]);
    const messagesBefore = await table(t, "whatsappMessages");
    const conversationsBefore = await table(t, "whatsappConversations");
    expect(messagesBefore).toHaveLength(3);
    expect(conversationsBefore).toHaveLength(2); // org A's outbound and inbound share a thread

    later(EVENT_RETENTION_MS - 1);
    expect(await purge(t)).toEqual({ deleted: 0, waiting: 0, continued: false });
    later(1);
    expect(await purge(t)).toEqual({ deleted: 5, waiting: 0, continued: false });
    expect(await table(t, "whatsappWebhookEvents")).toEqual([]);
    expect(await table(t, "whatsappMessages")).toEqual(messagesBefore);
    expect(await table(t, "whatsappConversations")).toEqual(conversationsBefore);

    // Without their dedupe keys the same events are stored again, but nothing applies twice:
    // known messages and an already recorded `read` are ignored.
    await postDelivery(t, inbound);
    await postDelivery(t, statuses);
    await processAll(t);
    expect(await eventStates()).toEqual([
      ["message:wamid.in.a", "ignored"],
      ["message:wamid.in.b", "ignored"],
      ["status:wamid.out:read", "ignored"],
      ["status:wamid.unknown:sent", "unmatched"],
      ["status:wamid.in.a:read", "ignored"],
    ]);
    expect(await table(t, "whatsappMessages")).toEqual(messagesBefore);
    expect(await table(t, "whatsappConversations")).toEqual(conversationsBefore);
  });

  it(`deletes at most ${RETENTION_BATCH_SIZE} events per run across statuses and orgs, then chains a follow-up`, async () => {
    const { t, orgA, orgB, numberA, numberB } = await setup();
    const old = EVENT_RETENTION_MS + DAY_MS;
    const recent = EVENT_RETENTION_MS - HOUR_MS;
    await seedEvents(t, orgA, numberA, {
      prefix: "p",
      status: "processed",
      ageMs: old,
      count: 150,
    });
    await seedEvents(t, orgB, numberB, {
      prefix: "u",
      status: "unmatched",
      ageMs: old,
      count: 100,
    });
    await seedEvents(t, orgA, numberA, { prefix: "i", status: "ignored", ageMs: old, count: 10 });
    await seedEvents(t, orgA, numberA, {
      prefix: "r",
      status: "processed",
      ageMs: recent,
      count: 5,
    });
    await seedEvents(t, orgB, numberB, { prefix: "f", status: "failed", ageMs: old, count: 5 });

    expect(await purge(t)).toEqual({ deleted: RETENTION_BATCH_SIZE, waiting: 0, continued: true });
    expect(await table(t, "whatsappWebhookEvents")).toHaveLength(270 - RETENTION_BATCH_SIZE);
    const followUps = await queuedPurges(t);
    expect(followUps.map((job) => job.args)).toEqual([[{ continuation: 1 }]]);

    await processAll(t); // the follow-up deletes the last 65 expired events: not a full batch
    expect(await queuedPurges(t)).toEqual([]);
    expect(await wamids(t)).toEqual(Array.from({ length: 5 }, (_, i) => `r.${i}`));
  });

  it(`stops chaining after ${MAX_RETENTION_CONTINUATIONS} follow-ups; the next scheduled run continues`, async () => {
    const { t, orgA, numberA } = await setup();
    await seedEvents(t, orgA, numberA, {
      prefix: "p",
      status: "processed",
      ageMs: EVENT_RETENTION_MS + DAY_MS,
      count: RETENTION_BATCH_SIZE + 1,
    });

    expect(await purge(t, MAX_RETENTION_CONTINUATIONS)).toEqual({
      deleted: RETENTION_BATCH_SIZE,
      waiting: 0,
      continued: false,
    });
    expect(await queuedPurges(t)).toEqual([]);
    expect(await table(t, "whatsappWebhookEvents")).toHaveLength(1);
    expect(await purge(t)).toEqual({ deleted: 1, waiting: 0, continued: false });
  });

  it("is idempotent: repeated, overlapping and retried runs delete each expired event once", async () => {
    const { t, orgA, numberA } = await setup();
    const old = EVENT_RETENTION_MS + DAY_MS;
    await seedEvents(t, orgA, numberA, {
      prefix: "old",
      status: "processed",
      ageMs: old,
      count: 30,
    });
    await seedEvents(t, orgA, numberA, {
      prefix: "new",
      status: "ignored",
      ageMs: HOUR_MS,
      count: 3,
    });

    const runs = await Promise.all([purge(t), purge(t), purge(t)]);
    expect(runs.reduce((sum, run) => sum + run.deleted, 0)).toBe(30);
    expect(runs.some((run) => run.continued)).toBe(false);
    expect(await purge(t)).toEqual({ deleted: 0, waiting: 0, continued: false });
    expect(await purge(t, 1)).toEqual({ deleted: 0, waiting: 0, continued: false }); // a retried follow-up
    expect(await wamids(t)).toEqual(["new.0", "new.1", "new.2"]);

    // A batch that empties the backlog exactly chains one follow-up, which finds nothing.
    await seedEvents(t, orgA, numberA, {
      prefix: "full",
      status: "unmatched",
      ageMs: old,
      count: RETENTION_BATCH_SIZE,
    });
    expect(await purge(t)).toEqual({ deleted: RETENTION_BATCH_SIZE, waiting: 0, continued: true });
    await processAll(t);
    expect(await queuedPurges(t)).toEqual([]);
    expect(await wamids(t)).toEqual(["new.0", "new.1", "new.2"]);
  });
});

// ---------------------------------------------------------------------------
// Parser and webhook edge cases (hardening step 5)
// ---------------------------------------------------------------------------

describe("other subscribed fields beside messages", () => {
  /** Adds changes for other fields around the entry's `messages` change. */
  function withOtherFields(
    entryBody: Record<string, unknown>,
    before: unknown[],
    after: unknown[] = [],
  ) {
    const changes = entryBody.changes as unknown[];
    entryBody.changes = [...before, ...changes, ...after];
    return entryBody;
  }

  it("accepts a delivery mixing messages with other fields of any value shape; stores only the messages", async () => {
    const { t } = await setup();
    const payload = delivery(
      withOtherFields(
        entry({
          messages: [
            { id: "wamid.mixed.1", text: "first" },
            { id: "wamid.mixed.2", from: CUSTOMER_2, text: "second" },
          ],
        }),
        [
          { field: "message_template_quality_update", value: null },
          { field: "phone_number_name_update", value: "renamed" },
        ],
        [{ field: "account_update", value: [{ event: "x" }] }, { field: "security" }],
      ),
      { id: WABA_A, changes: [{ field: "message_template_status_update", value: 42 }] },
    );

    const response = await postDelivery(t, payload);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("EVENT_RECEIVED");
    await processAll(t);
    expect((await table(t, "whatsappWebhookEvents")).map((e) => [e.wamid, e.status])).toEqual([
      ["wamid.mixed.1", "processed"],
      ["wamid.mixed.2", "processed"],
    ]);
    expect((await table(t, "whatsappMessages")).map((m) => m.text)).toEqual(["first", "second"]);
  });

  it("acknowledges a delivery holding only other fields and stores nothing", async () => {
    const { t } = await setup();
    const payload = delivery({
      id: WABA_A,
      changes: [
        { field: "message_template_status_update", value: "APPROVED" },
        { field: "phone_number_quality_update" },
      ],
    });
    expect((await postDelivery(t, payload)).status).toBe(200);
    await processAll(t);
    expect(await table(t, "whatsappWebhookEvents")).toEqual([]);
  });

  it("still rejects the whole delivery (400) when a messages change is malformed", async () => {
    const { t } = await setup();
    const payload = delivery(
      entry({ messages: [{ id: "wamid.never", text: "valid on its own" }] }),
      {
        id: WABA_A,
        changes: [
          { field: "account_update", value: null },
          { field: "messages", value: [] },
        ],
      },
    );
    expect((await postDelivery(t, payload)).status).toBe(400);
    await processAll(t);
    expect(await table(t, "whatsappWebhookEvents")).toEqual([]);
    expect(await table(t, "whatsappMessages")).toEqual([]);
  });
});

describe("Content-Length header", () => {
  const body = JSON.stringify(
    delivery(entry({ messages: [{ id: "wamid.length", text: "sized" }] })),
  );
  const size = new TextEncoder().encode(body).byteLength;

  /** POSTs signed bytes with explicit Content-Length header(s). */
  async function postWithLength(t: Backend, lengths: string[], raw = body) {
    return await t.fetch(WHATSAPP_WEBHOOK_PATH, {
      method: "POST",
      headers: [
        ["content-type", "application/json"],
        ["x-hub-signature-256", await signBody(raw)],
        ...lengths.map((length): [string, string] => ["content-length", length]),
      ],
      body: raw,
    });
  }

  async function stored(t: Backend) {
    await processAll(t);
    return (await table(t, "whatsappWebhookEvents")).map((e) => e.wamid);
  }

  it.each([
    ["letters", "abc"],
    ["empty", ""],
    ["negative", "-1"],
    ["with a plus sign", "+12"],
    ["an exponent", "1e3"],
    ["hexadecimal", "0x10"],
    ["a decimal", "12.5"],
    ["digits with a space inside", "1 2"],
  ])("rejects a Content-Length that is %s with 400 and stores nothing", async (_label, length) => {
    const { t } = await setup();
    expect((await postWithLength(t, [length])).status).toBe(400);
    expect(await stored(t)).toEqual([]);
  });

  it("rejects a repeated Content-Length header with 400", async () => {
    const { t } = await setup();
    expect((await postWithLength(t, [String(size), String(size)])).status).toBe(400);
    expect(await stored(t)).toEqual([]);
  });

  it.each([
    ["the exact size", () => String(size)],
    ["the exact size with leading zeros", () => `000${size}`],
    ["exactly the limit", () => String(MAX_WEBHOOK_BODY_BYTES)],
  ])("accepts a well-formed Content-Length of %s", async (_label, length) => {
    const { t } = await setup();
    expect((await postWithLength(t, [length()])).status).toBe(200);
    expect(await stored(t)).toEqual(["wamid.length"]);
  });

  it.each([
    ["one byte over the limit", String(MAX_WEBHOOK_BODY_BYTES + 1)],
    ["far beyond any integer", "9".repeat(40)],
  ])("refuses a declared size %s with 413", async (_label, length) => {
    const { t } = await setup();
    expect((await postWithLength(t, [length])).status).toBe(413);
    expect(await stored(t)).toEqual([]);
  });

  it("refuses an actual body over the limit with 413 even when the header claims less", async () => {
    const { t } = await setup();
    const raw = `{"object":"whatsapp_business_account","pad":"${"x".repeat(MAX_WEBHOOK_BODY_BYTES)}"}`;
    expect((await postWithLength(t, ["10"], raw)).status).toBe(413);
    expect(await stored(t)).toEqual([]);
  });
});

describe("contact names from out-of-order messages", () => {
  /** Delivers and processes one message from CUSTOMER_1 per delivery, in the order given. */
  async function send(t: Backend, ...items: MessageInput[]) {
    for (const item of items) {
      expect((await postDelivery(t, delivery(entry({ messages: [item] })))).status).toBe(200);
      await processAll(t);
    }
  }

  async function conversation(t: Backend) {
    const [row] = await table(t, "whatsappConversations");
    return row!;
  }

  it("keeps the newest name when an older message is processed later", async () => {
    const { t } = await setup();
    const base = nowSeconds() - 600;
    await send(
      t,
      { id: "wamid.n2", name: "New", timestamp: base + 10 },
      { id: "wamid.n1", name: "Old", timestamp: base },
    );
    expect(await conversation(t)).toMatchObject({
      contactName: "New",
      contactNameAt: (base + 10) * 1000,
    });
    const [listed] = await conversations(t, ORG_A);
    expect(listed!.contactName).toBe("New");

    await send(t, { id: "wamid.n3", name: "Newest", timestamp: base + 20 });
    const row = await conversation(t);
    const newest = (await table(t, "whatsappMessages")).find((m) => m.wamid === "wamid.n3")!;
    // The name is dated by the same instant as the message and the service window.
    expect(row).toMatchObject({ contactName: "Newest", contactNameAt: newest.platformAt });
    expect(row.lastInboundAt).toBe(newest.platformAt);
  });

  it("lets a message from the same second replace the name, but not one a second older", async () => {
    const { t } = await setup();
    const base = nowSeconds() - 600;
    await send(t, { id: "wamid.s1", name: "A", timestamp: base });
    expect(await conversation(t)).toMatchObject({ contactName: "A", contactNameAt: base * 1000 });
    await send(t, { id: "wamid.s2", name: "B", timestamp: base });
    expect(await conversation(t)).toMatchObject({ contactName: "B", contactNameAt: base * 1000 });
    await send(t, { id: "wamid.s0", name: "C", timestamp: base - 1 });
    expect(await conversation(t)).toMatchObject({ contactName: "B", contactNameAt: base * 1000 });
  });

  it("keeps the newest name when one delivery carries the older message after the newer one", async () => {
    const { t } = await setup();
    const base = nowSeconds() - 600;
    const payload = delivery(
      entry({ messages: [{ id: "wamid.b2", name: "New", timestamp: base + 10 }] }),
      entry({ messages: [{ id: "wamid.b1", name: "Old", timestamp: base }] }),
    );
    expect((await postDelivery(t, payload)).status).toBe(200);
    await processAll(t);
    expect(await conversation(t)).toMatchObject({ contactName: "New" });
    expect(await table(t, "whatsappMessages")).toHaveLength(2);
  });

  it("dates a name by its own message: nameless messages neither clear nor date it", async () => {
    const { t } = await setup();
    const base = nowSeconds() - 600;
    await send(t, { id: "wamid.u1", timestamp: base + 20 });
    expect((await conversation(t)).contactName).toBeUndefined();
    await send(t, { id: "wamid.u2", name: "Old", timestamp: base }); // fills the empty name
    expect(await conversation(t)).toMatchObject({ contactName: "Old", contactNameAt: base * 1000 });
    // Newer than "Old", though older than the latest inbound message.
    await send(t, { id: "wamid.u3", name: "Mid", timestamp: base + 10 });
    await send(t, { id: "wamid.u4", name: "Stale", timestamp: base + 5 });
    await send(t, { id: "wamid.u5", timestamp: base + 30 });
    expect(await conversation(t)).toMatchObject({
      contactName: "Mid",
      contactNameAt: (base + 10) * 1000,
      lastInboundAt: (base + 30) * 1000,
    });
  });

  it("dates names stored before contactNameAt existed by the latest inbound message", async () => {
    const { t, orgA, numberA } = await setup();
    const base = nowSeconds() - 600;
    await t.run(async (ctx) => {
      await ctx.db.insert("whatsappConversations", {
        orgId: orgA,
        numberId: numberA,
        contactWaId: CUSTOMER_1,
        contactName: "Legacy",
        lastInboundAt: (base + 10) * 1000,
        lastMessageAt: (base + 10) * 1000,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });
    await send(t, { id: "wamid.l1", name: "Older", timestamp: base + 9 });
    expect(await conversation(t)).toMatchObject({ contactName: "Legacy" });
    expect((await conversation(t)).contactNameAt).toBeUndefined();
    await send(t, { id: "wamid.l2", name: "Same", timestamp: base + 10 });
    expect(await conversation(t)).toMatchObject({
      contactName: "Same",
      contactNameAt: (base + 10) * 1000,
    });
  });

  it("dates a name from a future-dated message by its receipt, like the service window", async () => {
    const { t } = await setup();
    await send(t, { id: "wamid.f1", name: "Skewed", timestamp: nowSeconds() + 3600 });
    const row = await conversation(t);
    expect(row).toMatchObject({ contactName: "Skewed", contactNameAt: Date.now() });
    expect(row.lastInboundAt).toBe(Date.now());
  });
});
