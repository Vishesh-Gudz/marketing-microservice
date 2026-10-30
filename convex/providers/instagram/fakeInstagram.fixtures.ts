/// <reference types="vite/client" />

/**
 * TEST-ONLY fake of the Instagram endpoints Phase 10 uses (two dots in the filename: never
 * deployed). It models DOCUMENTED behavior only (docs/providers/instagram.md) and is NOT
 * evidence of real-account behavior. Served through the global `fetch` (tests stub it), so
 * every request has already passed our transport allowlist.
 *
 *   POST https://api.instagram.com/oauth/access_token          code -> short-lived token
 *   GET  https://graph.instagram.com/access_token              short -> long-lived (60 d)
 *   GET  https://graph.instagram.com/refresh_access_token      long -> new long-lived
 *   GET  https://graph.instagram.com/v25.0/me                  identity (Bearer)
 *   GET  https://graph.instagram.com/v25.0/{ig-id}             profile / media type (Bearer)
 *   GET  https://graph.instagram.com/v25.0/{ig-id}/media       media pages (Bearer)
 *   GET  https://graph.instagram.com/v25.0/{media-id}/insights lifetime metrics (Bearer)
 *   GET  https://graph.instagram.com/v25.0/{ig-id}/insights    account day insights (Bearer)
 *
 * Insights follow the documented "empty data set instead of 0": a metric the fixture does
 * not define is simply missing from `data` (an explicit 0 is returned as 0). Account
 * insights answer only period=day&metric_type=total_value with since/until (one UTC day);
 * follows_and_unfollows (breakdown=follow_type) is never returned under 100 followers.
 *
 * Every request is logged (method, host, path, parameter NAMES, whether it carried a Bearer
 * token, the full URL) so tests can count requests and scan for leaks. Failures can be
 * injected per route. All ids, tokens and secrets are fake.
 */

export const FAKE_IG_APP_ID = "1790000000000001";
export const FAKE_IG_APP_SECRET = "fake-ig-app-secret-DO-NOT-USE";
/** Every fake token starts with this marker (leak scans search for it). */
export const FAKE_IG_TOKEN_MARKER = "IGAAfake";
/** Every fake authorization code starts with this marker. */
export const FAKE_IG_CODE_MARKER = "igcodefake";
export const FAKE_IG_REDIRECT_URI = "https://marketing-tests.convex.site/oauth/callback";

export type FakeMedia = {
  id: string;
  caption?: string;
  media_type: string;
  /** Absent: the listing omits the field (IR3 scenario). */
  media_product_type?: string;
  permalink?: string;
  timestamp: string;
  /** Lifetime insights by Instagram metric name; missing names are not returned. */
  insights?: Record<string, number>;
  /** Deleted after listing: the type and insights reads answer 100/33. */
  deleted?: boolean;
};

export type FakeInstagramUser = {
  userId: string;
  /** The code exchange's `user_id` when it differs from /me.user_id (IR2; default: equal). */
  scopedUserId?: string;
  username: string;
  accountType: string;
  name?: string;
  followers?: number;
  permissions?: string;
  /** Newest first (as Instagram lists media). */
  media?: FakeMedia[];
  /** Day totals by UTC day and Instagram metric name (missing = not reported). */
  accountInsights?: Record<string, Record<string, number>>;
  /** follows_and_unfollows follow_type results by UTC day (e.g. { FOLLOWER: 5 }). */
  follows?: Record<string, Record<string, number>>;
};

export type FakeRequest = {
  method: string;
  host: string;
  path: string;
  params: string[];
  bearer: boolean;
  url: string;
};

export type FakeFailure = {
  status: number;
  body?: unknown;
  /** A body sent as is (not JSON-encoded), e.g. an HTML page. */
  raw?: string;
  headers?: Record<string, string>;
};

export type FakeRoute =
  | "code_exchange"
  | "long_lived_exchange"
  | "refresh"
  | "me"
  | "profile"
  | "media_type"
  | "media"
  | "insights"
  | "account_insights"
  | "subscribed_apps"
  | "send_message";

/** A text reply the fake accepted (ADR 0017 IM4). */
export type FakeSentMessage = { account: string; recipient: string; text: string; mid: string };

const DEFAULT_USERS: Record<string, FakeInstagramUser> = {
  business: {
    userId: "17841400000000101",
    username: "fake_brand",
    accountType: "Business",
    name: "Fake Brand",
    followers: 1234,
    permissions: "instagram_business_basic,instagram_business_manage_insights",
  },
  creator: {
    userId: "17841400000000102",
    username: "fake_creator",
    accountType: "Media_Creator",
    name: "Fake Creator",
    followers: 99,
    permissions: "instagram_business_basic,instagram_business_manage_insights",
  },
  personal: {
    userId: "17841400000000103",
    username: "fake_person",
    accountType: "Personal",
    permissions: "instagram_business_basic",
  },
  basic_only: {
    userId: "17841400000000104",
    username: "fake_basic",
    accountType: "Business",
    permissions: "instagram_business_basic",
  },
  /** ADR 0017: granted the messaging permission too. */
  messaging: {
    userId: "17841400000000105",
    username: "fake_inbox",
    accountType: "Business",
    permissions:
      "instagram_business_basic,instagram_business_manage_insights,instagram_business_manage_messages",
  },
};

const LONG_LIVED_SECONDS = 5_184_000; // 60 days [doc]

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function graphError(status: number, code: number, subcode?: number) {
  return json(status, {
    error: {
      message: "Fake error (never surfaced)",
      type: "OAuthException",
      code,
      ...(subcode !== undefined ? { error_subcode: subcode } : {}),
      fbtrace_id: "FakeTraceIdNeverStored",
    },
  });
}

export function createFakeInstagram(
  options: { users?: Record<string, FakeInstagramUser>; appId?: string; appSecret?: string } = {},
) {
  const users = { ...DEFAULT_USERS, ...(options.users ?? {}) };
  const appId = options.appId ?? FAKE_IG_APP_ID;
  const appSecret = options.appSecret ?? FAKE_IG_APP_SECRET;
  const codes = new Map<string, string>();
  const tokens = new Map<string, { user: string; kind: "short" | "long" }>();
  const failures = new Map<FakeRoute, FakeFailure[]>();
  const requests: FakeRequest[] = [];
  const sent: FakeSentMessage[] = [];
  let sequence = 0;
  let midSequence = 0;
  /** Sends that never answer: they end only when the caller's timeout aborts them. */
  let hangingSends = 0;
  /** Sends that fail at once as a network error (the fetch rejects; nothing times out). */
  let failingSends = 0;

  const issueToken = (user: string, kind: "short" | "long") => {
    const token = `${FAKE_IG_TOKEN_MARKER}${kind}${++sequence}x${user}`;
    tokens.set(token, { user, kind });
    return token;
  };

  const takeFailure = (route: FakeRoute): Response | undefined => {
    const queue = failures.get(route);
    const next = queue?.shift();
    if (next === undefined) return undefined;
    if (next.raw !== undefined) {
      return new Response(next.raw, { status: next.status, headers: next.headers ?? {} });
    }
    return next.body === undefined
      ? new Response(null, { status: next.status, headers: next.headers ?? {} })
      : json(next.status, next.body, next.headers ?? {});
  };

  const bearerUser = (headers: Headers) => {
    const auth = headers.get("authorization");
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : undefined;
    const entry = token === undefined ? undefined : tokens.get(token);
    return entry?.kind === "long" ? users[entry.user] : undefined;
  };

  const findMedia = (mediaId: string) => {
    for (const user of Object.values(users)) {
      const media = user.media?.find((m) => m.id === mediaId);
      if (media) return { user, media };
    }
    return undefined;
  };

  async function handle(url: URL, init: RequestInit): Promise<Response> {
    const method = (init.method ?? "GET").toUpperCase();
    const headers = new Headers(init.headers ?? {});
    const params = url.searchParams;

    if (url.hostname === "api.instagram.com" && url.pathname === "/oauth/access_token") {
      const failure = takeFailure("code_exchange");
      if (failure) return failure;
      const form = new URLSearchParams(typeof init.body === "string" ? init.body : "");
      const user = codes.get(form.get("code") ?? "");
      if (
        method !== "POST" ||
        form.get("client_id") !== appId ||
        form.get("client_secret") !== appSecret ||
        form.get("grant_type") !== "authorization_code" ||
        user === undefined
      ) {
        return json(400, {
          error_type: "OAuthException",
          code: 400,
          error_message: "Matching code was not found or was already used",
        });
      }
      codes.delete(form.get("code")!); // single use [doc]
      return json(200, {
        data: [
          {
            access_token: issueToken(user, "short"),
            user_id: users[user]!.scopedUserId ?? users[user]!.userId,
            permissions: users[user]!.permissions ?? "",
          },
        ],
      });
    }

    if (url.hostname !== "graph.instagram.com") return json(404, {});

    if (url.pathname === "/access_token") {
      const failure = takeFailure("long_lived_exchange");
      if (failure) return failure;
      const entry = tokens.get(params.get("access_token") ?? "");
      if (params.get("client_secret") !== appSecret || entry?.kind !== "short") {
        return graphError(400, 190);
      }
      return json(200, {
        access_token: issueToken(entry.user, "long"),
        token_type: "bearer",
        expires_in: LONG_LIVED_SECONDS,
      });
    }
    if (url.pathname === "/refresh_access_token") {
      const failure = takeFailure("refresh");
      if (failure) return failure;
      const entry = tokens.get(params.get("access_token") ?? "");
      if (params.get("grant_type") !== "ig_refresh_token" || entry?.kind !== "long") {
        return graphError(400, 190);
      }
      return json(200, {
        access_token: issueToken(entry.user, "long"),
        token_type: "bearer",
        expires_in: LONG_LIVED_SECONDS,
      });
    }

    const segments = url.pathname.split("/").slice(1);
    if (segments[0] !== "v25.0") return graphError(400, 2635);
    const user = bearerUser(headers);
    if (user === undefined) return graphError(400, 190);
    const [first, second] = segments.slice(1);

    // ADR 0017: the messaging webhook subscription ([doc] POST, `{"success": true}`). Refused
    // for another account and for a token without the messaging permission.
    if (first !== undefined && second === "subscribed_apps") {
      const failure = takeFailure("subscribed_apps");
      if (failure) return failure;
      if (method !== "POST" || !params.get("subscribed_fields")) return graphError(400, 100);
      if (first !== user.userId) return graphError(400, 100, 33);
      const granted = (user.permissions ?? "").split(",");
      if (!granted.includes("instagram_business_manage_messages")) return graphError(403, 10);
      return json(200, { success: true });
    }

    // ADR 0017 IM4: a text reply ([doc] POST, JSON body, `{recipient_id, message_id}`).
    if (first !== undefined && second === "messages") {
      if (failingSends > 0) {
        failingSends--;
        throw new TypeError("fetch failed");
      }
      if (hangingSends > 0) {
        hangingSends--;
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("The operation was aborted", "AbortError")),
          );
        });
      }
      const failure = takeFailure("send_message");
      if (failure) return failure;
      if (method !== "POST" || first !== user.userId) return graphError(400, 100, 33);
      const granted = (user.permissions ?? "").split(",");
      if (!granted.includes("instagram_business_manage_messages")) return graphError(403, 10);
      let payload: { recipient?: { id?: unknown }; message?: { text?: unknown } };
      try {
        payload = JSON.parse(typeof init.body === "string" ? init.body : "") as typeof payload;
      } catch {
        return graphError(400, 100);
      }
      const recipient = payload.recipient?.id;
      const text = payload.message?.text;
      if (typeof recipient !== "string" || typeof text !== "string") return graphError(400, 100);
      const mid = `mid.fake.${++midSequence}`;
      sent.push({ account: first, recipient, text, mid });
      return json(200, { recipient_id: recipient, message_id: mid });
    }

    if (first === "me" && second === undefined) {
      const failure = takeFailure("me");
      if (failure) return failure;
      return json(200, {
        user_id: user.userId,
        username: user.username,
        account_type: user.accountType,
        id: `app-scoped-${user.userId}`,
      });
    }
    if (first !== undefined && second === undefined) {
      const fields = params.get("fields") ?? "";
      if (fields === "media_product_type") {
        const failure = takeFailure("media_type");
        if (failure) return failure;
        const found = findMedia(first);
        if (found === undefined || found.media.deleted) return graphError(400, 100, 33);
        return json(200, {
          ...(found.media.media_product_type !== undefined
            ? { media_product_type: found.media.media_product_type }
            : {}),
          id: first,
        });
      }
      const failure = takeFailure("profile");
      if (failure) return failure;
      if (first !== user.userId) return graphError(400, 100, 33);
      return json(200, {
        user_id: user.userId,
        id: `app-scoped-${user.userId}`,
        username: user.username,
        name: user.name ?? "",
        biography: "Fake biography that must never be stored",
        profile_picture_url: `https://scontent.example.test/${user.userId}.jpg?sig=fake`,
        followers_count: user.followers ?? 0,
        follows_count: 3,
        media_count: user.media?.length ?? 0,
        website: "https://fake-website.example.test",
      });
    }
    if (first !== undefined && second === "media") {
      const failure = takeFailure("media");
      if (failure) return failure;
      if (first !== user.userId) return graphError(400, 100, 33);
      const limit = Number(params.get("limit") ?? "25");
      const all = user.media ?? [];
      const offset = params.get("after") ? Number(atob(params.get("after")!).slice(4)) : 0;
      const page = all.slice(offset, offset + limit);
      const next = offset + limit < all.length ? btoa(`off:${offset + limit}`) : undefined;
      return json(200, {
        data: page.map(({ insights: _insights, deleted: _deleted, ...media }) => ({
          ...media,
          username: user.username,
        })),
        paging: {
          cursors: { before: btoa(`off:${offset}`), ...(next ? { after: next } : {}) },
          // Meta's `next` URLs embed the access token: they must never be followed.
          ...(next
            ? {
                next: `https://graph.instagram.com/v25.0/${first}/media?access_token=${FAKE_IG_TOKEN_MARKER}inurl&after=${next}`,
              }
            : {}),
        },
      });
    }
    if (first !== undefined && second === "insights" && first === user.userId) {
      const failure = takeFailure("account_insights");
      if (failure) return failure;
      const since = params.get("since");
      if (
        params.get("period") !== "day" ||
        params.get("metric_type") !== "total_value" ||
        since === null ||
        params.get("until") === null
      ) {
        return graphError(400, 100);
      }
      const day = new Date(Number(since) * 1000).toISOString().slice(0, 10);
      const metrics = (params.get("metric") ?? "").split(",");
      if (params.get("breakdown") === "follow_type") {
        const results = user.follows?.[day];
        if ((user.followers ?? 0) < 100 || results === undefined) return json(200, { data: [] });
        return json(200, {
          data: [
            {
              name: "follows_and_unfollows",
              period: "day",
              title: "Follows and unfollows",
              total_value: {
                breakdowns: [
                  {
                    dimension_keys: ["follow_type"],
                    results: Object.entries(results).map(([key, value]) => ({
                      dimension_values: [key],
                      value,
                    })),
                  },
                ],
              },
              id: `${first}/insights/follows_and_unfollows/day`,
            },
          ],
        });
      }
      const values = user.accountInsights?.[day] ?? {};
      return json(200, {
        data: metrics
          .filter((name) => values[name] !== undefined)
          .map((name) => ({
            name,
            period: "day",
            title: name,
            total_value: { value: values[name] },
            id: `${first}/insights/${name}/day`,
          })),
      });
    }
    if (first !== undefined && second === "insights") {
      const failure = takeFailure("insights");
      if (failure) return failure;
      const found = findMedia(first);
      if (found === undefined || found.media.deleted) return graphError(400, 100, 33);
      const metrics = (params.get("metric") ?? "").split(",");
      return json(200, {
        data: metrics
          .filter((name) => found.media.insights?.[name] !== undefined)
          .map((name) => ({
            name,
            period: "lifetime",
            values: [{ value: found.media.insights![name] }],
            title: name,
            id: `${first}/insights/${name}/lifetime`,
          })),
      });
    }
    return graphError(400, 2635);
  }

  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(init.headers ?? {});
    const names: string[] = [];
    url.searchParams.forEach((_value, name) => names.push(name));
    requests.push({
      method: (init.method ?? "GET").toUpperCase(),
      host: url.hostname,
      path: url.pathname,
      params: names.sort(),
      bearer: (headers.get("authorization") ?? "").startsWith("Bearer "),
      url: url.toString(),
    });
    return await handle(url, init);
  };

  return {
    fetch: fetch as typeof globalThis.fetch,
    requests,
    users,
    /** A single-use authorization code for `user` (what Instagram appends to the redirect). */
    issueCode(user = "business"): string {
      const code = `${FAKE_IG_CODE_MARKER}${++sequence}${user}`;
      codes.set(code, user);
      return code;
    },
    /** A long-lived token for `user` (as if obtained by a previous connect). */
    issueLongLivedToken(user = "business"): string {
      return issueToken(user, "long");
    },
    /** Queues failures returned by the next requests of `route` (FIFO). */
    fail(route: FakeRoute, ...queued: FakeFailure[]) {
      failures.set(route, [...(failures.get(route) ?? []), ...queued]);
    },
    /** Text replies accepted, in order (IM4). */
    sent,
    /** The next `times` sends never answer (they end only by the caller's timeout). */
    hangNextSend(times = 1) {
      hangingSends += times;
    },
    /** The next `times` sends fail at once with a network error (no answer, no timeout). */
    failNextSendWithNetworkError(times = 1) {
      failingSends += times;
    },
    graphError,
    /** Every insight metric name requested (for forbidden-metric scans). */
    requestedMetrics(): string[] {
      return requests.flatMap((r) => new URL(r.url).searchParams.get("metric")?.split(",") ?? []);
    },
    /** Requests whose path starts with `prefix`. */
    count(prefix: string): number {
      return requests.filter((r) => r.path.startsWith(prefix)).length;
    },
    reset() {
      requests.length = 0;
    },
  };
}

export type FakeInstagram = ReturnType<typeof createFakeInstagram>;
