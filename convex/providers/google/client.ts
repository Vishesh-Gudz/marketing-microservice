import { GOOGLE_ADS_ORIGIN, OAUTH_TOKEN_URL, USERINFO_URL } from "./config";

/**
 * Minimal read-only Google Ads HTTP client (Phase 9, G-D2/G-D8). Plain `fetch` in the
 * default Convex runtime; no SDK, no retries (the sync engine owns retries).
 *
 * - URLs come only from fixed templates, and EVERY request is checked against an endpoint
 *   allowlist before any network call: the OAuth token endpoint, OpenID userinfo,
 *   customers:listAccessibleCustomers and customers/{id}/googleAds:search. The `adwords`
 *   scope can write, so mutate/searchStream/any other path is refused here (G-D8).
 * - Tokens travel only in the Authorization header or a form body, never in a URL.
 * - Results never carry the URL, headers, tokens, messages or request ids; failures are
 *   structured codes (errors.ts classifies them).
 */

export type GoogleAdsErrorCode = { family: string; code: string };

export type GoogleFailure =
  | { type: "network" }
  | { type: "timeout" }
  | { type: "invalid_json"; status: number }
  | {
      type: "http";
      status: number;
      /** google.rpc status name, e.g. "PERMISSION_DENIED". */
      rpcStatus?: string;
      /** GoogleAdsFailure error codes, e.g. { family: "authorizationError", code: "USER_PERMISSION_DENIED" }. */
      adsErrors: GoogleAdsErrorCode[];
      /** OAuth token endpoint error, e.g. "invalid_grant". */
      oauthError?: string;
      /** Largest retry delay reported (google.rpc.RetryInfo / quota error details). */
      retryAfterMs?: number;
    };

export type GoogleResult =
  { ok: true; status: number; body: unknown } | { ok: false; failure: GoogleFailure };

/** A request outside the read-only allowlist (refused before any network call). */
export class ForbiddenEndpointError extends Error {
  constructor() {
    super("Endpoint is not allowed by the read-only Google Ads client");
    this.name = "ForbiddenEndpointError";
  }
}

const ALLOWED: readonly { method: "GET" | "POST"; pattern: RegExp }[] = [
  { method: "POST", pattern: /^https:\/\/oauth2\.googleapis\.com\/token$/ },
  { method: "GET", pattern: /^https:\/\/openidconnect\.googleapis\.com\/v1\/userinfo$/ },
  {
    method: "GET",
    pattern: /^https:\/\/googleads\.googleapis\.com\/v\d{2,3}\/customers:listAccessibleCustomers$/,
  },
  {
    method: "POST",
    pattern:
      /^https:\/\/googleads\.googleapis\.com\/v\d{2,3}\/customers\/\d{10}\/googleAds:search$/,
  },
];

export function assertAllowedEndpoint(method: string, url: string): void {
  if (!ALLOWED.some((rule) => rule.method === method && rule.pattern.test(url))) {
    throw new ForbiddenEndpointError();
  }
}

const DURATION = /^(\d{1,6})(?:\.(\d{1,9}))?s$/;

/** "30s" / "1.5s" (protobuf Duration JSON) → ms; malformed → undefined. */
export function parseDuration(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = DURATION.exec(value);
  if (!match) return undefined;
  const fraction = match[2] ? Number(`0.${match[2]}`) : 0;
  return Math.round((Number(match[1]) + fraction) * 1000);
}

function maxDefined(values: (number | undefined)[]): number | undefined {
  const present = values.filter((v): v is number => v !== undefined);
  return present.length > 0 ? Math.max(...present) : undefined;
}

const FAMILY = /^[a-z][A-Za-z]{0,63}Error$/;
const CODE = /^[A-Z][A-Z0-9_]{0,99}$/;
const OAUTH_ERROR = /^[a-z][a-z_]{0,63}$/;
const RPC_STATUS = /^[A-Z][A-Z_]{0,63}$/;

/** Structured failure fields of an error body (Google Ads API error or OAuth error). */
export function parseErrorBody(
  body: unknown,
): Pick<
  Extract<GoogleFailure, { type: "http" }>,
  "rpcStatus" | "adsErrors" | "oauthError" | "retryAfterMs"
> {
  const adsErrors: GoogleAdsErrorCode[] = [];
  const delays: (number | undefined)[] = [];
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") {
    return OAUTH_ERROR.test(error) ? { adsErrors, oauthError: error } : { adsErrors };
  }
  if (typeof error !== "object" || error === null) return { adsErrors };
  const e = error as { status?: unknown; details?: unknown };
  for (const detail of Array.isArray(e.details) ? e.details : []) {
    if (typeof detail !== "object" || detail === null) continue;
    const d = detail as { retryDelay?: unknown; errors?: unknown };
    delays.push(parseDuration(d.retryDelay));
    for (const entry of Array.isArray(d.errors) ? d.errors : []) {
      const errorCode = (entry as { errorCode?: unknown } | null)?.errorCode;
      if (typeof errorCode === "object" && errorCode !== null) {
        for (const [family, code] of Object.entries(errorCode as Record<string, unknown>)) {
          if (FAMILY.test(family) && typeof code === "string" && CODE.test(code)) {
            adsErrors.push({ family, code });
          }
        }
      }
      const quota = (entry as { details?: { quotaErrorDetails?: { retryDelay?: unknown } } } | null)
        ?.details?.quotaErrorDetails;
      delays.push(parseDuration(quota?.retryDelay));
    }
  }
  const retryAfterMs = maxDefined(delays);
  return {
    adsErrors,
    ...(typeof e.status === "string" && RPC_STATUS.test(e.status) ? { rpcStatus: e.status } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
}

/** The transport: allowlist check FIRST, then fetch with a timeout. */
export async function sendChecked(
  method: "GET" | "POST",
  url: string,
  init: { headers: Record<string, string>; body?: string },
  timeoutMs: number,
): Promise<GoogleResult> {
  assertAllowedEndpoint(method, url);
  // Always the runtime's fetch, resolved per call (tests stub the global).
  const doFetch = globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await doFetch(url, { method, ...init, signal: controller.signal });
  } catch {
    // Never propagate the underlying error: it may contain the URL.
    return { ok: false, failure: { type: controller.signal.aborted ? "timeout" : "network" } };
  } finally {
    clearTimeout(timer);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok)
      return { ok: false, failure: { type: "invalid_json", status: response.status } };
    body = undefined;
  }
  if (!response.ok) {
    return {
      ok: false,
      failure: { type: "http", status: response.status, ...parseErrorBody(body) },
    };
  }
  return { ok: true, status: response.status, body };
}

export type AdsAuth = {
  accessToken: string;
  /** Manager customer id (10 digits) when the account is reached through a manager. */
  loginCustomerId?: string;
};

const CUSTOMER_ID = /^\d{10}$/;

/**
 * Google Ads API headers. No `developer-token`: developer tokens were sunset on 2026-09-09,
 * API access belongs to the Google Cloud project that owns the OAuth client, and Google will
 * reject the header in a future major version (docs/providers/google-ads.md "API access").
 */
function adsHeaders(auth: AdsAuth): Record<string, string> {
  if (auth.loginCustomerId !== undefined && !CUSTOMER_ID.test(auth.loginCustomerId)) {
    throw new ForbiddenEndpointError();
  }
  return {
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: "application/json",
    ...(auth.loginCustomerId !== undefined ? { "login-customer-id": auth.loginCustomerId } : {}),
  };
}

export function createGoogleAdsClient(options: { version: string; timeoutMs: number }) {
  const base = `${GOOGLE_ADS_ORIGIN}/${options.version}`;
  return {
    version: options.version,

    /** OAuth token endpoint (code exchange or refresh): form body, no secret in the URL. */
    async token(form: Record<string, string>): Promise<GoogleResult> {
      return await sendChecked(
        "POST",
        OAUTH_TOKEN_URL,
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            Accept: "application/json",
          },
          body: new URLSearchParams(form).toString(),
        },
        options.timeoutMs,
      );
    },

    /** OpenID userinfo (`sub` only with the `openid` scope). */
    async userinfo(accessToken: string): Promise<GoogleResult> {
      return await sendChecked(
        "GET",
        USERINFO_URL,
        { headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" } },
        options.timeoutMs,
      );
    },

    /** Customers the OAuth user can access directly (no login-customer-id). */
    async listAccessibleCustomers(auth: Omit<AdsAuth, "loginCustomerId">): Promise<GoogleResult> {
      return await sendChecked(
        "GET",
        `${base}/customers:listAccessibleCustomers`,
        { headers: adsHeaders(auth) },
        options.timeoutMs,
      );
    },

    /** One page of a GAQL query (read-only). */
    async search(
      auth: AdsAuth,
      customerId: string,
      query: string,
      pageToken?: string,
    ): Promise<GoogleResult> {
      if (!CUSTOMER_ID.test(customerId)) throw new ForbiddenEndpointError();
      return await sendChecked(
        "POST",
        `${base}/customers/${customerId}/googleAds:search`,
        {
          headers: { ...adsHeaders(auth), "Content-Type": "application/json" },
          body: JSON.stringify({ query, ...(pageToken !== undefined ? { pageToken } : {}) }),
        },
        options.timeoutMs,
      );
    },
  };
}

export type GoogleAdsClient = ReturnType<typeof createGoogleAdsClient>;
