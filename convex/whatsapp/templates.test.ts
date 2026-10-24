import { describe, expect, it } from "vitest";
import {
  checkValues,
  MAX_BODY_CHARS,
  parseTemplate,
  type ParsedTemplate,
  type TemplateValue,
} from "./templates";

// Template reading and value checks (pure). Shapes follow Meta's documented template objects
// (GET /{waba}/message_templates) and send payload ("Send messages"); they are not recordings.

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "990000000000001",
    name: "order_update",
    language: "en_US",
    status: "APPROVED",
    category: "UTILITY",
    parameter_format: "POSITIONAL",
    components: [
      { type: "HEADER", format: "TEXT", text: "Order {{1}}", example: { header_text: ["A-1"] } },
      {
        type: "BODY",
        text: "Hi {{1}}, your order {{2}} ships {{3}}.",
        example: { body_text: [["Ana", "A-1", "today"]] },
      },
      { type: "FOOTER", text: "Thanks for shopping" },
      {
        type: "BUTTONS",
        buttons: [
          { type: "QUICK_REPLY", text: "Stop updates" },
          { type: "URL", text: "Track", url: "https://example.com/track/{{1}}" },
          { type: "PHONE_NUMBER", text: "Call us", phone_number: "+15550009999" },
        ],
      },
    ],
    ...overrides,
  };
}

function parsed(overrides: Record<string, unknown> = {}): ParsedTemplate {
  const template = parseTemplate(raw(overrides));
  if (template === null) throw new Error("expected a template");
  return template;
}

const body = (text: string, extra: Record<string, unknown> = {}) => ({
  components: [{ type: "BODY", text, ...extra }],
});

describe("parseTemplate", () => {
  it("reads a positional template: parts, buttons and variables in send order, with examples", () => {
    expect(parsed()).toEqual({
      name: "order_update",
      language: "en_US",
      status: "APPROVED",
      category: "UTILITY",
      parameterFormat: "POSITIONAL",
      header: "Order {{1}}",
      body: "Hi {{1}}, your order {{2}} ships {{3}}.",
      footer: "Thanks for shopping",
      buttons: [
        { type: "QUICK_REPLY", text: "Stop updates" },
        { type: "URL", text: "Track" },
        { type: "PHONE_NUMBER", text: "Call us" },
      ],
      variables: [
        { component: "header", name: "1", example: "A-1" },
        { component: "body", name: "1", example: "Ana" },
        { component: "body", name: "2", example: "A-1" },
        { component: "body", name: "3", example: "today" },
        { component: "button", name: "1" },
      ],
      urlButtons: [1],
    });
  });

  it("reads a NAMED template with its example values", () => {
    const template = parsed({
      parameter_format: "NAMED",
      ...body("Hi {{first_name}}, order {{order_id}} is ready. {{first_name}}, thanks!", {
        example: {
          body_text_named_params: [
            { param_name: "first_name", example: "Ana" },
            { param_name: "order_id", example: "A-1" },
          ],
        },
      }),
    });
    expect(template.unsupported).toBeUndefined();
    expect(template.variables).toEqual([
      { component: "body", name: "first_name", example: "Ana" },
      { component: "body", name: "order_id", example: "A-1" },
    ]);
  });

  it("lists positional variables in number order, whatever order the text uses", () => {
    expect(parsed(body("{{2}} before {{1}}, then {{2}} again")).variables).toEqual([
      { component: "body", name: "1" },
      { component: "body", name: "2" },
    ]);
  });

  it("reads a template without variables", () => {
    const template = parsed(body("Your appointment is confirmed."));
    expect(template.variables).toEqual([]);
    expect(template.unsupported).toBeUndefined();
  });

  it.each([
    ["an image header", [{ type: "HEADER", format: "IMAGE" }], "media_header"],
    ["a document header", [{ type: "HEADER", format: "DOCUMENT" }], "media_header"],
    ["a location header", [{ type: "HEADER", format: "LOCATION" }], "location_header"],
    ["a carousel", [{ type: "CAROUSEL", cards: [] }], "unsupported_component"],
    ["a limited-time offer", [{ type: "LIMITED_TIME_OFFER" }], "unsupported_component"],
    [
      "a copy-code button",
      [{ type: "BUTTONS", buttons: [{ type: "COPY_CODE", text: "Copy" }] }],
      "unsupported_button",
    ],
    [
      "an OTP button",
      [{ type: "BUTTONS", buttons: [{ type: "OTP", text: "Copy code" }] }],
      "unsupported_button",
    ],
    [
      "a URL with two placeholders",
      [
        {
          type: "BUTTONS",
          buttons: [{ type: "URL", text: "Go", url: "https://x.test/{{1}}/{{2}}" }],
        },
      ],
      "unsupported_placeholder",
    ],
  ])("marks %s as not supported", (_label, extra, reason) => {
    const template = parsed({ components: [{ type: "BODY", text: "Hello" }, ...extra] });
    expect(template.unsupported).toBe(reason);
  });

  it("marks authentication templates as not supported", () => {
    expect(parsed({ category: "AUTHENTICATION", ...body("Code {{1}}") }).unsupported).toBe(
      "authentication",
    );
  });

  it.each([
    ["a gap in the numbering", "Hi {{1}}, order {{3}}", "POSITIONAL"],
    ["numbering that does not start at 1", "Order {{2}}", "POSITIONAL"],
    ["a named placeholder in a positional template", "Hi {{name}}", "POSITIONAL"],
    ["an uppercase named placeholder", "Hi {{Name}}", "NAMED"],
    ["a number in a NAMED template's braces with spaces", "Hi {{ 1 }}", "NAMED"],
  ])("marks a body with %s as not supported", (_label, text, format) => {
    expect(parsed({ parameter_format: format, ...body(text) }).unsupported).toBe(
      "unsupported_placeholder",
    );
  });

  it.each([
    ["no name", { name: undefined }],
    ["no language", { language: undefined }],
    ["no status", { status: undefined }],
    ["components that are not a list", { components: "BODY" }],
    ["no body", { components: [{ type: "FOOTER", text: "x" }] }],
    ["a body without text", { components: [{ type: "BODY" }] }],
    ["a component that is not an object", { components: [{ type: "BODY", text: "x" }, 7] }],
  ])("does not read a template with %s", (_label, overrides) => {
    expect(parseTemplate(raw(overrides))).toBeNull();
  });
});

describe("checkValues", () => {
  const values = (list: [TemplateValue["component"], string, string][]): TemplateValue[] =>
    list.map(([component, name, value]) => ({ component, name, value }));
  const allValues = values([
    ["button", "1", "A-1042"],
    ["body", "3", "tomorrow"],
    ["body", "1", "Ana"],
    ["header", "1", "A-1042"],
    ["body", "2", "A-1042"],
  ]);

  it("builds the components in placeholder order and the text the customer reads", () => {
    expect(checkValues(parsed(), allValues)).toEqual({
      ok: true,
      components: [
        { type: "header", parameters: [{ type: "text", text: "A-1042" }] },
        {
          type: "body",
          parameters: [
            { type: "text", text: "Ana" },
            { type: "text", text: "A-1042" },
            { type: "text", text: "tomorrow" },
          ],
        },
        {
          type: "button",
          sub_type: "url",
          index: "1",
          parameters: [{ type: "text", text: "A-1042" }],
        },
      ],
      text: "Order A-1042\n\nHi Ana, your order A-1042 ships tomorrow.\n\nThanks for shopping",
    });
  });

  it("sends NAMED values with their parameter names", () => {
    const template = parsed({
      parameter_format: "NAMED",
      ...body("Hi {{first_name}}, order {{order_id}}."),
    });
    const result = checkValues(
      template,
      values([
        ["body", "order_id", "A-1"],
        ["body", "first_name", "Ana"],
      ]),
    );
    expect(result).toEqual({
      ok: true,
      components: [
        {
          type: "body",
          parameters: [
            { type: "text", parameter_name: "first_name", text: "Ana" },
            { type: "text", parameter_name: "order_id", text: "A-1" },
          ],
        },
      ],
      text: "Hi Ana, order A-1.",
    });
  });

  it("sends nothing for a template without variables, and accepts no values for it", () => {
    const template = parsed(body("Confirmed."));
    expect(checkValues(template, [])).toEqual({ ok: true, components: [], text: "Confirmed." });
    expect(checkValues(template, values([["body", "1", "x"]]))).toMatchObject({
      ok: false,
      reason: "unexpected_value",
    });
  });

  it.each([
    ["a missing value", allValues.slice(1), "missing_value", "button.1"],
    [
      "a value for no placeholder",
      [...allValues, ...values([["body", "4", "x"]])],
      "unexpected_value",
      "body.4",
    ],
    [
      "a value for a button without a variable",
      [...allValues, ...values([["button", "0", "x"]])],
      "unexpected_value",
      "button.0",
    ],
    ["the same value twice", [...allValues, allValues[0]!], "unexpected_value", "button.1"],
    [
      "a blank value",
      values([
        ["header", "1", "A"],
        ["body", "1", "  "],
        ["body", "2", "A"],
        ["body", "3", "A"],
        ["button", "1", "A"],
      ]),
      "blank_value",
      "body.1",
    ],
    [
      "a body value that is too long",
      values([
        ["header", "1", "A"],
        ["body", "1", "x".repeat(MAX_BODY_CHARS + 1)],
        ["body", "2", "A"],
        ["body", "3", "A"],
        ["button", "1", "A"],
      ]),
      "too_long",
      "body.1",
    ],
    [
      "a URL value that is too long",
      values([
        ["header", "1", "A"],
        ["body", "1", "A"],
        ["body", "2", "A"],
        ["body", "3", "A"],
        ["button", "1", "x".repeat(2001)],
      ]),
      "too_long",
      "button.1",
    ],
    [
      "a header that is too long once filled in",
      values([
        ["header", "1", "x".repeat(60)],
        ["body", "1", "A"],
        ["body", "2", "A"],
        ["body", "3", "A"],
        ["button", "1", "A"],
      ]),
      "header_too_long",
      "header",
    ],
    [
      "a body that is too long once filled in",
      values([
        ["header", "1", "A"],
        ["body", "1", "x".repeat(500)],
        ["body", "2", "x".repeat(500)],
        ["body", "3", "x".repeat(10)],
        ["button", "1", "A"],
      ]),
      "body_too_long",
      "body",
    ],
  ])("refuses %s", (_label, given, reason, field) => {
    expect(checkValues(parsed(), given)).toEqual({ ok: false, reason, field });
  });
});
