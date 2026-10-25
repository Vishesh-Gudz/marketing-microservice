import { todayIn } from "../../../lib/dates";
import { ProviderError } from "../../errors";
import { fingerprint } from "../../hash";
import type { ProviderContext, ProviderOperation } from "../../types";
import { YOUTUBE_CAPABILITIES } from "../../youtube/capabilities";
import { mapChannel, mapVideo } from "../../youtube/mapping";
import type { ProviderSocialPost, SocialProvider } from "../types";
import { assertValidSocialRecord } from "../validate";
import { mockYouTubeChannel, mockYouTubeChannelId, mockYouTubeVideos } from "./youtubeData";

/**
 * Mock YouTube SocialProvider (ADR 0016, Y-D12), registered ONLY in PROVIDER_MODE=mock (local
 * development and tests), never in live or misconfigured modes. Deterministic; no network.
 * It serves the raw-shaped mock data (./youtubeData.ts) through the REAL YouTube mapping and
 * capabilities, with the same exclusions ("upcoming") and unresolved counts as the live
 * provider. User "revoked" holds a credential the mock rejects ("auth", as `invalid_grant`).
 * The mock OAuth spec and discovery that issue these credentials are Checkpoint 2.
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

function unsupported(operation: ProviderOperation, what: string): never {
  return fail("unsupported", operation, "not_implemented", `YouTube ${what} are not implemented`);
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

    // Not declared in the capabilities (Checkpoint 3), exactly like the live provider.
    async fetchPostMetrics() {
      return unsupported("fetchPostMetrics", "post metrics");
    },

    async fetchAccountMetrics() {
      return unsupported("fetchAccountMetrics", "account metrics");
    },
  } satisfies SocialProvider);
}
