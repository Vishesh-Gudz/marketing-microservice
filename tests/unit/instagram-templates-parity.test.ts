// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  INSTAGRAM_TEMPLATE_REFUSALS,
  MAX_BUTTON_TITLE_CHARS,
  MAX_BUTTONS_TEXT_CHARS,
  MAX_CARD_SUBTITLE_CHARS,
  MAX_CARD_TITLE_CHARS,
  MAX_INSTAGRAM_TEMPLATES,
  MAX_TEMPLATE_BUTTONS,
  MAX_TEMPLATE_CARDS,
  MAX_TEMPLATE_NAME_CHARS,
  MAX_TEMPLATE_URL_CHARS,
  fillTemplate,
  type TemplateContent,
} from "@/convex/instagram/messaging/templates";
import { fillCustomerName } from "@/convex/messaging/savedReplies";
import {
  builderIssues,
  fillTemplateContent,
  TEMPLATE_ERRORS,
  TEMPLATE_LIMITS,
  toTemplateInput,
} from "@/lib/instagram/templates";
import { fillSavedReply } from "@/lib/messaging/saved-replies";

// ADR 0022: the dashboard may not import server modules (D23), so its copies of the Instagram
// template rules are pinned to the server's here.

describe("Instagram templates: dashboard ↔ server parity", () => {
  it("counts with the server's limits", () => {
    expect(TEMPLATE_LIMITS).toEqual({
      templates: MAX_INSTAGRAM_TEMPLATES,
      name: MAX_TEMPLATE_NAME_CHARS,
      text: MAX_BUTTONS_TEXT_CHARS,
      buttons: MAX_TEMPLATE_BUTTONS,
      buttonTitle: MAX_BUTTON_TITLE_CHARS,
      cards: MAX_TEMPLATE_CARDS,
      cardTitle: MAX_CARD_TITLE_CHARS,
      cardSubtitle: MAX_CARD_SUBTITLE_CHARS,
      url: MAX_TEMPLATE_URL_CHARS,
    });
  });

  it("has a text for exactly the server's refusals", () => {
    expect(Object.keys(TEMPLATE_ERRORS).sort()).toEqual(
      [...INSTAGRAM_TEMPLATE_REFUSALS, "name_in_use", "limit_reached"].sort(),
    );
  });

  it("fills {{customer_name}} exactly as the server does", () => {
    const content: TemplateContent = {
      kind: "cards",
      cards: [
        {
          title: "For you, {{customer_name}}",
          subtitle: "{{customer_name}}",
          buttons: [{ type: "reply", title: "Yes" }],
        },
      ],
    };
    for (const name of ["Ana Souza", undefined, "  ", "Bo"]) {
      for (const text of [
        "Hi {{customer_name}}, thanks!",
        "Thank you, {{customer_name}}!",
        "{{customer_name}}",
        "No name here.",
      ]) {
        expect(fillSavedReply(text, name)).toBe(fillCustomerName(text, name));
      }
      expect(fillTemplateContent(content, name)).toEqual(fillTemplate(content, name));
    }
  });
});

describe("builderIssues", () => {
  it("asks for a name, the message and a button label", () => {
    expect(
      builderIssues("", { kind: "buttons", text: "", buttons: [{ type: "reply", title: "" }] }).map(
        (i) => i.message,
      ),
    ).toEqual([
      "Give the template a name.",
      "Write the message.",
      "Every button needs a label of up to 20 characters.",
    ]);
  });

  it("asks for https links of the business's own, and something besides a card's title", () => {
    expect(
      builderIssues("Picks", {
        kind: "cards",
        cards: [
          { title: "Shirt", imageUrl: "http://cdn.example.com/a.jpg", buttons: [] },
          {
            title: "Gift",
            buttons: [{ type: "url", title: "Go", url: "https://your-website.com/x" }],
          },
          { title: "Socks", subtitle: "", buttons: [] },
        ],
      }).map((i) => i.message),
    ).toEqual([
      "Card 1's picture must start with https://.",
      "Replace the example link with your own website.",
      "Card 3 needs a text, a picture, a link or a button.",
    ]);
  });

  it("finds nothing to do in a finished template, and trims it for the API", () => {
    const content: TemplateContent = {
      kind: "cards",
      cards: [
        { title: " Shirt ", subtitle: " ", linkUrl: " https://shop.example.com ", buttons: [] },
      ],
    };
    expect(builderIssues("Picks", content)).toEqual([]);
    expect(toTemplateInput(content)).toEqual({
      kind: "cards",
      cards: [{ title: "Shirt", linkUrl: "https://shop.example.com", buttons: [] }],
    });
  });
});
