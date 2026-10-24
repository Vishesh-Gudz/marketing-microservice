import type { TemplateComponentValues, TemplateParameter } from "./graph";

/**
 * WhatsApp message templates (pure; no Convex runtime). Reads Meta's template objects
 * (GET /{waba}/message_templates, "Template management", 2026-10-24), decides which ones this app
 * can send, lists their variables, checks the values a user filled in, and builds the send
 * payload's `components` ("Send messages": positional values in placeholder order; NAMED ones
 * with `parameter_name`).
 *
 * Supported (D5): a TEXT header or none, the BODY, a FOOTER, and QUICK_REPLY, PHONE_NUMBER or URL
 * buttons (a URL button may end in one variable). Not supported yet, listed with a reason: media
 * and location headers, carousel and limited-time-offer components, authentication templates,
 * other buttons (copy code, OTP, flow, catalog) and placeholders that do not follow Meta's rules.
 * Meta stays the final judge at send time (132000 / 132018 for parameter problems).
 */

export type TemplateComponentName = "header" | "body" | "button";
export type ParameterFormat = "POSITIONAL" | "NAMED";

export type TemplateVariable = {
  component: TemplateComponentName;
  /** The placeholder ("1", "order_id"), or the button's index for a URL button. */
  name: string;
  /** Meta's example value from the template, when it has one. */
  example?: string;
};

export type TemplateButton = { type: string; text: string };

export const UNSUPPORTED_REASONS = [
  "media_header",
  "location_header",
  "unsupported_component",
  "authentication",
  "unsupported_button",
  "unsupported_placeholder",
] as const;
export type UnsupportedReason = (typeof UNSUPPORTED_REASONS)[number];

export type ParsedTemplate = {
  name: string;
  language: string;
  status: string;
  category: string;
  parameterFormat: ParameterFormat;
  header?: string;
  body: string;
  footer?: string;
  buttons: TemplateButton[];
  /** In send order: header, body (placeholder order), then buttons. */
  variables: TemplateVariable[];
  /** URL buttons that carry a variable, by index (the button component's `index`). */
  urlButtons: number[];
  unsupported?: UnsupportedReason;
};

/** Longest header and body Meta allows (creation limits; checked again after filling in). */
export const MAX_HEADER_CHARS = 60;
export const MAX_BODY_CHARS = 1024;
/** Longest value for a URL button's variable (the button URL is limited to 2000 characters). */
export const MAX_URL_VALUE_CHARS = 2000;

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const POSITIONAL = /^\d{1,3}$/;
const NAMED = /^[a-z0-9_]{1,64}$/;
const SUPPORTED_BUTTONS = new Set(["QUICK_REPLY", "PHONE_NUMBER", "URL"]);

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** The placeholders of a text, in order of first appearance (each once). */
function placeholdersOf(text: string): string[] {
  const names: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (!names.includes(match[1]!)) names.push(match[1]!);
  }
  return names;
}

/**
 * The variables of one text, or null when its placeholders break Meta's rules: positional ones
 * are exactly 1..n (sent in numeric order); named ones are lowercase letters, digits and `_`.
 */
function variablesOf(
  text: string,
  format: ParameterFormat,
  component: "header" | "body",
  examples: Map<string, string>,
): TemplateVariable[] | null {
  const names = placeholdersOf(text);
  if (format === "POSITIONAL") {
    if (!names.every((n) => POSITIONAL.test(n))) return null;
    const numbers = names.map(Number).sort((a, b) => a - b);
    if (!numbers.every((n, i) => n === i + 1)) return null;
    return numbers.map((n) => withExample({ component, name: String(n) }, examples));
  }
  if (!names.every((n) => NAMED.test(n))) return null;
  return names.map((name) => withExample({ component, name }, examples));
}

function withExample(variable: TemplateVariable, examples: Map<string, string>): TemplateVariable {
  const example = examples.get(variable.name);
  return example !== undefined ? { ...variable, example } : variable;
}

/** Meta's example values for a header or body, by placeholder name. */
function examplesOf(example: unknown, kind: "header" | "body"): Map<string, string> {
  const examples = new Map<string, string>();
  if (!isObject(example)) return examples;
  const positional =
    kind === "header"
      ? example.header_text
      : Array.isArray(example.body_text)
        ? example.body_text[0]
        : undefined;
  if (Array.isArray(positional)) {
    positional.forEach((value, i) => {
      if (typeof value === "string") examples.set(String(i + 1), value);
    });
  }
  const named =
    kind === "header" ? example.header_text_named_params : example.body_text_named_params;
  if (Array.isArray(named)) {
    for (const item of named) {
      if (
        isObject(item) &&
        typeof item.param_name === "string" &&
        typeof item.example === "string"
      ) {
        examples.set(item.param_name, item.example);
      }
    }
  }
  return examples;
}

/**
 * Reads one template as Meta returns it. Null when it lacks what every template has (name,
 * language, status, a components list with a BODY text); otherwise `unsupported` says why it
 * cannot be sent by this app.
 */
export function parseTemplate(raw: Json): ParsedTemplate | null {
  const name = str(raw.name);
  const language = str(raw.language);
  const status = str(raw.status);
  const category = str(raw.category) ?? "";
  if (name === undefined || language === undefined || status === undefined) return null;
  if (!Array.isArray(raw.components)) return null;
  const parameterFormat: ParameterFormat =
    raw.parameter_format === "NAMED" ? "NAMED" : "POSITIONAL";

  let header: string | undefined;
  let body: string | undefined;
  let footer: string | undefined;
  const buttons: TemplateButton[] = [];
  const headerVars: TemplateVariable[] = [];
  const bodyVars: TemplateVariable[] = [];
  const buttonVars: TemplateVariable[] = [];
  const urlButtons: number[] = [];
  let unsupported: UnsupportedReason | undefined =
    category === "AUTHENTICATION" ? "authentication" : undefined;
  const flag = (reason: UnsupportedReason) => {
    unsupported ??= reason;
  };

  for (const component of raw.components) {
    if (!isObject(component)) return null;
    const type = str(component.type);
    if (type === "HEADER") {
      if (component.format === "LOCATION") flag("location_header");
      else if (component.format !== "TEXT") flag("media_header");
      else {
        header = str(component.text) ?? "";
        const vars = variablesOf(
          header,
          parameterFormat,
          "header",
          examplesOf(component.example, "header"),
        );
        if (vars === null) flag("unsupported_placeholder");
        else headerVars.push(...vars);
      }
    } else if (type === "BODY") {
      body = str(component.text);
      if (body === undefined) return null;
      const vars = variablesOf(
        body,
        parameterFormat,
        "body",
        examplesOf(component.example, "body"),
      );
      if (vars === null) flag("unsupported_placeholder");
      else bodyVars.push(...vars);
    } else if (type === "FOOTER") {
      footer = str(component.text);
    } else if (type === "BUTTONS") {
      const list = Array.isArray(component.buttons) ? component.buttons : [];
      list.forEach((button, index) => {
        if (!isObject(button)) return flag("unsupported_button");
        const buttonType = str(button.type) ?? "";
        if (!SUPPORTED_BUTTONS.has(buttonType)) flag("unsupported_button");
        buttons.push({ type: buttonType, text: str(button.text) ?? "" });
        if (buttonType === "URL") {
          const names = placeholdersOf(str(button.url) ?? "");
          if (names.length > 1) flag("unsupported_placeholder");
          else if (names.length === 1) {
            urlButtons.push(index);
            buttonVars.push({ component: "button", name: String(index) });
          }
        }
      });
    } else {
      flag("unsupported_component");
    }
  }
  if (body === undefined) return null;
  return {
    name,
    language,
    status,
    category,
    parameterFormat,
    ...(header !== undefined ? { header } : {}),
    body,
    ...(footer !== undefined ? { footer } : {}),
    buttons,
    variables: [...headerVars, ...bodyVars, ...buttonVars],
    urlButtons,
    ...(unsupported !== undefined ? { unsupported } : {}),
  };
}

export type TemplateValue = { component: TemplateComponentName; name: string; value: string };

export type CheckedValues =
  | { ok: true; components: TemplateComponentValues[]; text: string }
  | {
      ok: false;
      reason:
        | "missing_value"
        | "unexpected_value"
        | "blank_value"
        | "too_long"
        | "header_too_long"
        | "body_too_long";
      field: string;
    };

function fill(text: string, values: Map<string, string>): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => values.get(name) ?? whole);
}

/**
 * Checks the values a user filled in against a supported template and builds the send payload's
 * components and the text the customer will read (header, body and footer, filled in). Every
 * variable needs exactly one non-blank value; nothing else is accepted.
 */
export function checkValues(template: ParsedTemplate, values: TemplateValue[]): CheckedValues {
  const given = new Map<string, string>();
  for (const value of values) {
    const key = `${value.component}.${value.name}`;
    if (!template.variables.some((v) => `${v.component}.${v.name}` === key) || given.has(key)) {
      return { ok: false, reason: "unexpected_value", field: key };
    }
    given.set(key, value.value);
  }
  for (const variable of template.variables) {
    const key = `${variable.component}.${variable.name}`;
    const value = given.get(key);
    if (value === undefined) return { ok: false, reason: "missing_value", field: key };
    if (value.trim() === "") return { ok: false, reason: "blank_value", field: key };
    const max = variable.component === "button" ? MAX_URL_VALUE_CHARS : MAX_BODY_CHARS;
    if (value.length > max) return { ok: false, reason: "too_long", field: key };
  }

  const valuesOf = (component: TemplateComponentName) =>
    new Map(
      template.variables
        .filter((v) => v.component === component)
        .map((v) => [v.name, given.get(`${component}.${v.name}`)!]),
    );
  const headerValues = valuesOf("header");
  const bodyValues = valuesOf("body");
  const header = template.header !== undefined ? fill(template.header, headerValues) : undefined;
  const body = fill(template.body, bodyValues);
  if (header !== undefined && header.length > MAX_HEADER_CHARS) {
    return { ok: false, reason: "header_too_long", field: "header" };
  }
  if (body.length > MAX_BODY_CHARS) return { ok: false, reason: "body_too_long", field: "body" };

  const parameters = (component: "header" | "body", map: Map<string, string>) =>
    template.variables
      .filter((v) => v.component === component)
      .map((v): TemplateParameter =>
        template.parameterFormat === "NAMED"
          ? { type: "text", parameter_name: v.name, text: map.get(v.name)! }
          : { type: "text", text: map.get(v.name)! },
      );
  const components: TemplateComponentValues[] = [];
  if (headerValues.size > 0)
    components.push({ type: "header", parameters: parameters("header", headerValues) });
  if (bodyValues.size > 0)
    components.push({ type: "body", parameters: parameters("body", bodyValues) });
  for (const index of template.urlButtons) {
    components.push({
      type: "button",
      sub_type: "url",
      index: String(index),
      parameters: [{ type: "text", text: given.get(`button.${index}`)! }],
    });
  }
  return {
    ok: true,
    components,
    text: [header, body, template.footer]
      .filter((part) => part !== undefined && part !== "")
      .join("\n\n"),
  };
}
