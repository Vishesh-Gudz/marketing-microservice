import type { FunctionArgs, FunctionReturnType } from "convex/server";
import type { api } from "@/convex/_generated/api";

// YouTube dashboard types (ADR 0016, Checkpoint 5), derived from the PUBLIC v1 API only (the
// generated `api` references), never from internal modules. Type-only imports (D23).

type YouTube = typeof api.v1.youtubeAnalytics;

export type YouTubeChannelDaysArgs = FunctionArgs<YouTube["channelDays"]>;
export type YouTubeChannelDays = FunctionReturnType<YouTube["channelDays"]>;
export type YouTubeDay = YouTubeChannelDays["days"][number];
export type YouTubeDayStatus = YouTubeDay["status"];
export type YouTubeDayMetric = keyof YouTubeDay["metrics"];
export type YouTubeAnalyticsAccess = YouTubeChannelDays["analyticsAccess"];
export type YouTubeDataState = YouTubeChannelDays["dataState"];

export type YouTubeVideosArgs = FunctionArgs<YouTube["videos"]>;
export type YouTubeVideosPage = FunctionReturnType<YouTube["videos"]>;
export type YouTubeVideo = YouTubeVideosPage["page"][number];
export type YouTubeVideoStatistics = NonNullable<YouTubeVideo["latest"]>;
export type YouTubeVideoMetric = keyof YouTubeVideoStatistics["metrics"];

// ADR 0016 Checkpoint 8: range totals, the subscriber count, per-video windows and captures.
export type YouTubeTotals = YouTubeChannelDays["totals"];
export type YouTubeTotalMetric = keyof YouTubeTotals["metrics"];
export type YouTubeTotalReason = YouTubeTotals["unavailableMetrics"][number]["reason"];
export type YouTubeVideoAnalytics = YouTubeVideo["analytics"];
export type YouTubeVideoWindowName = keyof YouTubeVideoAnalytics;
export type YouTubeVideoWindow = NonNullable<YouTubeVideoAnalytics["last28"]>;
export type YouTubeWindowMetric = keyof YouTubeVideoWindow["metrics"];

export type YouTubeVideoDetailArgs = FunctionArgs<YouTube["video"]>;
export type YouTubeVideoDetail = FunctionReturnType<YouTube["video"]>;
export type YouTubeVideoCapture = YouTubeVideoDetail["captures"][number];
