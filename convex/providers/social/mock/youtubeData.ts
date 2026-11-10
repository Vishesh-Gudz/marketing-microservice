import { addDays, diffDays, eachDay, toDateKey, type DateKey } from "../../../lib/dates";
import { fnv1a, seededRandom } from "../../hash";
import type { RawChannel, RawReport, RawVideo } from "../../youtube/schemas";
import {
  ACCOUNT_REPORT_METRICS,
  REPORT_DAY_BASIS,
  VIDEO_REPORT_MAX_RESULTS,
  VIDEO_REPORT_METRICS,
} from "../../youtube/semantics";

/**
 * Deterministic mock YouTube data (ADR 0016, Y-D12), for PROVIDER_MODE=mock (local
 * development, tests and Playwright). Pure: the same user and day always produce the same
 * data; no randomness, no network. Everything is shaped like the YouTube APIs (raw resources
 * and report tables), so the mock provider runs the REAL YouTube mapping.
 *
 * Uploads: one video every MOCK_YT_UPLOAD_EVERY_DAYS UTC days (anchored to the epoch, so a
 * video keeps its id and day forever), listed newest first for the last MOCK_YT_LISTING_DAYS
 * days. Every 8th slot is an "upcoming" premiere (excluded). Lifetime statistics grow with the
 * video's age; slot 5 hides its like count and slot 6 has comments disabled (both counts stay
 * absent); a video published today has an explicit 0 views.
 *
 * Channel days (`reports.query`): every 9th day has no row (nothing reported) and every 11th
 * day reports explicit zeros.
 *
 * Users:
 *   "<n>"    a channel with a handle and a public subscriber count
 *   "hidden" the subscriber count is hidden (followersCount stays absent)
 *   "empty"  no uploads at all
 *   "edge"   one upload without a publish time (unresolved)
 * ("revoked" and "limited" are handled by the mock provider from the mock credential.)
 */

export const MOCK_YT_UPLOAD_EVERY_DAYS = 2;
export const MOCK_YT_LISTING_DAYS = 180;
const UPCOMING_SLOT = 7;
const HIDDEN_LIKES_SLOT = 5;
const NO_COMMENTS_SLOT = 6;
const SLOTS = 8;
const EDGE_SLOT = 3;
const NO_ROW_EVERY = 9;
const ZERO_ROW_EVERY = 11;
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

/** A deterministic count in [0, max) for one key. */
function count(key: string, max: number): number {
  return fnv1a(key) % max;
}

/** Lifetime statistics of a mock upload published `ageDays` before `today` ([doc] strings). */
function mockStatistics(seed: string, slot: number, ageDays: number): RawVideo["statistics"] {
  const views = ageDays * (10 + count(`${seed}:views`, 90));
  return {
    viewCount: String(views),
    ...(slot === HIDDEN_LIKES_SLOT ? {} : { likeCount: String(Math.floor(views / 20)) }),
    ...(slot === NO_COMMENTS_SLOT ? {} : { commentCount: String(Math.floor(views / 200)) }),
  };
}

/**
 * Every upload of `user` listed on `today` (newest first), as `videos.list` resources (snippet
 * and statistics; the provider asks for statistics only when it snapshots).
 */
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
    const seed = `mock-yt-video:${user}:${index}`;
    videos.push({
      id: mockId(seed, 11),
      snippet: {
        channelId,
        title: slot === 0 ? "" : `Mock video ${day}`,
        liveBroadcastContent: slot === UPCOMING_SLOT ? "upcoming" : "none",
        ...(edge ? {} : { publishedAt: `${day}T00:00:00Z` }),
      },
      ...(slot === UPCOMING_SLOT
        ? {}
        : { statistics: mockStatistics(seed, slot, diffDays(day, today)) }),
    });
  }
  return videos;
}

/**
 * The `reports.query` table of `user` for [from, to] (`dimensions=day`, the provider's exact
 * metric list). Days with no row are omitted, as YouTube omits them.
 */
export function mockYouTubeReport(user: string, from: DateKey, to: DateKey): RawReport {
  const metrics = ACCOUNT_REPORT_METRICS.split(",");
  const columnHeaders = [
    { name: "day", columnType: "DIMENSION", dataType: "STRING" },
    ...metrics.map((name) => ({ name, columnType: "METRIC", dataType: "INTEGER" })),
  ];
  const rows: (string | number)[][] = [];
  for (const day of eachDay(from, to)) {
    const index = dayIndex(day);
    if (index % NO_ROW_EVERY === 0) continue;
    const zero = index % ZERO_ROW_EVERY === 0;
    const views = zero ? 0 : 100 + count(`mock-yt-day:${user}:${day}:views`, 1_000);
    const value = (metric: string, max: number) =>
      zero ? 0 : count(`mock-yt-day:${user}:${day}:${metric}`, max);
    const values: Record<string, number> = {
      views,
      likes: value("likes", 60),
      comments: value("comments", 15),
      shares: value("shares", 10),
      estimatedMinutesWatched: value("estimatedMinutesWatched", 3_000),
      averageViewDuration: value("averageViewDuration", 300),
      subscribersGained: value("subscribersGained", 25),
      subscribersLost: value("subscribersLost", 6),
    };
    rows.push([day, ...metrics.map((metric) => values[metric]!)]);
  }
  return rows.length > 0 ? { columnHeaders, rows } : { columnHeaders };
}

/**
 * Checkpoint 8: the per-video `reports.query` table of `user` for [from, to] (Pacific Time days;
 * `dimensions=video`, the provider's exact metric list, `sort=-views`, at most 200 rows). Every
 * upload published (Pacific Time) on or before `to` has a row; its values grow with the number
 * of its days inside the window. `averageViewPercentage` is a decimal (two places); about one
 * video in eight is rewatched above 100 %. `listedOn` is the UTC day the uploads are listed for
 * (the mock listing's today).
 */
export function mockYouTubeVideoReport(
  user: string,
  from: DateKey,
  to: DateKey,
  listedOn: DateKey,
): RawReport {
  const metrics = VIDEO_REPORT_METRICS.split(",");
  const columnHeaders = [
    { name: "video", columnType: "DIMENSION", dataType: "STRING" },
    ...metrics.map((name) => ({
      name,
      columnType: "METRIC",
      dataType: name === "averageViewPercentage" ? "FLOAT" : "INTEGER",
    })),
  ];
  const rows: { id: string; views: number; cells: (string | number)[] }[] = [];
  for (const video of mockYouTubeVideos(user, listedOn)) {
    const published = video.snippet?.publishedAt;
    if (published === undefined || video.snippet?.liveBroadcastContent === "upcoming") continue;
    const publishedDay = toDateKey(Date.parse(published), REPORT_DAY_BASIS);
    if (publishedDay > to) continue;
    const firstDay = publishedDay > from ? publishedDay : from;
    const days = diffDays(firstDay, to) + 1;
    const seed = `mock-yt-report:${user}:${video.id}`;
    const views = days * (5 + count(`${seed}:views`, 40));
    // Whole hundredths (2_000 + n) / 100: exactly two decimal places, like YouTube's value.
    const percentBase = (2_000 + count(`${seed}:percent`, 6_000)) / 100;
    const values: Record<string, number> = {
      views,
      estimatedMinutesWatched: Math.floor((views * (2 + count(`${seed}:minutes`, 6))) / 3),
      averageViewDuration: 30 + count(`${seed}:duration`, 240),
      averageViewPercentage:
        count(`${seed}:loop`, 8) === 0
          ? (Math.round(percentBase * 100) + 8_000) / 100
          : percentBase,
      likes: Math.floor(views / 25),
      comments: Math.floor(views / 150),
      shares: Math.floor(views / 300),
      subscribersGained: Math.floor(views / 400),
      subscribersLost: Math.floor(views / 2_000),
    };
    rows.push({ id: video.id, views, cells: [video.id, ...metrics.map((m) => values[m]!)] });
  }
  const top = rows
    .sort((a, b) => b.views - a.views || (a.id < b.id ? -1 : 1))
    .slice(0, VIDEO_REPORT_MAX_RESULTS)
    .map((row) => row.cells);
  return top.length > 0 ? { columnHeaders, rows: top } : { columnHeaders };
}
