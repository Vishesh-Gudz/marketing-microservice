import { describe, expect, it } from "vitest";
import { buildTemplateRequest, type TemplateDraft } from "./templateDrafts";
import { parseTemplate } from "./templates";

// ADR 0020: a template draft checked against Meta's documented creation rules and turned into
// the POST /{waba}/message_templates request. Pure; nothing reaches Meta.

function draft(overrides: Partial<TemplateDraft> = {}): TemplateDraft {
  return {
    name: "order_update",
    language: "en_US",
    category: "UTILITY",
    body: "Hi {{customer_name}}, your order {{order_number}} has shipped.",
    buttons: [],
    examples: [
      { component: "body", name: "customer_name", value: "Priya" },
      { component: "body", name: "order_number", value: "#10234" },
    ],
    ...overrides,
  };
}

function refusal(overrides: Partial<TemplateDraft>) {
  const result = buildTemplateRequest(draft(overrides));
  if (result.ok) throw new Error("expected a refusal");
  return { reason: result.reason, field: result.field };
}

describe("buildTemplateRequest", () => {
  it("builds a named template with header, body, footer and every button type", () => {
    const result = buildTemplateRequest(
      draft({
        header: "Order {{order_number}}",
        footer: "Thank you for shopping with us",
        buttons: [
          { type: "QUICK_REPLY", text: "Stop updates" },
          {
            type: "URL",
            text: "Track order",
            url: "https://shop.example.in/track/{{1}}",
            example: "AWB123",
          },
          { type: "PHONE_NUMBER", text: "Call us", phoneNumber: "+91 98765 43210" },
        ],
        examples: [
          { component: "header", name: "order_number", value: "#10234" },
          { component: "body", name: "customer_name", value: "Priya" },
          { component: "body", name: "order_number", value: "#10234" },
        ],
      }),
    );
    expect(result).toEqual({
      ok: true,
      parameterFormat: "NAMED",
      request: {
        name: "order_update",
        language: "en_US",
        category: "UTILITY",
        parameter_format: "named",
        components: [
          {
            type: "HEADER",
            format: "TEXT",
            text: "Order {{order_number}}",
            example: {
              header_text_named_params: [{ param_name: "order_number", example: "#10234" }],
            },
          },
          {
            type: "BODY",
            text: "Hi {{customer_name}}, your order {{order_number}} has shipped.",
            example: {
              body_text_named_params: [
                { param_name: "customer_name", example: "Priya" },
                { param_name: "order_number", example: "#10234" },
              ],
            },
          },
          { type: "FOOTER", text: "Thank you for shopping with us" },
          {
            type: "BUTTONS",
            buttons: [
              { type: "QUICK_REPLY", text: "Stop updates" },
              {
                type: "URL",
                text: "Track order",
                url: "https://shop.example.in/track/{{1}}",
                example: ["AWB123"],
              },
              { type: "PHONE_NUMBER", text: "Call us", phone_number: "+919876543210" },
            ],
          },
        ],
      },
    });
  });

  it("builds a positional template the way Meta documents it (no parameter_format)", () => {
    const result = buildTemplateRequest(
      draft({
        header: "Order {{1}}",
        body: "Thanks, {{1}}! Your order ships on {{2}}.",
        examples: [
          { component: "header", name: "1", value: "A1234" },
          { component: "body", name: "1", value: "Pablo" },
          { component: "body", name: "2", value: "December 1st" },
        ],
      }),
    );
    expect(result.ok && result.request).toEqual({
      name: "order_update",
      language: "en_US",
      category: "UTILITY",
      components: [
        {
          type: "HEADER",
          format: "TEXT",
          text: "Order {{1}}",
          example: { header_text: ["A1234"] },
        },
        {
          type: "BODY",
          text: "Thanks, {{1}}! Your order ships on {{2}}.",
          example: { body_text: [["Pablo", "December 1st"]] },
        },
      ],
    });
  });

  it("builds a template without variables, and trims its texts", () => {
    const result = buildTemplateRequest(
      draft({ name: " welcome ", body: "  Welcome!  ", footer: "   ", examples: [] }),
    );
    expect(result.ok && result.request).toEqual({
      name: "welcome",
      language: "en_US",
      category: "UTILITY",
      components: [{ type: "BODY", text: "Welcome!" }],
    });
  });

  it("builds what the send path can read back as a sendable template", () => {
    const result = buildTemplateRequest(
      draft({
        header: "Order {{order_number}}",
        buttons: [
          { type: "URL", text: "View", url: "https://shop.example.in/o/{{1}}", example: "7" },
        ],
        examples: [
          { component: "header", name: "order_number", value: "#1" },
          { component: "body", name: "customer_name", value: "Priya" },
          { component: "body", name: "order_number", value: "#1" },
        ],
      }),
    );
    if (!result.ok) throw new Error(result.reason);
    const parsed = parseTemplate({
      ...result.request,
      status: "APPROVED",
      parameter_format: "NAMED",
    });
    expect(parsed?.unsupported).toBeUndefined();
    expect(parsed?.variables.map((v) => `${v.component}.${v.name}`)).toEqual([
      "header.order_number",
      "body.customer_name",
      "body.order_number",
      "button.0",
    ]);
  });

  it.each<[string, Partial<TemplateDraft>, string, string]>([
    ["an uppercase name", { name: "Order_Update" }, "invalid_name", "name"],
    ["a name with spaces", { name: "order update" }, "invalid_name", "name"],
    ["an empty name", { name: "" }, "invalid_name", "name"],
    ["a name over 512 characters", { name: "a".repeat(513) }, "invalid_name", "name"],
    ["a bad language", { language: "English" }, "invalid_language", "language"],
    ["another category", { category: "AUTHENTICATION" as never }, "invalid_category", "category"],
    ["a header over 60 characters", { header: "h".repeat(61) }, "header_too_long", "header"],
    ["a header on two lines", { header: "a\nb" }, "header_multiline", "header"],
    ["an empty body", { body: "  ", examples: [] }, "body_missing", "body"],
    [
      "a body over 1024 characters",
      { body: "b".repeat(1025), examples: [] },
      "body_too_long",
      "body",
    ],
    ["a footer over 60 characters", { footer: "f".repeat(61) }, "footer_too_long", "footer"],
    ["a footer variable", { footer: "Hi {{x}}" }, "footer_variable", "footer"],
  ])("refuses %s", (_label, overrides, reason, field) => {
    expect(refusal(overrides)).toEqual({ reason, field });
  });

  it("refuses broken or mixed variables", () => {
    expect(refusal({ body: "Hi {{Customer}}, thanks.", examples: [] })).toEqual({
      reason: "invalid_variable",
      field: "body",
    });
    expect(refusal({ body: "Hi {{1}} and {{name}}.", examples: [] })).toEqual({
      reason: "mixed_variables",
      field: "body",
    });
    expect(
      refusal({
        header: "{{a}} and {{b}}",
        examples: [],
      }),
    ).toEqual({ reason: "header_too_many_variables", field: "header" });
    expect(
      refusal({
        body: "Hi {{2}}, order {{1}}.",
        examples: [
          { component: "body", name: "1", value: "x" },
          { component: "body", name: "2", value: "y" },
        ],
      }),
    ).toEqual({ reason: "variables_not_sequential", field: "body" });
    expect(refusal({ body: "Hi {{1}}, order {{3}}.", examples: [] })).toEqual({
      reason: "variables_not_sequential",
      field: "body",
    });
  });

  it("requires exactly one usable sample per variable", () => {
    expect(
      refusal({ examples: [{ component: "body", name: "customer_name", value: "P" }] }),
    ).toEqual({
      reason: "missing_example",
      field: "examples.body.order_number",
    });
    expect(
      refusal({
        examples: [
          { component: "body", name: "customer_name", value: "  " },
          { component: "body", name: "order_number", value: "1" },
        ],
      }),
    ).toEqual({ reason: "missing_example", field: "examples.body.customer_name" });
    expect(
      refusal({
        examples: [...draft().examples, { component: "header", name: "customer_name", value: "P" }],
      }),
    ).toEqual({ reason: "unexpected_example", field: "examples.header.customer_name" });
    expect(
      refusal({
        examples: [
          { component: "body", name: "customer_name", value: "x".repeat(201) },
          { component: "body", name: "order_number", value: "1" },
        ],
      }),
    ).toEqual({ reason: "example_too_long", field: "examples.body.customer_name" });
  });

  it("enforces Meta's button rules", () => {
    const reply = (text = "Yes") => ({ type: "QUICK_REPLY" as const, text });
    const link = (url = "https://shop.example.in", example?: string) => ({
      type: "URL" as const,
      text: "Open",
      url,
      ...(example !== undefined ? { example } : {}),
    });
    expect(refusal({ buttons: Array.from({ length: 11 }, () => reply()) }).reason).toBe(
      "too_many_buttons",
    );
    expect(refusal({ buttons: [link(), link(), link()] }).reason).toBe("too_many_buttons");
    expect(
      refusal({
        buttons: [
          { type: "PHONE_NUMBER", text: "a", phoneNumber: "+15550001111" },
          { type: "PHONE_NUMBER", text: "b", phoneNumber: "+15550001112" },
        ],
      }).reason,
    ).toBe("too_many_buttons");
    expect(refusal({ buttons: [link(), reply()] })).toEqual({
      reason: "buttons_not_grouped",
      field: "buttons",
    });
    expect(refusal({ buttons: [reply("")] })).toEqual({
      reason: "button_text",
      field: "buttons.0",
    });
    expect(refusal({ buttons: [reply("x".repeat(26))] }).reason).toBe("button_text");
    for (const url of [
      "shop.example.in",
      "ftp://shop.example.in",
      "https://localhost",
      "https://shop.example.in/{{1}}/x",
      "https://shop.example.in/{{2}}",
      "https://shop.example.in/a b",
    ]) {
      expect(refusal({ buttons: [link(url, "7")] }).reason, url).toBe("invalid_url");
    }
    expect(refusal({ buttons: [link("https://shop.example.in/o/{{1}}")] })).toEqual({
      reason: "missing_example",
      field: "buttons.0",
    });
    expect(refusal({ buttons: [link("https://shop.example.in/o/{{1}}", "a b")] }).reason).toBe(
      "invalid_url",
    );
    for (const phoneNumber of ["9876543210", "+0123456789", "+1 555", "+1234567890123456789012"]) {
      expect(
        refusal({ buttons: [{ type: "PHONE_NUMBER", text: "Call", phoneNumber }] }).reason,
        phoneNumber,
      ).toBe("invalid_phone");
    }
  });
});
