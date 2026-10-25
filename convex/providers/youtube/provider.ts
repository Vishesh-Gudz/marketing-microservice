import { compareDateKeys, diffDays, isDateKey } from "../../lib/dates";
import type {
  ProviderSocialPost,
  ProviderSocialPostSnapshot,
  SocialProvider,
} from "../social/types";
import { assertValidSocialRecord } from "../social/validate";
import type { ProviderContext, ProviderOperation } from "../types";
import { YOUTUBE_CAPABILITIES } from "./capabilities";
import { YouTubeRequestBudget } from "./client";
import {
  isYouTubeChannelId,
  isYouTubePlaylistId,
  isYouTubeVideoId,
  SYNC_TIMEOUT_MS,
  YOUTUBE_PROVIDER_ID,
  type YouTubeAppConfig,
} from "./config";
import { decodeYouTubeCursor, encodeYouTubeCursor, youtubeRequestFingerprint } from "./cursor";
import { youtubeError } from "./errors";
import { mapChannel, mapReportDays, mapVideo, mapVideoSnapshot } from "./mapping";
import { YOUTUBE_ANALYTICS_SCOPE } from "./oauth";
import {
  parseRaw,
  rawListResponse,
  rawPlaylistItem,
  rawReport,
  rawVideo,
  type RawVideo,
} from "./schemas";
import { LISTING_PAGE_SIZE } from "./semantics";
import { bodyOf, createYouTubeSession, ownedChannelOf, type YouTubeSession } from "./session";

/**
 * The YouTube SocialProvider (ADR 0016). Plain fetch through the allowlisted client
 * (./client.ts), so it runs in either runtime; the social worker resolves it through
 * providers/social/nodeRegistry.ts like every social sync provider.
 *
 * Every operation first checks, before any network access (./session.ts), the configuration
 * (a valid OAuth client of its own, not shared with Google Ads; the credential's client must be
 * YOUTUBE_CLIENT_ID), the credential shape, and that the requested channel is the one the
 * consent was given for. Then, with an explicit per-call request budget
 * (capabilities.requestBudget), it mints a fresh access token from the stored refresh token
 * (memory only, Y-D5) and reads:
 *
 *   getAccount           2 requests: token + `channels.list?mine=true` (the channel must be one
 *                        the authorization owns: the authorization is re-checked on every sync)
 *   listPosts            first page 4 requests: token + channel (the uploads playlist) +
 *                        `playlistItems.list` (50) + `videos.list` (those ids); later pages 3
 *                        (the playlist id travels in the cursor)
 *   fetchPostMetrics     the same uploads pages, with `videos.list` statistics: one lifetime
 *                        snapshot per upload published on or after `publishedFrom` (newest
 *                        first; the listing ends at the first older upload)
 *   fetchAccountMetrics  2 requests: token + ONE `reports.query` for the whole window (at most
 *                        31 days); one record per requested day. Without the
 *                        yt-analytics.readonly grant it fails as `permission` before any request.
 *
 * Semantics and mapping: ./semantics.ts, ./mapping.ts. "upcoming" broadcasts are skipped;
 * uploads that `videos.list` no longer returns (deleted or made inaccessible between the two
 * reads), or that cannot be mapped, are counted `unresolved`. Only values YouTube reports are
 * emitted (Developer Policies III.E.4.h); a missing value stays absent.
 */

const CAPS = YOUTUBE_CAPABILITIES;

/** One page of the uploads playlist with its `videos.list` resources. */
type UploadsPage = {
  playlistId: string;
  /** Video ids of the page, in playlist order (newest first), once each. */
  ids: string[];
  videos: Map<string, RawVideo>;
  /** Playlist items without a usable video id. */
  unresolved: number;
  nextPageToken?: string;
};

function dayStartMs(day: string): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

export function createYouTubeSocialProvider(
  options: YouTubeAppConfig & { timeoutMs?: number },
): SocialProvider {
  const youtube = createYouTubeSession(options, {
    timeoutMs: options.timeoutMs ?? SYNC_TIMEOUT_MS,
  });
  const { client } = youtube;

  const verify = (
    operation: ProviderOperation,
    ctx: ProviderContext,
    accountExternalId: string,
  ): YouTubeSession => {
    const session = youtube.open(operation, ctx.credential);
    if (!isYouTubeChannelId(accountExternalId)) {
      throw youtubeError("invalid_request", operation, "account_invalid", "Invalid channel id");
    }
    if (accountExternalId !== session.credential.channelId) {
      throw youtubeError(
        "permission",
        operation,
        "account_mismatch",
        "The authorization does not belong to this channel",
      );
    }
    return session;
  };

  /** Token + (first page: the uploads playlist) + one playlist page + one `videos.list`. */
  async function uploadsPage(
    session: YouTubeSession,
    operation: ProviderOperation,
    position: { playlistId: string; pageToken: string } | undefined,
    statistics: boolean,
  ): Promise<UploadsPage> {
    const channelId = session.credential.channelId;
    const budget = new YouTubeRequestBudget(CAPS.requestBudget.maxRequestsPerProviderCall);
    const token = await youtube.accessToken(session, operation, budget);

    let playlistId = position?.playlistId;
    if (playlistId === undefined) {
      const channels = await youtube.ownedChannels(token, operation, budget);
      const uploads = ownedChannelOf(channels, channelId, operation).contentDetails
        ?.relatedPlaylists?.uploads;
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
      const body = bodyOf(await client.listVideos(token, ids, budget, { statistics }), operation);
      for (const item of parseRaw(rawListResponse, body, operation, "video list").items ?? []) {
        const video = parseRaw(rawVideo, item, operation, "video");
        // Only the ids this page asked for.
        if (ids.includes(video.id)) videos.set(video.id, video);
      }
    }
    return {
      playlistId,
      ids,
      videos,
      unresolved,
      ...(page.nextPageToken !== undefined ? { nextPageToken: page.nextPageToken } : {}),
    };
  }

  return Object.freeze({
    platform: "youtube" as const,
    providerId: YOUTUBE_PROVIDER_ID,
    capabilities: CAPS,

    async getAccount(ctx, request) {
      const operation = "getSocialAccount" as const;
      const session = verify(operation, ctx, request.accountExternalId);
      const budget = new YouTubeRequestBudget(2);
      const token = await youtube.accessToken(session, operation, budget);
      const channels = await youtube.ownedChannels(token, operation, budget);
      const record = mapChannel(ownedChannelOf(channels, request.accountExternalId, operation));
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
      const page = await uploadsPage(session, operation, position, false);

      let unresolved = page.unresolved;
      const items: ProviderSocialPost[] = [];
      for (const id of page.ids) {
        const video = page.videos.get(id);
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
                playlistId: page.playlistId,
                pageToken: page.nextPageToken,
              }),
            }
          : {}),
        ...(unresolved > 0 ? { unresolved } : {}),
      };
    },

    async fetchPostMetrics(ctx, request) {
      const operation = "fetchPostMetrics" as const;
      const session = verify(operation, ctx, request.accountExternalId);
      if (!isDateKey(request.publishedFrom)) {
        throw youtubeError("invalid_request", operation, "window_invalid", "Invalid window");
      }
      const channelId = request.accountExternalId;
      const windowStart = dayStartMs(request.publishedFrom);
      const fp = youtubeRequestFingerprint(operation, [channelId, request.publishedFrom]);
      const position =
        request.cursor === undefined
          ? undefined
          : decodeYouTubeCursor(request.cursor, fp, operation);
      const page = await uploadsPage(session, operation, position, true);
      const capturedAt = Date.now();

      let unresolved = page.unresolved;
      let reachedWindowEnd = false;
      const items: ProviderSocialPostSnapshot[] = [];
      for (const id of page.ids) {
        const video = page.videos.get(id);
        const mapped =
          video === undefined ? { kind: "unresolved" as const } : mapVideo(video, channelId);
        if (mapped.kind === "excluded") continue; // "upcoming": no snapshot, never counted
        if (mapped.kind === "unresolved") {
          unresolved++;
          continue;
        }
        if (mapped.record.publishedAt < windowStart) {
          reachedWindowEnd = true; // newest first [YR7]: everything after is older
          break;
        }
        const snapshot = mapVideoSnapshot({
          operation,
          accountExternalId: channelId,
          video: video!,
          capturedAt,
        });
        assertValidSocialRecord("socialPostSnapshot", snapshot, "youtube", operation);
        items.push(snapshot);
      }
      return {
        items,
        ...(!reachedWindowEnd && page.nextPageToken !== undefined
          ? {
              nextCursor: encodeYouTubeCursor(fp, operation, {
                playlistId: page.playlistId,
                pageToken: page.nextPageToken,
              }),
            }
          : {}),
        ...(unresolved > 0 ? { unresolved } : {}),
      };
    },

    async fetchAccountMetrics(ctx, request) {
      const operation = "fetchAccountMetrics" as const;
      const session = verify(operation, ctx, request.accountExternalId);
      const { from, to } = request;
      if (
        !isDateKey(from) ||
        !isDateKey(to) ||
        compareDateKeys(from, to) > 0 ||
        diffDays(from, to) + 1 > CAPS.maxAccountMetricsRangeDays
      ) {
        throw youtubeError("invalid_request", operation, "window_invalid", "Invalid window");
      }
      if (request.cursor !== undefined) {
        // One report covers the whole window: any cursor is foreign.
        throw youtubeError("invalid_request", operation, "cursor_invalid", "Unexpected cursor");
      }
      if (!session.credential.scopes.includes(YOUTUBE_ANALYTICS_SCOPE)) {
        // Granular consent left the analytics scope out: never a request that must fail.
        throw youtubeError(
          "permission",
          operation,
          "analytics_scope_missing",
          "YouTube Analytics access was not granted",
        );
      }
      const budget = new YouTubeRequestBudget(2);
      const token = await youtube.accessToken(session, operation, budget);
      const body = bodyOf(
        await client.queryChannelDays(token, { startDate: from, endDate: to }, budget),
        operation,
      );
      const items = mapReportDays({
        operation,
        accountExternalId: request.accountExternalId,
        from,
        to,
        report: parseRaw(rawReport, body, operation, "report"),
      });
      for (const item of items) {
        assertValidSocialRecord("socialAccountDay", item, "youtube", operation);
      }
      return { items };
    },
  } satisfies SocialProvider);
}
