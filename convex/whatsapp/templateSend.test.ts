import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
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
  type FakeTemplate,
  type FakeWhatsAppGraph,
} from "./fakeGraph.fixtures";
import {
  CUSTOMER_1,
  CUSTOMER_2,
  PHONE_A,
  WABA_A,
  delivery,
  entry,
  nowSeconds,
  postDelivery,
} from "./fakeWebhook.fixtures";

// Approved templates (ADR 0013 stage 5): listed from Meta with the number's own token, values
// checked against the template before anything is stored, sent whether or not the 24-hour window
// is open. The fake Graph applies Meta's documented parameter rules (132000 on a mismatch).

const TOKEN_A = "EAAG-test-business-token-org-a";
const PHONE_A2 = "200000000000003";
const PAGE = { paginationOpts: { numItems: 20, cursor: null } };

let graph: FakeWhatsAppGraph;

function template(overrides: Partial<FakeTemplate>): FakeTemplate {
  return {
    id: "990000000000001",
    name: "order_update",
    language: "en_US",
    status: "APPROVED",
    category: "UTILITY",
    parameter_format: "POSITIONAL",
    components: [],
    ...overrides,
  };
}

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
  graph.addTemplate(
    WABA_A,
    template({
      components: [
        {
          type: "BODY",
          text: "Hi {{1}}, your order {{2}} has shipped.",
          example: { body_text: [["Ana", "A-1"]] },
        },
        { type: "FOOTER", text: "Thanks" },
        {
          type: "BUTTONS",
          buttons: [{ type: "URL", text: "Track", url: "https://example.com/track/{{1}}" }],
        },
      ],
    }),
  );
  graph.addTemplate(
    WABA_A,
    template({
      id: "990000000000002",
      name: "welcome",
      category: "MARKETING",
      parameter_format: "NAMED",
      components: [{ type: "BODY", text: "Welcome {{first_name}}!" }],
    }),
  );
  graph.addTemplate(
    WABA_A,
    template({
      id: "990000000000003",
      name: "promo_image",
      category: "MARKETING",
      components: [
        { type: "HEADER", format: "IMAGE" },
        { type: "BODY", text: "New arrivals" },
      ],
    }),
  );
  // Complete templates that are not approved: only their status keeps them out.
  for (const [id, name, status] of [
    ["990000000000004", "old_one", "REJECTED"],
    ["990000000000005", "on_hold", "PAUSED"],
    ["990000000000006", "in_review", "PENDING"],
  ] as const) {
    graph.addTemplate(
      WABA_A,
      template({ id, name, status, components: [{ type: "BODY", text: "Hello again" }] }),
    );
  }
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Runs what is due now, 1 s at a time (see outbound.test.ts). */
const run = (t: Backend) =>
  t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000), 1_000);

async function setup() {
  const t = newBackend();
  const orgA = await seedOrg(t, ISSUER_ERP, "42");
  await seedOrg(t, ISSUER_CRM, "77");
  const now = Date.now();
  vi.setSystemTime(now - 60 * 60 * 1000);
  await as(t).action(api.v1.whatsapp.completeSignup, {
    code: graph.issueCode({ token: TOKEN_A, sharedWabas: [WABA_A] }),
    wabaId: WABA_A,
    phoneNumberId: PHONE_A,
  });
  vi.setSystemTime(now);
  await inbound(t, "wamid.in-1", CUSTOMER_1);
  const conversationId = (
    await as(t, { role: "viewer" }).query(api.v1.whatsapp.listConversations, PAGE)
  ).page[0]!.id;
  graph.log.length = 0;
  return { t, orgA, now, conversationId };
}

async function inbound(t: Backend, wamid: string, from: string, phoneNumberId = PHONE_A) {
  await postDelivery(
    t,
    delivery(entry({ phoneNumberId, messages: [{ id: wamid, from, text: "Hello" }] })),
  );
  await run(t);
}

async function thread(t: Backend, conversationId: string) {
  return (
    await as(t, { role: "viewer" }).query(api.v1.whatsapp.listMessages, {
      conversationId,
      ...PAGE,
    })
  ).page;
}

async function outboundRows(t: Backend) {
  return (await t.run(async (ctx) => await ctx.db.query("whatsappMessages").collect())).filter(
    (m) => m.direction === "outbound",
  );
}

const asB = (t: Backend) => as(t, { issuer: ISSUER_CRM, org: "77", sub: "user_b", role: "admin" });

const orderValues = [
  { component: "button" as const, name: "0", value: "A-1042" },
  { component: "body" as const, name: "2", value: "A-1042" },
  { component: "body" as const, name: "1", value: "Ana" },
];

function sendOrder(
  caller: ReturnType<typeof as>,
  conversationId: string,
  overrides: Partial<{
    templateName: string;
    language: string;
    variables: { component: "header" | "body" | "button"; name: string; value: string }[];
    clientMessageId: string;
  }> = {},
) {
  return caller.action(api.v1.whatsapp.sendTemplate, {
    conversationId,
    templateName: "order_update",
    language: "en_US",
    variables: orderValues,
    clientMessageId: "client-tpl-0001",
    ...overrides,
  });
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isMarketingError(error)) return { code: error.data.code, ...error.data.details };
    throw error;
  }
  throw new Error("expected the call to fail");
}

describe("listTemplates", () => {
  it("lists the account's approved templates from Meta, flagging those not supported yet", async () => {
    const { t, conversationId } = await setup();
    const listed = await as(t, { role: "editor" }).action(api.v1.whatsapp.listTemplates, {
      conversationId,
    });
    expect(listed.complete).toBe(true);
    expect(listed.templates.map((x) => [x.name, x.supported, x.unsupportedReason])).toEqual([
      ["order_update", true, undefined],
      ["welcome", true, undefined],
      ["promo_image", false, "media_header"],
    ]);
    expect(listed.templates[0]).toEqual({
      name: "order_update",
      language: "en_US",
      category: "UTILITY",
      parameterFormat: "POSITIONAL",
      body: "Hi {{1}}, your order {{2}} has shipped.",
      footer: "Thanks",
      buttons: [{ type: "URL", text: "Track" }],
      variables: [
        { component: "body", name: "1", example: "Ana" },
        { component: "body", name: "2", example: "A-1" },
        { component: "button", name: "0" },
      ],
      supported: true,
    });
    expect(graph.log.map((c) => [c.route, c.path, c.authorization])).toEqual([
      ["templates", `${WABA_A}/message_templates`, `Bearer ${TOKEN_A}`],
    ]);
  });

  it("is for editors and admins of the conversation's org only", async () => {
    const { t, conversationId } = await setup();
    await expectMarketingError(
      as(t, { role: "viewer" }).action(api.v1.whatsapp.listTemplates, { conversationId }),
      "FORBIDDEN",
    );
    await expectMarketingError(
      t.action(api.v1.whatsapp.listTemplates, { conversationId }),
      "UNAUTHENTICATED",
    );
    await expectMarketingError(
      asB(t).action(api.v1.whatsapp.listTemplates, { conversationId }),
      "NOT_FOUND",
    );
    await expectMarketingError(
      as(t).action(api.v1.whatsapp.listTemplates, { conversationId: "nope" }),
      "NOT_FOUND",
    );
    expect(graph.calls()).toBe(0);
  });

  it("is refused for a number set up by support, without calling Meta", async () => {
    const { t, orgA } = await setup();
    await t.mutation(internal.whatsapp.phoneNumbers.register, {
      orgId: orgA,
      wabaId: WABA_A,
      phoneNumberId: PHONE_A2,
      actorSubject: "operator:test",
    });
    await inbound(t, "wamid.in-op", CUSTOMER_2, PHONE_A2);
    const operatorConversation = (
      await as(t).query(api.v1.whatsapp.listConversations, PAGE)
    ).page.find((c) => c.phoneNumberId === PHONE_A2)!;
    graph.log.length = 0;
    expect(
      await failure(
        as(t).action(api.v1.whatsapp.listTemplates, { conversationId: operatorConversation.id }),
      ),
    ).toMatchObject({ code: "CONFLICT", reason: "number_cannot_send" });
    expect(graph.calls()).toBe(0);
  });

  it("reports Meta's failure, and asks for a reconnect when Meta refuses the token", async () => {
    const { t, conversationId } = await setup();
    graph.failNext("templates", { status: 503 });
    expect(
      await failure(as(t).action(api.v1.whatsapp.listTemplates, { conversationId })),
    ).toMatchObject({ code: "PROVIDER_ERROR", reason: "http_503" });

    graph.failNext("templates", graphError(190, 401, 463));
    expect(
      await failure(as(t).action(api.v1.whatsapp.listTemplates, { conversationId })),
    ).toMatchObject({ code: "CONFLICT", reason: "reconnect_required" });
    const connections = await t.run(async (ctx) => await ctx.db.query("connections").collect());
    expect(connections[0]!.status).toBe("needs_reauth");
  });
});

describe("sendTemplate", () => {
  it("sends an approved template after the window closed, with exactly the checked values", async () => {
    const { t, now, conversationId } = await setup();
    vi.setSystemTime(now + SERVICE_WINDOW_MS + 60_000);
    // Text needs the window; a template does not.
    await expectMarketingError(
      as(t).mutation(api.v1.whatsapp.sendText, {
        conversationId,
        text: "Hi",
        clientMessageId: "client-txt-0001",
      }),
      "CONFLICT",
    );
    const queued = await sendOrder(as(t, { role: "editor" }), conversationId);
    expect(queued).toMatchObject({
      direction: "outbound",
      type: "template",
      status: "pending",
      template: { name: "order_update", language: "en_US" },
      text: "Hi Ana, your order A-1042 has shipped.\n\nThanks",
    });
    await run(t);
    expect(graph.sent).toHaveLength(1);
    expect(graph.sent[0]!.body).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: `+${CUSTOMER_1}`,
      type: "template",
      template: {
        name: "order_update",
        language: { code: "en_US" },
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "Ana" },
              { type: "text", text: "A-1042" },
            ],
          },
          {
            type: "button",
            sub_type: "url",
            index: "0",
            parameters: [{ type: "text", text: "A-1042" }],
          },
        ],
      },
    });
    for (const value of ["Ana", "A-1042", TOKEN_A]) {
      expect(graph.log.every((c) => !c.url.includes(value))).toBe(true);
    }

    await postDelivery(
      t,
      delivery(
        entry({ statuses: [{ id: "wamid.fake-1", status: "delivered", timestamp: nowSeconds() }] }),
      ),
    );
    await run(t);
    expect((await thread(t, conversationId))[0]).toMatchObject({
      type: "template",
      status: "delivered",
    });
    const [stored] = await outboundRows(t);
    expect(stored!.template?.components).toHaveLength(2);
    expect(JSON.stringify(stored)).not.toContain(TOKEN_A);
  });

  it("sends a NAMED template with its parameter names", async () => {
    const { t, conversationId } = await setup();
    await sendOrder(as(t), conversationId, {
      templateName: "welcome",
      variables: [{ component: "body", name: "first_name", value: "Ana" }],
    });
    await run(t);
    expect(graph.sent[0]!.body.template).toEqual({
      name: "welcome",
      language: { code: "en_US" },
      components: [
        { type: "body", parameters: [{ type: "text", parameter_name: "first_name", text: "Ana" }] },
      ],
    });
    expect((await thread(t, conversationId))[0]).toMatchObject({
      status: "submitted",
      text: "Welcome Ana!",
    });
  });

  it.each([
    ["a missing value", orderValues.slice(1), "variables.button.0", "missing_value"],
    [
      "a value for no placeholder",
      [...orderValues, { component: "body" as const, name: "3", value: "x" }],
      "variables.body.3",
      "unexpected_value",
    ],
    [
      "a blank value",
      [...orderValues.slice(0, 2), { component: "body" as const, name: "1", value: " " }],
      "variables.body.1",
      "blank_value",
    ],
  ])("refuses %s before storing or sending anything", async (_label, variables, field, reason) => {
    const { t, conversationId } = await setup();
    expect(await failure(sendOrder(as(t), conversationId, { variables }))).toMatchObject({
      code: "INVALID_ARGUMENT",
      field,
      reason,
    });
    await run(t);
    expect(await outboundRows(t)).toEqual([]);
    expect(graph.calls("send")).toBe(0);
  });

  it.each([
    ["another language", { language: "pt_BR" }, "template_unavailable"],
    ["a rejected template", { templateName: "old_one" }, "template_unavailable"],
    ["a paused template", { templateName: "on_hold" }, "template_unavailable"],
    ["a template that does not exist", { templateName: "nothing_here" }, "template_unavailable"],
    ["an image template", { templateName: "promo_image", variables: [] }, "template_unsupported"],
  ])("refuses %s", async (_label, overrides, reason) => {
    const { t, conversationId } = await setup();
    expect(await failure(sendOrder(as(t), conversationId, overrides))).toMatchObject({
      code: "CONFLICT",
      reason,
    });
    expect(await outboundRows(t)).toEqual([]);
  });

  it.each([
    ["templateName", { templateName: "Bad Name" }],
    ["language", { language: "english!" }],
    ["clientMessageId", { clientMessageId: "x" }],
  ])("refuses a malformed %s without calling Meta", async (field, overrides) => {
    const { t, conversationId } = await setup();
    expect(await failure(sendOrder(as(t), conversationId, overrides))).toMatchObject({
      code: "INVALID_ARGUMENT",
      field,
    });
    expect(graph.calls()).toBe(0);
  });

  it("is for editors and admins of the conversation's org only", async () => {
    const { t, conversationId } = await setup();
    await expectMarketingError(sendOrder(as(t, { role: "viewer" }), conversationId), "FORBIDDEN");
    await expectMarketingError(sendOrder(asB(t), conversationId), "NOT_FOUND");
    expect(graph.calls()).toBe(0);
    expect(await outboundRows(t)).toEqual([]);
  });

  it("returns a repeated submit's message without reading templates or sending again", async () => {
    const { t, conversationId } = await setup();
    const first = await sendOrder(as(t), conversationId);
    await run(t);
    const again = await sendOrder(as(t), conversationId);
    expect(again).toMatchObject({ id: first.id, status: "submitted" });
    await run(t);
    expect(graph.calls("templates")).toBe(1);
    expect(graph.calls("send")).toBe(1);
  });

  it("fails the message when Meta refuses the template at send time", async () => {
    const { t, conversationId } = await setup();
    graph.failNext("send", graphError(132018, 400));
    await sendOrder(as(t), conversationId);
    await run(t);
    expect((await thread(t, conversationId))[0]).toMatchObject({
      type: "template",
      status: "failed",
      errorCode: 132018,
      failureReason: "meta_132018",
    });
  });
});
