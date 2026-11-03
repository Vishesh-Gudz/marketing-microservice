import { describe, expect, it } from "vitest";
import {
  addButton,
  builderFromStarter,
  builderIssues,
  emptyBuilder,
  newButton,
  normalizeTemplateName,
  sampleKeys,
  toDraft,
  variablesIn,
  withSamples,
} from "./template-builder";
import {
  CATEGORY_LABELS,
  matchesFilter,
  rejectionText,
  templateErrorNotice,
  templateStatus,
} from "./template-messages";
import { languageLabel, TEMPLATE_LANGUAGES } from "./template-languages";
import { TEMPLATE_STARTERS } from "./template-starters";
import { apiError } from "@/convex/lib/errors";

// ADR 0020: the template builder's in-browser helpers and texts. The server checks every rule
// again (convex/whatsapp/templateDrafts.test.ts).

describe("template builder", () => {
  it("normalizes names to what Meta accepts", () => {
    expect(normalizeTemplateName("Order Update - Nov!")).toBe("order_update_nov");
    expect(normalizeTemplateName("x".repeat(600))).toHaveLength(512);
  });

  it("finds variables and fills them with samples for the preview", () => {
    expect(variablesIn("Hi {{name}}, order {{id}} for {{name}}")).toEqual(["name", "id"]);
    const state = { ...emptyBuilder(), header: "Order {{id}}", body: "Hi {{name}}, order {{id}}" };
    expect(sampleKeys(state)).toEqual(["header.id", "body.name", "body.id"]);
    expect(withSamples(state.body, "body", { "body.name": "Priya" })).toBe(
      "Hi Priya, order {{id}}",
    );
  });

  it("keeps quick replies before the other buttons", () => {
    let buttons = addButton([], newButton("URL"));
    buttons = addButton(buttons, newButton("QUICK_REPLY"));
    buttons = addButton(buttons, newButton("PHONE_NUMBER"));
    buttons = addButton(buttons, newButton("QUICK_REPLY"));
    expect(buttons.map((b) => b.type)).toEqual([
      "QUICK_REPLY",
      "QUICK_REPLY",
      "URL",
      "PHONE_NUMBER",
    ]);
  });

  it("says what is missing before submitting", () => {
    expect(builderIssues(emptyBuilder()).map((i) => i.message)).toEqual([
      "Give the template a name.",
      "Write the message body.",
    ]);
    const state = {
      ...emptyBuilder(),
      name: "x",
      body: "Hi {{name}}",
      footer: "{{y}}",
      buttons: [newButton("QUICK_REPLY"), newButton("URL")],
    };
    expect(builderIssues(state).map((i) => i.field)).toEqual([
      "footer",
      "samples.body.name",
      "buttons.0",
      "buttons.1",
      "buttons.1",
    ]);
  });

  it("turns a starter into the createTemplate draft with only the samples it uses", () => {
    const starter = TEMPLATE_STARTERS.find((s) => s.id === "order_shipped")!;
    const draft = toDraft(builderFromStarter(starter, "en_IN"));
    expect(draft).toMatchObject({
      name: "order_shipped",
      language: "en_IN",
      category: "UTILITY",
      header: "Your order is on its way",
    });
    expect(draft.examples.map((e) => `${e.component}.${e.name}`)).toEqual([
      "body.customer_name",
      "body.order_number",
      "body.carrier",
      "body.delivery_date",
    ]);
    expect(draft.buttons).toEqual([
      {
        type: "URL",
        text: "Track order",
        url: "https://your-website.com/track/{{1}}",
        example: "AWB123456789",
      },
    ]);
    expect(draft).not.toHaveProperty("footer");
  });
});

describe("template texts", () => {
  it("labels statuses, categories, languages and rejections in words", () => {
    expect(templateStatus("PENDING")).toEqual({ label: "In review", tone: "secondary" });
    expect(templateStatus("SOMETHING_NEW").label).toBe("something new");
    expect(CATEGORY_LABELS.MARKETING).toBe("Marketing");
    expect(languageLabel("en_US")).toBe("English (US)");
    expect(languageLabel("xx")).toBe("xx");
    expect(new Set(TEMPLATE_LANGUAGES.map((l) => l.code)).size).toBe(TEMPLATE_LANGUAGES.length);
    expect(rejectionText("INVALID_FORMAT")).toContain("formatting");
    expect(rejectionText(undefined)).toBeNull();
    expect(matchesFilter("IN_APPEAL", "review")).toBe(true);
    expect(matchesFilter("PAUSED", "other")).toBe(true);
  });

  it("explains refusals in fixed words, never the server's", () => {
    const notice = (reason: string, code = "INVALID_ARGUMENT" as const) =>
      templateErrorNotice(apiError(code, "server detail never shown", { reason }), "create");
    expect(notice("variables_not_sequential").message).toContain("{{1}}, {{2}}");
    expect(notice("meta_100_2388024", "CONFLICT" as never).message).toContain("already exists");
    const unknown = templateErrorNotice(
      apiError("CONFLICT", "server detail never shown", { reason: "meta_100_999" }),
      "create",
    );
    expect(unknown.message).toContain("code 100 999");
    expect(unknown.message).not.toContain("server detail");
    expect(templateErrorNotice(new Error("x"), "list").title).toBe("Templates could not be loaded");
  });
});
