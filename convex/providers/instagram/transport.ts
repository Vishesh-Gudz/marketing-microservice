import {
  GRAPH_HOST,
  INSTAGRAM_GRAPH_VERSION,
  INSTAGRAM_SUBSCRIBED_FIELDS,
  LONG_LIVED_EXCHANGE_PATH,
  REFRESH_PATH,
  TOKEN_HOST,
  UNIFIED_GRAPH_HOST,
  UNIFIED_GRAPH_VERSION,
  UNIFIED_SUBSCRIBED_FIELDS,
} from "./config";

/**
 * The Instagram transport guard (Phase 10). EVERY Instagram request — OAuth, the Graph
 * reader and the social-sdk adapter (through the fetch we inject into it) — is checked
 * here BEFORE any network access. Anything not explicitly allowed is refused.
 *
 * Global rule (unchanged): no secret-like query parameter in any URL. The ONLY approved
 * exception (Stage 0 decision) is Meta's documented GET form of exactly two endpoints:
 *   GET https://graph.instagram.com/access_token
 *       grant_type=ig_exchange_token & client_secret & access_token   (nothing else)
 *   GET https://graph.instagram.com/refresh_access_token
 *       grant_type=ig_refresh_token & access_token                   (nothing else)
 * and only for the "oauth" caller. Those URLs are built right before the fetch and are
 * never logged, persisted, or carried by an error (see sendInstagram below).
 *
 * Everything else:
 * - "oauth":        POST https://api.instagram.com/oauth/access_token (form body, no query)
 * - "graph_reader": GET  https://graph.instagram.com/v25.0/... on the reader allowlist
 * - "sdk":          GET  https://graph.instagram.com/v25.0/... on the SDK allowlist (the
 *                   exact requests social-sdk 0.5.0 makes for the reads we use)
 * - "messaging":    POST https://graph.instagram.com/v25.0/{id}/subscribed_apps with exactly
 *                   `subscribed_fields` and no body (ADR 0017: the webhook subscription), and
 *                   POST https://graph.instagram.com/v25.0/{id}/messages with no query and a
 *                   JSON body (`Content-Type: application/json`; ADR 0017 IM4: a text reply)
 * Graph requests carry the token ONLY in an `Authorization: Bearer` header. (Meta's
 * subscribed_apps sample puts the token in the query, which is refused here; [assume] Meta
 * accepts it as Bearer.)
 *
 * Unified Login (config.ts) uses graph.facebook.com/v26.0 instead, on its own exact routes:
 * - "oauth":        GET /v26.0/oauth/access_token (client_id, client_secret, code,
 *                   redirect_uri) and GET /v26.0/debug_token (input_token, access_token = the
 *                   app token): Meta documents only these GET forms, so they are approved
 *                   secret-in-URL exceptions like the two above (built right before the fetch,
 *                   never logged, persisted or carried by an error)
 * - "graph_reader": GET /v26.0/me/assigned_instagram_accounts?fields=id,username
 * - "messaging":    POST /v26.0/{id}/subscribed_apps (`subscribed_fields` = messages,
 *                   messaging_seen) and POST /v26.0/{id}/messages (JSON body)
 * - "sdk":          nothing (organic sync never runs on a Unified Login token)
 * The token travels as `Authorization: Bearer` here too ([assume] for Unified Login: Meta's
 * samples use the access_token parameter).
 *
 * Nothing here logs. Errors carry a reason code only — never the URL, a header or a body.
 */

export type InstagramCaller = "oauth" | "graph_reader" | "sdk" | "messaging";

export const BLOCK_REASONS = [
  "scheme",
  "credentials_in_url",
  "fragment",
  "port",
  "host",
  "method",
  "path",
  "query",
  "secret_in_url",
  "authorization",
  "body",
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

/** Refused before any network access. The message is generic by design. */
export class TransportBlockedError extends Error {
  constructor(readonly reason: BlockReason) {
    super("Instagram request refused by the transport allowlist");
    this.name = "TransportBlockedError";
  }
}

/** The explicit per-call request budget was exhausted (I-D6): fail, never continue silently. */
export class RequestBudgetExceededError extends Error {
  constructor() {
    super("Instagram request budget exhausted");
    this.name = "RequestBudgetExceededError";
  }
}

/** A bounded number of platform requests for one provider call (or one OAuth flow). */
export class RequestBudget {
  private used = 0;
  constructor(readonly max: number) {
    if (!Number.isSafeInteger(max) || max < 1) throw new Error("Invalid request budget");
  }
  take(): void {
    if (this.used >= this.max) throw new RequestBudgetExceededError();
    this.used++;
  }
  get count(): number {
    return this.used;
  }
}

// ---------------------------------------------------------------------------
// Allowlists
// ---------------------------------------------------------------------------

/** Query parameter names that carry secrets (compared lower-case). */
const SECRET_PARAMS: ReadonlySet<string> = new Set([
  "access_token",
  "client_secret",
  "code",
  "refresh_token",
  "developer_token",
  "token",
  "input_token",
  "fb_exchange_token",
  "appsecret_proof",
  "password",
]);

function isSecretParam(name: string): boolean {
  const lower = name.toLowerCase();
  return SECRET_PARAMS.has(lower) || lower.includes("secret") || lower.includes("token");
}

/** Field lists social-sdk 0.5.0 requests (dist/platforms/instagram.js). Exact match only. */
export const SDK_PROFILE_FIELDS =
  "user_id,id,username,name,biography,profile_picture_url,followers_count,follows_count,media_count,website";
export const SDK_MEDIA_FIELDS =
  "id,caption,media_type,media_product_type,permalink,timestamp,username";
export const SDK_MEDIA_TYPE_FIELDS = "media_product_type";
export const SDK_POST_METRICS = ["likes,comments,saved,shares,reach", "shares,reach"] as const;

/** The reader's identity request (account_type: the SDK requests it but drops it). */
export const READER_IDENTITY_FIELDS = "user_id,username,account_type";

/**
 * [doc] Non-deprecated insight metrics the Graph reader may request (documented SDK gaps:
 * account insights; media `views` / `total_interactions`). Never allowed: deprecated metrics
 * (impressions, plays, video_views, profile_views, website_clicks), ad-inclusive metrics
 * (total_likes, total_comments, total_views, ... [F6]), reposts, profile_visits and follows
 * ([F5, R2]; account-level reposts are dropped too, the allowlist is not broadened for them).
 */
export const READER_MEDIA_METRICS: ReadonlySet<string> = new Set(["views", "total_interactions"]);
/** Account insights of request A (period=day, metric_type=total_value, no breakdown). */
export const READER_ACCOUNT_METRICS: ReadonlySet<string> = new Set([
  "reach",
  "views",
  "accounts_engaged",
  "total_interactions",
  "likes",
  "comments",
  "shares",
  "saves",
  "replies",
  "profile_links_taps",
]);
/** Request B: the only metric with a breakdown, and the only breakdown (follow_type). */
export const READER_FOLLOWS_METRIC = "follows_and_unfollows";
export const READER_BREAKDOWN = "follow_type";
export const DEPRECATED_METRICS: ReadonlySet<string> = new Set([
  "impressions",
  "plays",
  "video_views",
  "profile_views",
  "website_clicks",
]);

type ParamRule = (value: string) => boolean;

const exact =
  (...values: readonly string[]): ParamRule =>
  (value) =>
    values.includes(value);
const pattern =
  (regex: RegExp): ParamRule =>
  (value) =>
    regex.test(value);
/** A non-empty comma list whose every entry is in `allowed`, without duplicates. */
const metricList =
  (allowed: ReadonlySet<string>): ParamRule =>
  (value) => {
    const names = value.split(",");
    return (
      names.length > 0 &&
      names.length <= allowed.size &&
      new Set(names).size === names.length &&
      names.every((name) => allowed.has(name))
    );
  };

type RouteSpec = {
  /** Absent: GET. */
  method?: "POST";
  /** "json": the route takes (and requires) a JSON body. Absent: no body allowed. */
  body?: "json";
  /** Segments after /v25.0/; ":id" = a decimal Instagram id. */
  segments: readonly string[];
  params: Readonly<Record<string, ParamRule>>;
  required: readonly string[];
};

/** Graph paging cursors are opaque, printable and bounded (never followed as URLs). */
const PAGING_CURSOR = pattern(/^[!-~]{1,2048}$/);
const PAGE_LIMIT = pattern(/^(?:[1-9]\d?|100)$/);
const UNIX_SECONDS = pattern(/^\d{9,11}$/);

const SDK_ROUTES: readonly RouteSpec[] = [
  {
    segments: [":id"],
    params: { fields: exact(SDK_PROFILE_FIELDS, SDK_MEDIA_TYPE_FIELDS) },
    required: ["fields"],
  },
  {
    segments: [":id", "media"],
    params: { fields: exact(SDK_MEDIA_FIELDS), after: PAGING_CURSOR, limit: PAGE_LIMIT },
    required: ["fields"],
  },
  {
    segments: [":id", "insights"],
    params: { metric: exact(...SDK_POST_METRICS) },
    required: ["metric"],
  },
];

/**
 * [R2] Three strict request shapes share `/{id}/insights`; a request passes when it matches
 * ONE of them completely (the transport cannot tell a media id from an account id, so every
 * shape is also safe for either):
 * - post insights:      metric in {views,total_interactions}, period=lifetime; nothing else
 * - account request A:  metric in the account set, period=day, metric_type=total_value,
 *                       since + until; no breakdown
 * - account request B:  metric=follows_and_unfollows, period=day, metric_type=total_value,
 *                       breakdown=follow_type, since + until
 * `time_series` and every other breakdown are refused.
 */
const READER_ROUTES: readonly RouteSpec[] = [
  { segments: ["me"], params: { fields: exact(READER_IDENTITY_FIELDS) }, required: ["fields"] },
  {
    segments: [":id", "insights"],
    params: { metric: metricList(READER_MEDIA_METRICS), period: exact("lifetime") },
    required: ["metric", "period"],
  },
  {
    segments: [":id", "insights"],
    params: {
      metric: metricList(READER_ACCOUNT_METRICS),
      period: exact("day"),
      metric_type: exact("total_value"),
      since: UNIX_SECONDS,
      until: UNIX_SECONDS,
    },
    required: ["metric", "period", "metric_type", "since", "until"],
  },
  {
    segments: [":id", "insights"],
    params: {
      metric: exact(READER_FOLLOWS_METRIC),
      period: exact("day"),
      metric_type: exact("total_value"),
      breakdown: exact(READER_BREAKDOWN),
      since: UNIX_SECONDS,
      until: UNIX_SECONDS,
    },
    required: ["metric", "period", "metric_type", "breakdown", "since", "until"],
  },
];

/**
 * ADR 0017: subscribing the account to the messaging webhook fields (exact field list), and
 * sending a text reply ([doc] `POST /<IG_ID>/messages`, Bearer token, JSON body).
 */
const MESSAGING_ROUTES: readonly RouteSpec[] = [
  {
    method: "POST",
    segments: [":id", "subscribed_apps"],
    params: { subscribed_fields: exact(INSTAGRAM_SUBSCRIBED_FIELDS) },
    required: ["subscribed_fields"],
  },
  { method: "POST", segments: [":id", "messages"], params: {}, required: [], body: "json" },
];

const GRAPH_ROUTES: Readonly<Record<Exclude<InstagramCaller, "oauth">, readonly RouteSpec[]>> = {
  graph_reader: READER_ROUTES,
  sdk: SDK_ROUTES,
  messaging: MESSAGING_ROUTES,
};

/** [doc] The fields of the Unified Login account lookup. */
export const UNIFIED_ACCOUNT_FIELDS = "id,username";

/** Unified Login (graph.facebook.com/v26.0): discovery, the subscription and a text reply. */
const UNIFIED_GRAPH_ROUTES: Readonly<
  Record<Exclude<InstagramCaller, "oauth">, readonly RouteSpec[]>
> = {
  graph_reader: [
    {
      segments: ["me", "assigned_instagram_accounts"],
      params: { fields: exact(UNIFIED_ACCOUNT_FIELDS) },
      required: ["fields"],
    },
  ],
  sdk: [],
  messaging: [
    {
      method: "POST",
      segments: [":id", "subscribed_apps"],
      params: { subscribed_fields: exact(UNIFIED_SUBSCRIBED_FIELDS) },
      required: ["subscribed_fields"],
    },
    { method: "POST", segments: [":id", "messages"], params: {}, required: [], body: "json" },
  ],
};

const ID_SEGMENT = /^\d{1,32}$/;
const BEARER = /^Bearer [\x21-\x7e]{1,4096}$/;

type Target = { method: string; url: URL; headers: Headers; hasBody: boolean };

function queryEntries(url: URL): [string, string][] {
  const entries: [string, string][] = [];
  url.searchParams.forEach((value, name) => entries.push([name, value]));
  return entries;
}

function checkQuery(entries: [string, string][], route: RouteSpec): BlockReason | undefined {
  const seen = new Set<string>();
  for (const [name, value] of entries) {
    if (seen.has(name)) return "query";
    seen.add(name);
    const rule = route.params[name];
    if (rule === undefined || !rule(value)) return "query";
  }
  return route.required.every((name) => seen.has(name)) ? undefined : "query";
}

function graphRoute(
  target: Target,
  routes: readonly RouteSpec[],
  version: string = INSTAGRAM_GRAPH_VERSION,
): BlockReason | undefined {
  const methodOf = (route: RouteSpec) => route.method ?? "GET";
  const takesBody = (route: RouteSpec) => route.body === "json";
  if (!routes.some((route) => methodOf(route) === target.method)) return "method";
  if (target.hasBody) {
    if (!routes.some((route) => takesBody(route) && methodOf(route) === target.method)) {
      return "body";
    }
    const type = target.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (type !== "application/json") return "body";
  }
  const authorization = target.headers.get("authorization");
  if (authorization === null || !BEARER.test(authorization)) return "authorization";
  const path = target.url.pathname;
  if (path.includes("%") || path.includes("//")) return "path";
  const segments = path.split("/").slice(1);
  if (segments[0] !== version) return "path";
  const rest = segments.slice(1);
  const candidates = routes.filter(
    (r) =>
      methodOf(r) === target.method &&
      takesBody(r) === target.hasBody &&
      r.segments.length === rest.length &&
      r.segments.every((s, i) => (s === ":id" ? ID_SEGMENT.test(rest[i]!) : s === rest[i])),
  );
  if (candidates.length === 0) return "path";
  // Several shapes may share a path (reader insights): the request must match one fully.
  const entries = queryEntries(target.url);
  return candidates.some((route) => checkQuery(entries, route) === undefined) ? undefined : "query";
}

/** The two approved secret-in-URL shapes (exact parameter sets, GET, no version prefix). */
function tokenExceptionRoute(target: Target): BlockReason | undefined {
  if (target.url.hostname !== GRAPH_HOST) return "host";
  if (target.method !== "GET") return "method";
  if (target.hasBody) return "body";
  if (target.headers.get("authorization") !== null) return "authorization";
  const entries = queryEntries(target.url);
  const names = entries.map(([name]) => name).sort();
  const values = new Map(entries);
  const nonEmpty = (name: string) => (values.get(name) ?? "").length > 0;
  if (target.url.pathname === LONG_LIVED_EXCHANGE_PATH) {
    return names.join("&") === "access_token&client_secret&grant_type" &&
      values.get("grant_type") === "ig_exchange_token" &&
      nonEmpty("access_token") &&
      nonEmpty("client_secret")
      ? undefined
      : "secret_in_url";
  }
  if (target.url.pathname === REFRESH_PATH) {
    return names.join("&") === "access_token&grant_type" &&
      values.get("grant_type") === "ig_refresh_token" &&
      nonEmpty("access_token")
      ? undefined
      : "secret_in_url";
  }
  return "path";
}

/** Unified Login's two documented GET forms (exact parameter sets; see the module comment). */
function unifiedTokenExceptionRoute(target: Target): BlockReason | undefined {
  if (target.method !== "GET") return "method";
  if (target.hasBody) return "body";
  if (target.headers.get("authorization") !== null) return "authorization";
  const entries = queryEntries(target.url);
  const names = entries.map(([name]) => name).sort();
  const values = new Map(entries);
  const nonEmpty = (name: string) => (values.get(name) ?? "").length > 0;
  if (target.url.pathname === `/${UNIFIED_GRAPH_VERSION}/oauth/access_token`) {
    const required = ["client_id", "client_secret", "code", "redirect_uri"];
    return names.join("&") === required.join("&") && required.every(nonEmpty)
      ? undefined
      : "secret_in_url";
  }
  if (target.url.pathname === `/${UNIFIED_GRAPH_VERSION}/debug_token`) {
    return names.join("&") === "access_token&input_token" &&
      nonEmpty("access_token") &&
      nonEmpty("input_token")
      ? undefined
      : "secret_in_url";
  }
  return "path";
}

/** Throws TransportBlockedError unless the request is on the caller's allowlist. */
export function assertAllowedRequest(caller: InstagramCaller, target: Target): void {
  const { url } = target;
  let reason: BlockReason | undefined;
  if (url.protocol !== "https:") reason = "scheme";
  else if (url.username !== "" || url.password !== "") reason = "credentials_in_url";
  else if (url.hash !== "") reason = "fragment";
  else if (url.port !== "") reason = "port";

  const secretInQuery = queryEntries(url).some(([name]) => isSecretParam(name));
  if (reason === undefined) {
    if (caller === "oauth") {
      if (url.hostname === TOKEN_HOST) {
        reason =
          target.method !== "POST"
            ? "method"
            : url.pathname !== "/oauth/access_token"
              ? "path"
              : secretInQuery
                ? "secret_in_url"
                : url.search !== ""
                  ? "query"
                  : target.headers.get("authorization") !== null
                    ? "authorization"
                    : undefined;
      } else if (url.hostname === UNIFIED_GRAPH_HOST) {
        reason = unifiedTokenExceptionRoute(target);
      } else {
        reason = tokenExceptionRoute(target);
      }
    } else if (secretInQuery) {
      // The global rule: Graph reads never put a secret in the URL.
      reason = "secret_in_url";
    } else if (url.hostname === GRAPH_HOST) {
      reason = graphRoute(target, GRAPH_ROUTES[caller]);
    } else if (url.hostname === UNIFIED_GRAPH_HOST) {
      reason = graphRoute(target, UNIFIED_GRAPH_ROUTES[caller], UNIFIED_GRAPH_VERSION);
    } else {
      reason = "host";
    }
  }
  if (reason !== undefined) throw new TransportBlockedError(reason);
}

// ---------------------------------------------------------------------------
// Responses: structured, payload-free failures
// ---------------------------------------------------------------------------

export type InstagramErrorBody = {
  code?: number;
  subcode?: number;
  isTransient?: boolean;
};

export type UsageHints = {
  /** Max X-Business-Use-Case-Usage estimated_time_to_regain_access (minutes). */
  regainAccessMinutes?: number;
  /** Retry-After (seconds). */
  retryAfterSeconds?: number;
};

export type InstagramFailure =
  | { type: "blocked"; reason: BlockReason }
  | { type: "budget_exceeded" }
  | { type: "network" }
  | { type: "timeout" }
  | { type: "invalid_json"; status: number }
  | { type: "http"; status: number; error?: InstagramErrorBody; usage: UsageHints };

export type InstagramResult =
  | { ok: true; status: number; body: unknown; usage: UsageHints }
  | { ok: false; failure: InstagramFailure };

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Throttling hints; malformed headers are ignored. */
export function parseUsageHints(headers: Headers): UsageHints {
  const usage: UsageHints = {};
  const raw = headers.get("x-business-use-case-usage");
  if (raw !== null && raw.length <= 16_384) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        let max: number | undefined;
        for (const entries of Object.values(parsed as Record<string, unknown>)) {
          if (!Array.isArray(entries)) continue;
          for (const entry of entries) {
            const minutes = finiteNonNegative(
              (entry as { estimated_time_to_regain_access?: unknown } | null)
                ?.estimated_time_to_regain_access,
            );
            if (minutes !== undefined) max = Math.max(max ?? 0, minutes);
          }
        }
        if (max !== undefined) usage.regainAccessMinutes = max;
      }
    } catch {
      // Ignored: hints only.
    }
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null && /^\d{1,6}$/.test(retryAfter.trim())) {
    usage.retryAfterSeconds = Number(retryAfter.trim());
  }
  return usage;
}

/**
 * Error code/subcode of a failed response. Graph errors: `{error: {code, error_subcode,
 * is_transient}}`; the OAuth token endpoint: `{error_type, code, error_message}` [doc].
 * Only numbers and a boolean are read: messages, types, trace ids and payloads never are.
 */
export function parseErrorBody(body: unknown): InstagramErrorBody | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const graph = (body as { error?: unknown }).error;
  if (graph !== null && typeof graph === "object") {
    const e = graph as { code?: unknown; error_subcode?: unknown; is_transient?: unknown };
    return {
      ...(Number.isSafeInteger(e.code) ? { code: e.code as number } : {}),
      ...(Number.isSafeInteger(e.error_subcode) ? { subcode: e.error_subcode as number } : {}),
      ...(typeof e.is_transient === "boolean" ? { isTransient: e.is_transient } : {}),
    };
  }
  const oauth = body as { error_type?: unknown; code?: unknown };
  if (typeof oauth.error_type === "string" && Number.isSafeInteger(oauth.code)) {
    return { code: oauth.code as number };
  }
  return undefined;
}

/** Largest JSON body read (Instagram responses are far smaller). */
const MAX_BODY_BYTES = 1_048_576;

async function readBody(response: Response): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const text = await response.text();
    if (text.length > MAX_BODY_BYTES) return { ok: false };
    return { ok: true, body: text.trim() === "" ? null : (JSON.parse(text) as unknown) };
  } catch {
    return { ok: false };
  }
}

export type SendOptions = { timeoutMs: number; budget?: RequestBudget };

/**
 * Sends ONE allowlisted request with the runtime's fetch (resolved per call; tests stub
 * the global). Never throws: blocked, budget, network, timeout and HTTP failures are all
 * structured results. Underlying errors are never propagated (they may contain the URL).
 */
export async function sendInstagram(
  caller: InstagramCaller,
  url: URL,
  init: { method: "GET" | "POST"; headers?: Record<string, string>; body?: string },
  options: SendOptions,
): Promise<InstagramResult> {
  const headers = new Headers(init.headers ?? {});
  try {
    assertAllowedRequest(caller, {
      method: init.method,
      url,
      headers,
      hasBody: init.body !== undefined,
    });
    options.budget?.take();
  } catch (error) {
    if (error instanceof TransportBlockedError) {
      return { ok: false, failure: { type: "blocked", reason: error.reason } };
    }
    return { ok: false, failure: { type: "budget_exceeded" } };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  let response: Response;
  try {
    response = await globalThis.fetch(url.toString(), {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      redirect: "error",
      signal: controller.signal,
    });
  } catch {
    return { ok: false, failure: { type: controller.signal.aborted ? "timeout" : "network" } };
  } finally {
    clearTimeout(timer);
  }

  const usage = parseUsageHints(response.headers);
  const parsed = await readBody(response);
  if (!parsed.ok) {
    return response.ok
      ? { ok: false, failure: { type: "invalid_json", status: response.status } }
      : { ok: false, failure: { type: "http", status: response.status, usage } };
  }
  const error = parseErrorBody(parsed.body);
  if (!response.ok || error !== undefined) {
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
  return { ok: true, status: response.status, body: parsed.body, usage };
}

// ---------------------------------------------------------------------------
// The fetch injected into social-sdk (used ONLY by convex/providers/instagram/node/**)
// ---------------------------------------------------------------------------

/**
 * What the injected fetch observed about the most recent failure. The SDK maps errors by
 * HTTP status only and discards the body; this capture restores the Meta error code and
 * throttling hints so our classification (errors.ts) can replace the SDK's.
 */
export type FailureCapture = { last?: InstagramFailure };

function requestParts(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
): { method: string; url: URL; headers: Headers; hasBody: boolean } {
  if (typeof Request !== "undefined" && input instanceof Request) {
    return {
      method: (init?.method ?? input.method).toUpperCase(),
      url: new URL(input.url),
      headers: new Headers(init?.headers ?? input.headers),
      hasBody: init?.body != null || input.body !== null,
    };
  }
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    url: new URL(input instanceof URL ? input.toString() : String(input)),
    headers: new Headers(init?.headers ?? {}),
    hasBody: init?.body != null,
  };
}

/**
 * A `fetch` for social-sdk: allowlist ("sdk" caller) + budget BEFORE any network access,
 * then the runtime fetch. Failed responses are cloned and their error code / usage
 * headers captured before the SDK discards them. Thrown errors never carry the URL.
 */
export function createSdkFetch(options: {
  budget: RequestBudget;
  capture: FailureCapture;
}): typeof fetch {
  const guarded = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    let parts: ReturnType<typeof requestParts>;
    try {
      parts = requestParts(input, init);
      assertAllowedRequest("sdk", parts);
      options.budget.take();
    } catch (error) {
      if (error instanceof RequestBudgetExceededError) {
        options.capture.last = { type: "budget_exceeded" };
        throw new RequestBudgetExceededError();
      }
      // Blocked, or an unparseable URL: refused either way, with a reason code only.
      const reason = error instanceof TransportBlockedError ? error.reason : "path";
      options.capture.last = { type: "blocked", reason };
      throw new TransportBlockedError(reason);
    }
    let response: Response;
    try {
      response = await globalThis.fetch(parts.url.toString(), {
        ...init,
        method: parts.method,
        headers: parts.headers,
        redirect: "error",
      });
    } catch {
      const aborted = init?.signal?.aborted === true;
      options.capture.last = { type: aborted ? "timeout" : "network" };
      throw new Error(aborted ? "Instagram request timed out" : "Instagram request failed");
    }
    if (!response.ok) {
      const usage = parseUsageHints(response.headers);
      const parsed = await readBody(response.clone());
      const error = parsed.ok ? parseErrorBody(parsed.body) : undefined;
      options.capture.last = {
        type: "http",
        status: response.status,
        ...(error !== undefined ? { error } : {}),
        usage,
      };
    }
    return response;
  };
  return guarded as typeof fetch;
}
