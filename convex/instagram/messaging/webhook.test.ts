import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ISSUER_CRM, ISSUER_ERP, newBackend, seedOrg, type Backend } from "../../test.helpers";
import { disableMessaging } from "./accounts";
import {
  EVENT_RETENTION_MS,
  INSTAGRAM_MESSAGING_ENV,
  INSTAGRAM_WEBHOOK_PATH,
  MAX_WEBHOOK_BODY_BYTES,
  STUCK_EVENT_AFTER_MS,
} from "./config";
import {
  CUSTOMER_1,
  CUSTOMER_2,
  customerMessage,
  deleted,
  delivery,
  echo,
  edited,
  entry,
  FAKE_IG_VERIFY_TOKEN,
  IG_ACCOUNT,
  IG_ACCOUNT_2,
  postDelivery,
  seedHolder,
  seedLinked,
  seen,
  stubInstagramWebhookEnv,
} from "./fakeWebhook.fixtures";

// ADR 0017 (IM2): the Instagram messaging webhook end to end in-process (convex-test): GET
// handshake, signed POST deliveries, routing to the org holding the account, the activation
// cutoff, deduplication and processing. Signed fake payloads only; nothing reaches Meta.

const MINUTE = 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  stubInstagramWebhookEnv();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/** Two orgs; org A holds IG_ACCOUNT since a minute ago. */
async function setup() {
  const t = newBackend();
  const orgA = { orgId: await seedOrg(t, ISSUER_ERP, "42"), issuer: ISSUER_ERP };
  const orgB = { orgId: await seedOrg(t, ISSUER_CRM, "77"), issuer: ISSUER_CRM };
  const now = Date.now();
  vi.setSystemTime(now - MINUTE);
  const holderA = await seedHolder(t, orgA);
  vi.setSystemTime(now);
  return { t, orgA, orgB, holderA };
}

async function deliver(t: Backend, payload: unknown) {
  const response = await postDelivery(t, payload);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  return response;
}

async function messagesOf(t: Backend, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("instagramMessages").collect()).filter((m) => m.orgId === orgId),
  );
}

async function conversationsOf(t: Backend, orgId: Id<"organizations">) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("instagramConversations").collect()).filter((c) => c.orgId === orgId),
  );
}

async function storedEvents(t: Backend) {
  return await t.run((ctx) => ctx.db.query("instagramWebhookEvents").collect());
}

describe("GET verification handshake", () => {
  const get = (t: Backend, query: string) => t.fetch(`${INSTAGRAM_WEBHOOK_PATH}?${query}`);
  const handshake = (token: string, challenge = "1158201444") =>
    `hub.mode=subscribe&hub.verify_token=${token}&hub.challenge=${challenge}`;

  it("echoes the challenge for the configured verify token only", async () => {
    const t = newBackend();
    const ok = await get(t, handshake(FAKE_IG_VERIFY_TOKEN));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("1158201444");
    expect((await get(t, handshake("wrong-token"))).status).toBe(403);
    expect((await get(t, handshake(FAKE_IG_VERIFY_TOKEN, "<script>"))).status).toBe(403);
    vi.stubEnv(INSTAGRAM_MESSAGING_ENV.webhookVerifyToken, "");
    expect((await get(t, handshake(FAKE_IG_VERIFY_TOKEN))).status).toBe(403);
  });
});

describe("POST delivery authentication and validation", () => {
  const payload = delivery(entry([customerMessage("m.1")]));

  it.each([
    ["no signing secret is configured", { unset: true }, 503],
    ["the signature is missing", { signature: null }, 401],
    ["the signature is not hex", { signature: "sha256=zz" }, 401],
    ["it is signed with another secret (no fallback)", { secret: "the-instagram-app-secret" }, 401],
    ["the body is not JSON", { rawBody: "{not json" }, 400],
    ["it is another product's delivery", { rawBody: '{"object":"page","entry":[]}' }, 400],
  ] as const)("refuses a delivery when %s and stores nothing", async (_case, options, status) => {
    const { t } = await setup();
    if ("unset" in options) vi.stubEnv(INSTAGRAM_MESSAGING_ENV.webhookAppSecret, "");
    const response = await postDelivery(t, payload, "unset" in options ? {} : options);
    expect(response.status).toBe(status);
    expect(await storedEvents(t)).toEqual([]);
  });

  it("refuses malformed and oversized bodies before verifying them", async () => {
    const { t } = await setup();
    const send = (headers: Record<string, string>, body: string) =>
      t.fetch(INSTAGRAM_WEBHOOK_PATH, { method: "POST", headers, body });
    expect((await send({ "content-length": "10, 10" }, "{}")).status).toBe(400);
    expect((await send({}, "x".repeat(MAX_WEBHOOK_BODY_BYTES + 1))).status).toBe(413);
  });
});

describe("routing to the org holding the account", () => {
  it("stores a customer message for the holder once, however often Meta delivers it", async () => {
    const { t, orgA, orgB, holderA } = await setup();
    const payload = delivery(entry([customerMessage("m.1", { text: "Do you ship?" })]));
    expect((await deliver(t, payload)).status).toBe(200);
    expect((await deliver(t, payload)).status).toBe(200);

    const [conversation] = await conversationsOf(t, orgA.orgId);
    expect(conversation).toMatchObject({
      messagingAccountId: holderA.accountId,
      contactIgsid: CUSTOMER_1,
    });
    expect(conversation!.lastInboundAt).toBe(conversation!.lastMessageAt);
    expect(await messagesOf(t, orgA.orgId)).toEqual([
      expect.objectContaining({
        conversationId: conversation!._id,
        direction: "inbound",
        origin: "customer",
        mid: "m.1",
        messageType: "text",
        text: "Do you ship?",
        status: "received",
      }),
    ]);
    expect(await messagesOf(t, orgB.orgId)).toEqual([]);
    // One stored event, its body (with the text) cleared once applied.
    const events = await storedEvents(t);
    expect(events).toEqual([
      expect.objectContaining({ status: "processed", dedupeKey: "message:m.1" }),
    ]);
    expect(events[0]!.event).toBeUndefined();
  });

  it("routes to the one holder although another org links the same account", async () => {
    const { t, orgA, orgB } = await setup();
    await seedLinked(t, orgB.orgId); // org B: analytics only, no messaging
    await deliver(t, delivery(entry([customerMessage("m.1")])));
    expect(await messagesOf(t, orgA.orgId)).toHaveLength(1);
    expect(await messagesOf(t, orgB.orgId)).toEqual([]);
  });

  it("still routes while the holder waits for action", async () => {
    const { t, orgA, holderA } = await setup();
    await t.run((ctx) => ctx.db.patch(holderA.accountId, { status: "action_required" }));
    await deliver(t, delivery(entry([customerMessage("m.1")])));
    expect(await messagesOf(t, orgA.orgId)).toHaveLength(1);
  });

  it.each([
    ["nobody holds the account", "other_account"],
    ["messaging was turned off", "disabled"],
    ["the holder's connection was disconnected", "revoked"],
    ["two orgs hold it (broken invariant)", "two_holders"],
  ] as const)("drops events but answers 200 when %s", async (_case, situation) => {
    const { t, orgA, orgB, holderA } = await setup();
    let account = IG_ACCOUNT;
    if (situation === "other_account") account = IG_ACCOUNT_2;
    if (situation === "disabled") {
      await t.run((ctx) =>
        disableMessaging(
          ctx.db,
          { ...orgA, subject: "user_admin" },
          holderA.accountId,
          "turned_off",
        ),
      );
    }
    if (situation === "revoked") {
      await t.run((ctx) => ctx.db.patch(holderA.connectionId, { status: "revoked" }));
    }
    if (situation === "two_holders") {
      const linkedB = await seedLinked(t, orgB.orgId);
      await t.run((ctx) =>
        ctx.db.insert("instagramMessagingAccounts", {
          orgId: orgB.orgId,
          socialAccountId: linkedB.socialAccountId,
          connectionId: linkedB.connectionId,
          igAccountId: IG_ACCOUNT,
          status: "active",
          enabledBySubject: "user_admin",
          activatedAt: 0,
          createdAt: 0,
          updatedAt: 0,
        }),
      );
    }
    const response = await deliver(
      t,
      delivery(entry([customerMessage("m.1", { account })], account)),
    );
    expect(response.status).toBe(200);
    expect(await storedEvents(t)).toEqual([]);
    // Dropped by routing (not by the parser).
    const event = {
      kind: "message" as const,
      mid: "m.2",
      customerIgsid: CUSTOMER_1,
      timestampMs: Date.now(),
      messageType: "text" as const,
    };
    expect(
      await t.mutation(internal.instagram.messaging.ingest.recordDelivery, {
        entries: [{ igAccountId: account, events: [event] }],
      }),
    ).toEqual({ accepted: 0, duplicates: 0, unrouted: 1, beforeActivation: 0 });
  });

  it("keeps a connection that needs reauthorization receiving its customers' messages", async () => {
    const { t, orgA, holderA } = await setup();
    await t.run((ctx) => ctx.db.patch(holderA.connectionId, { status: "needs_reauth" }));
    await deliver(t, delivery(entry([customerMessage("m.1")])));
    expect(await messagesOf(t, orgA.orgId)).toHaveLength(1);
  });

  it("drops events from before the current hold, by event time, not notification time", async () => {
    const { t, orgA, orgB, holderA } = await setup();
    const activatedAt = (await t.run((ctx) => ctx.db.get(holderA.accountId)))!.activatedAt;
    // Org A turns messaging off; org B takes the account over later.
    await t.run((ctx) =>
      disableMessaging(ctx.db, { ...orgA, subject: "user_admin" }, holderA.accountId, "turned_off"),
    );
    const holderB = await seedHolder(t, orgB);
    const takenOverAt = (await t.run((ctx) => ctx.db.get(holderB.accountId)))!.activatedAt;
    vi.setSystemTime(takenOverAt + MINUTE);

    // A late retry of a message sent during org A's hold, in a fresh notification.
    const late = customerMessage("m.old", { timestamp: activatedAt + 1 });
    const current = customerMessage("m.new", { timestamp: takenOverAt });
    await deliver(t, delivery({ ...entry([late, current]), time: Date.now() }));

    expect(await messagesOf(t, orgA.orgId)).toEqual([]);
    expect((await messagesOf(t, orgB.orgId)).map((m) => m.mid)).toEqual(["m.new"]);
  });
});

describe("processing", () => {
  it("records echoes as sent from Instagram and marks them read when seen", async () => {
    const { t, orgA } = await setup();
    await deliver(
      t,
      delivery(
        entry([
          echo("m.1", { timestamp: Date.now() - 3_000 }),
          echo("m.2", { timestamp: Date.now() - 2_000 }),
          seen("m.2", { timestamp: Date.now() - 1_000 }),
        ]),
      ),
    );
    const messages = await messagesOf(t, orgA.orgId);
    expect(messages.map((m) => [m.mid, m.direction, m.origin, m.status])).toEqual([
      ["m.1", "outbound", "instagram", "read"],
      ["m.2", "outbound", "instagram", "read"],
    ]);
    // An echo does not open the reply window.
    expect((await conversationsOf(t, orgA.orgId))[0]!.lastInboundAt).toBeUndefined();
  });

  it("applies edits and deletions to known messages only, in the same thread", async () => {
    const { t, orgA } = await setup();
    await deliver(
      t,
      delivery(
        entry([
          customerMessage("m.1", { text: "first", timestamp: Date.now() - 3_000 }),
          customerMessage("m.2", { text: "second", customer: CUSTOMER_2 }),
        ]),
      ),
    );
    await deliver(
      t,
      delivery(
        entry([
          edited("m.1", "first, edited", 1),
          // Another customer's thread cannot touch m.1.
          deleted("m.1", { customer: CUSTOMER_2 }),
          deleted("m.2", { customer: CUSTOMER_2 }),
        ]),
      ),
    );
    const byMid = Object.fromEntries((await messagesOf(t, orgA.orgId)).map((m) => [m.mid, m]));
    expect(byMid["m.1"]).toMatchObject({ text: "first, edited" });
    expect(byMid["m.1"]!.editedAt).toBeDefined();
    expect(byMid["m.1"]!.deletedAt).toBeUndefined();
    expect(byMid["m.2"]!.text).toBeUndefined();
    expect(byMid["m.2"]!.deletedAt).toBeDefined();
  });

  it("never creates content from an edit or deletion of an unknown message", async () => {
    const { t, orgA } = await setup();
    await deliver(t, delivery(entry([edited("m.unknown", "secret text", 1), deleted("m.gone")])));
    expect(await messagesOf(t, orgA.orgId)).toEqual([]);
    expect(await conversationsOf(t, orgA.orgId)).toEqual([]);
    const events = await storedEvents(t);
    // The edit's text is dropped; the deletion (an id only) waits for its message.
    const edit = events.find((e) => e.kind === "edit")!;
    expect(edit.status).toBe("ignored");
    expect(edit.event).toBeUndefined();
    expect(events.find((e) => e.kind === "delete")).toMatchObject({ status: "unmatched" });
  });

  it("stores a message whose deletion came first without its text", async () => {
    const { t, orgA } = await setup();
    await deliver(t, delivery(entry([deleted("m.1", { timestamp: Date.now() - 1_000 })])));
    await deliver(
      t,
      delivery(entry([customerMessage("m.1", { text: "oops", timestamp: Date.now() - 2_000 })])),
    );
    const [message] = await messagesOf(t, orgA.orgId);
    expect(message!.text).toBeUndefined();
    expect(message!.deletedAt).toBeDefined();
    expect((await storedEvents(t)).every((e) => e.status === "processed")).toBe(true);
  });

  it("never applies an event to another org's message with the same mid", async () => {
    const { t, orgA, orgB } = await setup();
    await seedHolder(t, orgB, { igAccountId: IG_ACCOUNT_2 });
    await deliver(t, delivery(entry([customerMessage("m.1", { text: "org A's" })])));
    await deliver(t, delivery(entry([deleted("m.1", { account: IG_ACCOUNT_2 })], IG_ACCOUNT_2)));
    expect((await messagesOf(t, orgA.orgId))[0]).toMatchObject({ text: "org A's" });
    expect(await messagesOf(t, orgB.orgId)).toEqual([]);
  });
});

describe("recovery and retention", () => {
  async function stuckEvent(
    t: Backend,
    orgA: { orgId: Id<"organizations"> },
    accountId: Id<"instagramMessagingAccounts">,
  ) {
    return await t.run((ctx) =>
      ctx.db.insert("instagramWebhookEvents", {
        orgId: orgA.orgId,
        messagingAccountId: accountId,
        dedupeKey: "message:m.stuck",
        kind: "message",
        mid: "m.stuck",
        event: {
          kind: "message",
          mid: "m.stuck",
          customerIgsid: CUSTOMER_1,
          timestampMs: Date.now(),
          messageType: "text",
          text: "late",
        },
        status: "pending",
        receivedAt: Date.now() - STUCK_EVENT_AFTER_MS - 1,
      }),
    );
  }

  it("retries an event still pending after the stuck-event delay", async () => {
    const { t, orgA, holderA } = await setup();
    const id = await stuckEvent(t, orgA, holderA.accountId);
    expect(await t.mutation(internal.instagram.messaging.recovery.recoverStuckEvents, {})).toEqual({
      retried: 1,
      failed: 0,
      waiting: 0,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(await t.run((ctx) => ctx.db.get(id))).toMatchObject({ status: "processed" });
    expect(await messagesOf(t, orgA.orgId)).toHaveLength(1);
  });

  it("deletes events no longer pending after the retention period, never pending ones", async () => {
    const { t, orgA, holderA } = await setup();
    const pending = await stuckEvent(t, orgA, holderA.accountId);
    await deliver(t, delivery(entry([customerMessage("m.1")])));
    vi.setSystemTime(Date.now() + EVENT_RETENTION_MS + MINUTE);
    expect(
      await t.mutation(internal.instagram.messaging.retention.purgeExpiredEvents, {}),
    ).toMatchObject({ deleted: 1 });
    expect((await storedEvents(t)).map((e) => e._id)).toEqual([pending]);
    expect(await messagesOf(t, orgA.orgId)).toHaveLength(1);
  });
});
