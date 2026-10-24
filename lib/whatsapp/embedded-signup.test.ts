import { describe, expect, it } from "vitest";
import {
  awaitingFinish,
  codeOfLoginResponse,
  IDLE,
  isFacebookOrigin,
  nextAttempt,
  parseSignupMessage,
  type SignupAttempt,
  type SignupEvent,
} from "./embedded-signup";

const META = "https://www.facebook.com";
const WABA = "100000000000001";
const PHONE = "200000000000001";
const CODE = "AQ-test-signup-code";

function message(event: string, data: Record<string, unknown> = {}, type = "WA_EMBEDDED_SIGNUP") {
  return JSON.stringify({ type, event, data });
}

describe("isFacebookOrigin", () => {
  it("accepts https facebook.com and its subdomains", () => {
    for (const origin of [
      "https://www.facebook.com",
      "https://web.facebook.com",
      "https://facebook.com",
      "https://business.facebook.com",
    ]) {
      expect(isFacebookOrigin(origin), origin).toBe(true);
    }
  });

  it("refuses look-alikes, http, ports, paths and garbage (Meta's endsWith check would not)", () => {
    for (const origin of [
      "https://evilfacebook.com",
      "https://www.facebook.com.evil.example",
      "http://www.facebook.com",
      "https://www.facebook.com:8443",
      "https://www.facebook.com/",
      "https://user@www.facebook.com",
      "https://facebook.co",
      "null",
      "",
      "facebook.com",
    ]) {
      expect(isFacebookOrigin(origin), origin).toBe(false);
    }
  });
});

describe("parseSignupMessage", () => {
  it("reads FINISH with the WABA and phone number ids", () => {
    expect(
      parseSignupMessage(
        META,
        message("FINISH", { waba_id: WABA, phone_number_id: PHONE, business_id: "3" }),
      ),
    ).toEqual({ kind: "finish", wabaId: WABA, phoneNumberId: PHONE });
    // Small numeric ids are accepted exactly; unusable ids make the FINISH malformed.
    expect(
      parseSignupMessage(META, message("FINISH", { waba_id: 123, phone_number_id: 456 })),
    ).toEqual({ kind: "finish", wabaId: "123", phoneNumberId: "456" });
    for (const data of [
      { waba_id: WABA },
      { phone_number_id: PHONE },
      { waba_id: "waba", phone_number_id: PHONE },
      { waba_id: WABA, phone_number_id: 2 ** 60 },
      {},
    ]) {
      expect(parseSignupMessage(META, message("FINISH", data))).toEqual({ kind: "malformed" });
    }
    expect(
      parseSignupMessage(META, JSON.stringify({ type: "WA_EMBEDDED_SIGNUP", event: "FINISH" })),
    ).toEqual({
      kind: "malformed",
    });
  });

  it("maps the other FINISH variants to unsupported", () => {
    const variants = {
      FINISH_ONLY_WABA: "only_waba",
      FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING: "business_app",
      FINISH_OBO_MIGRATION: "obo_migration",
      FINISH_GRANT_ONLY_API_ACCESS: "grant_only",
      FINISH_SOMETHING_NEW: "other",
    };
    for (const [event, variant] of Object.entries(variants)) {
      expect(parseSignupMessage(META, message(event, { waba_id: WABA }))).toEqual({
        kind: "unsupported",
        variant,
      });
    }
  });

  it("reads CANCEL with its step, and errors (CANCEL with error details, or ERROR)", () => {
    expect(
      parseSignupMessage(META, message("CANCEL", { current_step: "PHONE_NUMBER_SETUP" })),
    ).toEqual({ kind: "cancel", step: "PHONE_NUMBER_SETUP" });
    expect(parseSignupMessage(META, message("CANCEL", { current_step: "<b>x</b>" }))).toEqual({
      kind: "cancel",
    });
    expect(
      parseSignupMessage(
        META,
        message("CANCEL", {
          error_message: "Something on Meta's side",
          error_code: "524126",
          session_id: "f34b51dab5e0498",
          timestamp: 1,
        }),
      ),
    ).toEqual({ kind: "error", errorCode: "524126", sessionId: "f34b51dab5e0498" });
    expect(
      parseSignupMessage(META, message("ERROR", { error_code: 1, session_id: "bad id!" })),
    ).toEqual({ kind: "error", errorCode: "1" });
  });

  it("ignores everything that is not an Embedded Signup message from Meta", () => {
    const finish = message("FINISH", { waba_id: WABA, phone_number_id: PHONE });
    expect(parseSignupMessage("https://evilfacebook.com", finish)).toBeNull();
    expect(parseSignupMessage("http://localhost:3000", finish)).toBeNull();
    expect(parseSignupMessage(META, message("FINISH", {}, "OTHER_TYPE"))).toBeNull();
    expect(parseSignupMessage(META, message("SOMETHING_ELSE"))).toBeNull();
    expect(parseSignupMessage(META, "{not json")).toBeNull();
    expect(parseSignupMessage(META, JSON.parse(finish))).toBeNull(); // objects are not sent
    expect(parseSignupMessage(META, "null")).toBeNull();
    expect(parseSignupMessage(META, `"${"x".repeat(70_000)}"`)).toBeNull();
  });
});

describe("codeOfLoginResponse", () => {
  it("returns the code only when FB.login carried a usable one", () => {
    expect(codeOfLoginResponse({ authResponse: { code: CODE }, status: "connected" })).toBe(CODE);
    for (const response of [
      undefined,
      null,
      {},
      { authResponse: null, status: "unknown" },
      { authResponse: { code: 42 } },
      { authResponse: { code: "has space" } },
      { authResponse: { code: "" } },
    ]) {
      expect(codeOfLoginResponse(response)).toBeNull();
    }
  });
});

describe("nextAttempt", () => {
  const finish = (wabaId = WABA, phoneNumberId = PHONE): SignupEvent => ({
    type: "message",
    message: { kind: "finish", wabaId, phoneNumberId },
  });
  const run = (...events: SignupEvent[]) =>
    events.reduce<SignupAttempt>((attempt, event) => nextAttempt(attempt, event), IDLE);
  const ready = { phase: "ready", code: CODE, wabaId: WABA, phoneNumberId: PHONE };

  it("pairs the code and the ids of one signup, in either order", () => {
    expect(run({ type: "start" }, { type: "login", code: CODE }, finish())).toEqual(ready);
    expect(run({ type: "start" }, finish(), { type: "login", code: CODE })).toEqual(ready);
  });

  it("ends without the server when the signup was closed, cancelled, failed or unsupported", () => {
    expect(run({ type: "start" }, { type: "login", code: null })).toEqual({
      phase: "ended",
      end: { reason: "closed" },
    });
    expect(run({ type: "start" }, finish(), { type: "login", code: null })).toEqual({
      phase: "ended",
      end: { reason: "incomplete" },
    });
    expect(
      run({ type: "start" }, { type: "message", message: { kind: "cancel", step: "X" } }),
    ).toEqual({ phase: "ended", end: { reason: "cancelled", step: "X" } });
    expect(
      run(
        { type: "start" },
        { type: "login", code: CODE },
        { type: "message", message: { kind: "error", errorCode: "7" } },
      ),
    ).toEqual({ phase: "ended", end: { reason: "meta_error", errorCode: "7" } });
    expect(
      run(
        { type: "start" },
        { type: "message", message: { kind: "unsupported", variant: "only_waba" } },
      ),
    ).toEqual({ phase: "ended", end: { reason: "unsupported", variant: "only_waba" } });
    expect(run({ type: "start" }, { type: "message", message: { kind: "malformed" } })).toEqual({
      phase: "ended",
      end: { reason: "incomplete" },
    });
  });

  it("gives up on a code whose FINISH does not follow, but never on a FINISH waiting for its code", () => {
    expect(run({ type: "start" }, { type: "login", code: CODE }, { type: "timeout" })).toEqual({
      phase: "ended",
      end: { reason: "incomplete" },
    });
    const finishFirst = run({ type: "start" }, finish(), { type: "timeout" }, { type: "timeout" });
    expect(finishFirst).toEqual({
      phase: "waiting",
      finish: { wabaId: WABA, phoneNumberId: PHONE },
    });
    expect(nextAttempt(finishFirst, { type: "login", code: CODE })).toEqual(ready);
    expect(run({ type: "start" }, { type: "timeout" })).toEqual({ phase: "waiting" });
  });

  it("reaches the server once: nothing changes a ready or ended attempt, submit drops the code", () => {
    const readyAttempt = run({ type: "start" }, { type: "login", code: CODE }, finish());
    expect(nextAttempt(readyAttempt, finish("1", "2"))).toBe(readyAttempt);
    expect(nextAttempt(readyAttempt, { type: "login", code: "other" })).toBe(readyAttempt);
    expect(nextAttempt(readyAttempt, { type: "submitted" })).toEqual(IDLE);
    const ended = run({ type: "start" }, { type: "login", code: null });
    expect(nextAttempt(ended, finish())).toBe(ended);
    expect(nextAttempt(ended, { type: "submitted" })).toBe(ended);
    expect(nextAttempt(IDLE, finish())).toBe(IDLE); // no signup started: ignored
    expect(nextAttempt(IDLE, { type: "login", code: CODE })).toBe(IDLE);
  });

  it("starts fresh after an attempt ended, and ignores a second start while waiting", () => {
    const waiting = run({ type: "start" }, { type: "login", code: CODE });
    expect(nextAttempt(waiting, { type: "start" })).toBe(waiting);
    const ended = run({ type: "start" }, { type: "login", code: null });
    expect(nextAttempt(ended, { type: "start" })).toEqual({ phase: "waiting" });
  });

  it("runs the pairing timer only while the code waits for FINISH", () => {
    expect(awaitingFinish(run({ type: "start" }))).toBe(false);
    expect(awaitingFinish(run({ type: "start" }, { type: "login", code: CODE }))).toBe(true);
    // FINISH first: Meta's final screen counts as finished; the code comes when the window
    // closes, however long the user stays there.
    expect(awaitingFinish(run({ type: "start" }, finish()))).toBe(false);
    expect(awaitingFinish(run({ type: "start" }, finish(), { type: "login", code: CODE }))).toBe(
      false,
    );
  });
});
