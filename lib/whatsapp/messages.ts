import { isMarketingError } from "@/convex/lib/errors";
import type { Notice } from "@/lib/connections/types";
import type { SignupEnd, UnsupportedFinish } from "./embedded-signup";
import type {
  DisconnectResult,
  SetupResult,
  SetupStatus,
  SetupStep,
  WhatsAppAccount,
  WhatsAppMessage,
} from "./types";

/**
 * Fixed, user-facing text for connecting WhatsApp (ADR 0014, B3). Only public contract values
 * are inspected (error code, the `reason` / `stage` details, setup statuses and reasons);
 * server messages and Meta's error text are never shown. Meta's own error code and session id
 * from the signup window are shown for support, as Meta reports them to the browser.
 */

const SUPPORT = "If it keeps happening, contact support.";

/** completeSignup / retrySetup refusals, by `details.reason` (docs/whatsapp.md). */
export const SIGNUP_ERROR_MESSAGES: Readonly<Record<string, Omit<Notice, "tone">>> = {
  invalid_code: {
    title: "Signup could not be completed",
    message: "Meta's signup answer was not usable. Start again.",
  },
  invalid_id: {
    title: "Signup could not be completed",
    message: "Meta's signup answer was not usable. Start again.",
  },
  signup_code_invalid: {
    title: "Signup expired",
    message: "The signup took too long or was already used. Start again.",
  },
  connections_disabled: {
    title: "WhatsApp is not available",
    message: "WhatsApp can't be connected on this service yet. Contact an administrator.",
  },
  not_configured: {
    title: "WhatsApp is not available",
    message: "WhatsApp is not set up on this service yet. Contact an administrator.",
  },
  token_invalid: {
    title: "Meta did not confirm the signup",
    message: "Start again and finish every step in the Meta window.",
  },
  token_wrong_app: {
    title: "Signup was made for another app",
    message: "Start again from this page.",
  },
  scopes_missing: {
    title: "Permissions missing",
    message: "Start again and allow every permission Meta asks for.",
  },
  waba_not_granted: {
    title: "WhatsApp account not shared",
    message: "Start again and share the WhatsApp Business account with this service.",
  },
  waba_not_accessible: {
    title: "WhatsApp account not accessible",
    message: "This service could not read the WhatsApp Business account. Start again.",
  },
  phone_number_not_in_waba: {
    title: "Number not in this account",
    message: "The phone number does not belong to the WhatsApp Business account. Start again.",
  },
  waba_in_use: {
    title: "Account connected elsewhere",
    message:
      "This WhatsApp Business account is connected to another organization. Disconnect it there first.",
  },
  phone_number_in_use: {
    title: "Number connected elsewhere",
    message: "This phone number is connected to another organization. Disconnect it there first.",
  },
  phone_number_operator_managed: {
    title: "Number set up by support",
    message:
      "This number is already set up for your organization by support, so it can't be connected here. Contact support to move it.",
  },
  stored_pin_unavailable: {
    title: "Connection can't be updated",
    message: "The saved WhatsApp connection could not be read. Contact support.",
  },
  signup_in_progress: {
    title: "Another signup finished first",
    message: "Someone connected this account at the same time. Check its status below.",
  },
  account_disconnected: {
    title: "Account disconnected",
    message: "This WhatsApp account is disconnected. Connect WhatsApp again.",
  },
  reconnect_required: {
    title: "Connect WhatsApp again",
    message: "Meta no longer accepts this connection. Use Connect WhatsApp to reconnect it.",
  },
  disconnect_in_progress: {
    title: "Still disconnecting",
    message:
      "This WhatsApp account is still being disconnected. Try again once the disconnect has finished.",
  },
};

function detail(error: unknown, key: "reason" | "stage"): string | undefined {
  if (!isMarketingError(error)) return undefined;
  const value = error.data.details?.[key];
  return typeof value === "string" ? value : undefined;
}

/** A completeSignup or retrySetup failure, in fixed words. */
export function signupErrorNotice(error: unknown): Notice {
  const known = SIGNUP_ERROR_MESSAGES[detail(error, "reason") ?? ""];
  if (known) {
    const warning = ["signup_in_progress", "reconnect_required", "signup_code_invalid"];
    return { tone: warning.includes(detail(error, "reason")!) ? "warning" : "error", ...known };
  }
  if (isMarketingError(error)) {
    switch (error.data.code) {
      case "PROVIDER_ERROR":
        return {
          tone: "error",
          title: "Meta could not complete the signup",
          message: `Meta did not answer as expected. Start again. ${SUPPORT}`,
        };
      case "FORBIDDEN":
        return {
          tone: "error",
          title: "Admins only",
          message: "Only organization admins can connect WhatsApp.",
        };
      case "UNAUTHENTICATED":
        return { tone: "error", title: "Signed out", message: "Sign in again, then retry." };
      case "NOT_FOUND":
        return {
          tone: "error",
          title: "Account not found",
          message: "This WhatsApp account no longer exists. Reload the page.",
        };
    }
  }
  return {
    tone: "error",
    title: "WhatsApp could not be connected",
    message: `Something went wrong. Start again. ${SUPPORT}`,
  };
}

/** A Meta step name ("PHONE_NUMBER_SETUP") in words ("phone number setup"). */
export function stepInWords(step: string): string {
  return step.toLowerCase().replace(/_/g, " ");
}

const UNSUPPORTED_MESSAGES: Readonly<Record<UnsupportedFinish, string>> = {
  only_waba: "No phone number was chosen. Start again and add or select a phone number.",
  business_app:
    "Numbers already used in the WhatsApp Business app can't be connected yet. Start again with another number.",
  obo_migration: "Moving a number from another provider isn't supported yet.",
  grant_only: "This kind of signup isn't supported yet. Start again and connect a phone number.",
  other: "This kind of signup isn't supported yet. Start again and connect a phone number.",
};

/** Why a signup ended in the browser, before reaching the server. */
export function signupEndNotice(end: SignupEnd): Notice {
  switch (end.reason) {
    case "cancelled":
      return {
        tone: "info",
        title: "Signup cancelled",
        message:
          end.step !== undefined
            ? `WhatsApp signup was cancelled at the “${stepInWords(end.step)}” step. Start again when you are ready.`
            : "WhatsApp signup was cancelled. Start again when you are ready.",
      };
    case "closed":
      return {
        tone: "info",
        title: "Signup window closed",
        message:
          "The Meta window closed before the signup finished. If it did not open, allow pop-ups for this site and try again.",
      };
    case "meta_error": {
      const reference = [
        end.errorCode !== undefined ? `error code ${end.errorCode}` : undefined,
        end.sessionId !== undefined ? `session ${end.sessionId}` : undefined,
      ].filter((part) => part !== undefined);
      return {
        tone: "error",
        title: "Meta reported an error",
        message:
          `The signup failed in the Meta window. Start again. ${SUPPORT}` +
          (reference.length > 0 ? ` Reference: ${reference.join(", ")}.` : ""),
      };
    }
    case "unsupported":
      return {
        tone: "warning",
        title: "Signup not supported",
        message: UNSUPPORTED_MESSAGES[end.variant],
      };
    case "incomplete":
      return {
        tone: "warning",
        title: "Signup did not finish",
        message: "Meta did not finish the signup. Start again.",
      };
  }
}

export const SDK_FAILED_NOTICE: Notice = {
  tone: "error",
  title: "Meta sign-in could not load",
  message:
    "Check that nothing blocks facebook.com on this page (for example, a content blocker), then reload.",
};

export const UNAVAILABLE_NOTICE: Notice = {
  tone: "info",
  title: "WhatsApp is not available yet",
  message: "WhatsApp can't be connected on this service yet. Contact an administrator.",
};

export const SETUP_STATUS_LABELS: Readonly<Record<SetupStatus, string>> = {
  connected: "Connected",
  action_required: "Setup not finished",
  reauthorization_required: "Reconnect required",
  disconnected: "Disconnected",
};

/** One setup reason (a sanitized server code) in words; unknown codes get a generic text. */
export function setupReasonText(
  reason: string | undefined,
  nextStep: SetupStep | undefined,
): string {
  switch (reason) {
    case "registration_in_progress":
      return "Setup is running right now. Check back in a moment.";
    case "registration_rate_limited":
    case "meta_133016":
      return "Meta limits how often a number can be registered. Retry setup after the time shown.";
    case "registration_attempts_exhausted":
      return "Registering this number failed too many times. Contact support.";
    case "no_active_number":
      return "This account has no active phone number. Use Connect WhatsApp to add one.";
    case "token_invalid":
      return "Meta no longer accepts this connection. Connect WhatsApp again.";
    case "network":
    case "timeout":
      return "Meta could not be reached. Retry setup.";
  }
  if (nextStep === "subscribe") {
    return "Meta has not finished turning on messages for this account. Retry setup.";
  }
  if (nextStep === "register") {
    return reason?.startsWith("meta_")
      ? "Meta refused to register this number. Numbers with two-step verification already turned on are not supported yet. Retry setup or contact support."
      : "The number is not registered for messaging yet. Retry setup.";
  }
  return `Setup is not finished. ${SUPPORT}`;
}

/** completeSignup / retrySetup succeeded at the server: where setup stands. */
export function setupResultNotice(result: SetupResult): Notice {
  switch (result.status) {
    case "connected":
      return {
        tone: "success",
        title: "WhatsApp connected",
        message: "The number is set up and receives messages in this app.",
      };
    case "action_required":
      return {
        tone: "warning",
        title: "WhatsApp connected, setup not finished",
        message: setupReasonText(result.reason, result.nextStep),
      };
    case "reauthorization_required":
      return {
        tone: "warning",
        title: "Connect WhatsApp again",
        message: setupReasonText(result.reason ?? "token_invalid", undefined),
      };
    case "disconnected":
      return {
        tone: "info",
        title: "Account disconnected",
        message: "This WhatsApp account is disconnected.",
      };
  }
}

/** The account card's explanation (none when connected or disconnected). */
export function accountSetupText(account: WhatsAppAccount): string | null {
  if (account.setupStatus === "action_required") {
    return setupReasonText(account.setupReason, account.nextStep);
  }
  if (account.setupStatus === "reauthorization_required") {
    return setupReasonText(account.setupReason ?? "token_invalid", undefined);
  }
  return null;
}

/** Shown when Meta's cleanup gave up (ADR 0014 B4): the customer can remove our access. */
const CLEANUP_FAILED =
  "Meta could not be told to stop sending this account's messages here. Its stored access was deleted. To remove this app's access completely, remove it in your Meta business settings.";

/** disconnectAccount succeeded: routing has stopped; where Meta's cleanup stands. */
export function disconnectResultNotice(result: DisconnectResult): Notice {
  switch (result.cleanup) {
    case "done":
      return {
        tone: "success",
        title: "WhatsApp disconnected",
        message:
          "Messages for this account no longer reach this app. Conversations and messages so far are kept.",
      };
    case "pending":
      return {
        tone: "warning",
        title: "WhatsApp disconnected, Meta cleanup still running",
        message:
          "Messages for this account no longer reach this app. Telling Meta did not work yet; it is retried automatically.",
      };
    case "failed":
      return { tone: "warning", title: "WhatsApp disconnected", message: CLEANUP_FAILED };
  }
}

/** A disconnected account's cleanup, in words (null otherwise). */
export function accountCleanupText(account: WhatsAppAccount): string | null {
  if (account.status !== "disconnected") return null;
  switch (account.cleanup?.status) {
    case "pending":
      return "Disconnected. Telling Meta is still being retried; the account can be connected again once that has finished.";
    case "failed":
      return `Disconnected. ${CLEANUP_FAILED} Use Connect WhatsApp to connect it again.`;
    default:
      return "Disconnected. Use Connect WhatsApp to connect it again.";
  }
}

// ---------------------------------------------------------------------------
// Sending (ADR 0013 stage 5): refusals of sendText / sendTemplate / listTemplates, and why an
// outbound message failed or is unconfirmed. Fixed words only; Meta's own text never appears.
// ---------------------------------------------------------------------------

const SETTINGS = "in the WhatsApp settings";

/** Refusals by `details.reason` (convex/whatsapp/outbound.ts, convex/whatsapp/templates.ts). */
export const SEND_ERROR_MESSAGES: Readonly<Record<string, Omit<Notice, "tone">>> = {
  service_window_closed: {
    title: "Reply window closed",
    message: "The customer last wrote more than 24 hours ago. Send an approved template instead.",
  },
  number_cannot_send: {
    title: "This number cannot send from here",
    message: "It was set up by support. Contact support to send messages from it.",
  },
  number_unavailable: {
    title: "Number no longer connected",
    message: `This WhatsApp number is no longer connected. Check it ${SETTINGS}.`,
  },
  reconnect_required: {
    title: "Connect WhatsApp again",
    message: `Meta no longer accepts this connection. Reconnect it ${SETTINGS}.`,
  },
  number_not_ready: {
    title: "Number not ready",
    message: `This number is not registered for messaging yet. Finish its setup ${SETTINGS}.`,
  },
  template_unavailable: {
    title: "Template not available",
    message: "This template is not approved for your account any more. Choose another one.",
  },
  template_unsupported: {
    title: "Template not supported",
    message: "This template cannot be sent from here yet. Choose another one.",
  },
  credential_unavailable: {
    title: "Connection could not be read",
    message: `The saved WhatsApp connection could not be read. ${SUPPORT}`,
  },
  missing_value: {
    title: "Fill in every value",
    message: "Every placeholder of the template needs a value.",
  },
  blank_value: {
    title: "Fill in every value",
    message: "Every placeholder of the template needs a value.",
  },
  too_long: { title: "A value is too long", message: "Shorten it and send again." },
  header_too_long: {
    title: "Header too long",
    message: "Filled in, the template's header is longer than 60 characters. Shorten its value.",
  },
  body_too_long: {
    title: "Message too long",
    message: "Filled in, the template is longer than 1024 characters. Shorten its values.",
  },
  unexpected_value: {
    title: "The template has changed",
    message: "Choose the template again and fill it in.",
  },
};

/** A refused send or template listing, in fixed words. */
export function sendErrorNotice(error: unknown): Notice {
  const reason = detail(error, "reason");
  const known = reason !== undefined ? SEND_ERROR_MESSAGES[reason] : undefined;
  if (known) return { tone: reason === "service_window_closed" ? "warning" : "error", ...known };
  if (isMarketingError(error)) {
    switch (error.data.code) {
      case "PROVIDER_ERROR":
        return {
          tone: "error",
          title: "Meta did not answer",
          message: `Meta did not answer as expected. Try again. ${SUPPORT}`,
        };
      case "INVALID_ARGUMENT":
        return {
          tone: "error",
          title: "Message not valid",
          message: "Check the message (1 to 4096 characters) and send again.",
        };
      case "FORBIDDEN":
        return {
          tone: "error",
          title: "Editors and admins only",
          message: "Only editors and admins can send WhatsApp messages.",
        };
      case "UNAUTHENTICATED":
        return { tone: "error", title: "Signed out", message: "Sign in again, then retry." };
      case "NOT_FOUND":
        return {
          tone: "error",
          title: "Conversation not found",
          message: "This conversation no longer exists. Go back to the inbox.",
        };
    }
  }
  return {
    tone: "error",
    title: "Message not sent",
    message: `Something went wrong. Try again. ${SUPPORT}`,
  };
}

/** Why an outbound message failed or is not confirmed (null for any other message). */
export function deliveryProblemText(
  message: Pick<WhatsAppMessage, "status" | "errorCode" | "failureReason">,
): string | null {
  if (message.status === "unknown") {
    return "WhatsApp did not confirm this message. It may have been sent: check with the customer before sending it again.";
  }
  if (message.status !== "failed") return null;
  const code = message.errorCode;
  switch (code) {
    case 131047:
      return "The customer's 24-hour reply window had closed. Send an approved template instead.";
    case 131026:
      return "WhatsApp could not deliver it to this number; it may not use WhatsApp.";
    case 131049:
      return "WhatsApp held it back to protect the customer's experience. Try again later.";
    case 131050:
      return "The customer has stopped messages from businesses.";
    case 131056:
    case 130429:
      return "Too many messages were sent in a short time. Try again in a moment.";
    case 190:
    case 102:
      return `Meta no longer accepts this connection. Reconnect it ${SETTINGS}.`;
  }
  if (code !== undefined && code >= 132000 && code < 133000) {
    return "Meta refused the template: it may be paused, changed or filled in wrongly.";
  }
  switch (message.failureReason) {
    case "not_sent":
      return "It could not be sent. Try again.";
    case "number_unavailable":
    case "number_cannot_send":
    case "number_not_ready":
      return `The number could no longer send when it was due. Check it ${SETTINGS}.`;
    case "reconnect_required":
      return `Meta no longer accepts this connection. Reconnect it ${SETTINGS}.`;
  }
  return "It could not be delivered.";
}
