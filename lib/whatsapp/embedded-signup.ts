/**
 * Meta's Embedded Signup in the browser (ADR 0014, B3), without React. Facts from Meta's
 * "Embedded Signup implementation" page (read 2026-10-24):
 *
 * - FB.login(callback, { config_id, response_type: "code", override_default_response_type:
 *   true, extras: { setup: {} } }) opens the flow; the callback carries the exchangeable code
 *   in `response.authResponse.code` (valid for 30 seconds).
 * - The WABA and phone number ids arrive separately, as a `message` event whose `data` is a
 *   JSON string with `type: "WA_EMBEDDED_SIGNUP"` and an `event`: FINISH (with
 *   `phone_number_id`, `waba_id`), other FINISH_* variants, CANCEL (with `current_step`, or
 *   with `error_message` / `error_code` / `session_id` for an error) or ERROR.
 *
 * Nothing here is trusted by the server: it verifies the code, the WABA and the number with
 * Meta itself (convex/whatsapp/signup.ts). The browser side only refuses anything that does
 * not come from Meta, and pairs the code with the ids of the SAME signup.
 */

export const SIGNUP_MESSAGE_TYPE = "WA_EMBEDDED_SIGNUP";

/** Mirrors the server's CODE_PATTERN: the code is refused locally if it could never pass. */
const CODE_PATTERN = /^[\x21-\x7e]{1,4096}$/;
const NUMERIC_ID = /^\d{1,32}$/;
const STEP = /^[A-Z][A-Z0-9_]{0,63}$/;
const ERROR_CODE = /^\d{1,12}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * How long to wait for Meta's FINISH message once the code arrived without it. Well inside the
 * code's 30 seconds, so the server still has time to exchange it. There is no limit the other
 * way round: Meta counts the final screen as finished (its docs: clicking Finish or closing the
 * popup there is a successful signup), so FINISH can come long before the popup closes and the
 * FB.login callback delivers the code; the callback always comes once the popup closes.
 */
export const PAIRING_TIMEOUT_MS = 10_000;

/**
 * Whether a `message` event comes from Meta. Meta's sample only checks
 * `origin.endsWith("facebook.com")`, which also accepts e.g. "https://evilfacebook.com"; this
 * requires an exact https origin on facebook.com or one of its subdomains, without a port.
 */
export function isFacebookOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.port === "" &&
    url.origin === origin &&
    (url.hostname === "facebook.com" || url.hostname.endsWith(".facebook.com"))
  );
}

/** Finish variants Meta documents that this release does not support (ADR 0014, D6). */
export type UnsupportedFinish =
  "only_waba" | "business_app" | "obo_migration" | "grant_only" | "other";

const UNSUPPORTED_FINISH: Readonly<Record<string, UnsupportedFinish>> = {
  FINISH_ONLY_WABA: "only_waba",
  FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING: "business_app",
  FINISH_OBO_MIGRATION: "obo_migration",
  FINISH_GRANT_ONLY_API_ACCESS: "grant_only",
};

export type SignupMessage =
  | { kind: "finish"; wabaId: string; phoneNumberId: string }
  | { kind: "unsupported"; variant: UnsupportedFinish }
  | { kind: "cancel"; step?: string }
  | { kind: "error"; errorCode?: string; sessionId?: string }
  /** A FINISH without usable ids. */
  | { kind: "malformed" };

function idOf(value: unknown): string | undefined {
  if (typeof value === "string" && NUMERIC_ID.test(value)) return value;
  // Large ids lose precision as numbers; only exact small integers are accepted.
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return String(value);
  }
  return undefined;
}

function matching(value: unknown, pattern: RegExp): string | undefined {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && pattern.test(text) ? text : undefined;
}

function errorOf(data: Record<string, unknown>): SignupMessage {
  const errorCode = matching(data.error_code, ERROR_CODE);
  const sessionId = matching(data.session_id, SESSION_ID);
  return {
    kind: "error",
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
  };
}

/**
 * The Embedded Signup message in a `message` event, or null when the event is not one (another
 * sender, another type, unparsable data or an unknown event). Never throws.
 */
export function parseSignupMessage(origin: string, raw: unknown): SignupMessage | null {
  if (!isFacebookOrigin(origin) || typeof raw !== "string" || raw.length > 65_536) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const message = parsed as { type?: unknown; event?: unknown; data?: unknown };
  if (message.type !== SIGNUP_MESSAGE_TYPE || typeof message.event !== "string") return null;
  const data =
    typeof message.data === "object" && message.data !== null
      ? (message.data as Record<string, unknown>)
      : {};

  if (message.event === "FINISH") {
    const wabaId = idOf(data.waba_id);
    const phoneNumberId = idOf(data.phone_number_id);
    return wabaId !== undefined && phoneNumberId !== undefined
      ? { kind: "finish", wabaId, phoneNumberId }
      : { kind: "malformed" };
  }
  if (message.event.startsWith("FINISH_")) {
    return { kind: "unsupported", variant: UNSUPPORTED_FINISH[message.event] ?? "other" };
  }
  if (message.event === "ERROR") return errorOf(data);
  if (message.event === "CANCEL") {
    // Meta reports errors as CANCEL with error details, and abandonment with the step reached.
    if (data.error_message !== undefined || data.error_code !== undefined) return errorOf(data);
    const step = matching(data.current_step, STEP);
    return { kind: "cancel", ...(step !== undefined ? { step } : {}) };
  }
  return null;
}

/** The exchangeable code of an FB.login response, or null (closed, cancelled or blocked). */
export function codeOfLoginResponse(response: unknown): string | null {
  const code = (response as { authResponse?: { code?: unknown } | null } | null)?.authResponse
    ?.code;
  return typeof code === "string" && CODE_PATTERN.test(code) ? code : null;
}

// ---------------------------------------------------------------------------
// One signup attempt: pairing the code with the ids
// ---------------------------------------------------------------------------

/** Why an attempt ended without reaching the server. */
export type SignupEnd =
  | { reason: "cancelled"; step?: string }
  /** The popup was closed (or blocked) before Meta reported anything. */
  | { reason: "closed" }
  | { reason: "meta_error"; errorCode?: string; sessionId?: string }
  | { reason: "unsupported"; variant: UnsupportedFinish }
  /** Only one half (code or ids) arrived, or the ids were unusable. */
  | { reason: "incomplete" };

export type SignupAttempt =
  | { phase: "idle" }
  | {
      phase: "waiting";
      code?: string;
      finish?: { wabaId: string; phoneNumberId: string };
    }
  | { phase: "ready"; code: string; wabaId: string; phoneNumberId: string }
  | { phase: "ended"; end: SignupEnd };

export type SignupEvent =
  | { type: "start" }
  /** The FB.login callback: the code, or null when it carried none. */
  | { type: "login"; code: string | null }
  | { type: "message"; message: SignupMessage }
  /** PAIRING_TIMEOUT_MS passed since the code arrived without FINISH. */
  | { type: "timeout" }
  /** The ready attempt was handed to the server; its code is dropped here. */
  | { type: "submitted" };

export const IDLE: SignupAttempt = { phase: "idle" };

function paired(
  code: string | undefined,
  finish: { wabaId: string; phoneNumberId: string } | undefined,
): SignupAttempt {
  if (code !== undefined && finish !== undefined) return { phase: "ready", code, ...finish };
  return {
    phase: "waiting",
    ...(code !== undefined ? { code } : {}),
    ...(finish !== undefined ? { finish } : {}),
  };
}

/**
 * The attempt's next state. An attempt reaches the server only as `ready` (both halves of the
 * same signup), and only once: anything after it ended (or was submitted) is ignored.
 */
export function nextAttempt(attempt: SignupAttempt, event: SignupEvent): SignupAttempt {
  if (event.type === "start") return attempt.phase === "waiting" ? attempt : { phase: "waiting" };
  if (event.type === "submitted") return attempt.phase === "ready" ? IDLE : attempt;
  if (attempt.phase !== "waiting") return attempt;

  switch (event.type) {
    case "login":
      if (event.code !== null) return paired(event.code, attempt.finish);
      return {
        phase: "ended",
        end: attempt.finish !== undefined ? { reason: "incomplete" } : { reason: "closed" },
      };
    case "message": {
      const { message } = event;
      switch (message.kind) {
        case "finish":
          return paired(attempt.code, {
            wabaId: message.wabaId,
            phoneNumberId: message.phoneNumberId,
          });
        case "unsupported":
          return { phase: "ended", end: { reason: "unsupported", variant: message.variant } };
        case "cancel":
          return {
            phase: "ended",
            end: {
              reason: "cancelled",
              ...(message.step !== undefined ? { step: message.step } : {}),
            },
          };
        case "error":
          return {
            phase: "ended",
            end: {
              reason: "meta_error",
              ...(message.errorCode !== undefined ? { errorCode: message.errorCode } : {}),
              ...(message.sessionId !== undefined ? { sessionId: message.sessionId } : {}),
            },
          };
        case "malformed":
          return { phase: "ended", end: { reason: "incomplete" } };
      }
      return attempt;
    }
    case "timeout":
      // Only a code still waiting for its ids expires; FINISH waits for the popup to close.
      return awaitingFinish(attempt) ? { phase: "ended", end: { reason: "incomplete" } } : attempt;
  }
}

/** Whether the code arrived without FINISH, i.e. the pairing timer should run. */
export function awaitingFinish(attempt: SignupAttempt): boolean {
  return attempt.phase === "waiting" && attempt.code !== undefined && attempt.finish === undefined;
}
