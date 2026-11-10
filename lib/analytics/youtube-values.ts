import type { ChartRow } from "./chart-data";
import { formatCount, getDisplayLocale } from "./format";
import type { DataState } from "./types";
import type { ValueView } from "./values";
import type {
  YouTubeAnalyticsAccess,
  YouTubeChannelDays,
  YouTubeDataState,
  YouTubeDay,
  YouTubeDayMetric,
  YouTubeDayStatus,
  YouTubeTotalMetric,
  YouTubeTotalReason,
  YouTubeVideoCapture,
  YouTubeVideoMetric,
  YouTubeVideoStatistics,
  YouTubeVideoWindow,
  YouTubeVideoWindowName,
  YouTubeWindowMetric,
} from "./youtube-types";

/**
 * Displayable YouTube values (ADR 0016, Checkpoints 5 and 8). Every number is the API's number,
 * for ONE channel and ONE day, one video capture or one video window, or (Checkpoint 8) the
 * server's range totals of one channel: the dashboard does NO metric arithmetic (no totals,
 * averages, rates, changes or scores; no combination with another channel or platform). The
 * formatters below only turn a value into text (seconds as m:ss, minutes as hours, YouTube's
 * percent number as a percent). A value the API omits shows "—" with the reason, never 0.
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
 * granted. With `scope_missing` only the daily metrics wait; the rest keeps syncing (ADR 0016,
 * open question 13).
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
          "This channel was connected without access to YouTube Analytics, so its daily metrics and video analytics are not synced (they stay unknown, never zero). Its videos and their public counts keep syncing. Reconnect YouTube on the Connections page and allow access to YouTube Analytics to add them.",
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

// ---------------------------------------------------------------------------
// Checkpoint 8: the range totals, the subscriber count, per-video windows, chart rows
// ---------------------------------------------------------------------------

const unavailable = (reason: string): ValueView => ({ kind: "unavailable", text: "—", reason });

/** Minutes as hours with one decimal ("172.8"); a few minutes show "< 0.1", never "0.0". */
export function formatWatchHours(
  minutes: number,
  locale: string | undefined = getDisplayLocale(),
): string {
  const format = new Intl.NumberFormat(locale, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
  const hours = minutes / 60;
  return hours > 0 && hours < 0.05 ? `< ${format.format(0.1)}` : format.format(hours);
}

/** A count with its sign ("+12", "-3", "0"): net subscribers can be negative. */
export function formatSignedCount(
  value: number,
  locale: string | undefined = getDisplayLocale(),
): string {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
    signDisplay: "exceptZero",
  }).format(value);
}

/** YouTube's percent number as a percent (45.3 -> "45.3%"; above 100 on rewatches). */
export function formatViewPercentage(
  percent: number,
  locale: string | undefined = getDisplayLocale(),
): string {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(
    percent / 100,
  );
}

/** The key metrics of the range: the current subscriber count, then the server's totals. */
export type YouTubeKpiKey =
  "subscribers" | Exclude<YouTubeTotalMetric, "subscribersGained" | "subscribersLost">;

export const YOUTUBE_KPIS: readonly YouTubeKpiKey[] = [
  "subscribers",
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "subscribersNet",
  "likes",
  "comments",
  "shares",
];

export const YOUTUBE_KPI_LABEL: Record<YouTubeKpiKey, string> = {
  subscribers: "Subscribers",
  views: "Views",
  estimatedMinutesWatched: "Watch time (hours)",
  averageViewDuration: "Avg. view duration",
  subscribersNet: "Net subscribers",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
};

export const YOUTUBE_TOTAL_REASON_TEXT: Record<YouTubeTotalReason, string> = {
  not_reported: "Not reported by YouTube for any day of this range",
  zero_views: "Not defined: this range has no views",
};

export const YOUTUBE_SUBSCRIBERS_HIDDEN = "Hidden by the channel, or not captured yet";

function formatTotal(metric: YouTubeTotalMetric, value: number, locale: string | undefined) {
  switch (metric) {
    case "estimatedMinutesWatched":
      return formatWatchHours(value, locale);
    case "averageViewDuration":
      return formatDuration(value);
    case "subscribersNet":
      return formatSignedCount(value, locale);
    default:
      return formatCount(value, locale);
  }
}

/**
 * Why the range has no total for `metric`: with no reported day, a missing grant or an
 * unsynced range explains every total; otherwise the API's own reason.
 */
function missingTotalReason(data: YouTubeChannelDays, metric: YouTubeTotalMetric): string {
  if (data.totals.reportedDays === 0) {
    if (data.analyticsAccess === "scope_missing") {
      return "YouTube Analytics access is missing for this channel";
    }
    if (data.dataState === "unknown") return "No Pacific Time day of this range is synced yet";
  }
  const entry = data.totals.unavailableMetrics.find((u) => u.metric === metric);
  return YOUTUBE_TOTAL_REASON_TEXT[entry?.reason ?? "not_reported"];
}

/** One range total of the channel, as the server computed it (or why it is missing). */
export function youtubeTotalValueView(
  metric: YouTubeTotalMetric,
  data: YouTubeChannelDays,
  locale: string | undefined = getDisplayLocale(),
): ValueView {
  const value = data.totals.metrics[metric];
  if (value === undefined) return unavailable(missingTotalReason(data, metric));
  return {
    kind: "value",
    text: formatTotal(metric, value, locale),
    // Totals cover the reported days only: a partly synced range is marked.
    partial: data.dataState === "partial",
  };
}

/** One key metric of the range: the subscriber count (a capture) or a range total. */
export function youtubeKpiValueView(
  key: YouTubeKpiKey,
  data: YouTubeChannelDays,
  locale: string | undefined = getDisplayLocale(),
): ValueView {
  if (key !== "subscribers") return youtubeTotalValueView(key, data, locale);
  if (data.subscribers === undefined) return unavailable(YOUTUBE_SUBSCRIBERS_HIDDEN);
  return { kind: "value", text: formatCount(data.subscribers.count, locale), partial: false };
}

export const YOUTUBE_VIDEO_WINDOWS: readonly YouTubeVideoWindowName[] = ["last28", "lifetime"];

export const YOUTUBE_WINDOW_NAME: Record<YouTubeVideoWindowName, string> = {
  last28: "Last 28 days",
  lifetime: "Lifetime",
};

/** Every per-video analytics value, in the API's order (parity-tested in tests/unit). */
export const YOUTUBE_WINDOW_METRICS: readonly YouTubeWindowMetric[] = [
  "views",
  "estimatedMinutesWatched",
  "averageViewDuration",
  "averageViewPercentage",
  "likes",
  "comments",
  "shares",
  "subscribersGained",
  "subscribersLost",
];

/** The videos table's columns (the video page shows all nine). */
export const YOUTUBE_WINDOW_COLUMNS: readonly YouTubeWindowMetric[] = YOUTUBE_WINDOW_METRICS.filter(
  (metric) => metric !== "subscribersLost",
);

export const YOUTUBE_WINDOW_LABEL: Record<YouTubeWindowMetric, string> = {
  views: "Views",
  estimatedMinutesWatched: "Watch time (hours)",
  averageViewDuration: "Avg. view duration",
  averageViewPercentage: "Avg. % viewed",
  likes: "Likes",
  comments: "Comments",
  shares: "Shares",
  subscribersGained: "Subscribers gained",
  subscribersLost: "Subscribers lost",
};

/** A video's window: reported, outside YouTube's top 200, or not synced (absent). */
export type YouTubeWindowState = "reported" | "not_in_top" | "not_synced";

export function youtubeWindowState(window: YouTubeVideoWindow | undefined): YouTubeWindowState {
  return window === undefined ? "not_synced" : window.status;
}

export const YOUTUBE_WINDOW_STATE_TEXT: Record<Exclude<YouTubeWindowState, "reported">, string> = {
  not_in_top: "Not in YouTube's top 200",
  not_synced: "Not synced yet",
};

export const YOUTUBE_WINDOW_STATE_DESCRIPTION: Record<
  Exclude<YouTubeWindowState, "reported">,
  string
> = {
  not_in_top:
    "YouTube reports per-video values only for the channel's 200 most-viewed videos of a period, and this video is not among them. Its values are unknown, not zero.",
  not_synced:
    "No values for this period yet: it has not been synced, or the video was published after the period ended.",
};

function formatWindowValue(
  metric: YouTubeWindowMetric,
  value: number,
  locale: string | undefined,
): string {
  switch (metric) {
    case "estimatedMinutesWatched":
      return formatWatchHours(value, locale);
    case "averageViewDuration":
      return formatDuration(value);
    case "averageViewPercentage":
      return formatViewPercentage(value, locale);
    default:
      return formatCount(value, locale);
  }
}

/** One value of a video's window, exactly as YouTube reported it (or why it is missing). */
export function youtubeWindowValueView(
  window: YouTubeVideoWindow | undefined,
  metric: YouTubeWindowMetric,
  locale: string | undefined = getDisplayLocale(),
): ValueView {
  if (window === undefined) return unavailable(YOUTUBE_WINDOW_STATE_TEXT.not_synced);
  if (window.status === "not_in_top") return unavailable(YOUTUBE_WINDOW_STATE_TEXT.not_in_top);
  const value = window.metrics[metric];
  if (value === undefined) return unavailable("Not reported by YouTube for this video and period");
  return { kind: "value", text: formatWindowValue(metric, value, locale), partial: false };
}

/** The daily chart's metrics: per-day values exactly as the server returns them. */
export const YOUTUBE_CHART_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "subscribersGained",
  "subscribersLost",
] as const satisfies readonly YouTubeDayMetric[];
export type YouTubeChartMetric = (typeof YOUTUBE_CHART_METRICS)[number];

export const YOUTUBE_CHART_LABEL: Record<YouTubeChartMetric, string> = {
  views: "Views",
  estimatedMinutesWatched: "Watch time (minutes)",
  subscribersGained: "Subscribers gained",
  subscribersLost: "Subscribers lost",
};

// The shared chart's data state per day; the chart labels it with YOUTUBE_DAY_STATUS_LABEL.
const DAY_CHART_STATE: Record<YouTubeDayStatus, DataState> = {
  reported: "reported",
  not_reported: "no_delivery",
  unknown: "unknown",
};

/**
 * One chart row per Pacific Time day (oldest first): the day's value as reported. A day that is
 * not reported or not synced, or lacks the metric, is a gap (null), never 0.
 */
export function youtubeDayRows(
  days: readonly YouTubeDay[],
  metric: YouTubeChartMetric,
  locale: string | undefined = getDisplayLocale(),
): ChartRow[] {
  return days.map((day) => {
    const value = day.status === "reported" ? day.metrics[metric] : undefined;
    return {
      bucket: day.date,
      from: day.date,
      to: day.date,
      dataState: DAY_CHART_STATE[day.status],
      incomplete: false,
      value: value ?? null,
      display: value === undefined ? "—" : formatCount(value, locale),
    };
  });
}

/**
 * A video's public counts at each capture (bucket = UTC capture day): lifetime values, NOT
 * daily performance; nothing is differenced.
 */
export function youtubeCaptureRows(
  captures: readonly YouTubeVideoCapture[],
  metric: YouTubeVideoMetric,
  locale: string | undefined = getDisplayLocale(),
): ChartRow[] {
  return captures.map((capture) => {
    const value = capture.metrics[metric];
    return {
      bucket: capture.capturedDate,
      from: capture.capturedDate,
      to: capture.capturedDate,
      dataState: capture.dataState,
      incomplete: false,
      value: value ?? null,
      display: value === undefined ? "—" : formatCount(value, locale),
    };
  });
}
