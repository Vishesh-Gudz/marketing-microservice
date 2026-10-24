import { afterEach, describe, expect, it, vi } from "vitest";
import { SIGNUP_TIMEOUT_MS } from "./config";
import {
  createFakeWhatsAppGraph,
  FAKE_WA_APP_ID,
  graphError,
  type FakeTemplate,
  type FakeWhatsAppGraph,
} from "./fakeGraph.fixtures";
import { FAKE_WA_APP_SECRET, PHONE_A, PHONE_B, WABA_A, WABA_B } from "./fakeWebhook.fixtures";
import {
  exchangeSignupCode,
  listMessageTemplates,
  MAX_TEMPLATE_PAGES,
  sendMessage,
  type OutboundMessage,
} from "./graph";

// The WhatsApp Graph client's messaging calls (send, list templates) against the fake Graph.
// Delivery is not part of these calls: Meta reports it later through status webhooks.

const TOKEN = "EAAG-test-business-token-messaging";
const auth = { accessToken: TOKEN, appSecret: FAKE_WA_APP_SECRET };
const CUSTOMER = "+15550001111";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A fake Graph where TOKEN was granted WABA_A, whose PHONE_A is registered for Cloud API. */
async function setup(): Promise<FakeWhatsAppGraph> {
  const fake = createFakeWhatsAppGraph();
  vi.stubGlobal("fetch", fake.fetch);
  fake.addWaba({
    id: WABA_A,
    name: "Org A Business",
    numbers: [{ id: PHONE_A, display_phone_number: "+1 555-000-0001" }],
  });
  fake.addWaba({
    id: WABA_B,
    name: "Org B Business",
    numbers: [{ id: PHONE_B, display_phone_number: "+1 555-000-0002" }],
  });
  const code = fake.issueCode({ token: TOKEN, sharedWabas: [WABA_A] });
  const exchanged = await exchangeSignupCode(
    { appId: FAKE_WA_APP_ID, appSecret: FAKE_WA_APP_SECRET },
    code,
  );
  expect(exchanged.ok).toBe(true);
  fake.registered.set(PHONE_A, "123456");
  fake.log.length = 0;
  return fake;
}

function template(overrides: Partial<FakeTemplate> = {}): FakeTemplate {
  return {
    id: "990000000000001",
    name: "order_update",
    language: "en_US",
    status: "APPROVED",
    category: "UTILITY",
    parameter_format: "POSITIONAL",
    components: [{ type: "BODY", text: "Your order {{1}} has shipped." }],
    ...overrides,
  };
}

const text = (body: string): OutboundMessage => ({ to: CUSTOMER, type: "text", text: { body } });

describe("sendMessage", () => {
  it("sends a text message as Meta documents it; recipient and content never reach the URL", async () => {
    const fake = await setup();
    expect(await sendMessage(PHONE_A, text("Thanks, we are on it."), auth)).toEqual({
      ok: true,
      wamid: "wamid.fake-1",
    });

    expect(fake.log).toHaveLength(1);
    const call = fake.log[0]!;
    expect(call).toMatchObject({
      route: "send",
      method: "POST",
      version: "v26.0",
      path: `${PHONE_A}/messages`,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(Object.keys(call.params)).toEqual(["appsecret_proof"]);
    expect(call.params.appsecret_proof).toMatch(/^[0-9a-f]{64}$/);
    expect(call.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: CUSTOMER,
      type: "text",
      text: { body: "Thanks, we are on it." },
    });
    for (const secret of [TOKEN, FAKE_WA_APP_SECRET, CUSTOMER.slice(1), "Thanks"]) {
      expect(call.url).not.toContain(secret);
    }
    expect(fake.sent).toEqual([{ phoneNumberId: PHONE_A, wamid: "wamid.fake-1", body: call.body }]);
  });

  it("sends a template with its parameters in the JSON body", async () => {
    const fake = await setup();
    fake.addTemplate(
      WABA_A,
      template({
        components: [
          { type: "BODY", text: "Your order {{1}} has shipped." },
          {
            type: "BUTTONS",
            buttons: [{ type: "URL", text: "Track", url: "https://example.com/track/{{1}}" }],
          },
        ],
      }),
    );
    const message: OutboundMessage = {
      to: CUSTOMER,
      type: "template",
      template: {
        name: "order_update",
        language: { code: "en_US" },
        components: [
          { type: "body", parameters: [{ type: "text", text: "A-1042" }] },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "A-1042" }],
          },
        ],
      },
    };
    expect(await sendMessage(PHONE_A, message, auth)).toEqual({ ok: true, wamid: "wamid.fake-1" });
    expect(fake.log[0]!.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      ...message,
    });
    expect(fake.log[0]!.url).not.toContain("A-1042");
  });

  it.each([
    ["outside the customer-service window (131047)", graphError(131047, 400)],
    ["an undeliverable recipient (131026)", graphError(131026, 400)],
    ["a rate limit (130429)", graphError(130429, 400)],
    ["a refused token (190)", graphError(190, 401, 463)],
    ["a template parameter problem (132018)", graphError(132018, 400)],
  ])("reports %s as Meta's numeric codes only", async (_label, failure) => {
    const fake = await setup();
    fake.failNext("send", failure);
    const result = await sendMessage(PHONE_A, text("hi"), auth);
    expect(result).toEqual({
      ok: false,
      failure: {
        kind: "http",
        status: failure.status,
        metaCode: failure.body.error.code,
        ...(failure.body.error.error_subcode !== undefined
          ? { metaSubcode: failure.body.error.error_subcode }
          : {}),
      },
    });
    expect(JSON.stringify(result)).not.toContain("Fake Graph error");
  });

  it("is refused by the fake Graph like Meta: unregistered number, another WABA, unknown template", async () => {
    const fake = await setup();
    fake.registered.delete(PHONE_A);
    expect(await sendMessage(PHONE_A, text("hi"), auth)).toMatchObject({
      ok: false,
      failure: { metaCode: 133010 },
    });
    fake.registered.set(PHONE_A, "123456");
    expect(await sendMessage(PHONE_B, text("hi"), auth)).toMatchObject({
      ok: false,
      failure: { metaCode: 100, metaSubcode: 33 },
    });
    fake.addTemplate(WABA_A, template({ status: "PAUSED" }));
    const paused: OutboundMessage = {
      to: CUSTOMER,
      type: "template",
      template: { name: "order_update", language: { code: "en_US" } },
    };
    expect(await sendMessage(PHONE_A, paused, auth)).toMatchObject({
      ok: false,
      failure: { metaCode: 132001 },
    });
    expect(fake.sent).toEqual([]);
  });

  it.each([
    ["no messages", { messaging_product: "whatsapp" }],
    ["an empty messages list", { messages: [] }],
    ["a numeric id", { messages: [{ id: 42 }] }],
    ["an id with spaces", { messages: [{ id: "wamid with spaces" }] }],
    ["messages that is not a list", { messages: { id: "wamid.x" } }],
  ])("does not read a 200 answer with %s as sent", async (_label, body) => {
    const fake = await setup();
    fake.failNext("send", { status: 200, body });
    expect(await sendMessage(PHONE_A, text("hi"), auth)).toEqual({
      ok: false,
      failure: { kind: "invalid_json", status: 200 },
    });
  });

  it("reports a network failure or an answer that is not JSON by its kind only", async () => {
    const fake = await setup();
    fake.failNext("send", "network");
    expect(await sendMessage(PHONE_A, text("hi"), auth)).toEqual({
      ok: false,
      failure: { kind: "network" },
    });
    fake.failNext("send", "invalid_json");
    expect(await sendMessage(PHONE_A, text("hi"), auth)).toEqual({
      ok: false,
      failure: { kind: "invalid_json", status: 200 },
    });
  });

  it("times out a hanging send and never repeats it", async () => {
    const fake = await setup();
    vi.useFakeTimers();
    fake.failNext("send", "hang");
    const pending = sendMessage(PHONE_A, text("hi"), auth);
    await vi.waitFor(() => expect(fake.calls("send")).toBe(1));
    await vi.advanceTimersByTimeAsync(SIGNUP_TIMEOUT_MS);
    expect(await pending).toEqual({ ok: false, failure: { kind: "timeout" } });
    expect(fake.calls("send")).toBe(1);
  });

  it("never puts a non-numeric phone id into a Graph path", async () => {
    const fake = await setup();
    await expect(sendMessage("../me", text("hi"), auth)).rejects.toThrow("Invalid Graph node id");
    expect(fake.calls()).toBe(0);
  });
});

describe("listMessageTemplates", () => {
  it("returns every template of the WABA across pages, whatever its status", async () => {
    const fake = await setup();
    for (let i = 0; i < 120; i++) {
      fake.addTemplate(
        WABA_A,
        template({
          id: String(990_000_000_000_100 + i),
          name: `t_${i}`,
          status: i % 3 === 0 ? "REJECTED" : "APPROVED",
        }),
      );
    }
    const result = await listMessageTemplates(WABA_A, auth);
    expect(result).toMatchObject({ ok: true, complete: true });
    if (!result.ok) throw new Error("expected ok");
    expect(result.templates.map((t) => t.name)).toEqual(
      Array.from({ length: 120 }, (_, i) => `t_${i}`),
    );
    expect(fake.calls("templates")).toBe(2);
    const first = fake.log[0]!;
    expect(first).toMatchObject({
      method: "GET",
      path: `${WABA_A}/message_templates`,
      authorization: `Bearer ${TOKEN}`,
    });
    expect(first.params).toMatchObject({
      fields: "id,name,language,status,category,parameter_format,components",
      limit: "100",
    });
    expect(first.params.appsecret_proof).toMatch(/^[0-9a-f]{64}$/);
    expect(first.url).not.toContain(TOKEN);
    expect(fake.log[1]!.params.after).toBeDefined();
  });

  it(`stops after ${MAX_TEMPLATE_PAGES} pages and says the list is incomplete`, async () => {
    const fake = await setup();
    for (let i = 0; i < MAX_TEMPLATE_PAGES * 100 + 1; i++) {
      fake.addTemplate(WABA_A, template({ id: String(990_000_000_001_000 + i), name: `t_${i}` }));
    }
    const result = await listMessageTemplates(WABA_A, auth);
    expect(result).toMatchObject({ ok: true, complete: false });
    if (!result.ok) throw new Error("expected ok");
    expect(result.templates).toHaveLength(MAX_TEMPLATE_PAGES * 100);
    expect(fake.calls("templates")).toBe(MAX_TEMPLATE_PAGES);
  });

  it("an empty WABA lists nothing and is complete", async () => {
    await setup();
    expect(await listMessageTemplates(WABA_A, auth)).toEqual({
      ok: true,
      templates: [],
      complete: true,
    });
  });

  it("keeps only objects and fails on a page whose data is not a list", async () => {
    const fake = await setup();
    fake.failNext("templates", {
      status: 200,
      body: { data: [template(), "not-a-template", null, [1, 2], 7] },
    });
    const kept = await listMessageTemplates(WABA_A, auth);
    if (!kept.ok) throw new Error("expected ok");
    expect(kept.templates).toEqual([template()]);
    fake.failNext("templates", { status: 200, body: { data: "nope" } });
    expect(await listMessageTemplates(WABA_A, auth)).toEqual({
      ok: false,
      failure: { kind: "invalid_json", status: 200 },
    });
  });

  it("reports a WABA the token cannot read as Meta's codes only", async () => {
    await setup();
    expect(await listMessageTemplates(WABA_B, auth)).toEqual({
      ok: false,
      failure: { kind: "http", status: 400, metaCode: 100, metaSubcode: 33 },
    });
  });

  it("never puts a non-numeric WABA id into a Graph path", async () => {
    const fake = await setup();
    await expect(listMessageTemplates("me", auth)).rejects.toThrow("Invalid Graph node id");
    expect(fake.calls()).toBe(0);
  });
});
