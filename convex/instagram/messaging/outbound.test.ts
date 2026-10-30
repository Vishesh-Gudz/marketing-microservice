import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type * as CredentialStore from "../../connections/credentialStore";
import { isMarketingError } from "../../lib/errors";
import { SERVICE_WINDOW_MS } from "../../messaging/window";
import {
  createFakeInstagram,
  FAKE_IG_TOKEN_MARKER,
  type FakeInstagram,
} from "../../providers/instagram/fakeInstagram.fixtures";
import {
  as,
  connectInstagramFake,
  expectMarketingError,
  ISSUER_CRM,
  linkSocial,
  newBackend,
  setupSyncOrg,
  stubLiveInstagram,
  type Backend,
} from "../../test.helpers";
import { STUCK_SEND_AFTER_MS } from "./config";
import {
  customerMessage,
  delivery,
  echo,
  entry,
  postDelivery,
  seen,
  stubInstagramWebhookEnv,
} from "./fakeWebhook.fixtures";

// ADR 0017 (IM4): outbound text replies end to end in-process: v1/instagramMessaging:sendText ->
// the one scheduled delivery against the fake Instagram API -> the recorded outcome, the
// watchdog, and echoes before and after the send result. Fakes only; nothing reaches Meta, and
// passing here says nothing about Meta's real behavior.

/**
 * Test-only hook into the delivery action: runs right after the claim, just before the action
 * reads the connection's credential (the only point between the two). The real
 * withConnectionCredential then runs unchanged.
 */
const credentialHook = vi.hoisted(() => ({
  before: undefined as undefined | ((connectionId: string) => Promise<void>),
}));
vi.mock("../../connections/credentialStore", async (importOriginal) => {
  const actual = await importOriginal<typeof CredentialStore>();
  return {
    ...actual,
    withConnectionCredential: async (
      ...args: Parameters<typeof actual.withConnectionCredential>
    ) => {
      const before = credentialHook.before;
      credentialHook.before = undefined;
      await before?.(args[1]);
      return await actual.withConnectionCredential(...args);
    },
  };
});

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-10-29T12:00:00Z").getTime();
const IG = "17841400000000105"; // the fake "messaging" user
const IG_B = "17841400000000106";
const CUSTOMER = "5550000000000001";
const CRM = { issuer: ISSUER_CRM };

let fake: FakeInstagram;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = createFakeInstagram({
    users: {
      messaging_b: {
        userId: IG_B,
        username: "fake_inbox_b",
        accountType: "Business",
        permissions:
          "instagram_business_basic,instagram_business_manage_insights,instagram_business_manage_messages",
      },
    },
  });
  stubLiveInstagram(fake);
  stubInstagramWebhookEnv();
});
afterEach(() => {
  credentialHook.before = undefined;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Who = { issuer?: string; role?: string };

/**
 * Runs what is due, moving the fake clock 1 s at a time (as WhatsApp's tests do): a delivery
 * takes a few steps, and jumping over all timers at once would fire its watchdog mid-delivery.
 */
async function drain(t: Backend) {
  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 1_000);
}

/** An org with messaging on for `user`'s account and a thread the customer just opened. */
async function thread(t: Backend, user = "messaging", account = IG, who: Who = {}) {
  await setupSyncOrg(t, who);
  const params = await connectInstagramFake(t, fake, user, who, { instagramMessaging: true });
  const connectionId = params.get("connection")! as Id<"connections">;
  const [social] = await linkSocial(t, connectionId, [account], who);
  const { accountId } = await as(t, who).action(api.v1.instagramMessaging.enable, {
    socialAccountId: social!.id,
  });
  await postDelivery(t, delivery(entry([customerMessage("m.in.1", { account })], account)));
  await drain(t);
  const conversation = (await t.run((ctx) => ctx.db.query("instagramConversations").collect()))
    .filter((c) => c.messagingAccountId === accountId)
    .at(0)!;
  fake.reset();
  return {
    connectionId,
    accountId: accountId as Id<"instagramMessagingAccounts">,
    conversationId: conversation._id,
  };
}

let ids = 0;
const clientId = () => `client-${String(++ids).padStart(4, "0")}`;

function send(
  t: Backend,
  target: { accountId: string; conversationId: string },
  text = "Yes, we ship to Lisbon.",
  who: Who = {},
  clientMessageId = clientId(),
) {
  return as(t, who).mutation(api.v1.instagramMessaging.sendText, {
    accountId: target.accountId,
    conversationId: target.conversationId,
    text,
    clientMessageId,
  });
}

/** The refusal reason of a failed call (CONFLICT / INVALID_ARGUMENT details). */
async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    if (isMarketingError(error)) return error.data.details?.reason as string | undefined;
    throw error;
  }
  throw new Error("expected a refusal");
}

async function outboundRows(t: Backend) {
  return (await t.run((ctx) => ctx.db.query("instagramMessages").collect())).filter(
    (m) => m.direction === "outbound",
  );
}

async function messageRow(t: Backend, id: string) {
  return (await t.run((ctx) => ctx.db.get(id as Id<"instagramMessages">)))!;
}

const sendRequests = () => fake.requests.filter((r) => r.path.endsWith("/messages"));

describe("who may send, and where", () => {
  it("lets editors and admins of the org send, refusing viewers, signed-out callers and other orgs", async () => {
    const t = newBackend();
    const a = await thread(t);
    await thread(t, "messaging_b", IG_B, CRM);

    await expectMarketingError(send(t, a, "hi", { role: "viewer" }), "FORBIDDEN");
    await expect(
      t.mutation(api.v1.instagramMessaging.sendText, {
        accountId: a.accountId,
        conversationId: a.conversationId,
        text: "hi",
        clientMessageId: clientId(),
      }),
    ).rejects.toThrow(/auth|identity|sign/i);
    await expectMarketingError(send(t, a, "hi", CRM), "NOT_FOUND");
    expect(await outboundRows(t)).toEqual([]);

    expect(await send(t, a, "hi", { role: "editor" })).toMatchObject({ status: "pending" });
  });

  it("refuses a conversation named with another messaging account", async () => {
    const t = newBackend();
    const a = await thread(t);
    const b = await thread(t, "messaging_b", IG_B, CRM);
    await expectMarketingError(
      send(t, { accountId: b.accountId, conversationId: a.conversationId }),
      "NOT_FOUND",
    );
    expect(await outboundRows(t)).toEqual([]);
  });

  it.each([
    ["messaging was turned off", "messaging_unavailable"],
    ["the setup waits for action", "setup_incomplete"],
    ["the connection needs reauthorization", "reconnect_required"],
    ["the messaging permission is gone", "scope_missing"],
    ["the customer's 24-hour window closed", "window_closed"],
  ] as const)("refuses to send when %s, storing and sending nothing", async (_case, reason) => {
    const t = newBackend();
    const a = await thread(t);
    if (reason === "messaging_unavailable") {
      await as(t).mutation(api.v1.instagramMessaging.disable, { accountId: a.accountId });
    } else if (reason === "setup_incomplete") {
      await t.run((ctx) => ctx.db.patch(a.accountId, { status: "action_required" }));
    } else if (reason === "reconnect_required") {
      await t.run((ctx) => ctx.db.patch(a.connectionId, { status: "needs_reauth" }));
    } else if (reason === "scope_missing") {
      await t.run((ctx) =>
        ctx.db.patch(a.connectionId, { grantedScopes: ["instagram_business_basic"] }),
      );
    } else {
      vi.setSystemTime(NOW + SERVICE_WINDOW_MS + 1_000);
    }
    expect(await reasonOf(send(t, a))).toBe(reason);
    await drain(t);
    expect(await outboundRows(t)).toEqual([]);
    expect(sendRequests()).toEqual([]);
  });

  it("stays closed on cloud deployments until the flag is set", async () => {
    const t = newBackend();
    const a = await thread(t);
    vi.stubEnv("CONVEX_CLOUD_URL", "https://happy-otter-123.convex.cloud");
    expect(await reasonOf(send(t, a))).toBe("messaging_unavailable");
    vi.stubEnv("INSTAGRAM_MESSAGING_ENABLED", "true");
    expect(await send(t, a)).toMatchObject({ status: "pending" });
  });
});

describe("text length", () => {
  it.each([
    ["1000 ASCII characters", "a".repeat(1000), true],
    ["1001 ASCII characters", "a".repeat(1001), false],
    ["333 three-byte characters (999 bytes)", "€".repeat(333), true],
    ["334 three-byte characters (1002 bytes)", "€".repeat(334), false],
    ["250 four-byte emoji (1000 bytes)", "😀".repeat(250), true],
    ["251 four-byte emoji (1004 bytes, 502 UTF-16 units)", "😀".repeat(251), false],
    ["blank text", "   ", false],
  ])("%s", async (_case, text, allowed) => {
    const t = newBackend();
    const a = await thread(t);
    if (allowed) {
      expect(await send(t, a, text)).toMatchObject({ status: "pending", text });
    } else {
      await expectMarketingError(send(t, a, text), "INVALID_ARGUMENT");
      expect(await outboundRows(t)).toEqual([]);
    }
  });
});

describe("the one Meta call", () => {
  it("sends once with the token only in the header, and records Meta's message id", async () => {
    const t = newBackend();
    const a = await thread(t);
    const queued = await send(t, a);
    await drain(t);

    expect(fake.sent).toEqual([
      { account: IG, recipient: CUSTOMER, text: "Yes, we ship to Lisbon.", mid: "mid.fake.1" },
    ]);
    const [request] = sendRequests();
    expect(request).toMatchObject({ method: "POST", bearer: true, params: [] });
    expect(request!.url).not.toContain(FAKE_IG_TOKEN_MARKER);
    expect(await messageRow(t, queued.id)).toMatchObject({
      status: "submitted",
      mid: "mid.fake.1",
      origin: "app",
      sentBySubject: "user_1",
    });
  });

  it("sends a repeated submit once and returns the same message", async () => {
    const t = newBackend();
    const a = await thread(t);
    const first = await send(t, a, "hi", {}, "client-same-0001");
    const again = await send(t, a, "hi", {}, "client-same-0001");
    expect(again.id).toBe(first.id);
    await drain(t);
    expect(sendRequests()).toHaveLength(1);
  });

  it.each([
    [
      "a refusal",
      { status: 400, body: { error: { code: 10, error_subcode: 2534022 } } },
      { status: "failed", failureReason: "meta_10", errorCode: 10 },
    ],
    ["a server error", { status: 500 }, { status: "unknown", failureReason: "http_500" }],
    [
      "an answer without a message id",
      { status: 200, body: { recipient_id: CUSTOMER } },
      { status: "unknown", failureReason: "unexpected_response" },
    ],
  ] as const)("records %s without changing the account", async (_case, answer, expected) => {
    const t = newBackend();
    const a = await thread(t);
    fake.fail("send_message", answer);
    const queued = await send(t, a);
    await drain(t);
    expect(await messageRow(t, queued.id)).toMatchObject(expected);
    expect((await t.run((ctx) => ctx.db.get(a.accountId)))!.status).toBe("active");
    expect((await t.run((ctx) => ctx.db.get(a.connectionId)))!.status).toBe("active");
  });

  it("moves the connection to needs_reauth when Meta refuses the token", async () => {
    const t = newBackend();
    const a = await thread(t);
    fake.fail("send_message", { status: 400, body: { error: { code: 190 } } });
    const queued = await send(t, a);
    await drain(t);
    expect(await messageRow(t, queued.id)).toMatchObject({
      status: "failed",
      failureReason: "meta_190",
    });
    expect((await t.run((ctx) => ctx.db.get(a.connectionId)))!.status).toBe("needs_reauth");
  });

  it("never sends again after an ambiguous result (a timeout)", async () => {
    const t = newBackend();
    const a = await thread(t);
    fake.hangNextSend();
    const queued = await send(t, a);
    await drain(t);
    expect(await messageRow(t, queued.id)).toMatchObject({
      status: "unknown",
      failureReason: "timeout",
    });
    // Later scheduled work, the watchdog and more time never send it again.
    vi.setSystemTime(NOW + STUCK_SEND_AFTER_MS + 60_000);
    await drain(t);
    expect(sendRequests()).toHaveLength(1);
    expect(fake.sent).toEqual([]);
    expect((await messageRow(t, queued.id)).status).toBe("unknown");
  });

  it("never sends again after a network error", async () => {
    const t = newBackend();
    const a = await thread(t);
    fake.failNextSendWithNetworkError();
    const queued = await send(t, a);
    await drain(t);
    expect(await messageRow(t, queued.id)).toMatchObject({
      status: "unknown",
      failureReason: "network",
    });
    vi.setSystemTime(NOW + STUCK_SEND_AFTER_MS + 60_000);
    await drain(t);
    expect(sendRequests()).toHaveLength(1);
    expect(fake.sent).toEqual([]);
    expect((await messageRow(t, queued.id)).status).toBe("unknown");
  });

  it("treats a 200 that is not JSON as unconfirmed, keeping nothing of its body", async () => {
    const t = newBackend();
    const a = await thread(t);
    const RAW = `<html>${FAKE_IG_TOKEN_MARKER}-echo ${CUSTOMER} raw-body-marker</html>`;
    fake.fail("send_message", { status: 200, raw: RAW, headers: { "content-type": "text/html" } });
    const queued = await send(t, a);
    await drain(t);
    const row = await messageRow(t, queued.id);
    expect(row).toMatchObject({ status: "unknown", failureReason: "unexpected_response" });
    expect(row.errorCode).toBeUndefined();
    expect(row.mid).toBeUndefined();

    vi.setSystemTime(NOW + STUCK_SEND_AFTER_MS + 60_000);
    await drain(t);
    expect(sendRequests()).toHaveLength(1);

    // Neither the stored message nor the API's answer holds the body, a token or the customer id.
    const page = await as(t).query(api.v1.instagramMessaging.listMessages, {
      conversationId: a.conversationId,
      paginationOpts: { numItems: 50, cursor: null },
    });
    const stored = JSON.stringify([await messageRow(t, queued.id), page]);
    for (const marker of ["raw-body-marker", "<html>", FAKE_IG_TOKEN_MARKER, CUSTOMER]) {
      expect(stored).not.toContain(marker);
    }
  });
});

describe("a connection revoked while a reply is on its way", () => {
  const disconnect = (t: Backend, connectionId: string) =>
    as(t).mutation(api.v1.connections.disconnect, { connectionId });

  it("after the reply was queued: the claim refuses it without contacting Meta", async () => {
    const t = newBackend();
    const a = await thread(t);
    const queued = await send(t, a);
    await disconnect(t, a.connectionId);
    await drain(t);

    expect(sendRequests()).toEqual([]);
    const row = await messageRow(t, queued.id);
    expect(row).toMatchObject({ status: "failed", failureReason: "messaging_unavailable" });
    expect(row.sendAttemptedAt).toBeUndefined(); // never claimed: no attempt was made
  });

  it("after the claim, before the credential is read: no request is made", async () => {
    const t = newBackend();
    const a = await thread(t);
    // The disconnect lands inside the delivery, between its claim and its credential read.
    credentialHook.before = async (connectionId) => {
      expect(connectionId).toBe(a.connectionId);
      await disconnect(t, connectionId);
    };
    const queued = await send(t, a);
    await drain(t);

    expect(credentialHook.before).toBeUndefined(); // the hook ran
    expect(sendRequests()).toEqual([]);
    const row = await messageRow(t, queued.id);
    expect(row).toMatchObject({ status: "failed", failureReason: "credential_unavailable" });
    expect(row.sendAttemptedAt).toBeDefined(); // the one attempt was claimed, then refused
    expect(row.mid).toBeUndefined();
    const connection = (await t.run((ctx) => ctx.db.get(a.connectionId)))!;
    expect(connection.status).toBe("revoked"); // not moved to needs_reauth by the refusal

    // Nothing sends it later: more scheduled work, the watchdog and time change nothing.
    vi.setSystemTime(NOW + STUCK_SEND_AFTER_MS + 60_000);
    await drain(t);
    expect(sendRequests()).toEqual([]);
    expect((await messageRow(t, queued.id)).status).toBe("failed");
  });
});

describe("the watchdog", () => {
  async function settle(t: Backend, messageId: string) {
    const row = await messageRow(t, messageId);
    vi.setSystemTime(row.createdAt + STUCK_SEND_AFTER_MS);
    await t.mutation(internal.instagram.messaging.outbound.settleStuckSend, {
      orgId: row.orgId,
      messageId: row._id,
    });
  }

  it("fails a reply never claimed, and no late delivery sends it", async () => {
    const t = newBackend();
    const a = await thread(t);
    const queued = await send(t, a);
    await settle(t, queued.id);
    expect(await messageRow(t, queued.id)).toMatchObject({
      status: "failed",
      failureReason: "not_sent",
    });
    await drain(t);
    expect(sendRequests()).toEqual([]);
  });

  it("marks a claimed reply without a result unknown, and a late result still replaces it", async () => {
    const t = newBackend();
    const a = await thread(t);
    const queued = await send(t, a);
    const row = await messageRow(t, queued.id);
    const claim = await t.mutation(internal.instagram.messaging.outbound.claimDelivery, {
      orgId: row.orgId,
      messageId: row._id,
    });
    expect(claim).not.toBeNull();
    await settle(t, queued.id);
    expect(await messageRow(t, queued.id)).toMatchObject({
      status: "unknown",
      failureReason: "no_result",
    });

    await t.mutation(internal.instagram.messaging.outbound.recordSendResult, {
      orgId: row.orgId,
      messageId: row._id,
      connectionId: a.connectionId,
      outcome: { kind: "accepted", mid: "mid.late.1" },
    });
    expect(await messageRow(t, queued.id)).toMatchObject({
      status: "submitted",
      mid: "mid.late.1",
    });
    await drain(t); // the queued delivery finds it claimed: no call
    expect(sendRequests()).toEqual([]);
  });
});

describe("echoes", () => {
  /** A reply claimed by hand, so webhooks can arrive before its result is recorded. */
  async function inFlight(t: Backend, a: Awaited<ReturnType<typeof thread>>) {
    const queued = await send(t, a);
    const row = await messageRow(t, queued.id);
    await t.mutation(internal.instagram.messaging.outbound.claimDelivery, {
      orgId: row.orgId,
      messageId: row._id,
    });
    const record = (mid: string) =>
      t.mutation(internal.instagram.messaging.outbound.recordSendResult, {
        orgId: row.orgId,
        messageId: row._id,
        connectionId: a.connectionId,
        outcome: { kind: "accepted", mid },
      });
    return { id: queued.id, record };
  }

  async function webhook(t: Backend, ...items: Record<string, unknown>[]) {
    await postDelivery(t, delivery(entry(items, IG)));
    await drain(t);
  }

  it("confirms the reply when its echo comes after the send result, never adding a row", async () => {
    const t = newBackend();
    const a = await thread(t);
    const queued = await send(t, a);
    await drain(t);
    const later = Date.now() + 1_000;
    await webhook(t, echo("mid.fake.1", { account: IG, timestamp: later }));
    await webhook(t, echo("mid.fake.1", { account: IG, timestamp: later })); // Meta repeats it
    expect(await outboundRows(t)).toEqual([
      expect.objectContaining({ _id: queued.id, status: "sent", sentAt: later, origin: "app" }),
    ]);
  });

  it("merges an echo (and a seen) that came before the send result into the reply", async () => {
    const t = newBackend();
    const a = await thread(t);
    const reply = await inFlight(t, a);
    await webhook(t, echo("mid.early.1", { account: IG }), seen("mid.early.1", { account: IG }));
    expect((await outboundRows(t)).map((m) => m.origin).sort()).toEqual(["app", "instagram"]);

    await reply.record("mid.early.1");
    expect(await outboundRows(t)).toEqual([
      expect.objectContaining({
        _id: reply.id,
        origin: "app",
        mid: "mid.early.1",
        status: "read",
        text: "Yes, we ship to Lisbon.",
      }),
    ]);
  });

  it("applies a seen that came before the send result", async () => {
    const t = newBackend();
    const a = await thread(t);
    const reply = await inFlight(t, a);
    await webhook(t, seen("mid.early.2", { account: IG }));
    await reply.record("mid.early.2");
    expect(await messageRow(t, reply.id)).toMatchObject({ status: "read", mid: "mid.early.2" });
    const events = await t.run((ctx) => ctx.db.query("instagramWebhookEvents").collect());
    expect(events.find((e) => e.kind === "read")).toMatchObject({ status: "processed" });
  });

  it("keeps an echo of a message sent from Instagram itself as its own row", async () => {
    const t = newBackend();
    const a = await thread(t);
    const queued = await send(t, a);
    await drain(t);
    await webhook(t, echo("m.from.app", { account: IG, text: "Sent from the Instagram app" }));
    const rows = await outboundRows(t);
    expect(rows.map((m) => [m.origin, m.mid, m.status]).sort()).toEqual(
      [
        ["app", "mid.fake.1", "submitted"],
        ["instagram", "m.from.app", "sent"],
      ].sort(),
    );
    expect(rows.find((m) => m._id === queued.id)!.status).toBe("submitted");
  });

  it("never merges by text: an unknown send and an echo with the same text stay apart", async () => {
    const t = newBackend();
    const a = await thread(t);
    fake.hangNextSend();
    const queued = await send(t, a, "Same words");
    await drain(t);
    await webhook(t, echo("m.other", { account: IG, text: "Same words" }));
    const rows = await outboundRows(t);
    expect(rows).toHaveLength(2);
    expect(rows.find((m) => m._id === queued.id)).toMatchObject({ status: "unknown" });
  });
});
