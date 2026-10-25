import type { ProviderSocialPost, SocialProvider } from "../social/types";
import { assertValidSocialRecord } from "../social/validate";
import type { ProviderContext, ProviderOperation } from "../types";
import { YOUTUBE_CAPABILITIES } from "./capabilities";
import { createYouTubeClient, YouTubeRequestBudget, type YouTubeResult } from "./client";
import {
  isValidYouTubeClientId,
  isValidYouTubeClientSecret,
  isYouTubeChannelId,
  isYouTubePlaylistId,
  isYouTubeVideoId,
  SYNC_TIMEOUT_MS,
  YOUTUBE_CONFIG_INVALID,
  YOUTUBE_PROVIDER_ID,
} from "./config";
import { isYouTubeCredential, type YouTubeCredential } from "./credential";
import { decodeYouTubeCursor, encodeYouTubeCursor, youtubeRequestFingerprint } from "./cursor";
import { classifyYouTubeFailure, youtubeError, youtubeProviderError } from "./errors";
import { mapChannel, mapVideo } from "./mapping";
import {
  parseRaw,
  rawChannel,
  rawListResponse,
  rawPlaylistItem,
  rawTokenResponse,
  rawVideo,
  type RawChannel,
  type RawVideo,
} from "./schemas";
import { LISTING_PAGE_SIZE } from "./semantics";

/**
 * The YouTube SocialProvider (ADR 0016). Plain fetch through the allowlisted client
 * (./client.ts), so it runs in either runtime; the social worker resolves it through
 * providers/social/nodeRegistry.ts like every social sync provider.
 *
 * Every operation first checks, before any network access, the configuration (the
 * credential's OAuth client must be YOUTUBE_CLIENT_ID), the credential shape, and that the
 * requested channel is the one the consent was given for. Then, with an explicit per-call
 * request budget (capabilities.requestBudget), it mints a fresh access token from the stored
 * refresh token (memory only, Y-D5) and reads:
 *
 *   getAccount        2 requests: token + `channels.list?mine=true` (the channel must be one
 *                     the authorization owns: the authorization is re-checked on every sync)
 *   listPosts         first page 4 requests: token + channel (the uploads playlist) +
 *                     `playlistItems.list` (50) + `videos.list` (those ids); later pages 3
 *                     (the playlist id travels in the cursor)
 *   fetchPostMetrics  unsupported until Checkpoint 3 (no network)
 *   fetchAccountMetrics  unsupported until Checkpoint 3 (no network)
 *
 * Semantics and mapping: ./semantics.ts, ./mapping.ts. "upcoming" broadcasts are skipped;
 * uploads that `videos.list` no longer returns (deleted or made inaccessible between the two
 * reads), or that cannot be mapped, are counted `unresolved`.
 */

const CAPS = YOUTUBE_CAPABILITIES;

function unsupported(operation: ProviderOperation, what: string) {
  return youtubeError(
    "unsupported",
    operation,
    "not_implemented",
    `YouTube ${what} are not implemented`,
  );
}

type Session = { credential: YouTubeCredential; clientId: string; clientSecret: string };

export function createYouTubeSocialProvider(options: {
  clientId?: string;
  clientSecret?: string;
  timeoutMs?: number;
}): SocialProvider {
  const client = createYouTubeClient({ timeoutMs: options.timeoutMs ?? SYNC_TIMEOUT_MS });

  const verify = (
    operation: ProviderOperation,
    ctx: ProviderContext,
    accountExternalId: string,
  ): Session => {
    const { clientId, clientSecret } = options;
    if (!isValidYouTubeClientId(clientId) || !isValidYouTubeClientSecret(clientSecret)) {
      throw youtubeError(
        "unknown",
        operation,
        YOUTUBE_CONFIG_INVALID,
        "YouTube OAuth configuration is missing or invalid",
      );
    }
    const credential: unknown = ctx.credential;
    if (!isYouTubeCredential(credential)) {
      throw youtubeError("auth", operation, "credential_invalid", "Unusable YouTube credential");
    }
    if (credential.clientId !== clientId) {
      throw youtubeError(
        "auth",
        operation,
        "client_id_mismatch",
        "Credential belongs to a different OAuth client",
      );
    }
    if (!isYouTubeChannelId(accountExternalId)) {
      throw youtubeError("invalid_request", operation, "account_invalid", "Invalid channel id");
    }
    if (accountExternalId !== credential.channelId) {
      throw youtubeError(
        "permission",
        operation,
        "account_mismatch",
        "The authorization does not belong to this channel",
      );
    }
    return { credential, clientId, clientSecret };
  };

  function bodyOf(result: YouTubeResult, operation: ProviderOperation): unknown {
    if (!result.ok) throw youtubeProviderError(classifyYouTubeFailure(result.failure), operation);
    return result.body;
  }

  async function accessToken(
    session: Session,
    operation: ProviderOperation,
    budget: YouTubeRequestBudget,
  ): Promise<string> {
    const result = await client.refreshAccessToken(
      {
        refreshToken: session.credential.refreshToken,
        clientId: session.clientId,
        clientSecret: session.clientSecret,
      },
      budget,
    );
    return parseRaw(rawTokenResponse, bodyOf(result, operation), operation, "token").access_token;
  }

  /** The requested channel among the channels the authorization owns. */
  async function ownedChannel(
    token: string,
    channelId: string,
    operation: ProviderOperation,
    budget: YouTubeRequestBudget,
  ): Promise<RawChannel> {
    const body = bodyOf(await client.listMyChannels(token, budget), operation);
    const list = parseRaw(rawListResponse, body, operation, "channel list");
    for (const item of list.items ?? []) {
      const channel = parseRaw(rawChannel, item, operation, "channel");
      if (channel.id === channelId) return channel;
    }
    throw youtubeError(
      "permission",
      operation,
      "account_mismatch",
      "The authorization does not own this channel",
    );
  }

  return Object.freeze({
    platform: "youtube" as const,
    providerId: YOUTUBE_PROVIDER_ID,
    capabilities: CAPS,

    async getAccount(ctx, request) {
      const operation = "getSocialAccount" as const;
      const session = verify(operation, ctx, request.accountExternalId);
      const budget = new YouTubeRequestBudget(2);
      const token = await accessToken(session, operation, budget);
      const channel = await ownedChannel(token, request.accountExternalId, operation, budget);
      const record = mapChannel(channel);
      assertValidSocialRecord("socialAccount", record, "youtube", operation);
      return record;
    },

    async listPosts(ctx, request) {
      const operation = "listSocialPosts" as const;
      const session = verify(operation, ctx, request.accountExternalId);
      const channelId = request.accountExternalId;
      const fp = youtubeRequestFingerprint(operation, [channelId]);
      const position =
        request.cursor === undefined
          ? undefined
          : decodeYouTubeCursor(request.cursor, fp, operation);
      const budget = new YouTubeRequestBudget(CAPS.requestBudget.maxRequestsPerProviderCall);
      const token = await accessToken(session, operation, budget);

      let playlistId = position?.playlistId;
      if (playlistId === undefined) {
        const channel = await ownedChannel(token, channelId, operation, budget);
        const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
        if (!isYouTubePlaylistId(uploads)) {
          throw youtubeError("data", operation, "uploads_missing", "No uploads playlist");
        }
        playlistId = uploads;
      }

      const pageBody = bodyOf(
        await client.listPlaylistItems(
          token,
          {
            playlistId,
            maxResults: LISTING_PAGE_SIZE,
            ...(position !== undefined ? { pageToken: position.pageToken } : {}),
          },
          budget,
        ),
        operation,
      );
      const page = parseRaw(rawListResponse, pageBody, operation, "playlist page");
      let unresolved = 0;
      const ids: string[] = [];
      for (const item of page.items ?? []) {
        const videoId = parseRaw(rawPlaylistItem, item, operation, "playlist item").contentDetails
          .videoId;
        if (!isYouTubeVideoId(videoId)) unresolved++;
        else if (!ids.includes(videoId)) ids.push(videoId);
      }

      const videos = new Map<string, RawVideo>();
      if (ids.length > 0) {
        const body = bodyOf(await client.listVideos(token, ids, budget), operation);
        for (const item of parseRaw(rawListResponse, body, operation, "video list").items ?? []) {
          const video = parseRaw(rawVideo, item, operation, "video");
          // Only the ids this page asked for.
          if (ids.includes(video.id)) videos.set(video.id, video);
        }
      }

      const items: ProviderSocialPost[] = [];
      for (const id of ids) {
        const video = videos.get(id);
        const mapped =
          video === undefined ? { kind: "unresolved" as const } : mapVideo(video, channelId);
        if (mapped.kind === "unresolved") unresolved++;
        if (mapped.kind !== "post") continue; // excluded ("upcoming"): never counted
        assertValidSocialRecord("socialPost", mapped.record, "youtube", operation);
        items.push(mapped.record);
      }
      return {
        items,
        ...(page.nextPageToken !== undefined
          ? {
              nextCursor: encodeYouTubeCursor(fp, operation, {
                playlistId,
                pageToken: page.nextPageToken,
              }),
            }
          : {}),
        ...(unresolved > 0 ? { unresolved } : {}),
      };
    },

    // Not declared in the capabilities, so never planned; a direct call fails before any request.
    async fetchPostMetrics() {
      throw unsupported("fetchPostMetrics", "post metrics");
    },

    async fetchAccountMetrics() {
      throw unsupported("fetchAccountMetrics", "account metrics");
    },
  } satisfies SocialProvider);
}
