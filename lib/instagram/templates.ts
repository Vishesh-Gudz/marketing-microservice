import type { FunctionReturnType } from "convex/server";
import { isMarketingError } from "@/convex/lib/errors";
import type { api } from "@/convex/_generated/api";
import type { Notice } from "@/lib/connections/types";
import { fillSavedReply } from "@/lib/messaging/saved-replies";
import { sendErrorNotice } from "./messages";

/**
 * Instagram templates in the dashboard (ADR 0022): types from the public v1 API, the limits the
 * builder counts with (the server checks every rule again, convex/instagram/messaging/
 * templates.ts; parity-tested), the builder's own checks before saving, filling in
 * `{{customer_name}}` for a preview, and fixed texts.
 */

export type InstagramTemplate = FunctionReturnType<typeof api.v1.instagramTemplates.list>[number];
export type TemplateContent = InstagramTemplate["content"];
export type TemplateKind = TemplateContent["kind"];
export type TemplateButton = Extract<TemplateContent, { kind: "buttons" }>["buttons"][number];
export type TemplateCard = Extract<TemplateContent, { kind: "cards" }>["cards"][number];

export const TEMPLATE_LIMITS = {
  templates: 100,
  name: 60,
  text: 640,
  buttons: 3,
  buttonTitle: 20,
  cards: 10,
  cardTitle: 80,
  cardSubtitle: 80,
  url: 1000,
} as const;

export const KIND_LABELS: Readonly<Record<TemplateKind, string>> = {
  buttons: "Button message",
  cards: "Cards",
};

export const KIND_HELP: Readonly<Record<TemplateKind, string>> = {
  buttons: "A message of up to 640 characters with 1 to 3 buttons under it.",
  cards:
    "1 to 10 cards the customer swipes through, each with a title, an optional picture, text and up to 3 buttons.",
};

export const BUTTON_TYPE_LABELS: Readonly<Record<TemplateButton["type"], string>> = {
  url: "Open a link",
  reply: "Send a reply",
};

/** The placeholder website in ready-made templates; the builder asks for the business's own. */
export const PLACEHOLDER_WEBSITE = "https://your-website.com";

/** The content for one customer: `{{customer_name}}` filled in (or left out) everywhere. */
export function fillTemplateContent(
  content: TemplateContent,
  contactName: string | undefined,
): TemplateContent {
  const fill = (text: string) => fillSavedReply(text, contactName).trim();
  if (content.kind === "buttons") return { ...content, text: fill(content.text) };
  return {
    kind: "cards",
    cards: content.cards.map(({ subtitle, ...card }) => {
      const filled = subtitle !== undefined ? fill(subtitle) : "";
      return { ...card, title: fill(card.title), ...(filled !== "" ? { subtitle: filled } : {}) };
    }),
  };
}

/** A short line for lists: the button message's text, or the cards' count and first title. */
export function templateSummary(content: TemplateContent): string {
  if (content.kind === "buttons") return content.text;
  const first = content.cards[0]?.title ?? "";
  return content.cards.length === 1 ? first : `${content.cards.length} cards: ${first}, …`;
}

/** The host a link points to, for the preview ("your-website.com"); never loaded. */
export function urlHost(value: string): string | undefined {
  try {
    return new URL(value).hostname || undefined;
  } catch {
    return undefined;
  }
}

/** Whether a value looks like the business's own https address (the server checks again). */
export function looksLikeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname.includes(".");
  } catch {
    return false;
  }
}

export type BuilderIssue = { field: string; message: string };

const BRACKETS = /\[[^\]]+\]/;

function buttonIssues(buttons: TemplateButton[], field: string, min: number): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  if (buttons.length < min) issues.push({ field, message: "Add at least one button." });
  const titles = new Set<string>();
  buttons.forEach((button, i) => {
    const title = button.title.trim();
    const at = `${field}.${i}`;
    if (title === "" || title.length > TEMPLATE_LIMITS.buttonTitle) {
      issues.push({
        field: `${at}.title`,
        message: "Every button needs a label of up to 20 characters.",
      });
    } else if (titles.has(title)) {
      issues.push({ field: `${at}.title`, message: "Every button needs a different label." });
    }
    titles.add(title);
    if (BRACKETS.test(title)) {
      issues.push({
        field: `${at}.title`,
        message: "Replace the text in [brackets] with your own.",
      });
    }
    if (button.type === "url") {
      if (!looksLikeHttpsUrl(button.url)) {
        issues.push({
          field: `${at}.url`,
          message: "Links start with https:// and name your website.",
        });
      } else if (button.url.trim().startsWith(PLACEHOLDER_WEBSITE)) {
        issues.push({
          field: `${at}.url`,
          message: "Replace the example link with your own website.",
        });
      }
    }
  });
  return issues;
}

/**
 * What still needs doing before the template can be saved, in the order shown: the server's
 * rules, plus the business's own links instead of the example one and its own words instead of
 * anything in [brackets].
 */
export function builderIssues(name: string, content: TemplateContent): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  if (name.trim() === "") issues.push({ field: "name", message: "Give the template a name." });
  if (name.trim().length > TEMPLATE_LIMITS.name) {
    issues.push({ field: "name", message: "Names are 60 characters at most." });
  }
  if (content.kind === "buttons") {
    const text = content.text.trim();
    if (text === "") issues.push({ field: "text", message: "Write the message." });
    if (text.length > TEMPLATE_LIMITS.text) {
      issues.push({ field: "text", message: "The message is 640 characters at most." });
    }
    if (BRACKETS.test(text)) {
      issues.push({ field: "text", message: "Replace the text in [brackets] with your own." });
    }
    issues.push(...buttonIssues(content.buttons, "buttons", 1));
    return issues;
  }
  if (content.cards.length === 0) issues.push({ field: "cards", message: "Add a card." });
  content.cards.forEach((card, i) => {
    const at = `cards.${i}`;
    const n = i + 1;
    const title = card.title.trim();
    const subtitle = card.subtitle?.trim() ?? "";
    const image = card.imageUrl?.trim() ?? "";
    const link = card.linkUrl?.trim() ?? "";
    if (title === "" || title.length > TEMPLATE_LIMITS.cardTitle) {
      issues.push({
        field: `${at}.title`,
        message: `Card ${n} needs a title of up to 80 characters.`,
      });
    }
    if (subtitle.length > TEMPLATE_LIMITS.cardSubtitle) {
      issues.push({
        field: `${at}.subtitle`,
        message: `Card ${n}'s text is 80 characters at most.`,
      });
    }
    if (BRACKETS.test(title) || BRACKETS.test(subtitle)) {
      issues.push({
        field: at,
        message: `Replace the text in [brackets] on card ${n} with your own.`,
      });
    }
    for (const [value, field, what] of [
      [image, "imageUrl", "picture"],
      [link, "linkUrl", "link"],
    ] as const) {
      if (value === "") continue;
      if (!looksLikeHttpsUrl(value)) {
        issues.push({
          field: `${at}.${field}`,
          message: `Card ${n}'s ${what} must start with https://.`,
        });
      } else if (value.startsWith(PLACEHOLDER_WEBSITE)) {
        issues.push({
          field: `${at}.${field}`,
          message: `Replace the example ${what} on card ${n} with your own.`,
        });
      }
    }
    if (subtitle === "" && image === "" && link === "" && card.buttons.length === 0) {
      issues.push({ field: at, message: `Card ${n} needs a text, a picture, a link or a button.` });
    }
    issues.push(...buttonIssues(card.buttons, `${at}.buttons`, 0));
  });
  return issues;
}

/**
 * The content as the API takes it: trimmed, empty optional parts left out (what the server would
 * store anyway).
 */
export function toTemplateInput(content: TemplateContent): TemplateContent {
  const buttons = (list: TemplateButton[]): TemplateButton[] =>
    list.map((b) =>
      b.type === "url"
        ? { type: "url", title: b.title.trim(), url: b.url.trim() }
        : { type: "reply", title: b.title.trim() },
    );
  if (content.kind === "buttons") {
    return { kind: "buttons", text: content.text.trim(), buttons: buttons(content.buttons) };
  }
  return {
    kind: "cards",
    cards: content.cards.map((card) => {
      const subtitle = card.subtitle?.trim() ?? "";
      const imageUrl = card.imageUrl?.trim() ?? "";
      const linkUrl = card.linkUrl?.trim() ?? "";
      return {
        title: card.title.trim(),
        ...(subtitle !== "" ? { subtitle } : {}),
        ...(imageUrl !== "" ? { imageUrl } : {}),
        ...(linkUrl !== "" ? { linkUrl } : {}),
        buttons: buttons(card.buttons),
      };
    }),
  };
}

/** Template refusals by `reason` (convex/instagram/messaging/templates.ts, v1/instagramTemplates). */
export const TEMPLATE_ERRORS: Readonly<Record<string, string>> = {
  name_missing: "Give the template a name.",
  name_too_long: "Names are 60 characters at most.",
  text_missing: "Write the message.",
  text_too_long: "The message is 640 characters at most.",
  button_count: "A button message has 1 to 3 buttons, and a card at most 3.",
  button_title: "Every button needs a label of up to 20 characters.",
  duplicate_button: "Every button needs a different label.",
  button_url: "Button links must be your website's https:// address.",
  card_count: "Use 1 to 10 cards.",
  card_title: "Every card needs a title of up to 80 characters.",
  card_subtitle: "Card texts are 80 characters at most.",
  card_image_url: "Pictures must be an https:// address of the image on your website.",
  card_link_url: "Card links must be your website's https:// address.",
  card_needs_more: "Every card needs a text, a picture, a link or a button besides its title.",
  unknown_placeholder: "Only {{customer_name}} can be filled in; remove any other {{…}}.",
  name_in_use: "Another template has this name. Choose another one.",
  limit_reached:
    "Your organization has 100 Instagram templates, the most allowed. Delete one first.",
};

export function templateErrorNotice(error: unknown): Notice {
  if (isMarketingError(error)) {
    const reason = error.data.details?.reason;
    const known = typeof reason === "string" ? TEMPLATE_ERRORS[reason] : undefined;
    if (known) return { tone: "error", title: "Template not saved", message: known };
    switch (error.data.code) {
      case "FORBIDDEN":
        return {
          tone: "error",
          title: "Editors and admins only",
          message: "Only editors and admins can change Instagram templates.",
        };
      case "NOT_FOUND":
        return {
          tone: "error",
          title: "Template not found",
          message: "It was deleted meanwhile. Reload the page.",
        };
      case "UNAUTHENTICATED":
        return { tone: "error", title: "Signed out", message: "Sign in again, then retry." };
    }
  }
  return {
    tone: "error",
    title: "Template not saved",
    message: "Something went wrong. Try again.",
  };
}

/** A refused template send: the template's own problems, else what any reply can run into. */
export function templateSendErrorNotice(error: unknown): Notice {
  if (isMarketingError(error)) {
    const { code, details } = error.data;
    if (code === "NOT_FOUND" && details?.table === "instagramTemplates") {
      return {
        tone: "error",
        title: "Template not found",
        message: "It was deleted meanwhile. Choose another one.",
      };
    }
    if (code === "INVALID_ARGUMENT" && details?.field !== "clientMessageId") {
      return {
        tone: "error",
        title: "Template not sent",
        message:
          "Without the customer's name this template has nothing left to send. Edit it on the Templates page.",
      };
    }
  }
  return sendErrorNotice(error);
}
