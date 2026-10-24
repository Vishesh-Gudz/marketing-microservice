import type { TemplateVariable, WhatsAppTemplate } from "./types";

/**
 * The template picker's form (pure). The server checks every value against the template it
 * reads from Meta (v1/whatsapp:sendTemplate); these rules only guide the user: one field per
 * variable, a live preview, and no send while a value is blank.
 */

/** Form values by variable key ("body.1", "header.first_name", "button.0"). */
export type TemplateFormValues = Readonly<Record<string, string>>;

export function variableKey(variable: Pick<TemplateVariable, "component" | "name">): string {
  return `${variable.component}.${variable.name}`;
}

/** A field's label: the placeholder and where it is, or the URL button it completes. */
export function variableLabel(
  variable: Pick<TemplateVariable, "component" | "name">,
  template: Pick<WhatsAppTemplate, "buttons">,
): string {
  if (variable.component === "button") {
    const button = template.buttons[Number(variable.name)];
    return `End of the link of the “${button?.text ?? "link"}” button`;
  }
  return `{{${variable.name}}} in the ${variable.component}`;
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

function fill(text: string, component: "header" | "body", values: TemplateFormValues): string {
  return text.replace(PLACEHOLDER, (whole, name: string) => {
    const value = values[`${component}.${name}`];
    return value !== undefined && value.trim() !== "" ? value : whole;
  });
}

/** What the customer will read, filled in so far (placeholders left as they are until filled). */
export function templatePreview(
  template: Pick<WhatsAppTemplate, "header" | "body" | "footer">,
  values: TemplateFormValues,
): string {
  return [
    template.header !== undefined ? fill(template.header, "header", values) : undefined,
    fill(template.body, "body", values),
    template.footer,
  ]
    .filter((part) => part !== undefined && part !== "")
    .join("\n\n");
}

/** The variables still without a value (blank counts as missing). */
export function missingVariables(
  template: Pick<WhatsAppTemplate, "variables">,
  values: TemplateFormValues,
): TemplateVariable[] {
  return template.variables.filter((v) => (values[variableKey(v)] ?? "").trim() === "");
}

/** The values to send, in the template's own order (v1/whatsapp:sendTemplate `variables`). */
export function templateValues(
  template: Pick<WhatsAppTemplate, "variables">,
  values: TemplateFormValues,
): { component: TemplateVariable["component"]; name: string; value: string }[] {
  return template.variables.map((v) => ({
    component: v.component,
    name: v.name,
    value: values[variableKey(v)] ?? "",
  }));
}

/** Why a listed template cannot be chosen, by `unsupportedReason` (convex/whatsapp/templates.ts). */
export const UNSUPPORTED_TEMPLATE_TEXTS: Readonly<Record<string, string>> = {
  media_header: "Has a photo, video or document header",
  location_header: "Has a location header",
  unsupported_component: "Uses a carousel or a limited-time offer",
  authentication: "Is an authentication (one-time code) template",
  unsupported_button: "Has a button this app cannot send yet",
  unsupported_placeholder: "Uses placeholders this app cannot fill",
};

export function unsupportedTemplateText(reason: string | undefined): string {
  return (
    (reason !== undefined ? UNSUPPORTED_TEMPLATE_TEXTS[reason] : undefined) ?? "Not supported yet"
  );
}
