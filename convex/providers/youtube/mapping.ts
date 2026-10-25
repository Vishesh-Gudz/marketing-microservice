import type { ProviderSocialAccount, ProviderSocialPost } from "../social/types";
import type { RawChannel, RawVideo } from "./schemas";
import { parseCount } from "./schemas";
import {
  CHANNEL_ACCOUNT_TYPE,
  EXCLUDED_BROADCAST_CONTENT,
  HANDLE,
  HANDLE_PREFIX,
  PUBLISHED_BROADCAST_CONTENT,
  TITLE_MAX_CHARS,
  VIDEO_POST_TYPE,
  youtubePermalink,
} from "./semantics";

/**
 * Pure YouTube -> canonical record mapping (ADR 0016), driven by ./semantics.ts. Inputs are
 * shape-checked raw Data API resources (./schemas.ts); outputs are provider records the caller
 * validates at the boundary. Rules:
 * - a missing value stays ABSENT; an explicit 0 stays 0; nothing is ever zero-filled;
 * - the built permalink is the only URL that survives; thumbnails never do;
 * - "upcoming" broadcasts are excluded; a video without a usable publish time, broadcast state
 *   or owner is unresolved — neither is ever emitted as a post.
 */

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/;

/**
 * [doc] Data API times are ISO 8601 in UTC ("2026-09-28T12:00:00Z"). Parsed explicitly; any
 * other shape (including an offset) is undefined. [PROVISIONAL YR8] the exact format.
 */
export function parseYouTubeTimestamp(raw: string | undefined): number | undefined {
  const match = raw === undefined ? null : TIMESTAMP.exec(raw);
  if (match === null) return undefined;
  const [y, mo, d, h, mi, s] = match.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const base = Date.UTC(y, mo - 1, d, h, mi, s);
  const check = new Date(base);
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() !== mo - 1 ||
    check.getUTCDate() !== d ||
    h > 23 ||
    mi > 59 ||
    s > 59
  ) {
    return undefined;
  }
  const fraction = match[7];
  const instant = base + (fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000));
  return instant > 0 && Number.isSafeInteger(instant) ? instant : undefined;
}

/** At most TITLE_MAX_CHARS characters (code points, never a split surrogate pair). */
export function capTitle(title: string | undefined): string | undefined {
  const trimmed = title?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  const chars = Array.from(trimmed);
  return chars.length <= TITLE_MAX_CHARS ? trimmed : chars.slice(0, TITLE_MAX_CHARS).join("");
}

/** The handle without its "@" when `customUrl` is a handle; anything else is undefined. */
export function handleOf(customUrl: string | undefined): string | undefined {
  if (customUrl === undefined || !customUrl.startsWith(HANDLE_PREFIX)) return undefined;
  const handle = customUrl.slice(HANDLE_PREFIX.length);
  return HANDLE.test(handle) ? handle : undefined;
}

/**
 * The preflight record of one channel: the title (falling back to the handle, then the id),
 * the handle as username, and the (rounded) subscriber count unless hidden. No URL (no
 * thumbnails, no custom URL beyond the handle).
 */
export function mapChannel(raw: RawChannel): ProviderSocialAccount {
  const username = handleOf(raw.snippet?.customUrl);
  const name = capTitle(raw.snippet?.title) ?? username ?? raw.id;
  const followersCount =
    raw.statistics?.hiddenSubscriberCount === true
      ? undefined
      : parseCount(raw.statistics?.subscriberCount);
  return {
    platform: "youtube",
    externalId: raw.id,
    ...(username !== undefined ? { username } : {}),
    name,
    accountType: CHANNEL_ACCOUNT_TYPE,
    ...(followersCount !== undefined ? { followersCount } : {}),
    status: "active",
  };
}

export type MappedVideo =
  { kind: "post"; record: ProviderSocialPost } | { kind: "excluded" } | { kind: "unresolved" };

/** One upload of `channelId` as a post, or why it is not one. */
export function mapVideo(raw: RawVideo, channelId: string): MappedVideo {
  const snippet = raw.snippet;
  if (snippet === undefined || snippet.channelId !== channelId) return { kind: "unresolved" };
  const broadcast = snippet.liveBroadcastContent;
  if (broadcast !== undefined && EXCLUDED_BROADCAST_CONTENT.has(broadcast)) {
    return { kind: "excluded" };
  }
  if (broadcast === undefined || !PUBLISHED_BROADCAST_CONTENT.has(broadcast)) {
    return { kind: "unresolved" };
  }
  const publishedAt = parseYouTubeTimestamp(snippet.publishedAt);
  if (publishedAt === undefined) return { kind: "unresolved" };
  const caption = capTitle(snippet.title);
  return {
    kind: "post",
    record: {
      platform: "youtube",
      accountExternalId: channelId,
      externalId: raw.id,
      type: VIDEO_POST_TYPE,
      publishedAt,
      ...(caption !== undefined ? { caption } : {}),
      permalink: youtubePermalink(raw.id),
    },
  };
}
