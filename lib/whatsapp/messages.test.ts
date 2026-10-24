import { describe, expect, it } from "vitest";
import { apiError } from "@/convex/lib/errors";
import {
  accountCleanupText,
  accountSetupText,
  deliveryProblemText,
  disconnectResultNotice,
  SEND_ERROR_MESSAGES,
  sendErrorNotice,
  SETUP_STATUS_LABELS,
  setupReasonText,
  setupResultNotice,
  signupEndNotice,
  signupErrorNotice,
  SIGNUP_ERROR_MESSAGES,
  stepInWords,
} from "./messages";
import type { WhatsAppAccount } from "./types";

// Every refusal reason completeSignup / retrySetup can send (convex/whatsapp/signup.ts,
// docs/whatsapp.md). A new server reason must get its own text here.
const SERVER_REASONS = [
  "invalid_code",
  "invalid_id",
  "signup_code_invalid",
  "connections_disabled",
  "not_configured",
  "token_invalid",
  "token_wrong_app",
  "scopes_missing",
  "waba_not_granted",
  "waba_not_accessible",
  "phone_number_not_in_waba",
  "waba_in_use",
  "phone_number_in_use",
  "phone_number_operator_managed",
  "stored_pin_unavailable",
  "signup_in_progress",
  "account_disconnected",
  "reconnect_required",
  "disconnect_in_progress",
];
const SERVER_TEXT = "server-side detail that must not be shown";

function account(overrides: Partial<WhatsAppAccount> = {}): WhatsAppAccount {
  return {
    id: "acc1",
    connectionId: "conn1",
    wabaId: "100000000000001",
    status: "active",
    setupStatus: "connected",
    connectedAt: "2026-10-24T10:00:00.000Z",
    numbers: [],
    ...overrides,
  };
}

describe("signupErrorNotice", () => {
  it("has its own fixed text for every server reason, and never shows the server message", () => {
    expect(Object.keys(SIGNUP_ERROR_MESSAGES).sort()).toEqual([...SERVER_REASONS].sort());
    for (const reason of SERVER_REASONS) {
      const notice = signupErrorNotice(apiError("CONFLICT", SERVER_TEXT, { reason }));
      expect(notice.title, reason).toBe(SIGNUP_ERROR_MESSAGES[reason]!.title);
      expect(JSON.stringify(notice), reason).not.toContain(SERVER_TEXT);
      expect(JSON.stringify(notice), reason).not.toContain(reason);
    }
  });

  it("is a warning for a race or a stale code, an error otherwise", () => {
    expect(
      signupErrorNotice(apiError("CONFLICT", "x", { reason: "signup_in_progress" })).tone,
    ).toBe("warning");
    expect(signupErrorNotice(apiError("CONFLICT", "x", { reason: "waba_in_use" })).tone).toBe(
      "error",
    );
  });

  it("explains provider errors, roles and anything unknown without details", () => {
    const provider = signupErrorNotice(
      apiError("PROVIDER_ERROR", SERVER_TEXT, { stage: "code_exchange", reason: "http_503" }),
    );
    expect(provider.title).toBe("Meta could not complete the signup");
    expect(JSON.stringify(provider)).not.toMatch(/http_503|code_exchange|server-side/);
    expect(signupErrorNotice(apiError("FORBIDDEN", SERVER_TEXT)).title).toBe("Admins only");
    expect(signupErrorNotice(apiError("NOT_FOUND", SERVER_TEXT)).title).toBe("Account not found");
    for (const error of [new Error(SERVER_TEXT), "boom", apiError("INTERNAL", SERVER_TEXT)]) {
      const notice = signupErrorNotice(error);
      expect(notice.title).toBe("WhatsApp could not be connected");
      expect(JSON.stringify(notice)).not.toContain(SERVER_TEXT);
    }
  });
});

describe("signupEndNotice", () => {
  it("explains every way a signup can end in the browser", () => {
    expect(signupEndNotice({ reason: "cancelled", step: "PHONE_NUMBER_SETUP" }).message).toContain(
      "“phone number setup” step",
    );
    expect(signupEndNotice({ reason: "cancelled" }).title).toBe("Signup cancelled");
    expect(signupEndNotice({ reason: "closed" }).message).toContain("allow pop-ups");
    expect(
      signupEndNotice({ reason: "meta_error", errorCode: "524126", sessionId: "abc123" }).message,
    ).toContain("Reference: error code 524126, session abc123.");
    expect(signupEndNotice({ reason: "meta_error" }).message).not.toContain("Reference");
    expect(signupEndNotice({ reason: "unsupported", variant: "only_waba" }).message).toContain(
      "No phone number was chosen",
    );
    expect(signupEndNotice({ reason: "unsupported", variant: "business_app" }).message).toContain(
      "WhatsApp Business app",
    );
    expect(signupEndNotice({ reason: "incomplete" }).title).toBe("Signup did not finish");
  });

  it("puts Meta step names in words", () => {
    expect(stepInWords("WABA_SETUP")).toBe("waba setup");
  });
});

describe("setup status texts", () => {
  it("labels every status and explains every known reason in words", () => {
    expect(Object.keys(SETUP_STATUS_LABELS).sort()).toEqual(
      ["action_required", "connected", "disconnected", "reauthorization_required"].sort(),
    );
    const texts = [
      setupReasonText("registration_in_progress", "register"),
      setupReasonText("registration_rate_limited", "register"),
      setupReasonText("meta_133016", "register"),
      setupReasonText("registration_attempts_exhausted", "register"),
      setupReasonText("no_active_number", undefined),
      setupReasonText("token_invalid", undefined),
      setupReasonText("timeout", "subscribe"),
      setupReasonText("http_503", "subscribe"),
      setupReasonText("meta_100", "register"),
      setupReasonText(undefined, "register"),
      setupReasonText("something_new", undefined),
    ];
    for (const text of texts) expect(text).not.toMatch(/meta_|http_|_/);
    expect(setupReasonText("meta_100", "register")).toContain("two-step verification");
    expect(setupReasonText("http_503", "subscribe")).toContain("turning on messages");
  });

  it("reports a setup result and an account's status in words", () => {
    expect(setupResultNotice({ accountId: "a", status: "connected" })).toMatchObject({
      tone: "success",
      title: "WhatsApp connected",
    });
    expect(
      setupResultNotice({
        accountId: "a",
        status: "action_required",
        nextStep: "register",
        reason: "registration_in_progress",
      }).message,
    ).toBe("Setup is running right now. Check back in a moment.");
    expect(setupResultNotice({ accountId: "a", status: "reauthorization_required" }).title).toBe(
      "Connect WhatsApp again",
    );
    expect(accountSetupText(account())).toBeNull();
    expect(
      accountSetupText(
        account({ setupStatus: "action_required", setupReason: "no_active_number" }),
      ),
    ).toContain("no active phone number");
    expect(accountSetupText(account({ setupStatus: "reauthorization_required" }))).toContain(
      "Connect WhatsApp again",
    );
  });
});

describe("disconnect texts", () => {
  it("reports a disconnect and where Meta's cleanup stands", () => {
    expect(disconnectResultNotice({ accountId: "a", cleanup: "done" })).toMatchObject({
      tone: "success",
      title: "WhatsApp disconnected",
    });
    expect(disconnectResultNotice({ accountId: "a", cleanup: "pending" }).title).toBe(
      "WhatsApp disconnected, Meta cleanup still running",
    );
    expect(disconnectResultNotice({ accountId: "a", cleanup: "failed" }).message).toContain(
      "remove it in your Meta business settings",
    );
  });

  it("explains a disconnected account's cleanup on its card", () => {
    expect(accountCleanupText(account())).toBeNull();
    const disconnected = account({ status: "disconnected", setupStatus: "disconnected" });
    expect(accountCleanupText({ ...disconnected, cleanup: { status: "done" } })).toBe(
      "Disconnected. Use Connect WhatsApp to connect it again.",
    );
    expect(accountCleanupText({ ...disconnected, cleanup: { status: "pending" } })).toContain(
      "still being retried",
    );
    expect(accountCleanupText({ ...disconnected, cleanup: { status: "failed" } })).toContain(
      "Meta business settings",
    );
  });
});

// Every refusal reason sendText / sendTemplate / listTemplates can send (convex/whatsapp/
// outbound.ts, convex/whatsapp/templates.ts). A new server reason must get its own text here.
const SEND_REASONS = [
  "service_window_closed",
  "number_cannot_send",
  "number_unavailable",
  "reconnect_required",
  "number_not_ready",
  "template_unavailable",
  "template_unsupported",
  "credential_unavailable",
  "missing_value",
  "blank_value",
  "too_long",
  "header_too_long",
  "body_too_long",
  "unexpected_value",
];

describe("sendErrorNotice", () => {
  it("has fixed words for every refusal reason, and only for those", () => {
    expect(Object.keys(SEND_ERROR_MESSAGES).sort()).toEqual([...SEND_REASONS].sort());
    for (const reason of SEND_REASONS) {
      const notice = sendErrorNotice(apiError("CONFLICT", "server text never shown", { reason }));
      expect(notice).toMatchObject(SEND_ERROR_MESSAGES[reason]!);
      expect(notice.message).not.toContain("server text");
      expect(notice.tone).toBe(reason === "service_window_closed" ? "warning" : "error");
    }
  });

  it.each([
    ["PROVIDER_ERROR", "Meta did not answer"],
    ["INVALID_ARGUMENT", "Message not valid"],
    ["FORBIDDEN", "Editors and admins only"],
    ["UNAUTHENTICATED", "Signed out"],
    ["NOT_FOUND", "Conversation not found"],
  ] as const)("names a %s without a known reason", (code, title) => {
    expect(sendErrorNotice(apiError(code, "server text"))).toMatchObject({ tone: "error", title });
  });

  it("falls back to a generic text for anything else", () => {
    expect(sendErrorNotice(new Error("network down"))).toMatchObject({
      tone: "error",
      title: "Message not sent",
    });
  });
});

describe("deliveryProblemText", () => {
  it("explains an unconfirmed message, and nothing for one on its way", () => {
    expect(deliveryProblemText({ status: "unknown", failureReason: "timeout" })).toContain(
      "check with the customer before sending it again",
    );
    for (const status of ["pending", "submitted", "sent", "delivered", "read"] as const) {
      expect(deliveryProblemText({ status })).toBeNull();
    }
  });

  it.each([
    [131047, "24-hour reply window had closed"],
    [131026, "could not deliver it to this number"],
    [131049, "held it back"],
    [131050, "stopped messages from businesses"],
    [131056, "Too many messages"],
    [130429, "Too many messages"],
    [190, "Reconnect it in the WhatsApp settings"],
    [132001, "Meta refused the template"],
    [132018, "Meta refused the template"],
  ])("explains Meta's code %s", (errorCode, text) => {
    expect(deliveryProblemText({ status: "failed", errorCode })).toContain(text);
  });

  it.each([
    ["not_sent", "could not be sent"],
    ["number_unavailable", "could no longer send"],
    ["reconnect_required", "Reconnect it"],
    ["something_else", "could not be delivered"],
  ])("explains a failure without a Meta code (%s)", (failureReason, text) => {
    expect(deliveryProblemText({ status: "failed", failureReason })).toContain(text);
  });
});
