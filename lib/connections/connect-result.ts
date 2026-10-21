import type { Notice } from "./types";

/**
 * The OAuth callback's redirect parameters (docs/connections.md). The server appends only
 * `status=connected&connection=<id>[&warning=discovery_failed]` or
 * `status=error&error=<code>`. Parsing is defensive: unknown error codes collapse to
 * "unknown", anything else unexpected is "malformed", and no parameter value is ever shown
 * to the user (the notices below are fixed text).
 */

/** Mirrors the server's CALLBACK_ERROR_CODES (parity-tested in tests/unit). */
export const CALLBACK_ERRORS = [
  "access_denied",
  "invalid_state",
  "expired_state",
  "exchange_failed",
  "identity_mismatch",
  "discovery_failed",
  "internal",
] as const;
export type CallbackError = (typeof CALLBACK_ERRORS)[number];

/** The result parameters the callback appends to the return URL. */
export const CONNECT_RESULT_PARAMS = ["status", "connection", "warning", "error"] as const;
/** Removed after reading. `code` / `state` never belong on a dashboard URL: dropped too. */
const STRIPPED_PARAMS = [...CONNECT_RESULT_PARAMS, "code", "state"] as const;

/** Convex document ids are lowercase letters and digits. */
const CONNECTION_ID = /^[a-z0-9]{1,64}$/;

export type ConnectResult =
  | { kind: "none" }
  | { kind: "connected"; connectionId: string; discoveryFailed: boolean }
  | { kind: "error"; error: CallbackError | "unknown" }
  | { kind: "malformed" };

/** `URLSearchParams`, or Next's read-only `useSearchParams()` value. */
type ReadableParams = Pick<URLSearchParams, "get" | "getAll">;

function isCallbackError(value: string | null): value is CallbackError {
  return value !== null && (CALLBACK_ERRORS as readonly string[]).includes(value);
}

export function parseConnectResult(params: ReadableParams): ConnectResult {
  const present = CONNECT_RESULT_PARAMS.filter((name) => params.getAll(name).length > 0);
  if (present.length === 0) return { kind: "none" };
  // A repeated result parameter is ambiguous: never pick one.
  if (present.some((name) => params.getAll(name).length > 1)) return { kind: "malformed" };

  const status = params.get("status");
  if (status === "connected") {
    const connectionId = params.get("connection");
    if (connectionId === null || !CONNECTION_ID.test(connectionId) || params.get("error") !== null)
      return { kind: "malformed" };
    // Unknown warnings are ignored (never displayed).
    return {
      kind: "connected",
      connectionId,
      discoveryFailed: params.get("warning") === "discovery_failed",
    };
  }
  if (status === "error") {
    const error = params.get("error");
    return { kind: "error", error: isCallbackError(error) ? error : "unknown" };
  }
  return { kind: "malformed" };
}

/** A copy of `params` without the result parameters (other parameters, e.g. filters, stay). */
export function withoutConnectResult(params: { toString(): string }): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  for (const name of STRIPPED_PARAMS) next.delete(name);
  return next;
}

const ERROR_NOTICES: Readonly<Record<CallbackError | "unknown", Notice>> = {
  access_denied: {
    tone: "warning",
    title: "Google Ads access was not granted",
    message: "The sign-in was cancelled or access was declined. Try again and allow access.",
  },
  invalid_state: {
    tone: "error",
    title: "This sign-in request is not valid",
    message: "It was already used or was not started here. Start the connection again.",
  },
  expired_state: {
    tone: "error",
    title: "The sign-in took too long",
    message: "Sign-in requests expire after 10 minutes. Start the connection again.",
  },
  exchange_failed: {
    tone: "error",
    title: "Google sign-in could not be completed",
    message:
      "Make sure the Google account you sign in with has access to a Google Ads account, then try again.",
  },
  identity_mismatch: {
    tone: "error",
    title: "A different Google account was used",
    message:
      "Reconnect only accepts the Google account that created this connection. To use another Google account, an admin must disconnect Google Ads first, then connect again.",
  },
  discovery_failed: {
    tone: "error",
    title: "Your Google Ads accounts could not be loaded",
    message: "Retry account discovery for the connection below.",
  },
  internal: {
    tone: "error",
    title: "Something went wrong",
    message: "The connection could not be completed. Try again later.",
  },
  unknown: {
    tone: "error",
    title: "The connection could not be completed",
    message: "Try connecting Google Ads again.",
  },
};

/** Fixed text for a parsed result (Google Ads flow); `null` when there is nothing to show. */
export function connectResultNotice(result: ConnectResult): Notice | null {
  switch (result.kind) {
    case "none":
      return null;
    case "connected":
      return result.discoveryFailed
        ? {
            tone: "warning",
            title: "Google Ads connected, but your accounts could not be loaded",
            message: "Retry account discovery below.",
          }
        : {
            tone: "success",
            title: "Google Ads connected",
            message: "Choose the account to link below.",
          };
    case "error":
      return ERROR_NOTICES[result.error];
    case "malformed":
      return {
        tone: "warning",
        title: "The connection result could not be read",
        message: "Check the Google Ads connection status below, and connect again if needed.",
      };
  }
}
