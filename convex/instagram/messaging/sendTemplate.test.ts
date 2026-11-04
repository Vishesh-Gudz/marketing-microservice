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
  ISSUER_CRM,
  linkSocial,
  newBackend,
  setupSyncOrg,
  stubLiveInstagram,
  type Backend,
} from "../../test.helpers";
import { HUMAN_AGENT_WINDOW_MS } from "./config";
import {
  CUSTOMER_1,
  customerMessage,
  delivery,
  echo,
  entry,
  postDelivery,
  stubInstagramWebhookEnv,
} from "./fakeWebhook.fixtures";
import type { TemplateContent } from "./templates";

// ADR 0022: sending an Instagram template end to end in-process, against the fake Instagram API
// and signed fake webhooks: Meta's attachment body, the message as sent (customer name filled
// in), the reply window and Human Agent rules shared with text replies, repeated submits,
// tenancy, and the echo. Nothing reaches Meta.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-11-04T12:00:00Z").getTime();
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

const welcome: TemplateContent = {
  kind: "buttons",
  text: "Hi {{customer_name}}, what can we do for you?",
  buttons: [
    { type: "reply", title: "Prices" },
    { type: "url", title: "Our shop", url: "https://shop.example.com" },
  ],
};

const picks: TemplateContent = {
  kind: "cards",
  cards: [
    {
      title: "Linen shirt",
      subtitle: "€49",
      imageUrl: "https://cdn.example.com/shirt.jpg",
      buttons: [{ type: "reply", title: "I want this" }],
    },
    { title: "Gift card", linkUrl: "https://shop.example.com/gift", buttons: [] },
  ],
};

/** An org with messaging on, a thread the customer opened, and two templates. */
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
  const welcomeT = await as(t).mutation(api.v1.instagramTemplates.create, {
    name: "Welcome",
    content: welcome,
  });
  const picksT = await as(t).mutation(api.v1.instagramTemplates.create, {
    name: "Picks",
    content: picks,
  });
  fake.reset();
  return {
    accountId: accountId as Id<"instagramMessagingAccounts">,
    conversationId: conversation!._id,
    welcomeId: welcomeT.id,
    picksId: picksT.id,
  };
}

let ids = 0;
const clientId = () => `tmpl-${String(++ids).padStart(4, "0")}`;

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isMarketingError(error)) throw error;
    return error.data;
  }
  throw new Error("expected the call to fail");
}

async function outbound(t: Backend) {
  return (await t.run((ctx) => ctx.db.query("instagramMessages").collect())).filter(
    (m) => m.direction === "outbound",
  );
}

describe("sendTemplate", () => {
  it("sends a button template with the customer's name filled in and keeps it as sent", async () => {
    const t = newBackend();
    const target = await thread(t);
    await t.run((ctx) => ctx.db.patch(target.conversationId, { contactName: "Ana Lima" }));
    const sent = await as(t, { role: "editor" }).mutation(api.v1.instagramMessaging.sendTemplate, {
      accountId: target.accountId,
      conversationId: target.conversationId,
      templateId: target.welcomeId,
      clientMessageId: clientId(),
    });
    expect(sent).toMatchObject({
      type: "template",
      status: "pending",
      text: "Hi Ana, what can we do for you?",
      templateName: "Welcome",
      template: { kind: "buttons", text: "Hi Ana, what can we do for you?" },
    });
    await drain(t);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.body).toEqual({
      recipient: { id: CUSTOMER_1 },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "button",
            text: "Hi Ana, what can we do for you?",
            buttons: [
              { type: "postback", title: "Prices", payload: "TEMPLATE_REPLY_1" },
              { type: "web_url", url: "https://shop.example.com", title: "Our shop" },
            ],
          },
        },
      },
    });
    expect(JSON.stringify(fake.sent[0]!.body)).not.toContain(FAKE_IG_TOKEN_MARKER);
    const [message] = await outbound(t);
    expect(message).toMatchObject({ status: "submitted", mid: fake.sent[0]!.mid });

    // Changing the template later never changes what was sent.
    await as(t).mutation(api.v1.instagramTemplates.update, {
      templateId: target.welcomeId,
      name: "Welcome",
      content: { ...welcome, text: "Changed" },
    });
    const page = await as(t, { role: "viewer" }).query(api.v1.instagramMessaging.listMessages, {
      conversationId: target.conversationId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(page.page[0]).toMatchObject({
      type: "template",
      template: { text: "Hi Ana, what can we do for you?" },
    });

    // Its echo confirms it, matched by mid.
    await postDelivery(t, delivery(entry([echo(fake.sent[0]!.mid, { account: IG })], IG)));
    await drain(t);
    expect((await outbound(t))[0]!.status).toBe("sent");
  });

  it("sends cards as a generic template, without the name when it is unknown", async () => {
    const t = newBackend();
    const target = await thread(t);
    await as(t).mutation(api.v1.instagramMessaging.sendTemplate, {
      accountId: target.accountId,
      conversationId: target.conversationId,
      templateId: target.picksId,
      clientMessageId: clientId(),
    });
    await drain(t);
    expect(fake.sent[0]!.body).toEqual({
      recipient: { id: CUSTOMER_1 },
      message: {
        attachment: {
          type: "template",
          payload: {
            template_type: "generic",
            elements: [
              {
                title: "Linen shirt",
                subtitle: "€49",
                image_url: "https://cdn.example.com/shirt.jpg",
                buttons: [
                  { type: "postback", title: "I want this", payload: "TEMPLATE_REPLY_1_1" },
                ],
              },
              {
                title: "Gift card",
                default_action: { type: "web_url", url: "https://shop.example.com/gift" },
              },
            ],
          },
        },
      },
    });
    const [message] = await outbound(t);
    expect(message).toMatchObject({ messageType: "template", text: "Linen shirt" });
  });

  it("refuses a template that is empty without the customer's name, before anything is stored", async () => {
    const t = newBackend();
    const target = await thread(t);
    const nameOnly = await as(t).mutation(api.v1.instagramTemplates.create, {
      name: "Name only",
      content: {
        kind: "buttons",
        text: "{{customer_name}}",
        buttons: [{ type: "reply", title: "Hi" }],
      },
    });
    const data = await refusal(
      as(t).mutation(api.v1.instagramMessaging.sendTemplate, {
        accountId: target.accountId,
        conversationId: target.conversationId,
        templateId: nameOnly.id,
        clientMessageId: clientId(),
      }),
    );
    expect(data).toMatchObject({ code: "INVALID_ARGUMENT", details: { reason: "text_missing" } });
    expect(await outbound(t)).toEqual([]);
  });

  it("sends once per clientMessageId and only within the reply window", async () => {
    const t = newBackend();
    const target = await thread(t);
    const args = {
      accountId: target.accountId,
      conversationId: target.conversationId,
      templateId: target.welcomeId,
      clientMessageId: clientId(),
    };
    const first = await as(t).mutation(api.v1.instagramMessaging.sendTemplate, args);
    const again = await as(t).mutation(api.v1.instagramMessaging.sendTemplate, args);
    expect(again.id).toBe(first.id);
    await drain(t);
    expect(fake.sent).toHaveLength(1);

    vi.setSystemTime(NOW + SERVICE_WINDOW_MS + 1);
    const closed = await refusal(
      as(t).mutation(api.v1.instagramMessaging.sendTemplate, {
        ...args,
        clientMessageId: clientId(),
      }),
    );
    expect(closed).toMatchObject({ code: "CONFLICT", details: { reason: "window_closed" } });
  });

  it("is sent with the Human Agent tag after 24 hours only while that is on", async () => {
    vi.stubEnv("INSTAGRAM_HUMAN_AGENT_ENABLED", "true");
    const t = newBackend();
    const target = await thread(t);
    vi.setSystemTime(NOW + 2 * DAY);
    expect(2 * DAY).toBeLessThan(HUMAN_AGENT_WINDOW_MS);
    await as(t).mutation(api.v1.instagramMessaging.sendTemplate, {
      accountId: target.accountId,
      conversationId: target.conversationId,
      templateId: target.welcomeId,
      clientMessageId: clientId(),
    });
    await drain(t);
    expect(fake.sent[0]!.body).toMatchObject({ messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" });
    expect((await outbound(t))[0]!.tag).toBe("human_agent");
  });

  it("is for editors and admins, and never sends another org's template", async () => {
    const t = newBackend();
    const target = await thread(t);
    const args = {
      accountId: target.accountId,
      conversationId: target.conversationId,
      templateId: target.welcomeId,
      clientMessageId: clientId(),
    };
    expect(
      (
        await refusal(
          as(t, { role: "viewer" }).mutation(api.v1.instagramMessaging.sendTemplate, args),
        )
      ).code,
    ).toBe("FORBIDDEN");

    const other = { issuer: ISSUER_CRM };
    await setupSyncOrg(t, other);
    const theirs = await as(t, other).mutation(api.v1.instagramTemplates.create, {
      name: "Theirs",
      content: welcome,
    });
    const data = await refusal(
      as(t).mutation(api.v1.instagramMessaging.sendTemplate, { ...args, templateId: theirs.id }),
    );
    expect(data).toMatchObject({ code: "NOT_FOUND", details: { table: "instagramTemplates" } });
    // Nor in another org's conversation.
    const foreign = await refusal(
      as(t, other).mutation(api.v1.instagramMessaging.sendTemplate, {
        ...args,
        templateId: theirs.id,
      }),
    );
    expect(foreign.code).toBe("NOT_FOUND");
    expect(await outbound(t)).toEqual([]);
  });
});
