/**
 * TEST-ONLY fake of the Google endpoints the YouTube provider uses (two dots in the filename:
 * never deployed). It models DOCUMENTED behavior only (docs/providers/youtube.md) and is NOT
 * evidence of real-channel behavior. Served through the global `fetch` (tests stub it), so
 * every request has already passed our client allowlist.
 *
 *   POST https://oauth2.googleapis.com/token                 refresh grant -> access token
 *   GET  https://www.googleapis.com/youtube/v3/channels      mine=true (Bearer)
 *   GET  https://www.googleapis.com/youtube/v3/playlistItems the uploads playlist (Bearer)
 *   GET  https://www.googleapis.com/youtube/v3/videos        video snippets by id (Bearer)
 *
 * Errors use the documented shapes: OAuth `{ error: "invalid_grant" }` and the Google API
 * `{ error: { code, status, errors: [{ reason }] } }`. Every request is logged (method, host,
 * path, parameter NAMES, whether it carried a Bearer token, the full URL and the body) so
 * tests can count requests and scan for leaks. Failures can be injected per route. All ids,
 * tokens and secrets are fake.
 */

export const FAKE_YT_CLIENT_ID = "100000000001-fakeyoutubeclient.apps.googleusercontent.com";
export const FAKE_YT_CLIENT_SECRET = "fake-yt-client-secret-DO-NOT-USE";
/** Every fake token starts with this marker (leak scans search for it). */
export const FAKE_YT_TOKEN_MARKER = "ytfake";

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
export type FakeRoute = "token" | "channels" | "playlistItems" | "videos";

export const FAKE_CHANNEL_ID = "UCfakeChannel0000000000a";

const DEFAULT_CHANNELS: Record<string, FakeChannel> = {
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

export function createFakeYouTube(options: { channels?: Record<string, FakeChannel> } = {}) {
  const channels: Record<string, FakeChannel> = { ...DEFAULT_CHANNELS, ...options.channels };
  const requests: FakeRequest[] = [];
  const failures = new Map<FakeRoute, FakeFailure[]>();
  const refreshTokens = new Map<string, string>(); // refresh token -> user
  const accessTokens = new Map<string, string>(); // access token -> user
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

  async function handle(url: URL, init: RequestInit | undefined): Promise<Response> {
    const route = `${url.host}${url.pathname}`;
    if (route === "oauth2.googleapis.com/token") {
      const failed = injected("token");
      if (failed) return failed;
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (
        form.get("client_id") !== FAKE_YT_CLIENT_ID ||
        form.get("client_secret") !== FAKE_YT_CLIENT_SECRET
      ) {
        return json(401, { error: "invalid_client" });
      }
      const user = refreshTokens.get(form.get("refresh_token") ?? "");
      if (form.get("grant_type") !== "refresh_token" || user === undefined) {
        return json(400, { error: "invalid_grant" });
      }
      const accessToken = `${FAKE_YT_TOKEN_MARKER}-access-${user}-${++issued}`;
      accessTokens.set(accessToken, user);
      return json(200, { access_token: accessToken, expires_in: 3599, token_type: "Bearer" });
    }

    const user = bearerUser(init);
    if (user === undefined) return apiError(401, "authError", "UNAUTHENTICATED");
    const channel = channels[user];
    const path = url.pathname.replace("/youtube/v3/", "");
    if (path === "channels") {
      const failed = injected("channels");
      if (failed) return failed;
      if (channel === undefined) return json(200, { items: [] });
      return json(200, {
        items: [
          {
            id: channel.channelId,
            snippet: {
              title: channel.title,
              ...(channel.customUrl !== undefined ? { customUrl: channel.customUrl } : {}),
              thumbnails: { default: { url: "https://yt3.example.invalid/fake.jpg" } },
            },
            statistics: channel.hidden
              ? { hiddenSubscriberCount: true, viewCount: "1" }
              : { subscriberCount: channel.subscriberCount, hiddenSubscriberCount: false },
            contentDetails: { relatedPlaylists: { uploads: uploadsOf(channel), likes: "" } },
          },
        ],
      });
    }
    if (path === "playlistItems") {
      const failed = injected("playlistItems");
      if (failed) return failed;
      if (channel === undefined || url.searchParams.get("playlistId") !== uploadsOf(channel)) {
        return apiError(404, "playlistNotFound", "NOT_FOUND");
      }
      const size = Number(url.searchParams.get("maxResults"));
      const token = url.searchParams.get("pageToken");
      const start = token === null ? 0 : Number(/^fakepage-(\d+)$/.exec(token)?.[1] ?? NaN);
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
        })),
      });
    }
    return apiError(404, "notFound", "NOT_FOUND");
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
    /** A refresh token the fake accepts for `user` (a key of the channels map). */
    issueRefreshToken(user: string): string {
      const token = `${FAKE_YT_TOKEN_MARKER}-refresh-${user}-${refreshTokens.size + 1}`;
      refreshTokens.set(token, user);
      return token;
    },
    /** Revokes every token of `user` (the next refresh answers invalid_grant). */
    revoke(user: string): void {
      for (const [token, owner] of [...refreshTokens]) {
        if (owner === user) refreshTokens.delete(token);
      }
      for (const [token, owner] of [...accessTokens]) {
        if (owner === user) accessTokens.delete(token);
      }
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
