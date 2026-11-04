import { v, type Infer } from "convex/values";
import { CUSTOMER_NAME, fillCustomerName } from "../../messaging/savedReplies";

/**
 * Instagram templates (ADR 0022; pure, no Convex runtime): an org's reusable rich messages for
 * Instagram DMs. Instagram has no Meta-approved templates: these are stored here only, never
 * submitted or reviewed, and sent like any reply, inside the customer's 24-hour window (or as a
 * Human Agent reply when that is on). Two kinds, as Instagram offers them:
 *
 * - `buttons`: a text of up to 640 characters with 1-3 buttons ([doc] "Button template",
 *   `template_type: "button"`).
 * - `cards`: 1-10 cards side by side ([doc] "Generic template", `template_type: "generic"`),
 *   each with a title and optional subtitle (80 characters each), image, link and up to 3
 *   buttons; besides its title a card needs at least one of them [doc].
 *
 * A button opens a link (`web_url`) or sends a reply (`postback`: the button's title arrives as
 * the customer's message, stored with `tap: "button"`; its payload is the button's position,
 * never customer data). Links and images are the business's own `https` addresses.
 * `{{customer_name}}` is the only placeholder, in texts and card titles and subtitles; it is
 * filled when sending.
 *
 * [assume] Button titles: 20 characters (Meta states the limit for Messenger buttons, not for
 * Instagram). [doc] Instagram shows these messages in its apps, not on instagram.com.
 */

export const MAX_INSTAGRAM_TEMPLATES = 100;
export const MAX_TEMPLATE_NAME_CHARS = 60;
/** [doc] Button template text: "UTF-8-encoded text of up to 640 characters". */
export const MAX_BUTTONS_TEXT_CHARS = 640;
/** [doc] 1-3 buttons per button template and at most 3 per card. */
export const MAX_TEMPLATE_BUTTONS = 3;
/** [assume] Messenger's button title limit. */
export const MAX_BUTTON_TITLE_CHARS = 20;
/** [doc] At most 10 cards per generic template. */
export const MAX_TEMPLATE_CARDS = 10;
/** [doc] Card title and subtitle: 80 characters each. */
export const MAX_CARD_TITLE_CHARS = 80;
export const MAX_CARD_SUBTITLE_CHARS = 80;
export const MAX_TEMPLATE_URL_CHARS = 1000;

export const templateButtonValidator = v.union(
  v.object({ type: v.literal("url"), title: v.string(), url: v.string() }),
  v.object({ type: v.literal("reply"), title: v.string() }),
);
export type TemplateButton = Infer<typeof templateButtonValidator>;

export const templateCardValidator = v.object({
  title: v.string(),
  subtitle: v.optional(v.string()),
  imageUrl: v.optional(v.string()),
  /** Opened when the card itself is tapped ([doc] `default_action`). */
  linkUrl: v.optional(v.string()),
  buttons: v.array(templateButtonValidator),
});
export type TemplateCard = Infer<typeof templateCardValidator>;

export const templateContentValidator = v.union(
  v.object({
    kind: v.literal("buttons"),
    text: v.string(),
    buttons: v.array(templateButtonValidator),
  }),
  v.object({ kind: v.literal("cards"), cards: v.array(templateCardValidator) }),
);
export type TemplateContent = Infer<typeof templateContentValidator>;

export const instagramTemplateInputValidator = {
  name: v.string(),
  content: templateContentValidator,
};
export type InstagramTemplateInput = { name: string; content: TemplateContent };

export const INSTAGRAM_TEMPLATE_REFUSALS = [
  "name_missing",
  "name_too_long",
  "text_missing",
  "text_too_long",
  "button_count",
  "button_title",
  "duplicate_button",
  "button_url",
  "card_count",
  "card_title",
  "card_subtitle",
  "card_image_url",
  "card_link_url",
  "card_needs_more",
  "unknown_placeholder",
] as const;
export type InstagramTemplateRefusal = (typeof INSTAGRAM_TEMPLATE_REFUSALS)[number];

type Refused = { ok: false; reason: InstagramTemplateRefusal; field: string };

const PLACEHOLDER = /\{\{[^{}]*\}\}/g;

/** Whether a text uses any placeholder other than `{{customer_name}}`. */
function unknownPlaceholder(text: string): boolean {
  return (text.match(PLACEHOLDER) ?? []).some((p) => p !== CUSTOMER_NAME);
}

/** The business's own public `https` address (no credentials, a real host name). */
export function isPublicHttpsUrl(value: string): boolean {
  if (value.length > MAX_TEMPLATE_URL_CHARS || /\s/.test(value) || value.includes("{{")) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.hostname.includes(".") &&
    !/^[\d.]+$/.test(url.hostname) &&
    !url.hostname.endsWith(".localhost")
  );
}

function checkButtons(
  buttons: TemplateButton[],
  field: string,
  min: number,
): { ok: true; buttons: TemplateButton[] } | Refused {
  if (buttons.length < min || buttons.length > MAX_TEMPLATE_BUTTONS) {
    return { ok: false, reason: "button_count", field };
  }
  const checked: TemplateButton[] = [];
  for (const [i, button] of buttons.entries()) {
    const title = button.title.trim();
    if (title === "" || title.length > MAX_BUTTON_TITLE_CHARS || /[\r\n]/.test(title)) {
      return { ok: false, reason: "button_title", field: `${field}.${i}.title` };
    }
    if (title.includes("{{")) {
      return { ok: false, reason: "unknown_placeholder", field: `${field}.${i}.title` };
    }
    if (checked.some((b) => b.title === title)) {
      return { ok: false, reason: "duplicate_button", field: `${field}.${i}.title` };
    }
    if (button.type === "url") {
      const url = button.url.trim();
      if (!isPublicHttpsUrl(url)) {
        return { ok: false, reason: "button_url", field: `${field}.${i}.url` };
      }
      checked.push({ type: "url", title, url });
    } else {
      checked.push({ type: "reply", title });
    }
  }
  return { ok: true, buttons: checked };
}

function checkCard(card: TemplateCard, field: string): { ok: true; card: TemplateCard } | Refused {
  const title = card.title.trim();
  if (title === "" || title.length > MAX_CARD_TITLE_CHARS) {
    return { ok: false, reason: "card_title", field: `${field}.title` };
  }
  if (unknownPlaceholder(title)) {
    return { ok: false, reason: "unknown_placeholder", field: `${field}.title` };
  }
  const subtitle = card.subtitle?.trim() ?? "";
  if (subtitle.length > MAX_CARD_SUBTITLE_CHARS) {
    return { ok: false, reason: "card_subtitle", field: `${field}.subtitle` };
  }
  if (unknownPlaceholder(subtitle)) {
    return { ok: false, reason: "unknown_placeholder", field: `${field}.subtitle` };
  }
  const imageUrl = card.imageUrl?.trim() ?? "";
  if (imageUrl !== "" && !isPublicHttpsUrl(imageUrl)) {
    return { ok: false, reason: "card_image_url", field: `${field}.imageUrl` };
  }
  const linkUrl = card.linkUrl?.trim() ?? "";
  if (linkUrl !== "" && !isPublicHttpsUrl(linkUrl)) {
    return { ok: false, reason: "card_link_url", field: `${field}.linkUrl` };
  }
  const buttons = checkButtons(card.buttons, `${field}.buttons`, 0);
  if (!buttons.ok) return buttons;
  if (subtitle === "" && imageUrl === "" && linkUrl === "" && buttons.buttons.length === 0) {
    return { ok: false, reason: "card_needs_more", field };
  }
  return {
    ok: true,
    card: {
      title,
      ...(subtitle !== "" ? { subtitle } : {}),
      ...(imageUrl !== "" ? { imageUrl } : {}),
      ...(linkUrl !== "" ? { linkUrl } : {}),
      buttons: buttons.buttons,
    },
  };
}

/** Checks a template's content; returns it trimmed, empty optional parts left out. */
export function checkTemplateContent(
  content: TemplateContent,
): { ok: true; content: TemplateContent } | Refused {
  if (content.kind === "buttons") {
    const text = content.text.trim();
    if (text === "") return { ok: false, reason: "text_missing", field: "content.text" };
    if (text.length > MAX_BUTTONS_TEXT_CHARS) {
      return { ok: false, reason: "text_too_long", field: "content.text" };
    }
    if (unknownPlaceholder(text)) {
      return { ok: false, reason: "unknown_placeholder", field: "content.text" };
    }
    const buttons = checkButtons(content.buttons, "content.buttons", 1);
    if (!buttons.ok) return buttons;
    return { ok: true, content: { kind: "buttons", text, buttons: buttons.buttons } };
  }
  if (content.cards.length < 1 || content.cards.length > MAX_TEMPLATE_CARDS) {
    return { ok: false, reason: "card_count", field: "content.cards" };
  }
  const cards: TemplateCard[] = [];
  for (const [i, card] of content.cards.entries()) {
    const checked = checkCard(card, `content.cards.${i}`);
    if (!checked.ok) return checked;
    cards.push(checked.card);
  }
  return { ok: true, content: { kind: "cards", cards } };
}

/** A checked template: its name (trimmed) and content. */
export function checkInstagramTemplate(
  input: InstagramTemplateInput,
): { ok: true; value: InstagramTemplateInput } | Refused {
  const name = input.name.trim();
  if (name === "") return { ok: false, reason: "name_missing", field: "name" };
  if (name.length > MAX_TEMPLATE_NAME_CHARS) {
    return { ok: false, reason: "name_too_long", field: "name" };
  }
  const content = checkTemplateContent(input.content);
  if (!content.ok) return content;
  return { ok: true, value: { name, content: content.content } };
}

/** The content for one customer: `{{customer_name}}` filled in (or left out) everywhere. */
export function fillTemplate(
  content: TemplateContent,
  contactName: string | undefined,
): TemplateContent {
  const fill = (text: string) => fillCustomerName(text, contactName).trim();
  if (content.kind === "buttons") return { ...content, text: fill(content.text) };
  return {
    kind: "cards",
    cards: content.cards.map(({ subtitle, ...card }) => {
      const filled = subtitle !== undefined ? fill(subtitle) : "";
      return { ...card, title: fill(card.title), ...(filled !== "" ? { subtitle: filled } : {}) };
    }),
  };
}

/** A text for lists and notes: the button message's text, or the first card's title. */
export function templateSummary(content: TemplateContent): string {
  return content.kind === "buttons" ? content.text : content.cards[0]!.title;
}

type MetaButton =
  | { type: "web_url"; url: string; title: string }
  | { type: "postback"; title: string; payload: string };

function metaButtons(buttons: TemplateButton[], prefix: string): MetaButton[] {
  return buttons.map((button, i) =>
    button.type === "url"
      ? { type: "web_url", url: button.url, title: button.title }
      : { type: "postback", title: button.title, payload: `${prefix}${i + 1}` },
  );
}

/** The payload of a reply button: its position only, never customer data. */
export const TEMPLATE_REPLY_PAYLOAD_PREFIX = "TEMPLATE_REPLY_";

/**
 * Meta's `message.attachment` for a template ([doc] `{type: "template", payload: {...}}`): a
 * button template, or a generic template with one element per card.
 */
export function templateAttachment(content: TemplateContent): {
  type: "template";
  payload: Record<string, unknown>;
} {
  if (content.kind === "buttons") {
    return {
      type: "template",
      payload: {
        template_type: "button",
        text: content.text,
        buttons: metaButtons(content.buttons, TEMPLATE_REPLY_PAYLOAD_PREFIX),
      },
    };
  }
  return {
    type: "template",
    payload: {
      template_type: "generic",
      elements: content.cards.map((card, c) => ({
        title: card.title,
        ...(card.subtitle !== undefined ? { subtitle: card.subtitle } : {}),
        ...(card.imageUrl !== undefined ? { image_url: card.imageUrl } : {}),
        ...(card.linkUrl !== undefined
          ? { default_action: { type: "web_url", url: card.linkUrl } }
          : {}),
        ...(card.buttons.length > 0
          ? { buttons: metaButtons(card.buttons, `${TEMPLATE_REPLY_PAYLOAD_PREFIX}${c + 1}_`) }
          : {}),
      })),
    },
  };
}
