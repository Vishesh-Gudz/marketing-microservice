/**
 * TEST-ONLY fake of the Google endpoints the YouTube provider uses (two dots in the filename:
 * never deployed). It models DOCUMENTED behavior only (docs/providers/youtube.md) and is NOT
 * evidence of real-channel behavior. Served through the global `fetch` (tests stub it), so
 * every request has already passed our client allowlist.
 *
 *   POST https://oauth2.googleapis.com/token                 code (+ PKCE) or refresh grant
 *   POST https://oauth2.googleapis.com/revoke                revokes the grant of a token
 *   GET  https://www.googleapis.com/youtube/v3/channels      mine=true (Bearer)
 *   GET  https://www.googleapis.com/youtube/v3/playlistItems the uploads playlist (Bearer)
 *   GET  https://www.googleapis.com/youtube/v3/videos        snippets (+ statistics) by id (Bearer)
 *   GET  https://youtubeanalytics.googleapis.com/v2/reports  the channel day report (Bearer)
 *
 * Errors use the documented shapes: OAuth `{ error: "invalid_grant" }` and the Google API
 * `{ error: { code, status, errors: [{ reason }] } }`. Authorization codes are single-use and
 * bound to their PKCE challenge and redirect URI. A user mapped to `null` is a Google account
 * without a channel. Every request is logged (method, host, path, parameter NAMES, whether it
 * carried a Bearer token, the full URL and the body) so tests can count requests and scan for
 * leaks. Failures can be injected per route. All ids, tokens and secrets are fake.
 */

export const FAKE_YT_CLIENT_ID = "100000000001-fakeyoutubeclient.apps.googleusercontent.com";
export const FAKE_YT_CLIENT_SECRET = "fake-yt-client-secret-DO-NOT-USE";
/** Every fake token starts with this marker (leak scans search for it). */
export const FAKE_YT_TOKEN_MARKER = "ytfake";
/** Every fake authorization code starts with this marker. */
export const FAKE_YT_CODE_MARKER = "ytcodefake";

export const FAKE_YT_READONLY_SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
export const FAKE_YT_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly";

export type FakeVideo = {
  id: string;
  title?: string;
  /** Absent: the snippet omits the field. */
  publishedAt?: string;
  /** Default "none". */
  liveBroadcastContent?: string;
  /** Default: the channel's own id. */
  channelId?: string;
  /** Listed in the uploads playlist, but `videos.list` no longer returns it. */
  deleted?: boolean;
  /** Lifetime statistics as the Data API sends them (strings); a missing count is hidden. */
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
};

export type FakeChannel = {
  channelId: string;
  title?: string;
  customUrl?: string;
  /** Decimal string as the Data API sends it. */
  subscriberCount?: string;
  hidden?: boolean;
  /** Default "UU" + the channel id without "UC". */
  uploadsId?: string;
  /** Newest first (the uploads playlist order). */
  videos?: FakeVideo[];
  /** The granted scopes the code exchange reports (default: both YouTube scopes). */
  grantedScope?: string;
  /** The code exchange issues no refresh token. */
  omitRefreshToken?: boolean;
  /** `channels.list?mine=true` also returns this second channel. */
  alsoOwns?: FakeChannel;
  /** Analytics values by (Pacific Time) day and metric name; a missing day has no row. */
  days?: Record<string, Record<string, number | null>>;
  /** [doc] endDate is cut back to the last processed day: no row after this day. */
  processedThrough?: string;
  /** Requested metric columns the report leaves out. */
  omitMetrics?: string[];
};

export type FakeRequest = {
  method: string;
  host: string;
  path: string;
  params: string[];
  bearer: boolean;
  url: string;
  body?: string;
};

export type FakeFailure = { status: number; body?: unknown; headers?: Record<string, string> };
export type FakeRoute = "token" | "revoke" | "channels" | "playlistItems" | "videos" | "reports";

export const FAKE_CHANNEL_ID = "UCfakeChannel0000000000a";

const DEFAULT_CHANNELS: Record<string, FakeChannel | null> = {
  brand: {
    channelId: FAKE_CHANNEL_ID,
    title: "Fake Brand",
    customUrl: "@fakebrand",
    subscriberCount: "12300",
    videos: [],
  },
};

function json(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function apiError(status: number, reason: string, rpc: string) {
  return json(status, { error: { code: status, status: rpc, errors: [{ reason }] } });
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function channelResource(channel: FakeChannel, uploads: string) {
  return {
    id: channel.channelId,
    snippet: {
      title: channel.title,
      ...(channel.customUrl !== undefined ? { customUrl: channel.customUrl } : {}),
      thumbnails: { default: { url: "https://yt3.example.invalid/fake.jpg" } },
    },
    statistics: channel.hidden
      ? { hiddenSubscriberCount: true, viewCount: "1" }
      : { subscriberCount: channel.subscriberCount, hiddenSubscriberCount: false },
    contentDetails: { relatedPlaylists: { uploads, likes: "" } },
  };
}

export function createFakeYouTube(options: { channels?: Record<string, FakeChannel | null> } = {}) {
  const channels: Record<string, FakeChannel | null> = { ...DEFAULT_CHANNELS, ...options.channels };
  const requests: FakeRequest[] = [];
  const failures = new Map<FakeRoute, FakeFailure[]>();
  const codes = new Map<
    string,
    { user: string; challenge: string; redirectUri: string; used: boolean }
  >();
  const refreshTokens = new Map<string, string>(); // refresh token -> user
  const accessTokens = new Map<string, string>(); // access token -> user
  /** Users whose grant was revoked through the revocation endpoint. */
  const revokedUsers: string[] = [];
  let issued = 0;

  const uploadsOf = (channel: FakeChannel) =>
    channel.uploadsId ?? `UU${channel.channelId.slice(2)}`;

  function injected(route: FakeRoute): Response | undefined {
    const queue = failures.get(route);
    const failure = queue?.shift();
    if (failure === undefined) return undefined;
    return json(failure.status, failure.body ?? {}, failure.headers);
  }

  function bearerUser(init: RequestInit | undefined): string | undefined {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    const token = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length) : "";
    return accessTokens.get(token);
  }

  function issueAccess(user: string): string {
    const accessToken = `${FAKE_YT_TOKEN_MARKER}-access-${user}-${++issued}`;
    accessTokens.set(accessToken, user);
    return accessToken;
  }

  function issueRefresh(user: string): string {
    const token = `${FAKE_YT_TOKEN_MARKER}-refresh-${user}-${refreshTokens.size + 1}`;
    refreshTokens.set(token, user);
    return token;
  }

  function revokeUser(user: string): void {
    for (const [token, owner] of [...refreshTokens]) {
      if (owner === user) refreshTokens.delete(token);
    }
    for (const [token, owner] of [...accessTokens]) {
      if (owner === user) accessTokens.delete(token);
    }
  }

  async function token(form: URLSearchParams): Promise<Response> {
    if (
      form.get("client_id") !== FAKE_YT_CLIENT_ID ||
      form.get("client_secret") !== FAKE_YT_CLIENT_SECRET
    ) {
      return json(401, { error: "invalid_client" });
    }
    if (form.get("grant_type") === "refresh_token") {
      const user = refreshTokens.get(form.get("refresh_token") ?? "");
      if (user === undefined) return json(400, { error: "invalid_grant" });
      return json(200, { access_token: issueAccess(user), expires_in: 3599, token_type: "Bearer" });
    }
    const code = codes.get(form.get("code") ?? "");
    if (
      code === undefined ||
      code.used ||
      form.get("grant_type") !== "authorization_code" ||
      form.get("redirect_uri") !== code.redirectUri ||
      (await s256(form.get("code_verifier") ?? "")) !== code.challenge
    ) {
      return json(400, { error: "invalid_grant" });
    }
    code.used = true;
    const channel = channels[code.user];
    return json(200, {
      access_token: issueAccess(code.user),
      expires_in: 3599,
      ...(channel?.omitRefreshToken ? {} : { refresh_token: issueRefresh(code.user) }),
      scope: channel?.grantedScope ?? `${FAKE_YT_READONLY_SCOPE} ${FAKE_YT_ANALYTICS_SCOPE}`,
      token_type: "Bearer",
    });
  }

  async function handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    const route = `${url.host}${url.pathname}`;
    const form = new URLSearchParams(String(init?.body ?? ""));
    if (route === "oauth2.googleapis.com/token") {
      return injected("token") ?? (await token(form));
    }
    if (route === "oauth2.googleapis.com/revoke") {
      const failed = injected("revoke");
      if (failed) return failed;
      const raw = form.get("token") ?? "";
      const user = refreshTokens.get(raw) ?? accessTokens.get(raw);
      if (user === undefined) return json(400, { error: "invalid_token" });
      revokeUser(user);
      revokedUsers.push(user);
      return new Response(null, { status: 200 });
    }

    const user = bearerUser(init);
    if (user === undefined) return apiError(401, "authError", "UNAUTHENTICATED");
    const channel = channels[user] ?? undefined;
    const path = url.pathname.replace("/youtube/v3/", "");
    if (path === "channels") {
      const failed = injected("channels");
      if (failed) return failed;
      if (channel === undefined) return json(200, { items: [] });
      const owned = [channel, ...(channel.alsoOwns !== undefined ? [channel.alsoOwns] : [])];
      return json(200, { items: owned.map((c) => channelResource(c, uploadsOf(c))) });
    }
    if (path === "playlistItems") {
      const failed = injected("playlistItems");
      if (failed) return failed;
      if (channel === undefined || url.searchParams.get("playlistId") !== uploadsOf(channel)) {
        return apiError(404, "playlistNotFound", "NOT_FOUND");
      }
      const size = Number(url.searchParams.get("maxResults"));
      const pageToken = url.searchParams.get("pageToken");
      const start = pageToken === null ? 0 : Number(/^fakepage-(\d+)$/.exec(pageToken)?.[1] ?? NaN);
      if (!Number.isInteger(start)) return apiError(400, "invalidPageToken", "INVALID_ARGUMENT");
      const videos = channel.videos ?? [];
      const page = videos.slice(start, start + size);
      return json(200, {
        items: page.map((video) => ({
          kind: "youtube#playlistItem",
          contentDetails: {
            videoId: video.id,
            ...(video.publishedAt !== undefined ? { videoPublishedAt: video.publishedAt } : {}),
          },
        })),
        ...(start + size < videos.length ? { nextPageToken: `fakepage-${start + size}` } : {}),
      });
    }
    if (path === "videos") {
      const failed = injected("videos");
      if (failed) return failed;
      const ids = new Set((url.searchParams.get("id") ?? "").split(","));
      const withStatistics = (url.searchParams.get("part") ?? "").split(",").includes("statistics");
      const found = (channel?.videos ?? []).filter((video) => ids.has(video.id) && !video.deleted);
      return json(200, {
        items: found.map((video) => ({
          id: video.id,
          snippet: {
            channelId: video.channelId ?? channel!.channelId,
            ...(video.title !== undefined ? { title: video.title } : {}),
            ...(video.publishedAt !== undefined ? { publishedAt: video.publishedAt } : {}),
            liveBroadcastContent: video.liveBroadcastContent ?? "none",
            description: "never stored",
            thumbnails: { default: { url: "https://i.ytimg.example.invalid/fake.jpg" } },
          },
          ...(withStatistics && video.statistics !== undefined
            ? { statistics: { ...video.statistics, favoriteCount: "0" } }
            : {}),
        })),
      });
    }
    if (url.host === "youtubeanalytics.googleapis.com" && url.pathname === "/v2/reports") {
      const failed = injected("reports");
      if (failed) return failed;
      if (channel === undefined) return apiError(403, "forbidden", "PERMISSION_DENIED");
      const granted =
        channel.grantedScope ?? `${FAKE_YT_READONLY_SCOPE} ${FAKE_YT_ANALYTICS_SCOPE}`;
      if (!granted.split(" ").includes(FAKE_YT_ANALYTICS_SCOPE)) {
        return apiError(403, "insufficientPermissions", "PERMISSION_DENIED");
      }
      return json(200, reportOf(channel, url.searchParams));
    }
    return apiError(404, "notFound", "NOT_FOUND");
  }

  /** [doc] A day report: headers (day + requested metrics), rows in day order, cut at processedThrough. */
  function reportOf(channel: FakeChannel, params: URLSearchParams) {
    const start = params.get("startDate") ?? "";
    const end = params.get("endDate") ?? "";
    const through =
      channel.processedThrough !== undefined && channel.processedThrough < end
        ? channel.processedThrough
        : end;
    const metrics = (params.get("metrics") ?? "")
      .split(",")
      .filter((metric) => !(channel.omitMetrics ?? []).includes(metric));
    const rows = Object.entries(channel.days ?? {})
      .filter(([day]) => day >= start && day <= through)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([day, values]) => [day, ...metrics.map((metric) => values[metric] ?? null)]);
    return {
      kind: "youtubeAnalytics#resultTable",
      columnHeaders: [
        { name: "day", columnType: "DIMENSION", dataType: "STRING" },
        ...metrics.map((name) => ({ name, columnType: "METRIC", dataType: "INTEGER" })),
      ],
      ...(rows.length > 0 ? { rows } : {}),
    };
  }

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const params: string[] = [];
    url.searchParams.forEach((_value, name) => params.push(name));
    requests.push({
      method: init?.method ?? "GET",
      host: url.host,
      path: url.pathname,
      params,
      bearer: (new Headers(init?.headers).get("authorization") ?? "").startsWith("Bearer "),
      url: url.toString(),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    return await handle(url, init);
  };

  return {
    fetch: fakeFetch as typeof fetch,
    requests,
    revokedUsers,
    /** A single-use code for `user`, bound to the PKCE challenge and redirect URI. */
    issueCode(user: string, codeChallenge: string, redirectUri: string): string {
      const code = `${FAKE_YT_CODE_MARKER}-${user}-${codes.size + 1}`;
      codes.set(code, { user, challenge: codeChallenge, redirectUri, used: false });
      return code;
    },
    /** A refresh token the fake accepts for `user` (a key of the channels map). */
    issueRefreshToken(user: string): string {
      return issueRefresh(user);
    },
    /** Revokes every token of `user` on Google's side (the next refresh answers invalid_grant). */
    revoke(user: string): void {
      revokeUser(user);
    },
    /** The next request on `route` answers `failure` (queued, one per call). */
    failNext(route: FakeRoute, failure: FakeFailure): void {
      failures.set(route, [...(failures.get(route) ?? []), failure]);
    },
    uploadsIdOf(user: string): string {
      return uploadsOf(channels[user]!);
    },
  };
}

export type FakeYouTube = ReturnType<typeof createFakeYouTube>;

/** `n` fake videos, newest first, one per day before `newest` (an ISO instant). */
export function fakeVideos(n: number, newest: string): FakeVideo[] {
  const start = Date.parse(newest);
  return Array.from({ length: n }, (_, i) => ({
    id: `vid${String(i).padStart(8, "0")}`,
    title: `Fake video ${i}`,
    publishedAt: new Date(start - i * 86_400_000).toISOString().replace(".000Z", "Z"),
  }));
}
