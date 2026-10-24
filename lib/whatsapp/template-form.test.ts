import { describe, expect, it } from "vitest";
import {
  missingVariables,
  templatePreview,
  templateValues,
  unsupportedTemplateText,
  UNSUPPORTED_TEMPLATE_TEXTS,
  variableKey,
  variableLabel,
} from "./template-form";
import type { WhatsAppTemplate } from "./types";

const ORDER: WhatsAppTemplate = {
  name: "order_update",
  language: "en_US",
  category: "UTILITY",
  parameterFormat: "POSITIONAL",
  header: "Order {{1}}",
  body: "Hi {{1}}, your order {{2}} has shipped.",
  footer: "Thanks",
  buttons: [
    { type: "QUICK_REPLY", text: "Stop" },
    { type: "URL", text: "Track" },
  ],
  variables: [
    { component: "header", name: "1" },
    { component: "body", name: "1", example: "Ana" },
    { component: "body", name: "2" },
    { component: "button", name: "1" },
  ],
  supported: true,
};

describe("template form", () => {
  it("labels each field by its placeholder and place, or by its button", () => {
    expect(ORDER.variables.map((v) => [variableKey(v), variableLabel(v, ORDER)])).toEqual([
      ["header.1", "{{1}} in the header"],
      ["body.1", "{{1}} in the body"],
      ["body.2", "{{2}} in the body"],
      ["button.1", "End of the link of the “Track” button"],
    ]);
  });

  it("previews the text as it fills in, leaving unfilled placeholders visible", () => {
    expect(templatePreview(ORDER, {})).toBe(
      "Order {{1}}\n\nHi {{1}}, your order {{2}} has shipped.\n\nThanks",
    );
    expect(templatePreview(ORDER, { "header.1": "A-1", "body.1": "Ana", "body.2": "  " })).toBe(
      "Order A-1\n\nHi Ana, your order {{2}} has shipped.\n\nThanks",
    );
    expect(templatePreview({ body: "Hello {{first_name}}" }, { "body.first_name": "Ana" })).toBe(
      "Hello Ana",
    );
  });

  it("knows which values are still missing (blank counts) and sends them in template order", () => {
    const values = { "button.1": "A-1", "body.2": "A-1", "body.1": " ", "header.1": "A-1" };
    expect(missingVariables(ORDER, values).map(variableKey)).toEqual(["body.1"]);
    expect(templateValues(ORDER, { ...values, "body.1": "Ana" })).toEqual([
      { component: "header", name: "1", value: "A-1" },
      { component: "body", name: "1", value: "Ana" },
      { component: "body", name: "2", value: "A-1" },
      { component: "button", name: "1", value: "A-1" },
    ]);
  });

  it("explains every reason a template cannot be chosen", () => {
    for (const reason of [
      "media_header",
      "location_header",
      "unsupported_component",
      "authentication",
      "unsupported_button",
      "unsupported_placeholder",
    ]) {
      expect(UNSUPPORTED_TEMPLATE_TEXTS[reason]).toBeDefined();
    }
    expect(unsupportedTemplateText("media_header")).toBe("Has a photo, video or document header");
    expect(unsupportedTemplateText("something_new")).toBe("Not supported yet");
    expect(unsupportedTemplateText(undefined)).toBe("Not supported yet");
  });
});
