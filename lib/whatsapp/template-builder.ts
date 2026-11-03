import { PLACEHOLDER_WEBSITE, type StarterButton, type TemplateStarter } from "./template-starters";

/**
 * The template builder's state and its light, in-browser checks (ADR 0020). The server checks
 * every rule again (convex/whatsapp/templateDrafts.ts) and Meta reviews the result; the limits
 * here mirror Meta's documented ones so the form can count and explain before submitting.
 */

/**
 * v1/whatsapp:createTemplate's `draft`, written out (this module is also used by a Convex test,
 * which cannot resolve the generated api); the call site checks it against the api types.
 */
export type TemplateDraftArgs = {
  name: string;
  language: string;
  category: "UTILITY" | "MARKETING";
  header?: string;
  body: string;
  footer?: string;
  buttons: (
    | { type: "QUICK_REPLY"; text: string }
    | { type: "URL"; text: string; url: string; example?: string }
    | { type: "PHONE_NUMBER"; text: string; phoneNumber: string }
  )[];
  examples: { component: "header" | "body"; name: string; value: string }[];
};

export const LIMITS = {
  name: 512,
  header: 60,
  body: 1024,
  footer: 60,
  buttonText: 25,
  buttons: 10,
  quickReplies: 10,
  urlButtons: 2,
  phoneButtons: 1,
  example: 200,
} as const;

export type BuilderButton = StarterButton & { key: string };

export type BuilderState = {
  name: string;
  language: string;
  category: "UTILITY" | "MARKETING";
  header: string;
  body: string;
  footer: string;
  /** Quick replies first, then the other buttons (Meta's order). */
  buttons: BuilderButton[];
  /** Sample values by variable ("header.order_id", "body.customer_name"). */
  samples: Record<string, string>;
};

let keySeq = 0;
function key(): string {
  keySeq += 1;
  return `button-${keySeq}`;
}

export function emptyBuilder(language = "en"): BuilderState {
  return {
    name: "",
    language,
    category: "UTILITY",
    header: "",
    body: "",
    footer: "",
    buttons: [],
    samples: {},
  };
}

/** A starter as a builder state (its samples apply to the header and the body). */
export function builderFromStarter(starter: TemplateStarter, language = "en"): BuilderState {
  const samples: Record<string, string> = {};
  for (const [name, value] of Object.entries(starter.samples)) {
    samples[`header.${name}`] = value;
    samples[`body.${name}`] = value;
  }
  return {
    name: starter.name,
    language,
    category: starter.category,
    header: starter.header ?? "",
    body: starter.body,
    footer: starter.footer ?? "",
    buttons: starter.buttons.map((button) => ({ ...button, key: key() })),
    samples,
  };
}

export function newButton(type: StarterButton["type"]): BuilderButton {
  switch (type) {
    case "QUICK_REPLY":
      return { type, text: "", key: key() };
    case "URL":
      return { type, text: "", url: "https://", key: key() };
    case "PHONE_NUMBER":
      return { type, text: "", phoneNumber: "", key: key() };
  }
}

/** Adds a button where Meta wants it: quick replies before the others. */
export function addButton(buttons: BuilderButton[], button: BuilderButton): BuilderButton[] {
  if (button.type !== "QUICK_REPLY") return [...buttons, button];
  const firstOther = buttons.findIndex((b) => b.type !== "QUICK_REPLY");
  return firstOther === -1
    ? [...buttons, button]
    : [...buttons.slice(0, firstOther), button, ...buttons.slice(firstOther)];
}

/** A template name as Meta accepts it: lowercase letters, digits and underscores. */
export function normalizeTemplateName(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, LIMITS.name);
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** A text's variables, in order of first appearance (each once). */
export function variablesIn(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!names.includes(match[1]!)) names.push(match[1]!);
  }
  return names;
}

/** The header's and the body's variables, as sample keys ("body.customer_name"). */
export function sampleKeys(state: Pick<BuilderState, "header" | "body">): string[] {
  return [
    ...variablesIn(state.header).map((n) => `header.${n}`),
    ...variablesIn(state.body).map((n) => `body.${n}`),
  ];
}

/** The text with each variable replaced by its sample (or left as it is). */
export function withSamples(
  text: string,
  component: "header" | "body",
  samples: Record<string, string>,
): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const sample = samples[`${component}.${name}`]?.trim();
    return sample ? sample : whole;
  });
}

/** Whether a URL button's link carries a value (`{{1}}` at its end). */
export function urlHasVariable(url: string): boolean {
  return /\{\{1\}\}$/.test(url.trim());
}

export type BuilderIssue = { field: string; message: string };

/** What still keeps the form from being submitted, in words (the server checks again). */
export function builderIssues(state: BuilderState): BuilderIssue[] {
  const issues: BuilderIssue[] = [];
  const add = (field: string, message: string) => issues.push({ field, message });
  if (state.name === "") add("name", "Give the template a name.");
  if (state.header.length > LIMITS.header)
    add("header", "The header is longer than 60 characters.");
  if (variablesIn(state.header).length > 1)
    add("header", "The header can have one variable at most.");
  if (state.body.trim() === "") add("body", "Write the message body.");
  if (state.body.length > LIMITS.body) add("body", "The body is longer than 1024 characters.");
  if (state.footer.length > LIMITS.footer)
    add("footer", "The footer is longer than 60 characters.");
  if (variablesIn(state.footer).length > 0) add("footer", "The footer cannot have variables.");
  for (const sample of sampleKeys(state)) {
    if ((state.samples[sample] ?? "").trim() === "") {
      add(`samples.${sample}`, "Every variable needs a sample value for Meta's review.");
      break;
    }
  }
  state.buttons.forEach((button, i) => {
    const field = `buttons.${i}`;
    if (button.text.trim() === "") add(field, "Every button needs a label.");
    else if (button.text.length > LIMITS.buttonText)
      add(field, "Button labels are 25 characters at most.");
    if (button.type === "URL") {
      if (button.url.startsWith(PLACEHOLDER_WEBSITE)) {
        add(field, "Replace the example link with your own website.");
      } else if (!/^https?:\/\/[^\s/?#]+\.[^\s/?#]+/.test(button.url.trim())) {
        add(field, "Enter the full website link, starting with https://.");
      }
      if (urlHasVariable(button.url) && (button.example ?? "").trim() === "") {
        add(field, "Give a sample value for the end of the link.");
      }
    }
    if (
      button.type === "PHONE_NUMBER" &&
      !/^\+[1-9]\d{6,18}$/.test(button.phoneNumber.replace(/[\s()-]/g, ""))
    ) {
      add(field, "Enter the phone number with + and the country code.");
    }
  });
  return issues;
}

/** The builder state as v1/whatsapp:createTemplate's `draft`. */
export function toDraft(state: BuilderState): TemplateDraftArgs {
  const examples = sampleKeys(state).map((sample) => {
    const [component, ...rest] = sample.split(".");
    return {
      component: component as "header" | "body",
      name: rest.join("."),
      value: state.samples[sample] ?? "",
    };
  });
  return {
    name: state.name,
    language: state.language,
    category: state.category,
    ...(state.header.trim() !== "" ? { header: state.header } : {}),
    body: state.body,
    ...(state.footer.trim() !== "" ? { footer: state.footer } : {}),
    buttons: state.buttons.map((button) => {
      switch (button.type) {
        case "QUICK_REPLY":
          return { type: button.type, text: button.text };
        case "PHONE_NUMBER":
          return { type: button.type, text: button.text, phoneNumber: button.phoneNumber };
        case "URL":
          return {
            type: button.type,
            text: button.text,
            url: button.url,
            ...(urlHasVariable(button.url) && button.example !== undefined
              ? { example: button.example }
              : {}),
          };
      }
    }),
    examples,
  };
}
