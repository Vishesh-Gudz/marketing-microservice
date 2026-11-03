import { MAX_BODY_CHARS, MAX_HEADER_CHARS } from "./templates";

/**
 * New WhatsApp message templates (ADR 0020; pure, no Convex runtime). Checks a template draft
 * from the dashboard against Meta's documented creation rules ("Message templates", "Template
 * components", 2026-11-03) and builds the POST /{waba}/message_templates request. Only what this
 * app can also send (convex/whatsapp/templates.ts, ADR 0015 D5): a TEXT header or none, the
 * BODY, a FOOTER, and QUICK_REPLY, URL and PHONE_NUMBER buttons; categories MARKETING and
 * UTILITY. Meta reviews every template and stays the final judge.
 *
 * Variables are named (`{{customer_name}}`) or positional (`{{1}}`), one style per template
 * (Meta's `parameter_format`). Each needs a sample value (Meta requires them for review). A
 * URL button may end in one positional variable (`{{1}}`), with its own sample.
 */

export const TEMPLATE_CATEGORIES = ["MARKETING", "UTILITY"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export type DraftButton =
  | { type: "QUICK_REPLY"; text: string }
  | { type: "URL"; text: string; url: string; example?: string }
  | { type: "PHONE_NUMBER"; text: string; phoneNumber: string };

/** A sample for one variable of the header or the body. */
export type DraftExample = { component: "header" | "body"; name: string; value: string };

export type TemplateDraft = {
  name: string;
  language: string;
  category: TemplateCategory;
  header?: string;
  body: string;
  footer?: string;
  buttons: DraftButton[];
  examples: DraftExample[];
};

/** Meta's limits (documented) and ours (marked). */
export const MAX_TEMPLATE_NAME_CHARS = 512;
export const MAX_FOOTER_CHARS = 60;
export const MAX_BUTTON_TEXT_CHARS = 25;
export const MAX_BUTTONS = 10;
export const MAX_QUICK_REPLIES = 10;
export const MAX_URL_BUTTONS = 2;
export const MAX_PHONE_BUTTONS = 1;
export const MAX_URL_CHARS = 2000;
export const MAX_PHONE_CHARS = 20;
/** Ours: a sample value is a short example, never a whole message. */
export const MAX_EXAMPLE_CHARS = 200;

const NAME = /^[a-z0-9_]+$/;
const LANGUAGE = /^[a-z]{2,3}(_[A-Za-z0-9]{2,4})?$/;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const POSITIONAL = /^[1-9]\d{0,2}$/;
const NAMED = /^[a-z][a-z0-9_]{0,63}$/;
const URL_START = /^https?:\/\/[^\s/?#]+\.[^\s/?#]+/;
const PHONE = /^\+[1-9]\d{6,18}$/;

export const DRAFT_REFUSALS = [
  "invalid_name",
  "invalid_language",
  "invalid_category",
  "header_too_long",
  "header_multiline",
  "header_too_many_variables",
  "body_missing",
  "body_too_long",
  "footer_too_long",
  "footer_variable",
  "invalid_variable",
  "mixed_variables",
  "variables_not_sequential",
  "missing_example",
  "unexpected_example",
  "example_too_long",
  "too_many_buttons",
  "buttons_not_grouped",
  "button_text",
  "invalid_url",
  "invalid_phone",
] as const;
export type DraftRefusal = (typeof DRAFT_REFUSALS)[number];

export type DraftResult =
  | { ok: true; request: Record<string, unknown>; parameterFormat: "NAMED" | "POSITIONAL" }
  | { ok: false; reason: DraftRefusal; field: string };

function refuse(reason: DraftRefusal, field: string): DraftResult {
  return { ok: false, reason, field };
}

/** A text's placeholders, in order of first appearance (each once). */
export function placeholderNames(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!names.includes(match[1]!)) names.push(match[1]!);
  }
  return names;
}

/** The variable style of these names, `mixed` or `invalid`; null when there are none. */
function styleOf(names: string[]): "NAMED" | "POSITIONAL" | "mixed" | "invalid" | null {
  if (names.length === 0) return null;
  if (names.every((n) => POSITIONAL.test(n))) return "POSITIONAL";
  if (names.every((n) => NAMED.test(n))) return "NAMED";
  if (names.every((n) => POSITIONAL.test(n) || NAMED.test(n))) return "mixed";
  return "invalid";
}

/** Text without line ends at its edges; Meta trims nothing for us. */
function clean(text: string | undefined): string | undefined {
  const value = text?.trim();
  return value === undefined || value === "" ? undefined : value;
}

/**
 * Checks a draft and builds Meta's request, or names the first rule it breaks (`field` is the
 * part of the form: "name", "header", "body", "footer", "examples.body.<name>",
 * "buttons.<index>", …).
 */
export function buildTemplateRequest(draft: TemplateDraft): DraftResult {
  const name = draft.name.trim();
  if (name.length === 0 || name.length > MAX_TEMPLATE_NAME_CHARS || !NAME.test(name)) {
    return refuse("invalid_name", "name");
  }
  if (!LANGUAGE.test(draft.language)) return refuse("invalid_language", "language");
  if (!(TEMPLATE_CATEGORIES as readonly string[]).includes(draft.category)) {
    return refuse("invalid_category", "category");
  }

  const header = clean(draft.header);
  const body = clean(draft.body);
  const footer = clean(draft.footer);
  if (header !== undefined) {
    if (header.length > MAX_HEADER_CHARS) return refuse("header_too_long", "header");
    if (/[\r\n]/.test(header)) return refuse("header_multiline", "header");
  }
  if (body === undefined) return refuse("body_missing", "body");
  if (body.length > MAX_BODY_CHARS) return refuse("body_too_long", "body");
  if (footer !== undefined) {
    if (footer.length > MAX_FOOTER_CHARS) return refuse("footer_too_long", "footer");
    if (placeholderNames(footer).length > 0) return refuse("footer_variable", "footer");
  }

  // Variables: one style for the header and the body together.
  const headerNames = header === undefined ? [] : placeholderNames(header);
  const bodyNames = placeholderNames(body);
  if (headerNames.length > 1) return refuse("header_too_many_variables", "header");
  const style = styleOf([...headerNames, ...bodyNames]);
  if (style === "invalid") {
    const field = styleOf(headerNames) === "invalid" ? "header" : "body";
    return refuse("invalid_variable", field);
  }
  if (style === "mixed") return refuse("mixed_variables", "body");
  const format = style ?? "POSITIONAL";
  if (format === "POSITIONAL") {
    for (const [component, names] of [
      ["header", headerNames],
      ["body", bodyNames],
    ] as const) {
      // Meta numbers each component's variables 1..n, in order of first appearance.
      if (!names.every((n, i) => Number(n) === i + 1)) {
        return refuse("variables_not_sequential", component);
      }
    }
  }

  // One sample per variable, nothing else.
  const samples = new Map<string, string>();
  for (const example of draft.examples) {
    const key = `${example.component}.${example.name}`;
    const known =
      example.component === "header"
        ? headerNames.includes(example.name)
        : bodyNames.includes(example.name);
    if (!known || samples.has(key)) return refuse("unexpected_example", `examples.${key}`);
    const value = example.value.trim();
    if (value === "") return refuse("missing_example", `examples.${key}`);
    if (value.length > MAX_EXAMPLE_CHARS) return refuse("example_too_long", `examples.${key}`);
    samples.set(key, value);
  }
  for (const [component, names] of [
    ["header", headerNames],
    ["body", bodyNames],
  ] as const) {
    for (const n of names) {
      if (!samples.has(`${component}.${n}`)) {
        return refuse("missing_example", `examples.${component}.${n}`);
      }
    }
  }

  const buttons = checkButtons(draft.buttons);
  if (!buttons.ok) return buttons;

  const sampleList = (component: "header" | "body", names: string[]) =>
    names.map((n) => samples.get(`${component}.${n}`)!);
  const components: Record<string, unknown>[] = [];
  if (header !== undefined) {
    components.push({
      type: "HEADER",
      format: "TEXT",
      text: header,
      ...(headerNames.length === 0
        ? {}
        : {
            example:
              format === "NAMED"
                ? {
                    header_text_named_params: headerNames.map((n) => ({
                      param_name: n,
                      example: samples.get(`header.${n}`)!,
                    })),
                  }
                : { header_text: sampleList("header", headerNames) },
          }),
    });
  }
  components.push({
    type: "BODY",
    text: body,
    ...(bodyNames.length === 0
      ? {}
      : {
          example:
            format === "NAMED"
              ? {
                  body_text_named_params: bodyNames.map((n) => ({
                    param_name: n,
                    example: samples.get(`body.${n}`)!,
                  })),
                }
              : { body_text: [sampleList("body", bodyNames)] },
        }),
  });
  if (footer !== undefined) components.push({ type: "FOOTER", text: footer });
  if (buttons.list.length > 0) components.push({ type: "BUTTONS", buttons: buttons.list });

  return {
    ok: true,
    parameterFormat: format,
    request: {
      name,
      language: draft.language,
      category: draft.category,
      // Meta's default is positional; named templates say so (PROVISIONAL: lowercase, as the
      // creation docs write it).
      ...(format === "NAMED" ? { parameter_format: "named" } : {}),
      components,
    },
  };
}

function checkButtons(
  drafts: DraftButton[],
): { ok: true; list: Record<string, unknown>[] } | (DraftResult & { ok: false }) {
  if (drafts.length > MAX_BUTTONS)
    return { ok: false, reason: "too_many_buttons", field: "buttons" };
  const count = (type: DraftButton["type"]) => drafts.filter((b) => b.type === type).length;
  if (
    count("QUICK_REPLY") > MAX_QUICK_REPLIES ||
    count("URL") > MAX_URL_BUTTONS ||
    count("PHONE_NUMBER") > MAX_PHONE_BUTTONS
  ) {
    return { ok: false, reason: "too_many_buttons", field: "buttons" };
  }
  // Meta: quick replies are grouped before the other buttons.
  const firstOther = drafts.findIndex((b) => b.type !== "QUICK_REPLY");
  if (firstOther !== -1 && drafts.slice(firstOther).some((b) => b.type === "QUICK_REPLY")) {
    return { ok: false, reason: "buttons_not_grouped", field: "buttons" };
  }
  const list: Record<string, unknown>[] = [];
  for (const [i, button] of drafts.entries()) {
    const field = `buttons.${i}`;
    const text = button.text.trim();
    if (text === "" || text.length > MAX_BUTTON_TEXT_CHARS || /[\r\n]/.test(text)) {
      return { ok: false, reason: "button_text", field };
    }
    if (button.type === "QUICK_REPLY") {
      list.push({ type: "QUICK_REPLY", text });
    } else if (button.type === "PHONE_NUMBER") {
      const phone = button.phoneNumber.replace(/[\s()-]/g, "");
      if (!PHONE.test(phone) || phone.length > MAX_PHONE_CHARS) {
        return { ok: false, reason: "invalid_phone", field };
      }
      list.push({ type: "PHONE_NUMBER", text, phone_number: phone });
    } else {
      const url = button.url.trim();
      const names = placeholderNames(url);
      const variable = names.length === 1 && names[0] === "1" && url.endsWith("{{1}}");
      if (
        url.length > MAX_URL_CHARS ||
        !URL_START.test(url) ||
        /\s/.test(url) ||
        (names.length > 0 && !variable) ||
        url.split("{{").length > 2
      ) {
        return { ok: false, reason: "invalid_url", field };
      }
      const example = button.example?.trim() ?? "";
      if (variable && example === "") return { ok: false, reason: "missing_example", field };
      if (variable && example.length > MAX_EXAMPLE_CHARS) {
        return { ok: false, reason: "example_too_long", field };
      }
      // The sample completes the URL: no spaces in it either.
      if (variable && /\s/.test(example)) return { ok: false, reason: "invalid_url", field };
      list.push({ type: "URL", text, url, ...(variable ? { example: [example] } : {}) });
    }
  }
  return { ok: true, list };
}
