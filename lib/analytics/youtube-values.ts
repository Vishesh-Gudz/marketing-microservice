import { formatCount, getDisplayLocale } from "./format";
import type { ValueView } from "./values";
import type {
  YouTubeAnalyticsAccess,
  YouTubeDataState,
  YouTubeDay,
  YouTubeDayMetric,
  YouTubeDayStatus,
  YouTubeVideoMetric,
  YouTubeVideoStatistics,
} from "./youtube-types";

/**
 * Displayable YouTube values (ADR 0016, Checkpoint 5). Every number is the API's number, for
 * ONE channel and ONE day (or one video capture): the dashboard does NO metric arithmetic (no
 * totals, averages, rates, changes or scores; no combination with another channel or
 * platform). A value the API omits shows "—" with the reason, never 0.
 */

/** YouTube Analytics days are Pacific Time days (mirrors the API; parity-tested in tests/unit). */
export const YOUTUBE_DAY_TIMEZONE = "America/Los_Angeles";

/** The day columns, in the API's order (YouTube's own metric names). */
export const YOUTUBE_DAY_COLUMNS: readonly YouTubeDayMetric[] = [
  "views",
  "likes",
  "comments",
  "shares",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "subscribersGained",
  "subscribersLost",
];

export const YOUTUBE_DAY_LABEL: Record<YouTubeDayMetric, string> = {
  views: "Views",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  estimatedMinutesWatched: "Est. minutes watched",
  averageViewDuration: "Avg. view duration",
  subscribersGained: "Subscribers gained",
  subscribersLost: "Subscribers lost",
};

export const YOUTUBE_VIDEO_COLUMNS: readonly YouTubeVideoMetric[] = ["views", "likes", "comments"];

export const YOUTUBE_VIDEO_LABEL: Record<YouTubeVideoMetric, string> = {
  views: "Views",
  likes: "Likes",
  comments: "Comments",
};

export const YOUTUBE_DAY_STATUS_LABEL: Record<YouTubeDayStatus, string> = {
  reported: "Reported",
  not_reported: "Not reported",
  unknown: "Unknown",
};

export const YOUTUBE_DAY_STATUS_DESCRIPTION: Record<YouTubeDayStatus, string> = {
  reported: "Synced; the values below are what YouTube reported for this day.",
  not_reported: "Synced, but YouTube reported no data for this day.",
  unknown: "Not synced yet. YouTube reports days about 3 days late.",
};

export const YOUTUBE_DATA_STATE_DESCRIPTION: Record<YouTubeDataState, string> = {
  reported: "Every Pacific Time day of the range is synced.",
  partial: "Some Pacific Time days of the range are not synced yet.",
  unknown: "No channel day of this range is synced yet.",
  unsupported: "Not supported for this channel.",
};

export const YOUTUBE_VIDEO_STATE_DESCRIPTION: Record<YouTubeDataState, string> = {
  reported: "Lifetime statistics of the latest capture.",
  partial: "The latest capture lacks a statistic the owner hides or disabled.",
  unknown: "Not captured yet (videos from the last 90 days are captured daily).",
  unsupported: "Not supported for this channel.",
};

/** Seconds as m:ss or h:mm:ss (display only; YouTube's own per-day value). */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** One metric of one day, exactly as reported (or why it is missing). */
export function youtubeDayValueView(
  day: YouTubeDay,
  metric: YouTubeDayMetric,
  locale: string | undefined = getDisplayLocale(),
): ValueView {
  if (day.status !== "reported") {
    return { kind: "unavailable", text: "—", reason: YOUTUBE_DAY_STATUS_DESCRIPTION[day.status] };
  }
  const value = day.metrics[metric];
  if (value === undefined) {
    return { kind: "unavailable", text: "—", reason: "Not reported by YouTube for this day" };
  }
  return {
    kind: "value",
    text: metric === "averageViewDuration" ? formatDuration(value) : formatCount(value, locale),
    partial: false,
  };
}

/** One lifetime statistic of a video's latest capture (or why it is missing). */
export function youtubeVideoValueView(
  statistics: YouTubeVideoStatistics | undefined,
  metric: YouTubeVideoMetric,
  locale: string | undefined = getDisplayLocale(),
): ValueView {
  if (statistics === undefined) {
    return { kind: "unavailable", text: "—", reason: YOUTUBE_VIDEO_STATE_DESCRIPTION.unknown };
  }
  const value = statistics.metrics[metric];
  if (value === undefined) {
    return {
      kind: "unavailable",
      text: "—",
      reason: "Not reported by YouTube (hidden or disabled by the channel owner)",
    };
  }
  return { kind: "value", text: formatCount(value, locale), partial: false };
}

export type AccessNotice = { tone: "info" | "warning"; title: string; message: string };

/**
 * The channel's analytics grant (v1/youtubeAnalytics:channelDays `analyticsAccess`); `null` when
 * granted. `scope_missing` also names the known sync limitation (ADR 0016 open question 13).
 */
export function youtubeAccessNotice(access: YouTubeAnalyticsAccess): AccessNotice | null {
  switch (access) {
    case "granted":
      return null;
    case "scope_missing":
      return {
        tone: "warning",
        title: "YouTube Analytics access is missing",
        message:
          "This channel was connected without access to YouTube Analytics, so its daily metrics cannot sync. Reconnect YouTube on the Connections page and allow access to YouTube Analytics. Known limitation: until then, the channel's video statistics may stop updating as well.",
      };
    case "reauth_required":
      return {
        tone: "warning",
        title: "Reconnect required",
        message:
          "Google access for this channel expired or was revoked, so it is not syncing. Reconnect YouTube on the Connections page.",
      };
    case "not_linked":
      return {
        tone: "info",
        title: "Not linked",
        message: "This channel is not linked to a YouTube connection; nothing new is synced.",
      };
    case "unknown":
      return {
        tone: "info",
        title: "Access unknown",
        message: "YouTube is not configured on this service, so the channel's access is unknown.",
      };
  }
}
