import {
  isYouTubePlaylistId,
  isYouTubeVideoId,
  OAUTH_REVOKE_URL,
  OAUTH_TOKEN_URL,
  YOUTUBE_DATA_BASE,
} from "./config";

/**
 * Minimal read-only YouTube HTTP client (ADR 0016, Y-D1). Plain `fetch` in either runtime; no
 * SDK, no retries (the sync engine owns retries).
 *
 * - URLs come only from fixed templates, and EVERY request is checked against an exact
 *   allowlist BEFORE any network access: https only; no user info, port or fragment; a fixed
 *   method + URL per route; exactly the route's query parameter names, each value checked.
 *   Routes: the OAuth token endpoint (authorization-code and refresh grants), token
 *   revocation (disconnect, Checkpoint 2) and three Data API reads (channels mine=true,
 *   playlistItems, videos snippet). Anything else, any write, any API key parameter and any
 *   other host is refused.
 * - Tokens travel only in the Authorization header (Bearer) or a form body, never in a URL.
 * - Every request takes one unit from an explicit per-call request budget.
 * - Results never carry the URL, headers, tokens, messages or request ids; failures are
 *   structured codes (errors.ts classifies them). Fetch exceptions are never propagated
 *   (they may contain the URL).
 */

export type YouTubeFailure =
  | { type: "blocked" }
  | { type: "budget_exceeded" }
  | { type: "network" }
  | { type: "timeout" }
  | { type: "invalid_json"; status: number }
  | {
      type: "http";
      status: number;
      /** Google API error reasons (`error.errors[].reason`, `error.details[].reason`). */
      reasons: string[];
      /** google.rpc status name, e.g. "PERMISSION_DENIED". */
      rpcStatus?: string;
      /** OAuth token endpoint error, e.g. "invalid_grant". */
      oauthError?: string;
      /** From a Retry-After header in seconds, when present. */
      retryAfterMs?: number;
    };

export type YouTubeResult = { ok: true; body: unknown } | { ok: false; failure: YouTubeFailure };

/** A bounded number of platform requests for one provider call. */
export class YouTubeRequestBudget {
  private used = 0;
  constructor(readonly max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new Error("Invalid request budget");
  }
  /** False (and nothing is counted) once the budget is spent. */
  take(): boolean {
    if (this.used >= this.max) return false;
    this.used++;
    return true;
  }
  get count(): number {
    return this.used;
  }
}

// ---------------------------------------------------------------------------
// Allowlist
// ---------------------------------------------------------------------------

/** Parts the Data API reads request (exact strings). */
export const CHANNEL_PARTS = "snippet,statistics,contentDetails";
export const PLAYLIST_ITEM_PARTS = "contentDetails";
export const VIDEO_PARTS = "snippet";

/** [doc] Data API list pages hold at most 50 items; `videos.list` takes ids in batches. */
export const MAX_RESULTS = 50;
/** Opaque Data API page tokens: printable ASCII, bounded. [PROVISIONAL YR3] alphabet. */
const PAGE_TOKEN = /^[\x21-\x7e]{1,4096}$/;

type ParamCheck = (value: string) => boolean;

type Route = {
  method: "GET" | "POST";
  url: string;
  params: Readonly<Record<string, ParamCheck>>;
  required: readonly string[];
};

const exactly =
  (expected: string): ParamCheck =>
  (value) =>
    value === expected;

const pageSize: ParamCheck = (value) =>
  /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_RESULTS;

/** 1..50 distinct video ids, comma-separated. */
const videoIds: ParamCheck = (value) => {
  const ids = value.split(",");
  return (
    ids.length >= 1 &&
    ids.length <= MAX_RESULTS &&
    new Set(ids).size === ids.length &&
    ids.every(isYouTubeVideoId)
  );
};

const ROUTES: readonly Route[] = [
  { method: "POST", url: OAUTH_TOKEN_URL, params: {}, required: [] },
  { method: "POST", url: OAUTH_REVOKE_URL, params: {}, required: [] },
  {
    method: "GET",
    url: `${YOUTUBE_DATA_BASE}/channels`,
    params: { part: exactly(CHANNEL_PARTS), mine: exactly("true"), maxResults: exactly("50") },
    required: ["part", "mine", "maxResults"],
  },
  {
    method: "GET",
    url: `${YOUTUBE_DATA_BASE}/playlistItems`,
    params: {
      part: exactly(PLAYLIST_ITEM_PARTS),
      playlistId: isYouTubePlaylistId,
      maxResults: pageSize,
      pageToken: (value) => PAGE_TOKEN.test(value),
    },
    required: ["part", "playlistId", "maxResults"],
  },
  {
    method: "GET",
    url: `${YOUTUBE_DATA_BASE}/videos`,
    params: { part: exactly(VIDEO_PARTS), id: videoIds },
    required: ["part", "id"],
  },
];

/** True when `method url` is exactly an allowlisted request. Checked before any network call. */
export function isAllowedRequest(method: string, rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return false;
  if (url.port !== "" || url.hash !== "" || rawUrl.includes("#")) return false;
  // The raw URL must spell the route exactly (no default port, case or encoding variants).
  const base = rawUrl.split("?", 1)[0];
  const route = ROUTES.find((r) => r.method === method && r.url === base);
  if (route === undefined || `${url.origin}${url.pathname}` !== base) return false;
  const entries: [string, string][] = [];
  url.searchParams.forEach((value, name) => entries.push([name, value]));
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    const check = route.params[name];
    if (check === undefined || seen.has(name) || !check(value)) return false;
    seen.add(name);
  }
  return route.required.every((name) => seen.has(name));
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const REASON = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const RPC_STATUS = /^[A-Z][A-Z_]{0,63}$/;
const OAUTH_ERROR = /^[a-z][a-z_]{0,63}$/;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/** Structured fields of a Google API error body or an OAuth error body. */
export function parseErrorBody(
  body: unknown,
): Pick<Extract<YouTubeFailure, { type: "http" }>, "reasons" | "rpcStatus" | "oauthError"> {
  const reasons: string[] = [];
  const error = (body as { error?: unknown } | null)?.error;
  if (typeof error === "string") {
    return OAUTH_ERROR.test(error) ? { reasons, oauthError: error } : { reasons };
  }
  if (typeof error !== "object" || error === null) return { reasons };
  const e = error as { status?: unknown; errors?: unknown; details?: unknown };
  for (const list of [e.errors, e.details]) {
    for (const entry of Array.isArray(list) ? list : []) {
      const reason = (entry as { reason?: unknown } | null)?.reason;
      if (typeof reason === "string" && REASON.test(reason) && !reasons.includes(reason)) {
        reasons.push(reason);
      }
    }
  }
  return {
    reasons,
    ...(typeof e.status === "string" && RPC_STATUS.test(e.status) ? { rpcStatus: e.status } : {}),
  };
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get("retry-after");
  if (raw === null || !/^\d{1,6}$/.test(raw.trim())) return undefined;
  const seconds = Number(raw.trim());
  return seconds > 0 && seconds <= MAX_RETRY_AFTER_SECONDS ? seconds * 1_000 : undefined;
}

/** The transport: allowlist check FIRST, then the budget, then fetch with a timeout. */
async function sendChecked(
  method: "GET" | "POST",
  url: string,
  init: { headers: Record<string, string>; body?: string },
  timeoutMs: number,
  budget: YouTubeRequestBudget,
): Promise<YouTubeResult> {
  if (!isAllowedRequest(method, url)) return { ok: false, failure: { type: "blocked" } };
  if (!budget.take()) return { ok: false, failure: { type: "budget_exceeded" } };
  // Always the runtime's fetch, resolved per call (tests stub the global).
  const doFetch = globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await doFetch(url, { method, ...init, signal: controller.signal });
  } catch {
    return { ok: false, failure: { type: controller.signal.aborted ? "timeout" : "network" } };
  } finally {
    clearTimeout(timer);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    if (response.ok) {
      return { ok: false, failure: { type: "invalid_json", status: response.status } };
    }
    body = undefined;
  }
  if (!response.ok) {
    const retry = retryAfterMs(response.headers);
    return {
      ok: false,
      failure: {
        type: "http",
        status: response.status,
        ...parseErrorBody(body),
        ...(retry !== undefined ? { retryAfterMs: retry } : {}),
      },
    };
  }
  return { ok: true, body };
}

function dataUrl(path: string, params: Record<string, string>): string {
  const url = new URL(`${YOUTUBE_DATA_BASE}/${path}`);
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

function bearer(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, Accept: "application/json" };
}

const FORM_HEADERS = {
  "Content-Type": "application/x-www-form-urlencoded",
  Accept: "application/json",
};

export function createYouTubeClient(options: { timeoutMs: number }) {
  const { timeoutMs } = options;
  const postForm = async (
    url: string,
    form: Record<string, string>,
    budget: YouTubeRequestBudget,
  ): Promise<YouTubeResult> =>
    await sendChecked(
      "POST",
      url,
      { headers: FORM_HEADERS, body: new URLSearchParams(form).toString() },
      timeoutMs,
      budget,
    );

  return {
    /**
     * OAuth authorization-code grant with the PKCE verifier (form body; no secret in the URL):
     * access + refresh token.
     */
    async exchangeCode(
      input: {
        code: string;
        redirectUri: string;
        codeVerifier: string;
        clientId: string;
        clientSecret: string;
      },
      budget: YouTubeRequestBudget,
    ): Promise<YouTubeResult> {
      return await postForm(
        OAUTH_TOKEN_URL,
        {
          grant_type: "authorization_code",
          code: input.code,
          redirect_uri: input.redirectUri,
          code_verifier: input.codeVerifier,
          client_id: input.clientId,
          client_secret: input.clientSecret,
        },
        budget,
      );
    },

    /** OAuth refresh grant (form body; no secret in the URL): a fresh access token. */
    async refreshAccessToken(
      input: { refreshToken: string; clientId: string; clientSecret: string },
      budget: YouTubeRequestBudget,
    ): Promise<YouTubeResult> {
      return await postForm(
        OAUTH_TOKEN_URL,
        {
          grant_type: "refresh_token",
          refresh_token: input.refreshToken,
          client_id: input.clientId,
          client_secret: input.clientSecret,
        },
        budget,
      );
    },

    /** [doc] Revokes a token and the grant behind it (the token in the form body only). */
    async revokeToken(token: string, budget: YouTubeRequestBudget): Promise<YouTubeResult> {
      return await postForm(OAUTH_REVOKE_URL, { token }, budget);
    },

    /** [doc] `channels.list?mine=true`: the channels the authorizing user owns (1 unit). */
    async listMyChannels(accessToken: string, budget: YouTubeRequestBudget) {
      return await sendChecked(
        "GET",
        dataUrl("channels", { part: CHANNEL_PARTS, mine: "true", maxResults: "50" }),
        { headers: bearer(accessToken) },
        timeoutMs,
        budget,
      );
    },

    /** [doc] One page of a playlist (the uploads playlist), newest first (1 unit). */
    async listPlaylistItems(
      accessToken: string,
      input: { playlistId: string; maxResults: number; pageToken?: string },
      budget: YouTubeRequestBudget,
    ) {
      return await sendChecked(
        "GET",
        dataUrl("playlistItems", {
          part: PLAYLIST_ITEM_PARTS,
          playlistId: input.playlistId,
          maxResults: String(input.maxResults),
          ...(input.pageToken !== undefined ? { pageToken: input.pageToken } : {}),
        }),
        { headers: bearer(accessToken) },
        timeoutMs,
        budget,
      );
    },

    /** [doc] Video metadata for up to 50 ids in one request (1 unit). */
    async listVideos(accessToken: string, ids: readonly string[], budget: YouTubeRequestBudget) {
      return await sendChecked(
        "GET",
        dataUrl("videos", { part: VIDEO_PARTS, id: ids.join(",") }),
        { headers: bearer(accessToken) },
        timeoutMs,
        budget,
      );
    },
  };
}

export type YouTubeClient = ReturnType<typeof createYouTubeClient>;
