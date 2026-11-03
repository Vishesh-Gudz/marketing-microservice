import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
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
  linkSocial,
  newBackend,
  setupSyncOrg,
  stubLiveInstagram,
  type Backend,
} from "../../test.helpers";
import { HUMAN_AGENT_WINDOW_MS, INSTAGRAM_MESSAGING_ENV } from "./config";
import {
  CUSTOMER_1,
  customerMessage,
  delivery,
  entry,
  postDelivery,
  stubInstagramWebhookEnv,
} from "./fakeWebhook.fixtures";

// ADR 0021: Instagram reply tools end to end in-process, against the fake Instagram API and
// signed fake webhooks: quick-reply buttons on a reply and the customer's tap, ice breakers (set,
// removed, tapped) and Human Agent replies after the 24-hour window. Nothing reaches Meta.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-11-03T12:00:00Z").getTime();
const IG = "17841400000000105"; // the fake "messaging" user
const DAY = 24 * 60 * 60 * 1000;

let fake: FakeInstagram;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = createFakeInstagram();
  stubLiveInstagram(fake);
  stubInstagramWebhookEnv();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function drain(t: Backend) {
  await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 1_000);
}

/** An org with messaging on for the fake "messaging" account and a thread the customer opened. */
async function thread(t: Backend) {
  await setupSyncOrg(t);
  const params = await connectInstagramFake(t, fake, "messaging", {}, { instagramMessaging: true });
  const connectionId = params.get("connection")! as Id<"connections">;
  const [social] = await linkSocial(t, connectionId, [IG]);
  const { accountId } = await as(t).action(api.v1.instagramMessaging.enable, {
    socialAccountId: social!.id,
  });
  await postDelivery(t, delivery(entry([customerMessage("m.in.1", { account: IG })], IG)));
  await drain(t);
  const [conversation] = await t.run((ctx) => ctx.db.query("instagramConversations").collect());
  fake.reset();
  return {
    connectionId,
    accountId: accountId as Id<"instagramMessagingAccounts">,
    conversationId: conversation!._id,
  };
}

let ids = 0;
const clientId = () => `client-${String(++ids).padStart(4, "0")}`;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isMarketingError(error)) throw error;
    return error.data;
  }
  throw new Error("expected the call to fail");
}

async function messages(t: Backend) {
  return await t.run((ctx) => ctx.db.query("instagramMessages").collect());
}

describe("quick-reply buttons", () => {
  it("sends them with the reply, keeps them on the message and shows them in the thread", async () => {
    const t = newBackend();
    const target = await thread(t);
    const reply = await as(t).mutation(api.v1.instagramMessaging.sendText, {
      accountId: target.accountId,
      conversationId: target.conversationId,
      text: "Which size would you like?",
      clientMessageId: clientId(),
      quickReplies: [" Small ", "Medium", "Large"],
    });
    expect(reply.quickReplies).toEqual(["Small", "Medium", "Large"]);
    await drain(t);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.body).toEqual({
      recipient: { id: CUSTOMER_1 },
      message: {
        text: "Which size would you like?",
        quick_replies: [
          { content_type: "text", title: "Small", payload: "QUICK_REPLY_1" },
          { content_type: "text", title: "Medium", payload: "QUICK_REPLY_2" },
          { content_type: "text", title: "Large", payload: "QUICK_REPLY_3" },
        ],
      },
    });
    // The token travels only in the header.
    expect(JSON.stringify(fake.sent[0]!.body)).not.toContain(FAKE_IG_TOKEN_MARKER);
  });

  it("refuses more than 13, an empty or too long label, or a repeated one, before anything is stored", async () => {
    const t = newBackend();
    const target = await thread(t);
    const before = (await messages(t)).length;
    for (const [quickReplies, reason] of [
      [Array.from({ length: 14 }, (_, i) => `Option ${i}`), "too_many_quick_replies"],
      [["  "], "quick_reply_text"],
      [["x".repeat(21)], "quick_reply_text"],
      [["Yes", "Yes"], "duplicate_quick_reply"],
    ] as const) {
      const data = await refusal(
        as(t).mutation(api.v1.instagramMessaging.sendText, {
          accountId: target.accountId,
          conversationId: target.conversationId,
          text: "Hi",
          clientMessageId: clientId(),
          quickReplies: [...quickReplies],
        }),
      );
      expect(data).toMatchObject({ code: "INVALID_ARGUMENT", details: { reason } });
    }
    expect(await messages(t)).toHaveLength(before);
  });

  it("marks the customer's tap on a quick reply", async () => {
    const t = newBackend();
    await thread(t);
    await postDelivery(
      t,
      delivery(
        entry(
          [
            customerMessage("m.tap.1", {
              account: IG,
              text: "Medium",
              message: { quick_reply: { payload: "QUICK_REPLY_2" } },
            }),
          ],
          IG,
        ),
      ),
    );
    await drain(t);
    const tap = (await messages(t)).find((m) => m.mid === "m.tap.1")!;
    expect(tap).toMatchObject({ direction: "inbound", text: "Medium", tap: "quick_reply" });
    // The payload is never stored.
    expect(JSON.stringify(await messages(t))).not.toContain("QUICK_REPLY_2");
  });
});

describe("ice breakers", () => {
  it("sets them at Instagram, keeps and audits them, then removes them", async () => {
    const t = newBackend();
    const { accountId } = await thread(t);
    await as(t).action(api.v1.instagramMessaging.setIceBreakers, {
      accountId,
      questions: [" What are your opening hours? ", "How much does it cost?"],
    });
    expect(fake.iceBreakers.get(IG)).toEqual([
      {
        call_to_actions: [
          { question: "What are your opening hours?", payload: "ICE_BREAKER_1" },
          { question: "How much does it cost?", payload: "ICE_BREAKER_2" },
        ],
      },
    ]);
    const request = fake.requests.find((r) => r.path.endsWith("/messenger_profile"))!;
    expect(request).toMatchObject({ method: "POST", bearer: true, params: [] });
    const [account] = await as(t).query(api.v1.instagramMessaging.listAccounts, {});
    expect(account!.iceBreakers).toEqual([
      "What are your opening hours?",
      "How much does it cost?",
    ]);

    await as(t).action(api.v1.instagramMessaging.clearIceBreakers, { accountId });
    expect(fake.iceBreakers.has(IG)).toBe(false);
    const [after] = await as(t).query(api.v1.instagramMessaging.listAccounts, {});
    expect(after!.iceBreakers).toBeUndefined();
    const audits = await t.run(async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((a) =>
        a.action.startsWith("instagram.ice"),
      ),
    );
    expect(audits.map((a) => [a.action, a.changes])).toEqual([
      ["instagram.ice_breakers_set", { questions: { from: 0, to: 2 } }],
      ["instagram.ice_breakers_cleared", { questions: { from: 2, to: 0 } }],
    ]);
  });

  it("checks the questions, the role and the account before calling Instagram", async () => {
    const t = newBackend();
    const { accountId } = await thread(t);
    for (const [questions, reason] of [
      [[], "ice_breaker_count"],
      [["a", "b", "c", "d", "e"], "ice_breaker_count"],
      [["x".repeat(81)], "ice_breaker_text"],
      [["Same?", "Same?"], "duplicate_ice_breaker"],
    ] as const) {
      const data = await refusal(
        as(t).action(api.v1.instagramMessaging.setIceBreakers, {
          accountId,
          questions: [...questions],
        }),
      );
      expect(data).toMatchObject({ code: "INVALID_ARGUMENT", details: { reason } });
    }
    const forbidden = await refusal(
      as(t, { role: "editor" }).action(api.v1.instagramMessaging.setIceBreakers, {
        accountId,
        questions: ["Hi?"],
      }),
    );
    expect(forbidden.code).toBe("FORBIDDEN");
    await as(t).mutation(api.v1.instagramMessaging.disable, { accountId });
    const off = await refusal(
      as(t).action(api.v1.instagramMessaging.setIceBreakers, { accountId, questions: ["Hi?"] }),
    );
    expect(off).toMatchObject({ code: "CONFLICT", details: { reason: "messaging_unavailable" } });
    expect(fake.count("/v25.0/" + IG + "/messenger_profile")).toBe(0);
  });

  it("moves the connection to reconnect when Instagram refuses the token", async () => {
    const t = newBackend();
    const { accountId, connectionId } = await thread(t);
    fake.fail("messenger_profile", {
      status: 401,
      body: { error: { message: "Invalid token", type: "OAuthException", code: 190 } },
    });
    const data = await refusal(
      as(t).action(api.v1.instagramMessaging.setIceBreakers, { accountId, questions: ["Hi?"] }),
    );
    expect(data).toMatchObject({ code: "CONFLICT", details: { reason: "reconnect_required" } });
    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection!.status).toBe("needs_reauth");
  });

  it("stores a tapped ice breaker as the customer's message, opening the reply window", async () => {
    const t = newBackend();
    await thread(t);
    vi.setSystemTime(NOW + 2 * DAY); // the earlier message's window has closed
    const tappedAt = Date.now();
    await postDelivery(
      t,
      delivery(
        entry(
          [
            {
              sender: { id: CUSTOMER_1 },
              recipient: { id: IG },
              timestamp: tappedAt,
              postback: { title: "What are your opening hours?", payload: "ICE_BREAKER_1" },
            },
            {
              sender: { id: CUSTOMER_1 },
              recipient: { id: IG },
              timestamp: tappedAt + 1,
              postback: { mid: "m.button.1", title: "Book now", payload: "OTHER" },
            },
          ],
          IG,
        ),
      ),
    );
    await drain(t);
    const taps = (await messages(t)).filter((m) => m.tap !== undefined);
    expect(taps.map((m) => [m.text, m.tap, m.direction])).toEqual([
      ["What are your opening hours?", "ice_breaker", "inbound"],
      ["Book now", "button", "inbound"],
    ]);
    const [conversation] = await t.run((ctx) => ctx.db.query("instagramConversations").collect());
    expect(conversation!.lastInboundAt).toBe(tappedAt + 1);
    expect(JSON.stringify(await messages(t))).not.toContain("ICE_BREAKER_1");
  });
});

describe("Human Agent replies", () => {
  it("are refused after 24 hours while the switch is off", async () => {
    const t = newBackend();
    const target = await thread(t);
    vi.setSystemTime(NOW + SERVICE_WINDOW_MS + 1000);
    const data = await refusal(
      as(t).mutation(api.v1.instagramMessaging.sendText, {
        accountId: target.accountId,
        conversationId: target.conversationId,
        text: "Sorry for the wait!",
        clientMessageId: clientId(),
      }),
    );
    expect(data).toMatchObject({ code: "CONFLICT", details: { reason: "window_closed" } });
    const conversation = await as(t).query(api.v1.instagramMessaging.getConversation, {
      conversationId: target.conversationId,
    });
    expect(conversation.humanAgentWindowExpiresAt).toBeUndefined();
  });

  it("are sent with the HUMAN_AGENT tag after 24 hours and within 7 days once the switch is on", async () => {
    vi.stubEnv(INSTAGRAM_MESSAGING_ENV.humanAgentEnabled, "true");
    const t = newBackend();
    const target = await thread(t);
    const conversation = await as(t).query(api.v1.instagramMessaging.getConversation, {
      conversationId: target.conversationId,
    });
    expect(Date.parse(conversation.humanAgentWindowExpiresAt!)).toBe(
      Date.parse(conversation.lastInboundAt!) + HUMAN_AGENT_WINDOW_MS,
    );

    // Inside 24 hours: no tag.
    await as(t).mutation(api.v1.instagramMessaging.sendText, {
      accountId: target.accountId,
      conversationId: target.conversationId,
      text: "On it!",
      clientMessageId: clientId(),
    });
    await drain(t);
    expect(fake.sent[0]!.body).not.toHaveProperty("tag");

    // Three days later: tagged.
    vi.setSystemTime(NOW + 3 * DAY);
    const late = await as(t).mutation(api.v1.instagramMessaging.sendText, {
      accountId: target.accountId,
      conversationId: target.conversationId,
      text: "Your order has arrived at our store.",
      clientMessageId: clientId(),
    });
    expect(late.humanAgent).toBe(true);
    await drain(t);
    expect(fake.sent[1]!.body).toMatchObject({
      recipient: { id: CUSTOMER_1 },
      messaging_type: "MESSAGE_TAG",
      tag: "HUMAN_AGENT",
      message: { text: "Your order has arrived at our store." },
    });

    // After 7 days: refused.
    vi.setSystemTime(NOW + HUMAN_AGENT_WINDOW_MS + 1000);
    const data = await refusal(
      as(t).mutation(api.v1.instagramMessaging.sendText, {
        accountId: target.accountId,
        conversationId: target.conversationId,
        text: "Hello?",
        clientMessageId: clientId(),
      }),
    );
    expect(data).toMatchObject({ details: { reason: "window_closed" } });
  });

  it("fails a queued Human Agent reply without calling Instagram when the switch goes off", async () => {
    vi.stubEnv(INSTAGRAM_MESSAGING_ENV.humanAgentEnabled, "true");
    const t = newBackend();
    const target = await thread(t);
    vi.setSystemTime(NOW + 2 * DAY);
    await as(t).mutation(api.v1.instagramMessaging.sendText, {
      accountId: target.accountId,
      conversationId: target.conversationId,
      text: "Following up",
      clientMessageId: clientId(),
    });
    vi.stubEnv(INSTAGRAM_MESSAGING_ENV.humanAgentEnabled, "");
    await drain(t);
    expect(fake.sent).toHaveLength(0);
    const failed = (await messages(t)).find((m) => m.text === "Following up")!;
    expect(failed).toMatchObject({ status: "failed", failureReason: "window_closed" });
  });
});
