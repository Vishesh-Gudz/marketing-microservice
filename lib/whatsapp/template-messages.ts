import { isMarketingError } from "@/convex/lib/errors";
import type { Notice } from "@/lib/connections/types";

/**
 * Fixed, user-facing text for template management (ADR 0020). Only public contract values are
 * read (error code, `reason`, `field`); server messages and Meta's text are never shown.
 */

const SUPPORT = "If it keeps happening, contact support.";

export type StatusTone = "default" | "secondary" | "destructive" | "outline";

/** Meta's template statuses in words, with a badge tone. Unknown ones are shown as they are. */
export function templateStatus(status: string): { label: string; tone: StatusTone } {
  switch (status) {
    case "APPROVED":
      return { label: "Approved", tone: "default" };
    case "PENDING":
    case "IN_APPEAL":
      return { label: status === "PENDING" ? "In review" : "Appeal in review", tone: "secondary" };
    case "REJECTED":
      return { label: "Rejected", tone: "destructive" };
    case "PAUSED":
      return { label: "Paused", tone: "outline" };
    case "DISABLED":
      return { label: "Disabled", tone: "destructive" };
    case "PENDING_DELETION":
    case "DELETED":
      return { label: "Being deleted", tone: "outline" };
    case "LIMIT_EXCEEDED":
      return { label: "Limit exceeded", tone: "outline" };
    default:
      return { label: status.toLowerCase().replace(/_/g, " "), tone: "outline" };
  }
}

/** The status filters of the template list. */
export const STATUS_FILTERS = [
  { id: "all", label: "All" },
  { id: "approved", label: "Approved" },
  { id: "review", label: "In review" },
  { id: "rejected", label: "Rejected" },
  { id: "other", label: "Paused or disabled" },
] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number]["id"];

export function matchesFilter(status: string, filter: StatusFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "approved":
      return status === "APPROVED";
    case "review":
      return status === "PENDING" || status === "IN_APPEAL";
    case "rejected":
      return status === "REJECTED";
    case "other":
      return !["APPROVED", "PENDING", "IN_APPEAL", "REJECTED"].includes(status);
  }
}

export const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  UTILITY: "Utility",
  MARKETING: "Marketing",
  AUTHENTICATION: "Authentication",
};

export const CATEGORY_HELP: Readonly<Record<"UTILITY" | "MARKETING", string>> = {
  UTILITY:
    "About something the customer did or asked for: an order, a booking, a payment, their account. No promotion.",
  MARKETING:
    "Offers, announcements, invitations and anything else that promotes your business. Customers can opt out.",
};

/** Meta's rejection reasons in words; Meta's own wording is never shown. */
export function rejectionText(reason: string | undefined): string | null {
  switch (reason) {
    case undefined:
      return null;
    case "INVALID_FORMAT":
      return "Meta found a formatting problem, for example a variable at the start or end, two variables side by side, or a sample that does not fit.";
    case "ABUSIVE_CONTENT":
      return "Meta considered the content against its policies.";
    case "PROMOTIONAL":
    case "INCORRECT_CATEGORY":
      return "Meta found promotional content in a utility template. Submit it as Marketing, or remove the promotion.";
    case "TAG_CONTENT_MISMATCH":
      return "The content did not match the chosen category or language.";
    case "SCAM":
      return "Meta considered it a possible scam.";
    default:
      return "Meta rejected it. Check the WhatsApp template guidelines, change it and submit it as a new template.";
  }
}

/** Why a listed template cannot be sent from this app (null when it can). */
export function unsupportedText(reason: string | undefined): string | null {
  switch (reason) {
    case undefined:
      return null;
    case "media_header":
      return "Image, video or document headers cannot be sent from this app yet.";
    case "location_header":
      return "Location headers cannot be sent from this app yet.";
    case "authentication":
      return "Authentication templates cannot be sent from this app.";
    case "unsupported_button":
      return "One of its buttons cannot be sent from this app yet.";
    default:
      return "It cannot be sent from this app yet.";
  }
}

/** createTemplate's own refusals, by `reason` (convex/whatsapp/templateDrafts.ts). */
export const DRAFT_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid_name: "Use lowercase letters, numbers and underscores only for the name.",
  invalid_language: "Choose the template's language.",
  invalid_category: "Choose Utility or Marketing.",
  header_too_long: "The header is longer than 60 characters.",
  header_multiline: "The header must be one line.",
  header_too_many_variables: "The header can have one variable at most.",
  body_missing: "Write the message body.",
  body_too_long: "The body is longer than 1024 characters.",
  footer_too_long: "The footer is longer than 60 characters.",
  footer_variable: "The footer cannot have variables.",
  invalid_variable:
    "Variables are written {{name}} with lowercase letters, numbers and underscores, starting with a letter, or as numbers {{1}}, {{2}}.",
  mixed_variables: "Use either named variables or numbered ones in one template, not both.",
  variables_not_sequential: "Numbered variables must be {{1}}, {{2}}, {{3}}… in order.",
  missing_example: "Every variable needs a sample value for Meta's review.",
  unexpected_example: "A sample was given for a variable the template does not have.",
  example_too_long: "Sample values are 200 characters at most.",
  too_many_buttons:
    "Use at most 10 buttons: up to 10 quick replies, 2 website links and 1 phone number.",
  buttons_not_grouped: "Put quick replies before the other buttons.",
  button_text: "Every button needs a label of up to 25 characters.",
  invalid_url:
    "Enter a full website link starting with https://; only its end may be a {{1}} value.",
  invalid_phone: "Enter the phone number with + and the country code.",
};

/** Meta's refusals of a new template that we can explain (PROVISIONAL codes). */
const META_REFUSALS: Readonly<Record<string, string>> = {
  meta_100_2388024:
    "A template with this name already exists in this language. Choose another name.",
  meta_100_2388023:
    "A template with this name is still being deleted. Choose another name or try again later.",
};

function details(error: unknown): { reason?: string; field?: string } {
  if (!isMarketingError(error)) return {};
  const d = error.data.details ?? {};
  return {
    ...(typeof d.reason === "string" ? { reason: d.reason } : {}),
    ...(typeof d.field === "string" ? { field: d.field } : {}),
  };
}

/** A refused template listing, creation or deletion, in fixed words. */
export function templateErrorNotice(error: unknown, action: "list" | "create" | "delete"): Notice {
  const { reason } = details(error);
  const known = reason !== undefined ? DRAFT_ERROR_MESSAGES[reason] : undefined;
  if (known) return { tone: "error", title: "Template not valid", message: known };
  if (reason !== undefined && META_REFUSALS[reason]) {
    return { tone: "error", title: "Meta refused the template", message: META_REFUSALS[reason]! };
  }
  if (reason === "reconnect_required") {
    return {
      tone: "warning",
      title: "Connect WhatsApp again",
      message: "Meta no longer accepts this connection. Reconnect it in the WhatsApp settings.",
    };
  }
  if (reason === "account_disconnected") {
    return {
      tone: "warning",
      title: "Account disconnected",
      message: "This WhatsApp account is disconnected. Connect it again in the WhatsApp settings.",
    };
  }
  if (isMarketingError(error)) {
    switch (error.data.code) {
      case "CONFLICT":
        return {
          tone: "error",
          title: action === "delete" ? "Meta refused the deletion" : "Meta refused the template",
          message:
            action === "delete"
              ? "Meta did not delete this template. Disabled templates cannot be deleted."
              : `Meta did not accept this template${reason?.startsWith("meta_") ? ` (${reason.replace("meta_", "code ").replace(/_/g, " ")})` : ""}. Check it against WhatsApp's template guidelines and try again.`,
        };
      case "PROVIDER_ERROR":
        return {
          tone: "error",
          title: "Meta did not answer",
          message: `Meta did not answer as expected. Try again. ${SUPPORT}`,
        };
      case "FORBIDDEN":
        return {
          tone: "error",
          title: "Admins only",
          message: "Only organization admins can create or delete templates.",
        };
      case "NOT_FOUND":
        return {
          tone: "error",
          title: "Account not found",
          message: "This WhatsApp account no longer exists. Reload the page.",
        };
      case "UNAUTHENTICATED":
        return { tone: "error", title: "Signed out", message: "Sign in again, then retry." };
    }
  }
  const what = {
    list: "Templates could not be loaded",
    create: "Template not submitted",
    delete: "Template not deleted",
  }[action];
  return { tone: "error", title: what, message: `Something went wrong. Try again. ${SUPPORT}` };
}
