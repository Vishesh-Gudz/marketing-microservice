import { compareDateKeys, diffDays, isDateKey, todayIn } from "../../../lib/dates";
import { pkceChallengeS256 } from "../../../lib/crypto";
import { ProviderError } from "../../errors";
import { fingerprint } from "../../hash";
import type { OAuthGrant, OAuthSpec } from "../../oauth";
import type { PageRequest, ProviderContext, ProviderOperation, ProviderPage } from "../../types";
import { YOUTUBE_CAPABILITIES } from "../../youtube/capabilities";
import { mapChannel, mapReportDays, mapVideo, mapVideoSnapshot } from "../../youtube/mapping";
import { YOUTUBE_READONLY_SCOPE, YOUTUBE_SCOPES } from "../../youtube/oauth";
import type {
  ProviderDiscoveredSocialAccount,
  ProviderSocialPost,
  ProviderSocialPostSnapshot,
  SocialAccountDiscovery,
  SocialProvider,
} from "../types";
import { assertValidSocialRecord } from "../validate";
import {
  mockYouTubeChannel,
  mockYouTubeChannelId,
  mockYouTubeReport,
  mockYouTubeVideos,
} from "./youtubeData";

/**
 * Mock YouTube (ADR 0016, Y-D12), registered ONLY in PROVIDER_MODE=mock (local development and
 * tests), never in live or misconfigured modes. Deterministic; no network.
 *
 * - The SocialProvider serves the raw-shaped mock data (./youtubeData.ts) through the REAL
 *   YouTube mapping and capabilities, with the same exclusions ("upcoming") and unresolved
 *   counts as the live provider; day reports and lifetime statistics run the same mapping.
 * - The OAuth spec is "instant consent" with PKCE (like the ads mock): the authorization URL
 *   IS the callback URL carrying `mock-yt-code.<user>.<fingerprint(challenge, user)>`; the
 *   scopes are the real YouTube scopes.
 * - Discovery returns the credential's channel.
 *
 * Users: "<n>" a channel; "limited" grants youtube.readonly only (analytics scope missing:
 * its day reports fail as `permission`, like the live provider);
 * "noyoutube" grants no youtube.readonly (the exchange fails); "nochannel" has no channel;
 * "norefresh" receives no refresh token; "revoked" holds a credential the mock rejects
 * ("auth", as `invalid_grant`). See ./youtubeData.ts for the data users.
 */

export const MOCK_YOUTUBE_PROVIDER_ID = "mock-youtube";

export type MockYouTubeCredential = { kind: "mock_youtube"; token: string; user: string };

export function isMockYouTubeCredential(value: unknown): value is MockYouTubeCredential {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return c.kind === "mock_youtube" && typeof c.token === "string" && typeof c.user === "string";
}

const USER = /^[A-Za-z0-9_-]{1,32}$/;
const CAPS = YOUTUBE_CAPABILITIES;

function fail(
  kind: ProviderError["kind"],
  operation: ProviderOperation,
  providerCode: string,
  message: string,
): never {
  throw new ProviderError({ kind, platform: "youtube", operation, message, providerCode });
}

/** Checks the credential and channel ownership exactly like the YouTube provider. */
function mockUser(ctx: ProviderContext, operation: ProviderOperation, channelId: string) {
  const credential = ctx.credential;
  if (!isMockYouTubeCredential(credential) || !USER.test(credential.user)) {
    return fail("auth", operation, "credential_invalid", "Unusable mock credential");
  }
  if (credential.token === "revoked") return fail("auth", operation, "invalid_grant", "Revoked");
  if (channelId !== mockYouTubeChannelId(credential.user)) {
    return fail("permission", operation, "account_mismatch", "Not this mock channel");
  }
  return credential.user;
}

/** Opaque mock cursor bound to (operation, channel): "mockyt1.<offset>.<check>". */
function encodeCursor(operation: ProviderOperation, channelId: string, offset: number): string {
  return `mockyt1.${offset}.${fingerprint([operation, channelId, offset])}`;
}

function decodeCursor(operation: ProviderOperation, channelId: string, cursor: string): number {
  const match = /^mockyt1\.(\d{1,6})\.([0-9a-z]+)$/.exec(cursor);
  if (!match || match[2] !== fingerprint([operation, channelId, Number(match[1])])) {
    return fail("invalid_request", operation, "cursor_invalid", "Cursor is malformed");
  }
  return Number(match[1]);
}

export function createMockYouTubeSocialProvider(): SocialProvider {
  return Object.freeze({
    platform: "youtube" as const,
    providerId: MOCK_YOUTUBE_PROVIDER_ID,
    capabilities: CAPS,

    async getAccount(ctx, request) {
      const operation = "getSocialAccount" as const;
      const user = mockUser(ctx, operation, request.accountExternalId);
      const record = mapChannel(mockYouTubeChannel(user));
      assertValidSocialRecord("socialAccount", record, "youtube", operation);
      return record;
    },

    async listPosts(ctx, request) {
      const operation = "listSocialPosts" as const;
      const channelId = request.accountExternalId;
      const user = mockUser(ctx, operation, channelId);
      const start =
        request.cursor === undefined ? 0 : decodeCursor(operation, channelId, request.cursor);
      const videos = mockYouTubeVideos(user, todayIn("UTC", Date.now()));
      const page = videos.slice(start, start + CAPS.defaultPageSize);
      const items: ProviderSocialPost[] = [];
      let unresolved = 0;
      for (const video of page) {
        const mapped = mapVideo(video, channelId);
        if (mapped.kind === "unresolved") unresolved++;
        if (mapped.kind !== "post") continue;
        assertValidSocialRecord("socialPost", mapped.record, "youtube", operation);
        items.push(mapped.record);
      }
      const next = start + CAPS.defaultPageSize;
      return {
        items,
        ...(next < videos.length ? { nextCursor: encodeCursor(operation, channelId, next) } : {}),
        ...(unresolved > 0 ? { unresolved } : {}),
      };
    },

    async fetchPostMetrics(ctx, request) {
      const operation = "fetchPostMetrics" as const;
      const channelId = request.accountExternalId;
      const user = mockUser(ctx, operation, channelId);
      if (!isDateKey(request.publishedFrom)) {
        return fail("invalid_request", operation, "window_invalid", "Invalid window");
      }
      const binding = `${channelId}|${request.publishedFrom}`;
      const start =
        request.cursor === undefined ? 0 : decodeCursor(operation, binding, request.cursor);
      const now = Date.now();
      const windowStart = Date.parse(`${request.publishedFrom}T00:00:00Z`);
      const videos = mockYouTubeVideos(user, todayIn("UTC", now));
      const page = videos.slice(start, start + CAPS.postMetricsPageSize);
      const items: ProviderSocialPostSnapshot[] = [];
      let unresolved = 0;
      let ended = false;
      for (const video of page) {
        const mapped = mapVideo(video, channelId);
        if (mapped.kind === "excluded") continue;
        if (mapped.kind === "unresolved") {
          unresolved++;
          continue;
        }
        if (mapped.record.publishedAt < windowStart) {
          ended = true;
          break;
        }
        const snapshot = mapVideoSnapshot({
          operation,
          accountExternalId: channelId,
          video,
          capturedAt: now,
        });
        assertValidSocialRecord("socialPostSnapshot", snapshot, "youtube", operation);
        items.push(snapshot);
      }
      const next = start + CAPS.postMetricsPageSize;
      return {
        items,
        ...(!ended && next < videos.length
          ? { nextCursor: encodeCursor(operation, binding, next) }
          : {}),
        ...(unresolved > 0 ? { unresolved } : {}),
      };
    },

    async fetchAccountMetrics(ctx, request) {
      const operation = "fetchAccountMetrics" as const;
      const user = mockUser(ctx, operation, request.accountExternalId);
      const { from, to } = request;
      if (
        !isDateKey(from) ||
        !isDateKey(to) ||
        compareDateKeys(from, to) > 0 ||
        diffDays(from, to) + 1 > CAPS.maxAccountMetricsRangeDays
      ) {
        return fail("invalid_request", operation, "window_invalid", "Invalid window");
      }
      if (request.cursor !== undefined) {
        return fail("invalid_request", operation, "cursor_invalid", "Unexpected cursor");
      }
      if (user === "limited") {
        return fail("permission", operation, "analytics_scope_missing", "Not granted");
      }
      const items = mapReportDays({
        operation,
        accountExternalId: request.accountExternalId,
        from,
        to,
        report: mockYouTubeReport(user, from, to),
      });
      for (const item of items) {
        assertValidSocialRecord("socialAccountDay", item, "youtube", operation);
      }
      return { items };
    },
  } satisfies SocialProvider);
}

// ---------------------------------------------------------------------------
// Mock OAuth (instant consent with PKCE) and discovery
// ---------------------------------------------------------------------------

const CODE = /^mock-yt-code\.([A-Za-z0-9_-]{1,32})\.([0-9a-z]+)$/;
export const MOCK_YT_INVALID_CODE = "mock-yt-code-invalid";
export const MOCK_YT_UNAVAILABLE_CODE = "mock-yt-code-5xx";

function codeSignature(codeChallenge: string | undefined, user: string): string {
  return fingerprint(["youtube", codeChallenge ?? "", user]);
}

/** Test helper: the code the mock issues for `user` with this PKCE challenge. */
export function mockYouTubeCode(codeChallenge: string | undefined, user = "1"): string {
  return `mock-yt-code.${user}.${codeSignature(codeChallenge, user)}`;
}

export function createMockYouTubeOAuthSpec(): OAuthSpec<MockYouTubeCredential> {
  const operation = "oauthExchange" as const;
  const grantFor = (user: string): OAuthGrant<MockYouTubeCredential> => ({
    credential: {
      kind: "mock_youtube",
      token: user === "revoked" ? "revoked" : `mock-yt-token-${user}`,
      user,
    },
    identity: { externalUserId: mockYouTubeChannelId(user) },
    grantedScopes: user === "limited" ? [YOUTUBE_READONLY_SCOPE] : [...YOUTUBE_SCOPES],
    refreshable: true,
  });

  return Object.freeze({
    platform: "youtube" as const,
    providerId: MOCK_YOUTUBE_PROVIDER_ID,
    requestedScopes: YOUTUBE_SCOPES,
    requiredScopes: YOUTUBE_SCOPES,
    usesPkce: true,

    buildAuthorizationUrl({ state, redirectUri, codeChallenge }) {
      const url = new URL(redirectUri);
      url.searchParams.set("state", state);
      url.searchParams.set("code", mockYouTubeCode(codeChallenge));
      url.searchParams.set("scope", YOUTUBE_SCOPES.join(" "));
      if (codeChallenge !== undefined) {
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url.toString();
    },

    async exchangeCode({ code, codeVerifier }) {
      if (code === MOCK_YT_UNAVAILABLE_CODE) {
        return fail(
          "transient",
          operation,
          "token_exchange:http_503",
          "Token endpoint unavailable",
        );
      }
      const match = CODE.exec(code);
      const challenge =
        codeVerifier !== undefined ? await pkceChallengeS256(codeVerifier) : undefined;
      if (!match || match[2] !== codeSignature(challenge, match[1]!)) {
        return fail(
          "auth",
          operation,
          "token_exchange:invalid_grant",
          "Invalid authorization code",
        );
      }
      const user = match[1]!;
      if (user === "norefresh") {
        return fail("auth", operation, "token_exchange:no_refresh_token", "No refresh token");
      }
      if (user === "noyoutube") {
        return fail("permission", operation, "identity:youtube_scope_missing", "Not granted");
      }
      if (user === "nochannel") {
        return fail("permission", operation, "identity:no_channel", "No channel");
      }
      return grantFor(user);
    },

    // The mock has nothing to revoke at a platform.
    async revoke() {},
  } satisfies OAuthSpec<MockYouTubeCredential>);
}

export function createMockYouTubeDiscovery(): SocialAccountDiscovery {
  const operation = "listSocialAccounts" as const;
  return Object.freeze({
    platform: "youtube" as const,
    providerId: MOCK_YOUTUBE_PROVIDER_ID,
    async listAccounts(
      ctx: ProviderContext,
      request: PageRequest,
    ): Promise<ProviderPage<ProviderDiscoveredSocialAccount>> {
      if (request.cursor !== undefined) {
        return fail("invalid_request", operation, "cursor_invalid", "Unexpected cursor");
      }
      const credential = ctx.credential;
      if (!isMockYouTubeCredential(credential) || !USER.test(credential.user)) {
        return fail("auth", operation, "credential_invalid", "Unusable mock credential");
      }
      const user = mockUser(ctx, operation, mockYouTubeChannelId(credential.user));
      const channel = mockYouTubeChannel(user);
      const record: ProviderDiscoveredSocialAccount = {
        platform: "youtube",
        externalId: channel.id,
        accountType: "channel",
      };
      assertValidSocialRecord("discoveredSocialAccount", record, "youtube", operation);
      return { items: [record] };
    },
  });
}
