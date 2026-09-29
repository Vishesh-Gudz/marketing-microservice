import type { SocialAccountType, SocialPostType } from "../../domain/types";
import { toDateKey, type DateKey } from "../../lib/dates";
import type {
  ProviderSocialAccount,
  ProviderSocialAccountDay,
  ProviderSocialPost,
  ProviderSocialPostSnapshot,
} from "../social/types";
import type { ProviderOperation } from "../types";
import { instagramError } from "./errors";
import {
  ACCOUNT_INSIGHT_TARGETS,
  allowedPermalink,
  CAPTION_MAX_CHARS,
  EXCLUDED_MEDIA_PRODUCT_TYPES,
  FOLLOW_TYPE_FOLLOWS,
  FOLLOW_TYPE_UNFOLLOWS,
  MEDIA_TYPE_POST_TYPES,
  OTHER_POST_TYPE,
  READER_POST_METRIC_COLUMNS,
  REELS_PRODUCT_TYPE,
  SDK_POST_METRIC_COLUMNS,
} from "./semantics";

/**
 * Pure Instagram -> canonical record mapping (Phase 10 Stage B), driven by ./semantics.ts.
 * Inputs are our own read types (never raw Graph payloads or SDK types); outputs are
 * provider records the caller validates at the boundary. Rules:
 * - a missing value stays ABSENT; an explicit 0 stays 0; nothing is ever zero-filled;
 * - the permalink is the only URL that survives (R1b); profile pictures never do (F1);
 * - AD / STORY media are excluded (F20, I-D14); media without a product type or a usable
 *   timestamp are unresolved (R3) — neither is ever emitted as a post.
 */

/** One media item of a listing (raw Instagram vocabulary, already shape-checked). */
export type MediaInput = {
  id: string;
  caption?: string;
  mediaType?: string;
  mediaProductType?: string;
  permalink?: string;
  timestamp?: string;
};

export type MediaClass =
  { kind: "post"; type: SocialPostType } | { kind: "excluded" } | { kind: "unresolved" };

/** [doc] media_product_type decides first (REELS, AD, STORY); media_type decides the rest. */
export function classifyMedia(
  media: Pick<MediaInput, "mediaType" | "mediaProductType">,
): MediaClass {
  const product = media.mediaProductType;
  if (product === undefined || product === "") return { kind: "unresolved" };
  if (EXCLUDED_MEDIA_PRODUCT_TYPES.has(product)) return { kind: "excluded" };
  if (product === REELS_PRODUCT_TYPE) return { kind: "post", type: "reel" };
  const byMediaType = MEDIA_TYPE_POST_TYPES as Readonly<Record<string, SocialPostType>>;
  return { kind: "post", type: byMediaType[media.mediaType ?? ""] ?? OTHER_POST_TYPE };
}

const TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):?(\d{2}))$/;

/**
 * [doc] Media `timestamp` is ISO 8601 (Instagram writes offsets as +0000). Parsed explicitly
 * (not Date.parse, whose handling of "+0000" is implementation-defined); anything else is
 * undefined.
 */
export function parseInstagramTimestamp(raw: string | undefined): number | undefined {
  const match = raw === undefined ? null : TIMESTAMP.exec(raw);
  if (match === null) return undefined;
  const [, y, mo, d, h, mi, s, fraction, zone, sign, oh, om] = match;
  const parts = [y, mo, d, h, mi, s].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const base = Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  const check = new Date(base);
  if (
    check.getUTCFullYear() !== parts[0] ||
    check.getUTCMonth() !== parts[1] - 1 ||
    check.getUTCDate() !== parts[2] ||
    parts[3] > 23 ||
    parts[4] > 59 ||
    parts[5] > 59
  ) {
    return undefined;
  }
  const millis = fraction === undefined ? 0 : Math.floor(Number(`0.${fraction}`) * 1000);
  const offsetMinutes = zone === "Z" ? 0 : (sign === "-" ? -1 : 1) * (Number(oh) * 60 + Number(om));
  if (offsetMinutes !== 0 && (Number(oh) > 23 || Number(om) > 59)) return undefined;
  const instant = base + millis - offsetMinutes * 60_000;
  return instant > 0 && Number.isSafeInteger(instant) ? instant : undefined;
}

/** [F21] At most CAPTION_MAX_CHARS characters (code points, never a split surrogate pair). */
export function capCaption(caption: string | undefined): string | undefined {
  if (caption === undefined || caption.length === 0) return undefined;
  const chars = Array.from(caption);
  return chars.length <= CAPTION_MAX_CHARS ? caption : chars.slice(0, CAPTION_MAX_CHARS).join("");
}

export type MappedMedia =
  { kind: "post"; record: ProviderSocialPost } | { kind: "excluded" } | { kind: "unresolved" };

export function mapMedia(media: MediaInput, accountExternalId: string): MappedMedia {
  const classified = classifyMedia(media);
  if (classified.kind !== "post") return classified;
  const publishedAt = parseInstagramTimestamp(media.timestamp);
  if (publishedAt === undefined) return { kind: "unresolved" };
  const caption = capCaption(media.caption);
  const permalink = allowedPermalink(media.permalink);
  return {
    kind: "post",
    record: {
      platform: "instagram",
      accountExternalId,
      externalId: media.id,
      type: classified.type,
      publishedAt,
      ...(caption !== undefined ? { caption } : {}),
      ...(permalink !== undefined ? { permalink } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Account (sync preflight)
// ---------------------------------------------------------------------------

const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

/** Profile fields we read (biography, website and the picture never reach this point). */
export type ProfileInput = { username?: string; name?: string; followersCount?: number };
export type IdentityInput = { username?: string; accountType: SocialAccountType };

/**
 * The preflight record: [doc] name falls back to the username, then the id; followersCount
 * is the latest value as of capture [PROVISIONAL IR15]. No URL of any kind (F1).
 */
export function mapProfile(
  profile: ProfileInput,
  identity: IdentityInput,
  accountExternalId: string,
): ProviderSocialAccount {
  const username = [profile.username, identity.username].find(
    (value): value is string => value !== undefined && USERNAME.test(value),
  );
  const name = profile.name?.trim() || username || accountExternalId;
  return {
    platform: "instagram",
    externalId: accountExternalId,
    ...(username !== undefined ? { username } : {}),
    name,
    accountType: identity.accountType,
    ...(profile.followersCount !== undefined ? { followersCount: profile.followersCount } : {}),
    status: "active",
  };
}

// ---------------------------------------------------------------------------
// Post lifetime snapshot
// ---------------------------------------------------------------------------

function unexpected(operation: ProviderOperation): never {
  throw instagramError("data", operation, "metric_unexpected", "Unexpected Instagram metric");
}

/** SDK metrics (Instagram names) + reader metrics -> one snapshot captured at `capturedAt`. */
export function mapPostSnapshot(input: {
  operation: ProviderOperation;
  accountExternalId: string;
  postExternalId: string;
  capturedAt: number;
  sdk: readonly { name: string; value: number }[];
  reader: Readonly<Record<string, number>>;
}): ProviderSocialPostSnapshot {
  const metrics: Record<string, number> = {};
  const sdkColumns = SDK_POST_METRIC_COLUMNS as Readonly<Record<string, string>>;
  const readerColumns = READER_POST_METRIC_COLUMNS as Readonly<Record<string, string>>;
  const put = (column: string | undefined, value: number) => {
    if (column === undefined || column in metrics) unexpected(input.operation);
    metrics[column] = value;
  };
  for (const { name, value } of input.sdk) put(sdkColumns[name], value);
  for (const [name, value] of Object.entries(input.reader)) put(readerColumns[name], value);
  return {
    platform: "instagram",
    accountExternalId: input.accountExternalId,
    postExternalId: input.postExternalId,
    capturedDate: toDateKey(input.capturedAt, "UTC"),
    capturedAt: input.capturedAt,
    ...metrics,
  };
}

// ---------------------------------------------------------------------------
// Account daily insights (the insights column group)
// ---------------------------------------------------------------------------

/**
 * [F3][PROVISIONAL IR8] follows - unfollows from the follow_type breakdown, only when BOTH
 * values are reported and every other dimension value (e.g. UNKNOWN) is zero or absent.
 */
export function followerDelta(breakdown: Readonly<Record<string, number>> | undefined) {
  if (breakdown === undefined) return undefined;
  const follows = breakdown[FOLLOW_TYPE_FOLLOWS];
  const unfollows = breakdown[FOLLOW_TYPE_UNFOLLOWS];
  if (follows === undefined || unfollows === undefined) return undefined;
  for (const [key, value] of Object.entries(breakdown)) {
    if (key !== FOLLOW_TYPE_FOLLOWS && key !== FOLLOW_TYPE_UNFOLLOWS && value !== 0) {
      return undefined;
    }
  }
  return follows - unfollows;
}

/** One UTC day of insights; emitted even when nothing was reported (all metrics absent). */
export function mapAccountDay(input: {
  operation: ProviderOperation;
  accountExternalId: string;
  date: DateKey;
  insights: Readonly<Record<string, number>>;
  follows?: Readonly<Record<string, number>>;
}): ProviderSocialAccountDay {
  const columns: Record<string, number> = {};
  const extras: Record<string, number> = {};
  const targets = ACCOUNT_INSIGHT_TARGETS as Readonly<
    Record<string, { column: string } | { extra: string }>
  >;
  for (const [name, value] of Object.entries(input.insights)) {
    const target = targets[name];
    if (target === undefined) unexpected(input.operation);
    if ("column" in target) columns[target.column] = value;
    else extras[target.extra] = value;
  }
  const delta = followerDelta(input.follows);
  return {
    platform: "instagram",
    accountExternalId: input.accountExternalId,
    date: input.date,
    ...columns,
    ...(delta !== undefined ? { followerDelta: delta } : {}),
    ...(Object.keys(extras).length > 0 ? { extras } : {}),
  };
}
