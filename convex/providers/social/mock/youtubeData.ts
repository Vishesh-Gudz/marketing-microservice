import { addDays, type DateKey } from "../../../lib/dates";
import { fnv1a, seededRandom } from "../../hash";
import type { RawChannel, RawVideo } from "../../youtube/schemas";

/**
 * Deterministic mock YouTube data (ADR 0016, Y-D12), for PROVIDER_MODE=mock (local
 * development, tests and Playwright). Pure: the same user and day always produce the same
 * data; no randomness, no network. Everything is shaped like the YouTube Data API (raw
 * resources), so the mock provider runs the REAL YouTube mapping.
 *
 * Uploads: one video every MOCK_YT_UPLOAD_EVERY_DAYS UTC days (anchored to the epoch, so a
 * video keeps its id and day forever), listed newest first for the last MOCK_YT_LISTING_DAYS
 * days. Every 8th slot is an "upcoming" premiere (excluded). Users:
 *   "<n>"    a channel with a handle and a public subscriber count
 *   "hidden" the subscriber count is hidden (followersCount stays absent)
 *   "empty"  no uploads at all
 *   "edge"   one upload without a publish time (unresolved)
 * ("revoked" is handled by the mock provider: its credential is rejected.)
 */

export const MOCK_YT_UPLOAD_EVERY_DAYS = 2;
export const MOCK_YT_LISTING_DAYS = 180;
const UPCOMING_SLOT = 7;
const SLOTS = 8;
const EDGE_SLOT = 3;
const DAY_MS = 86_400_000;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** `length` characters of the URL-safe alphabet, derived from `seed` only. */
function mockId(seed: string, length: number): string {
  const random = seededRandom(seed);
  let id = "";
  for (let i = 0; i < length; i++) id += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return id;
}

/** Deterministic channel id ("UC" + 22 characters) of a mock user. */
export function mockYouTubeChannelId(user: string): string {
  return `UC${mockId(`mock-yt-channel:${user}`, 22)}`;
}

/** [doc] the uploads playlist id of a mock user. */
export function mockYouTubeUploadsId(user: string): string {
  return `UU${mockId(`mock-yt-channel:${user}`, 22)}`;
}

/** Subscriber count of a mock user (already "rounded" to three significant figures). */
export function mockYouTubeSubscribers(user: string): number {
  return (100 + (fnv1a(`mock-yt-subscribers:${user}`) % 900)) * 100;
}

/** The `channels.list?mine=true` resource of a mock user. */
export function mockYouTubeChannel(user: string): RawChannel {
  return {
    id: mockYouTubeChannelId(user),
    snippet: { title: `Mock ${user} channel`, customUrl: `@mock_${user.replace(/-/g, "_")}` },
    statistics:
      user === "hidden"
        ? { hiddenSubscriberCount: true }
        : {
            subscriberCount: String(mockYouTubeSubscribers(user)),
            hiddenSubscriberCount: false,
          },
    contentDetails: { relatedPlaylists: { uploads: mockYouTubeUploadsId(user) } },
  };
}

/** Whole UTC days since 1970-01-01. */
function dayIndex(day: DateKey): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, m - 1, d) / DAY_MS);
}

/** Every upload of `user` listed on `today` (newest first), as `videos.list` resources. */
export function mockYouTubeVideos(user: string, today: DateKey): RawVideo[] {
  if (user === "empty") return [];
  const channelId = mockYouTubeChannelId(user);
  const newest = dayIndex(today);
  const videos: RawVideo[] = [];
  for (let index = newest; index > newest - MOCK_YT_LISTING_DAYS; index--) {
    if (index % MOCK_YT_UPLOAD_EVERY_DAYS !== 0) continue;
    const slot = (index / MOCK_YT_UPLOAD_EVERY_DAYS) % SLOTS;
    const day = addDays("1970-01-01", index);
    const edge = user === "edge" && slot === EDGE_SLOT;
    videos.push({
      id: mockId(`mock-yt-video:${user}:${index}`, 11),
      snippet: {
        channelId,
        title: slot === 0 ? "" : `Mock video ${day}`,
        liveBroadcastContent: slot === UPCOMING_SLOT ? "upcoming" : "none",
        ...(edge ? {} : { publishedAt: `${day}T00:00:00Z` }),
      },
    });
  }
  return videos;
}
