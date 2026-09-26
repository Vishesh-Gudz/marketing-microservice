import { GRAPH_ORIGIN } from "./config";

/**
 * Minimal Meta Graph HTTP client (Phase 8, D2/D6). Plain `fetch` in the default
 * Convex runtime; no SDK, no retries (the sync engine owns retries).
 *
 * - Ads reads are GET-only; the access token travels in the Authorization header,
 *   never in the URL. appsecret_proof (HMAC-SHA256 of the token with the app
 *   secret) is added to every token-bearing call.
 * - OAuth token exchanges POST a form body, so client secrets and codes never
 *   appear in a URL (V2 confirms Meta's acceptance at G2).
 * - Results never carry the request URL, headers or token; failures are
 *   structured (see errors.ts) so no message text or payload is ever stored.
 * - `paging.next` URLs are never followed (they embed the token); callers pass
 *   `paging.cursors.after` back as the `after` parameter.
 */

export type UsageHeaders = {
  /** Max X-Business-Use-Case-Usage estimated_time_to_regain_access (minutes). */
  regainAccessMinutes?: number;
  /** X-Ad-Account-Usage reset_time_duration (seconds). */
  accountResetSeconds?: number;
  /** Retry-After (seconds). */
  retryAfterSeconds?: number;
};

export type GraphErrorBody = {
  code?: number;
  subcode?: number;
  isTransient?: boolean;
};

export type GraphFailure =
  | { type: "network" }
  | { type: "timeout" }
  | { type: "invalid_json"; status: number }
  | { type: "http"; status: number; error?: GraphErrorBody; usage: UsageHeaders };

export type GraphResult =
  | { ok: true; status: number; body: unknown; usage: UsageHeaders }
  | { ok: false; failure: GraphFailure };

export type GraphClientOptions = {
  version: string;
  timeoutMs: number;
};

const PATH = /^[A-Za-z0-9_./-]{1,200}$/;

function url(version: string, path: string, params: Record<string, string>): string {
  if (!PATH.test(path) || path.startsWith("/") || path.includes("..")) {
    throw new Error("Invalid Graph path");
  }
  const query = new URLSearchParams(params).toString();
  return `${GRAPH_ORIGIN}/${version}/${path}${query ? `?${query}` : ""}`;
}

function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** appsecret_proof = hex(HMAC-SHA256(key = app secret, message = access token)). */
export async function appSecretProof(appSecret: string, accessToken: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(accessToken)));
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseJsonHeader(value: string | null): unknown {
  if (value === null || value.length > 16_384) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** Throttling hints from the usage headers; malformed headers are ignored. */
export function parseUsageHeaders(headers: Headers): UsageHeaders {
  const usage: UsageHeaders = {};

  const buc = parseJsonHeader(headers.get("x-business-use-case-usage"));
  if (buc !== null && typeof buc === "object") {
    let max: number | undefined;
    for (const entries of Object.values(buc as Record<string, unknown>)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        const minutes = finiteNumber(
          (entry as { estimated_time_to_regain_access?: unknown } | null)
            ?.estimated_time_to_regain_access,
        );
        if (minutes !== undefined) max = Math.max(max ?? 0, minutes);
      }
    }
    if (max !== undefined) usage.regainAccessMinutes = max;
  }

  const account = parseJsonHeader(headers.get("x-ad-account-usage"));
  if (account !== null && typeof account === "object") {
    const seconds = finiteNumber(
      (account as { reset_time_duration?: unknown }).reset_time_duration,
    );
    if (seconds !== undefined) usage.accountResetSeconds = seconds;
  }

  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && /^\d{1,6}$/.test(retryAfter.trim())) {
    usage.retryAfterSeconds = Number(retryAfter.trim());
  }
  return usage;
}

function graphErrorOf(body: unknown): GraphErrorBody | undefined {
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error !== "object" || error === null) return undefined;
  const e = error as { code?: unknown; error_subcode?: unknown; is_transient?: unknown };
  return {
    ...(typeof e.code === "number" && Number.isInteger(e.code) ? { code: e.code } : {}),
    ...(typeof e.error_subcode === "number" && Number.isInteger(e.error_subcode)
      ? { subcode: e.error_subcode }
      : {}),
    ...(typeof e.is_transient === "boolean" ? { isTransient: e.is_transient } : {}),
  };
}

export function createGraphClient(options: GraphClientOptions) {
  async function send(target: string, init: RequestInit): Promise<GraphResult> {
    // Always the runtime's fetch, resolved per call (no injection option; tests stub the global).
    const doFetch = globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    let response: Response;
    try {
      response = await doFetch(target, { ...init, signal: controller.signal });
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
    const usage = parseUsageHeaders(response.headers);
    if (!response.ok || graphErrorOf(body) !== undefined) {
      const error = graphErrorOf(body);
      return {
        ok: false,
        failure: {
          type: "http",
          status: response.status,
          ...(error !== undefined ? { error } : {}),
          usage,
        },
      };
    }
    return { ok: true, status: response.status, body, usage };
  }

  return {
    version: options.version,

    /** Token-bearing GET (ads reads, /me, /me/permissions). */
    async get(
      path: string,
      params: Record<string, string>,
      auth: { accessToken: string; appSecret: string },
    ): Promise<GraphResult> {
      const proof = await appSecretProof(auth.appSecret, auth.accessToken);
      return await send(url(options.version, path, { ...params, appsecret_proof: proof }), {
        method: "GET",
        headers: { Authorization: `Bearer ${auth.accessToken}`, Accept: "application/json" },
      });
    },

    /** GET authorized with an app access token (debug_token); no appsecret_proof. */
    async getAsApp(
      path: string,
      params: Record<string, string>,
      appToken: string,
    ): Promise<GraphResult> {
      return await send(url(options.version, path, params), {
        method: "GET",
        headers: { Authorization: `Bearer ${appToken}`, Accept: "application/json" },
      });
    },

    /** OAuth token endpoint: form-encoded POST body (no secrets in the URL). */
    async postForm(path: string, form: Record<string, string>): Promise<GraphResult> {
      return await send(url(options.version, path, {}), {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: new URLSearchParams(form).toString(),
      });
    },
  };
}

export type GraphClient = ReturnType<typeof createGraphClient>;
