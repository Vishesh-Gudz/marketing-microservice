import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../_generated/api";
import { isMarketingError } from "../lib/errors";
import { as, ISSUER_CRM, ISSUER_ERP, newBackend, seedOrg, type Backend } from "../test.helpers";
import { graphError, installFakeWhatsAppGraph, type FakeWhatsAppGraph } from "./fakeGraph.fixtures";
import { FAKE_WA_APP_SECRET, PHONE_A, PHONE_B, WABA_A, WABA_B } from "./fakeWebhook.fixtures";
import type { TemplateDraft } from "./templateDrafts";

// ADR 0020: template management through the public API, against the fake Graph (Meta's
// documented create, list and delete calls). Nothing here calls Meta.

const TOKEN_A = "EAAG-test-business-token-templates-a";
const TOKEN_B = "EAAG-test-business-token-templates-b";
const SECRETS = [TOKEN_A, TOKEN_B, FAKE_WA_APP_SECRET];

let graph: FakeWhatsAppGraph;

beforeEach(() => {
  graph = installFakeWhatsAppGraph();
  graph.addWaba({
    id: WABA_A,
    name: "Org A Business",
    numbers: [{ id: PHONE_A, display_phone_number: "+1 555-000-0001" }],
  });
  graph.addWaba({
    id: WABA_B,
    name: "Org B Business",
    numbers: [{ id: PHONE_B, display_phone_number: "+1 555-000-0002" }],
  });
  graph.addTemplate(WABA_A, {
    id: "800000000000001",
    name: "order_update",
    language: "en_US",
    status: "APPROVED",
    category: "UTILITY",
    components: [
      { type: "BODY", text: "Your order {{1}} shipped.", example: { body_text: [["#1"]] } },
    ],
  });
  graph.addTemplate(WABA_A, {
    id: "800000000000002",
    name: "big_sale",
    language: "en",
    status: "REJECTED",
    category: "MARKETING",
    components: [{ type: "BODY", text: "Sale!" }],
    ...({ rejected_reason: "INVALID_FORMAT" } as object),
  });
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    vi.spyOn(console, level).mockImplementation(() => undefined);
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORG_B = { issuer: ISSUER_CRM, org: "77", sub: "user_b", role: "admin" };

async function setup() {
  const t = newBackend();
  await seedOrg(t, ISSUER_ERP, "42");
  await seedOrg(t, ISSUER_CRM, "77");
  const a = await as(t).action(api.v1.whatsapp.completeSignup, {
    code: graph.issueCode({ token: TOKEN_A, sharedWabas: [WABA_A] }),
    wabaId: WABA_A,
    phoneNumberId: PHONE_A,
  });
  const b = await as(t, ORG_B).action(api.v1.whatsapp.completeSignup, {
    code: graph.issueCode({ token: TOKEN_B, sharedWabas: [WABA_B] }),
    wabaId: WABA_B,
    phoneNumberId: PHONE_B,
  });
  graph.log.length = 0;
  return { t, accountA: a.accountId, accountB: b.accountId };
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (!isMarketingError(error)) throw error;
    const text = JSON.stringify(error.data);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    return error.data;
  }
  throw new Error("expected the call to fail");
}

function draft(overrides: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    name: "appointment_reminder",
    language: "en",
    category: "UTILITY",
    header: "Appointment reminder",
    body: "Hi {{customer_name}}, see you on {{appointment_date}}.",
    footer: "Reply to reschedule",
    buttons: [{ type: "QUICK_REPLY", text: "Confirm" }],
    examples: [
      { component: "body", name: "customer_name", value: "Rahul" },
      { component: "body", name: "appointment_date", value: "12 November" },
    ],
    ...overrides,
  };
}

async function audits(t: Backend) {
  return await t.run(async (ctx) =>
    (await ctx.db.query("auditLog").collect()).filter((a) =>
      a.action.startsWith("whatsapp.template"),
    ),
  );
}

describe("listAccountTemplates", () => {
  it("lists every template of the account, any status, for every member", async () => {
    const { t, accountA } = await setup();
    const list = await as(t, { role: "viewer" }).action(api.v1.whatsapp.listAccountTemplates, {
      accountId: accountA,
    });
    expect(list.complete).toBe(true);
    expect(list.templates).toEqual([
      expect.objectContaining({
        id: "800000000000001",
        name: "order_update",
        status: "APPROVED",
        category: "UTILITY",
        sendable: true,
      }),
      expect.objectContaining({
        id: "800000000000002",
        name: "big_sale",
        status: "REJECTED",
        rejectedReason: "INVALID_FORMAT",
      }),
    ]);
    expect(graph.log.map((c) => c.route)).toEqual(["templates"]);
    expect(JSON.stringify(list)).not.toContain(TOKEN_A);
  });

  it("never shows another org's account", async () => {
    const { t, accountB } = await setup();
    const data = await refusal(
      as(t).action(api.v1.whatsapp.listAccountTemplates, { accountId: accountB }),
    );
    expect(data.code).toBe("NOT_FOUND");
    expect(graph.calls()).toBe(0);
  });

  it("refuses a disconnected account without calling Meta", async () => {
    const { t, accountA } = await setup();
    await as(t).action(api.v1.whatsapp.disconnectAccount, { accountId: accountA });
    graph.log.length = 0;
    const data = await refusal(
      as(t).action(api.v1.whatsapp.listAccountTemplates, { accountId: accountA }),
    );
    expect(data).toMatchObject({ code: "CONFLICT", details: { reason: "account_disconnected" } });
    expect(graph.calls()).toBe(0);
  });

  it("marks the connection for reconnection when Meta refuses the token", async () => {
    const { t, accountA } = await setup();
    graph.failNext("templates", graphError(190, 401));
    const data = await refusal(
      as(t).action(api.v1.whatsapp.listAccountTemplates, { accountId: accountA }),
    );
    expect(data).toMatchObject({ code: "CONFLICT", details: { reason: "reconnect_required" } });
    const connections = await t.run(async (ctx) => await ctx.db.query("connections").collect());
    expect(connections.find((c) => c.externalUserId === WABA_A)?.status).toBe("needs_reauth");
  });
});

describe("createTemplate", () => {
  it("submits the checked template to Meta, audits it, and lists it as in review", async () => {
    const { t, accountA } = await setup();
    const created = await as(t).action(api.v1.whatsapp.createTemplate, {
      accountId: accountA,
      draft: draft(),
    });
    expect(created).toEqual({
      id: expect.stringMatching(/^\d+$/),
      name: "appointment_reminder",
      language: "en",
      status: "PENDING",
      category: "UTILITY",
    });
    expect(graph.createdTemplates).toEqual([
      {
        name: "appointment_reminder",
        language: "en",
        category: "UTILITY",
        parameter_format: "named",
        components: [
          { type: "HEADER", format: "TEXT", text: "Appointment reminder" },
          {
            type: "BODY",
            text: "Hi {{customer_name}}, see you on {{appointment_date}}.",
            example: {
              body_text_named_params: [
                { param_name: "customer_name", example: "Rahul" },
                { param_name: "appointment_date", example: "12 November" },
              ],
            },
          },
          { type: "FOOTER", text: "Reply to reschedule" },
          { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirm" }] },
        ],
      },
    ]);
    // The token travels only in the Authorization header, never in the body or URL.
    const call = graph.log.find((c) => c.route === "create_template")!;
    expect(call.authorization).toBe(`Bearer ${TOKEN_A}`);
    expect(call.url).not.toContain(TOKEN_A);
    expect(JSON.stringify(call.body)).not.toContain(TOKEN_A);

    expect(await audits(t)).toEqual([
      expect.objectContaining({
        action: "whatsapp.template_created",
        subject: "user_1",
        targetType: "whatsappBusinessAccount",
        targetId: accountA,
        changes: {
          template: { from: null, to: "appointment_reminder" },
          templateId: { from: null, to: created.id },
          language: { from: null, to: "en" },
          category: { from: null, to: "UTILITY" },
        },
      }),
    ]);
    const list = await as(t).action(api.v1.whatsapp.listAccountTemplates, { accountId: accountA });
    expect(list.templates.find((x) => x.name === "appointment_reminder")).toMatchObject({
      status: "PENDING",
      header: "Appointment reminder",
      footer: "Reply to reschedule",
      buttons: [{ type: "QUICK_REPLY", text: "Confirm" }],
      parameterFormat: "NAMED",
    });
  });

  it("is for admins only", async () => {
    const { t, accountA } = await setup();
    for (const role of ["editor", "viewer"]) {
      const data = await refusal(
        as(t, { role }).action(api.v1.whatsapp.createTemplate, {
          accountId: accountA,
          draft: draft(),
        }),
      );
      expect(data.code).toBe("FORBIDDEN");
    }
    expect(graph.calls()).toBe(0);
  });

  it("refuses a draft that breaks a rule before calling Meta", async () => {
    const { t, accountA } = await setup();
    const data = await refusal(
      as(t).action(api.v1.whatsapp.createTemplate, {
        accountId: accountA,
        draft: draft({ examples: [] }),
      }),
    );
    expect(data).toMatchObject({
      code: "INVALID_ARGUMENT",
      details: { reason: "missing_example", field: "examples.body.customer_name" },
    });
    expect(graph.calls("create_template")).toBe(0);
    expect(await audits(t)).toEqual([]);
  });

  it("reports Meta's refusal by code and subcode only", async () => {
    const { t, accountA } = await setup();
    const data = await refusal(
      as(t).action(api.v1.whatsapp.createTemplate, {
        accountId: accountA,
        draft: draft({ name: "order_update", language: "en_US", examples: draft().examples }),
      }),
    );
    expect(data).toMatchObject({
      code: "CONFLICT",
      details: { reason: "meta_100_2388024", retryable: false },
    });
    expect(JSON.stringify(data)).not.toContain("Fake Graph error");
    expect(await audits(t)).toEqual([]);

    graph.failNext("create_template", "network");
    const lost = await refusal(
      as(t).action(api.v1.whatsapp.createTemplate, { accountId: accountA, draft: draft() }),
    );
    expect(lost).toMatchObject({
      code: "PROVIDER_ERROR",
      details: { reason: "network", retryable: true },
    });
  });

  it("never creates in another org's account", async () => {
    const { t, accountB } = await setup();
    const data = await refusal(
      as(t).action(api.v1.whatsapp.createTemplate, { accountId: accountB, draft: draft() }),
    );
    expect(data.code).toBe("NOT_FOUND");
    expect(graph.templatesOf(WABA_B)).toEqual([]);
  });
});

describe("deleteTemplate", () => {
  it("deletes one template in one language at Meta and audits it", async () => {
    const { t, accountA } = await setup();
    await as(t).action(api.v1.whatsapp.deleteTemplate, {
      accountId: accountA,
      templateId: "800000000000002",
      name: "big_sale",
      language: "en",
    });
    const call = graph.log.find((c) => c.route === "delete_template")!;
    expect(call.method).toBe("DELETE");
    expect(call.params).toMatchObject({ hsm_id: "800000000000002", name: "big_sale" });
    expect(graph.templatesOf(WABA_A).map((x) => x.name)).toEqual(["order_update"]);
    expect(await audits(t)).toEqual([
      expect.objectContaining({
        action: "whatsapp.template_deleted",
        targetId: accountA,
        changes: {
          template: { from: "big_sale", to: null },
          templateId: { from: "800000000000002", to: null },
          language: { from: "en", to: null },
        },
      }),
    ]);
  });

  it("checks its arguments, the role and the account before calling Meta", async () => {
    const { t, accountA, accountB } = await setup();
    const base = {
      accountId: accountA,
      templateId: "800000000000001",
      name: "order_update",
      language: "en_US",
    };
    expect(
      (await refusal(as(t).action(api.v1.whatsapp.deleteTemplate, { ...base, templateId: "x" })))
        .details,
    ).toMatchObject({ field: "templateId" });
    expect(
      (await refusal(as(t).action(api.v1.whatsapp.deleteTemplate, { ...base, name: "Bad Name" })))
        .details,
    ).toMatchObject({ field: "name" });
    expect(
      (await refusal(as(t).action(api.v1.whatsapp.deleteTemplate, { ...base, language: "x" })))
        .details,
    ).toMatchObject({ field: "language" });
    expect(
      (await refusal(as(t, { role: "editor" }).action(api.v1.whatsapp.deleteTemplate, base))).code,
    ).toBe("FORBIDDEN");
    expect(
      (
        await refusal(
          as(t).action(api.v1.whatsapp.deleteTemplate, { ...base, accountId: accountB }),
        )
      ).code,
    ).toBe("NOT_FOUND");
    expect(graph.calls()).toBe(0);
  });

  it("reports a refused deletion and audits nothing", async () => {
    const { t, accountA } = await setup();
    const data = await refusal(
      as(t).action(api.v1.whatsapp.deleteTemplate, {
        accountId: accountA,
        templateId: "800000000000999",
        name: "missing",
        language: "en",
      }),
    );
    expect(data).toMatchObject({ code: "CONFLICT", details: { reason: "meta_100" } });
    expect(await audits(t)).toEqual([]);
  });
});
