import { isMarketingError } from "@/convex/lib/errors";
import { isAdConnectionProvider, PROVIDERS, type AdConnectionProvider } from "./providers";
import type { Notice } from "./types";

/**
 * The OAuth callback's redirect parameters (docs/connections.md). The server appends only
 * `status=pending&claim=<one-time code>` (S2: the consent is stored as a pending grant that
 * the same signed-in user must claim with v1/connections:completeConnect) or
 * `status=error&error=<code>`. `status=connected&connection=<id>[&warning=discovery_failed]`
 * is the result of a successful claim (and the callback's format before S2; display only).
 * Parsing is defensive: unknown error codes collapse to "unknown", anything else unexpected
 * is "malformed", and no parameter value is ever shown to the user (the notices below are
 * fixed text). The result names no provider: the dashboard's own return URL carries a
 * display-only `connect=<provider>` hint, which only picks the notice's wording (no hint:
 * neutral wording).
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
export const CONNECT_RESULT_PARAMS = ["status", "connection", "warning", "error", "claim"] as const;
/** The return URL's provider hint (lib/connections/navigation.ts connectReturnUrl). */
export const CONNECT_PROVIDER_PARAM = "connect";
/** Removed after reading. `code` / `state` never belong on a dashboard URL: dropped too. */
const STRIPPED_PARAMS = [
  ...CONNECT_RESULT_PARAMS,
  CONNECT_PROVIDER_PARAM,
  "code",
  "state",
] as const;

/** Convex document ids are lowercase letters and digits. */
const CONNECTION_ID = /^[a-z0-9]{1,64}$/;
/** Claim codes: 32 random bytes, base64url (mirrors the server's CLAIM_CODE_PATTERN). */
const CLAIM_CODE = /^[A-Za-z0-9_-]{43}$/;

/** The provider the dashboard started the connection for (exactly one known hint value). */
type Hint = { provider?: AdConnectionProvider };

export type ConnectResult =
  | { kind: "none" }
  | ({ kind: "pending"; claim: string } & Hint)
  | ({ kind: "connected"; connectionId: string; discoveryFailed: boolean } & Hint)
  | ({ kind: "error"; error: CallbackError | "unknown" } & Hint)
  | ({ kind: "malformed" } & Hint);

/** `URLSearchParams`, or Next's read-only `useSearchParams()` value. */
type ReadableParams = Pick<URLSearchParams, "get" | "getAll">;

function isCallbackError(value: string | null): value is CallbackError {
  return value !== null && (CALLBACK_ERRORS as readonly string[]).includes(value);
}

function providerHint(params: ReadableParams): Hint {
  const values = params.getAll(CONNECT_PROVIDER_PARAM);
  return values.length === 1 && isAdConnectionProvider(values[0]) ? { provider: values[0] } : {};
}

export function parseConnectResult(params: ReadableParams): ConnectResult {
  const present = CONNECT_RESULT_PARAMS.filter((name) => params.getAll(name).length > 0);
  if (present.length === 0) return { kind: "none" };
  const hint = providerHint(params);
  // A repeated result parameter is ambiguous: never pick one.
  if (present.some((name) => params.getAll(name).length > 1)) return { kind: "malformed", ...hint };

  const status = params.get("status");
  if (status === "pending") {
    const claim = params.get("claim");
    if (
      claim === null ||
      !CLAIM_CODE.test(claim) ||
      params.get("connection") !== null ||
      params.get("error") !== null
    )
      return { kind: "malformed", ...hint };
    return { kind: "pending", claim, ...hint };
  }
  if (status === "connected") {
    const connectionId = params.get("connection");
    if (
      connectionId === null ||
      !CONNECTION_ID.test(connectionId) ||
      params.get("error") !== null ||
      params.get("claim") !== null
    )
      return { kind: "malformed", ...hint };
    // Unknown warnings are ignored (never displayed).
    return {
      kind: "connected",
      connectionId,
      discoveryFailed: params.get("warning") === "discovery_failed",
      ...hint,
    };
  }
  if (status === "error") {
    const error = params.get("error");
    return { kind: "error", error: isCallbackError(error) ? error : "unknown", ...hint };
  }
  return { kind: "malformed", ...hint };
}

/** A copy of `params` without the result parameters (other parameters, e.g. filters, stay). */
export function withoutConnectResult(params: { toString(): string }): URLSearchParams {
  const next = new URLSearchParams(params.toString());
  for (const name of STRIPPED_PARAMS) next.delete(name);
  return next;
}

/** Fixed text for a callback error, in the provider's words (neutral without a hint). */
function errorNotice(error: CallbackError | "unknown", provider?: AdConnectionProvider): Notice {
  const p = provider !== undefined ? PROVIDERS[provider] : undefined;
  switch (error) {
    case "access_denied":
      return {
        tone: "warning",
        title: p ? `${p.name} access was not granted` : "Access was not granted",
        message: "The sign-in was cancelled or access was declined. Try again and allow access.",
      };
    case "invalid_state":
      return {
        tone: "error",
        title: "This sign-in request is not valid",
        message: "It was already used or was not started here. Start the connection again.",
      };
    case "expired_state":
      return {
        tone: "error",
        title: "The sign-in took too long",
        message: "Sign-in requests expire after 10 minutes. Start the connection again.",
      };
    case "exchange_failed":
      return p
        ? {
            tone: "error",
            title: `${p.platform} sign-in could not be completed`,
            message: `Make sure the ${p.identity} you sign in with has access to a ${p.accountNoun}, then try again.`,
          }
        : {
            tone: "error",
            title: "The sign-in could not be completed",
            message: "Try connecting again.",
          };
    case "identity_mismatch":
      return p
        ? {
            tone: "error",
            title: `A different ${p.identity} was used`,
            message: `Reconnect only accepts the ${p.identity} that created this connection. To use another ${p.identity}, an admin must disconnect ${p.name} first, then connect again.`,
          }
        : {
            tone: "error",
            title: "A different account was used",
            message:
              "Reconnect only accepts the account that created this connection. To use another account, an admin must disconnect it first, then connect again.",
          };
    case "discovery_failed":
      return {
        tone: "error",
        title: p
          ? `Your ${p.accountNoun}s could not be loaded`
          : "Your accounts could not be loaded",
        message: "Retry account discovery for the connection below.",
      };
    case "internal":
      return {
        tone: "error",
        title: "Something went wrong",
        message: "The connection could not be completed. Try again later.",
      };
    case "unknown":
      return {
        tone: "error",
        title: "The connection could not be completed",
        message: p ? `Try connecting ${p.name} again.` : "Try connecting again.",
      };
  }
}

/** Fixed text for a parsed result; `null` when there is nothing to show. */
export function connectResultNotice(result: ConnectResult): Notice | null {
  if (result.kind === "none") return null;
  const name = result.provider !== undefined ? PROVIDERS[result.provider].name : undefined;
  switch (result.kind) {
    case "pending":
      return {
        tone: "info",
        title: name ? `Finishing the ${name} connection…` : "Finishing the connection…",
        message: "Checking that you started this connection.",
      };
    case "connected":
      return result.discoveryFailed
        ? {
            tone: "warning",
            title: name
              ? `${name} connected, but your accounts could not be loaded`
              : "Connected, but your accounts could not be loaded",
            message: "Retry account discovery below.",
          }
        : {
            tone: "success",
            title: name ? `${name} connected` : "Connected",
            message: "Choose the account to link below.",
          };
    case "error":
      return errorNotice(result.error, result.provider);
    case "malformed":
      return {
        tone: "warning",
        title: "The connection result could not be read",
        message: name
          ? `Check the ${name} connection status below, and connect again if needed.`
          : "Check the connection status below, and connect again if needed.",
      };
  }
}

/**
 * Fixed text for a refused claim (v1/connections:completeConnect). Only the public error code
 * and the allowlisted `reason` are inspected; server messages are never displayed.
 */
export function claimErrorNotice(error: unknown, provider?: AdConnectionProvider): Notice {
  const p = provider !== undefined ? PROVIDERS[provider] : undefined;
  if (isMarketingError(error)) {
    const { code, details } = error.data;
    if (details?.reason === "identity_mismatch") return errorNotice("identity_mismatch", provider);
    if (details?.reason === "expired_claim")
      return {
        tone: "error",
        title: "The connection request expired",
        message:
          "Connection requests must be finished within 10 minutes. Start the connection again.",
      };
    if (details?.reason === "invalid_claim")
      return {
        tone: "error",
        title: "This connection request is not valid",
        message:
          "It was already used, has expired, or was started by another user or organization. Start the connection again.",
      };
    if (code === "FORBIDDEN")
      return {
        tone: "error",
        title: "Admins only",
        message: "Only the organization admin who started this connection can finish it.",
      };
    if (details?.reason === "connections_disabled")
      return {
        tone: "error",
        title: p ? `${p.name} is not available` : "Connections are not available",
        message: "Platform connections are not enabled on this service yet.",
      };
  }
  return {
    tone: "error",
    title: "The connection could not be completed",
    message: p ? `Try connecting ${p.name} again.` : "Try connecting again.",
  };
}
