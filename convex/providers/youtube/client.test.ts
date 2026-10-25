import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHANNEL_PARTS,
  createYouTubeClient,
  isAllowedRequest,
  parseErrorBody,
  YouTubeRequestBudget,
} from "./client";

// ADR 0016: the YouTube client sends only allowlisted, read-only requests, checked before any
// network access; tokens never travel in a URL; failures carry codes, never URLs or tokens.

const DATA = "https://www.googleapis.com/youtube/v3";
const PLAYLIST = "UUfakeChannel0000000000a";
const VIDEO = "vid00000000";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("allowlist", () => {
  it.each([
    ["POST", "https://oauth2.googleapis.com/token"],
    ["POST", "https://oauth2.googleapis.com/revoke"],
    ["GET", `${DATA}/channels?part=${CHANNEL_PARTS}&mine=true&maxResults=50`],
    ["GET", `${DATA}/playlistItems?part=contentDetails&playlistId=${PLAYLIST}&maxResults=50`],
    [
      "GET",
      `${DATA}/playlistItems?part=contentDetails&playlistId=${PLAYLIST}&maxResults=1&pageToken=EAAaBlBUOkNESQ`,
    ],
    ["GET", `${DATA}/videos?part=snippet&id=${VIDEO},vid00000001`],
  ])("allows %s %s", (method, url) => {
    expect(isAllowedRequest(method, url)).toBe(true);
  });

  it.each([
    ["plain http", "GET", `http://www.googleapis.com/youtube/v3/videos?part=snippet&id=${VIDEO}`],
    [
      "another host",
      "GET",
      `https://youtube.googleapis.com/youtube/v3/videos?part=snippet&id=${VIDEO}`,
    ],
    [
      "an explicit port",
      "GET",
      `https://www.googleapis.com:443/youtube/v3/videos?part=snippet&id=${VIDEO}`,
    ],
    [
      "user info",
      "GET",
      `https://a:b@www.googleapis.com/youtube/v3/videos?part=snippet&id=${VIDEO}`,
    ],
    ["a fragment", "GET", `${DATA}/videos?part=snippet&id=${VIDEO}#x`],
    ["an API key", "GET", `${DATA}/videos?part=snippet&id=${VIDEO}&key=abc`],
    ["a token parameter", "GET", `${DATA}/videos?part=snippet&id=${VIDEO}&access_token=abc`],
    ["a duplicate parameter", "GET", `${DATA}/videos?part=snippet&id=${VIDEO}&id=${VIDEO}`],
    ["a missing parameter", "GET", `${DATA}/videos?part=snippet`],
    ["another part", "GET", `${DATA}/videos?part=snippet,statistics&id=${VIDEO}`],
    ["a duplicate id", "GET", `${DATA}/videos?part=snippet&id=${VIDEO},${VIDEO}`],
    ["a malformed id", "GET", `${DATA}/videos?part=snippet&id=short`],
    [
      "51 ids",
      "GET",
      `${DATA}/videos?part=snippet&id=${Array.from({ length: 51 }, (_, i) => `vid${String(i).padStart(8, "0")}`).join(",")}`,
    ],
    [
      "maxResults over 50",
      "GET",
      `${DATA}/playlistItems?part=contentDetails&playlistId=${PLAYLIST}&maxResults=51`,
    ],
    [
      "a bad playlist id",
      "GET",
      `${DATA}/playlistItems?part=contentDetails&playlistId=a/b&maxResults=5`,
    ],
    [
      "channels by id",
      "GET",
      `${DATA}/channels?part=${CHANNEL_PARTS}&id=UCfakeChannel0000000000a&maxResults=50`,
    ],
    ["a write", "POST", `${DATA}/videos?part=snippet&id=${VIDEO}`],
    ["search", "GET", `${DATA}/search?part=snippet&q=x`],
    ["comments", "GET", `${DATA}/commentThreads?part=snippet&videoId=${VIDEO}`],
    ["the token endpoint by GET", "GET", "https://oauth2.googleapis.com/token"],
    ["a token URL query", "POST", "https://oauth2.googleapis.com/token?refresh_token=x"],
    ["a token in the revocation URL", "POST", "https://oauth2.googleapis.com/revoke?token=x"],
    ["revocation by GET", "GET", "https://oauth2.googleapis.com/revoke"],
    ["analytics (Checkpoint 3)", "GET", "https://youtubeanalytics.googleapis.com/v2/reports"],
  ])("refuses %s", (_label, method, url) => {
    expect(isAllowedRequest(method, url)).toBe(false);
  });
});

describe("transport", () => {
  it("never calls fetch for a refused request or a spent budget", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const client = createYouTubeClient({ timeoutMs: 1_000 });
    const blocked = await client.listVideos("tok", ["bad id"], new YouTubeRequestBudget(5));
    expect(blocked).toEqual({ ok: false, failure: { type: "blocked" } });
    const budget = new YouTubeRequestBudget(1);
    budget.take();
    const spent = await client.listVideos("tok", [VIDEO], budget);
    expect(spent).toEqual({ ok: false, failure: { type: "budget_exceeded" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends the access token only as a Bearer header and the refresh token only in the body", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const client = createYouTubeClient({ timeoutMs: 1_000 });
    const budget = new YouTubeRequestBudget(2);
    await client.listMyChannels("access-secret", budget);
    await client.refreshAccessToken(
      {
        refreshToken: "refresh-secret",
        clientId: "1-a.apps.googleusercontent.com",
        clientSecret: "client-secret",
      },
      budget,
    );
    const calls = fetch.mock.calls as unknown as [string, RequestInit][];
    expect(calls).toHaveLength(2);
    const [channelsUrl, channelsInit] = calls[0]!;
    const [tokenUrl, tokenInit] = calls[1]!;
    expect(channelsUrl).not.toMatch(/secret/);
    expect(new Headers(channelsInit.headers).get("authorization")).toBe("Bearer access-secret");
    expect(tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(new Headers(tokenInit.headers).get("authorization")).toBeNull();
    expect(new URLSearchParams(String(tokenInit.body)).get("refresh_token")).toBe("refresh-secret");
    expect(budget.count).toBe(2);
  });

  it("reports network failures and timeouts without the underlying error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error(`boom ${DATA}?secret`))),
    );
    const client = createYouTubeClient({ timeoutMs: 1_000 });
    const network = await client.listVideos("tok", [VIDEO], new YouTubeRequestBudget(1));
    expect(network).toEqual({ ok: false, failure: { type: "network" } });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      ),
    );
    const slow = createYouTubeClient({ timeoutMs: 5 });
    const timeout = await slow.listVideos("tok", [VIDEO], new YouTubeRequestBudget(1));
    expect(timeout).toEqual({ ok: false, failure: { type: "timeout" } });
  });

  it("returns structured HTTP failures with reasons and a bounded Retry-After", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 403,
                status: "PERMISSION_DENIED",
                errors: [{ reason: "quotaExceeded" }],
              },
            }),
            { status: 403, headers: { "Retry-After": "120" } },
          ),
      ),
    );
    const client = createYouTubeClient({ timeoutMs: 1_000 });
    const result = await client.listVideos("tok", [VIDEO], new YouTubeRequestBudget(1));
    expect(result).toEqual({
      ok: false,
      failure: {
        type: "http",
        status: 403,
        reasons: ["quotaExceeded"],
        rpcStatus: "PERMISSION_DENIED",
        retryAfterMs: 120_000,
      },
    });
  });
});

describe("parseErrorBody", () => {
  it("reads OAuth errors, reasons, detail reasons and the RPC status", () => {
    expect(parseErrorBody({ error: "invalid_grant", error_description: "x" })).toEqual({
      reasons: [],
      oauthError: "invalid_grant",
    });
    expect(
      parseErrorBody({
        error: {
          status: "PERMISSION_DENIED",
          errors: [{ reason: "accessNotConfigured", message: "no" }],
          details: [
            { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SERVICE_DISABLED" },
          ],
        },
      }),
    ).toEqual({
      reasons: ["accessNotConfigured", "SERVICE_DISABLED"],
      rpcStatus: "PERMISSION_DENIED",
    });
  });

  it("drops anything that is not a plain code", () => {
    expect(
      parseErrorBody({ error: { status: "bad status!", errors: [{ reason: "has space" }, {}] } }),
    ).toEqual({ reasons: [] });
    expect(parseErrorBody({ error: "Not An Error Code" })).toEqual({ reasons: [] });
    expect(parseErrorBody(undefined)).toEqual({ reasons: [] });
  });
});
