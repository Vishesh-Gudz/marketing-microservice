import { describe, expect, it } from "vitest";
import { builderFromStarter, builderIssues, toDraft } from "../../lib/whatsapp/template-builder";
import { PLACEHOLDER_WEBSITE, TEMPLATE_STARTERS } from "../../lib/whatsapp/template-starters";
import { buildTemplateRequest } from "./templateDrafts";
import { parseTemplate } from "./templates";

// ADR 0020: every ready-made template of the dashboard's gallery (lib/whatsapp/template-starters)
// passes the server's checks once the business entered its own link and phone number, and is a
// template this app can send. Also Meta's writing guidelines that the server does not enforce.

const VARIABLE = /\{\{[^{}]*\}\}/;

function ready(starterId: string) {
  const starter = TEMPLATE_STARTERS.find((s) => s.id === starterId)!;
  const state = builderFromStarter(starter);
  return {
    ...state,
    buttons: state.buttons.map((button) =>
      button.type === "URL"
        ? { ...button, url: button.url.replace(PLACEHOLDER_WEBSITE, "https://shop.example.in") }
        : button.type === "PHONE_NUMBER"
          ? { ...button, phoneNumber: "+91 98765 43210" }
          : button,
    ),
  };
}

describe("template starters", () => {
  it("have unique ids and template names", () => {
    expect(new Set(TEMPLATE_STARTERS.map((s) => s.id)).size).toBe(TEMPLATE_STARTERS.length);
    expect(new Set(TEMPLATE_STARTERS.map((s) => s.name)).size).toBe(TEMPLATE_STARTERS.length);
    expect(TEMPLATE_STARTERS.length).toBeGreaterThanOrEqual(20);
  });

  it.each(TEMPLATE_STARTERS.map((s) => [s.id]))(
    "%s builds a valid, sendable template once the business's own link and phone are in",
    (id) => {
      const state = ready(id);
      expect(builderIssues(state)).toEqual([]);
      const built = buildTemplateRequest(toDraft(state));
      if (!built.ok) throw new Error(`${built.reason} at ${built.field}`);
      const parsed = parseTemplate({
        ...built.request,
        status: "APPROVED",
        parameter_format: built.parameterFormat,
      });
      expect(parsed?.unsupported).toBeUndefined();
    },
  );

  it.each(TEMPLATE_STARTERS.map((s) => [s.id, s]))(
    "%s follows Meta's writing guidelines",
    (_id, starter) => {
      const body = starter.body.trim();
      // No variable at the very start or end, never two side by side.
      expect(body.startsWith("{{")).toBe(false);
      expect(body.replace(/[.!?]+$/, "").endsWith("}}")).toBe(false);
      expect(/\}\}\s*\{\{/.test(body)).toBe(false);
      // A sample for every variable, and only for them.
      const names = [...`${starter.header ?? ""} ${body}`.matchAll(/\{\{([^{}]*)\}\}/g)].map(
        (m) => m[1]!,
      );
      expect(Object.keys(starter.samples).sort()).toEqual([...new Set(names)].sort());
      // Marketing offers a way out; utility promotes nothing.
      const stop = starter.buttons.some(
        (b) => b.type === "QUICK_REPLY" && b.text === "Stop promotions",
      );
      expect(stop).toBe(starter.category === "MARKETING");
      if (starter.category === "UTILITY") {
        expect(body).not.toMatch(/\b(offer|discount|sale|promo|% off)\b/i);
      }
      expect(VARIABLE.test(starter.footer ?? "")).toBe(false);
    },
  );

  it("asks for the business's own link and phone number before submitting", () => {
    const withLink = builderFromStarter(
      TEMPLATE_STARTERS.find((s) => s.id === "order_confirmation")!,
    );
    expect(builderIssues(withLink).map((i) => i.message)).toEqual([
      "Replace the example link with your own website.",
    ]);
    const withPhone = builderFromStarter(
      TEMPLATE_STARTERS.find((s) => s.id === "appointment_confirmed")!,
    );
    expect(builderIssues(withPhone).map((i) => i.message)).toEqual([
      "Enter the phone number with + and the country code.",
    ]);
  });
});
