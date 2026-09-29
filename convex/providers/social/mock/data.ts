import { diffDays, type DateKey } from "../../../lib/dates";
import { fnv1a } from "../../hash";
import type { MediaInput } from "../../instagram/mapping";

/**
 * Deterministic mock Instagram data (Phase 10 Stage B, F15), for PROVIDER_MODE=mock (local
 * development, tests and Playwright). Pure: the same user and instant always produce the
 * same data; no randomness, no network. Everything is shaped like the fake Instagram API
 * (Instagram vocabulary), so the mock provider runs the REAL Instagram mapping.
 *
 * Media: one post every 3rd UTC day (anchored to the epoch, so a post keeps its id and day
 * forever), listed newest first for the last MOCK_LISTING_DAYS days. The product/media type
 * cycles over 10 slots: IMAGE, VIDEO, REELS, CAROUSEL_ALBUM, IMAGE with explicit zeros,
 * REELS, AD (excluded), IMAGE, STORY (excluded), VIDEO. User "edge" has no
 * media_product_type on slot 7 (R3: unresolved). Posts published today report nothing yet.
 *
 * Account days: every 7th day reports nothing (an empty set); another has explicit zeros.
 * User "small" has fewer than 100 followers: follows_and_unfollows is never reported.
 */

export const MOCK_POST_EVERY_DAYS = 3;
export const MOCK_LISTING_DAYS = 180;
const DAY_MS = 86_400_000;

const MEDIA_SLOTS: readonly { mediaType: string; productType: string }[] = [
  { mediaType: "IMAGE", productType: "FEED" },
  { mediaType: "VIDEO", productType: "FEED" },
  { mediaType: "VIDEO", productType: "REELS" },
  { mediaType: "CAROUSEL_ALBUM", productType: "FEED" },
  { mediaType: "IMAGE", productType: "FEED" }, // explicit zeros, views not reported
  { mediaType: "VIDEO", productType: "REELS" },
  { mediaType: "IMAGE", productType: "AD" },
  { mediaType: "IMAGE", productType: "FEED" }, // "edge": product type missing
  { mediaType: "IMAGE", productType: "STORY" },
  { mediaType: "VIDEO", productType: "FEED" },
];
const ZERO_SLOT = 4;
const EDGE_SLOT = 7;

/** Whole UTC days since 1970-01-01. */
function dayIndex(day: DateKey): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

function dayOf(index: number): DateKey {
  return new Date(index * DAY_MS).toISOString().slice(0, 10);
}

/** [F15] Follower count of a mock user (user "small" stays under 100). */
export function mockFollowers(user: string): number {
  return user === "small" ? 57 : 1_000 + (fnv1a(`mock-followers:${user}`) % 9_000);
}

/** Every media item of `user` listed on `today` (newest first). */
export function mockMedia(user: string, today: DateKey): MediaInput[] {
  const prefix = String(fnv1a(`mock-media:${user}`) % 1_000_000).padStart(6, "0");
  const newest = dayIndex(today);
  const media: MediaInput[] = [];
  for (let index = newest; index > newest - MOCK_LISTING_DAYS; index--) {
    if (index % MOCK_POST_EVERY_DAYS !== 0) continue;
    const slotIndex = (index / MOCK_POST_EVERY_DAYS) % MEDIA_SLOTS.length;
    const slot = MEDIA_SLOTS[slotIndex]!;
    const day = dayOf(index);
    const id = `179${prefix}${String(index).padStart(8, "0")}`;
    const missingType = user === "edge" && slotIndex === EDGE_SLOT;
    media.push({
      id,
      caption: `Mock ${slot.mediaType.toLowerCase()} post of ${day}`,
      mediaType: slot.mediaType,
      ...(missingType ? {} : { mediaProductType: slot.productType }),
      permalink: `https://www.instagram.com/p/mock${id}/`,
      timestamp: `${day}T12:00:00+0000`,
    });
  }
  return media;
}

function publishedDay(media: MediaInput): DateKey {
  return media.timestamp!.slice(0, 10);
}

/**
 * Lifetime insights of a media item as of `day` (Instagram names). Values only grow with
 * age; a post published on `day` reports nothing yet (empty set).
 */
export function mockPostInsights(
  media: MediaInput,
  day: DateKey,
): { sdk: { name: string; value: number }[]; reader: Record<string, number> } {
  const age = Math.min(diffDays(publishedDay(media), day), 30);
  if (age <= 0) return { sdk: [], reader: {} };
  const slot = (dayIndex(publishedDay(media)) / MOCK_POST_EVERY_DAYS) % MEDIA_SLOTS.length;
  const likes = ((fnv1a(`mock-likes:${media.id}`) % 50) + 10) * age;
  if (slot === ZERO_SLOT) {
    return {
      sdk: [
        { name: "likes", value: likes },
        { name: "comments", value: 0 },
        { name: "saved", value: 0 },
        { name: "shares", value: 0 },
        { name: "reach", value: likes * 6 },
      ],
      reader: { total_interactions: likes }, // views not reported
    };
  }
  const comments = Math.floor(likes / 10);
  const saved = Math.floor(likes / 20);
  const shares = Math.floor(likes / 25);
  const reach = likes * 8;
  return {
    sdk: [
      { name: "likes", value: likes },
      { name: "comments", value: comments },
      { name: "saved", value: saved },
      { name: "shares", value: shares },
      { name: "reach", value: reach },
    ],
    reader: { views: reach * 2, total_interactions: likes + comments + saved + shares },
  };
}

/** Day totals of the account on a UTC day (Instagram names; {} = nothing reported). */
export function mockAccountInsights(user: string, day: DateKey): Record<string, number> {
  const index = dayIndex(day);
  if (index % 7 === 3) return {};
  const h = fnv1a(`mock-day:${user}:${day}`);
  const reach = 200 + (h % 300);
  if (index % 7 === 5) {
    return {
      reach,
      views: reach * 3,
      accounts_engaged: 0,
      total_interactions: 0,
      likes: 0,
      replies: 0,
    };
  }
  return {
    reach,
    views: reach * 3,
    accounts_engaged: Math.floor(reach / 10),
    total_interactions: Math.floor(reach / 5),
    likes: Math.floor(reach / 7),
    comments: h % 11,
    shares: h % 5,
    saves: h % 7,
    replies: h % 3,
    profile_links_taps: h % 4,
  };
}

/** follows_and_unfollows by follow_type ([doc] never reported under 100 followers). */
export function mockFollowBreakdown(
  user: string,
  day: DateKey,
): Record<string, number> | undefined {
  if (mockFollowers(user) < 100 || dayIndex(day) % 7 === 3) return undefined;
  const h = fnv1a(`mock-follows:${user}:${day}`);
  return { FOLLOWER: h % 9, NON_FOLLOWER: h % 4 };
}
