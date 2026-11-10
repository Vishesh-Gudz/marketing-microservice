import type { PaginationOptions } from "convex/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { compareDateKeys, eachDay, toDateKey, type DateKey } from "../../lib/dates";
import { getOwned } from "../../lib/tenancy";
import { createDefaultRegistry } from "../../providers";
import type { DateRange } from "../periods";
import type { TenantCtx } from "../scope";
import { SocialReadBudget } from "./budget";
import {
  YOUTUBE_DAY_METRICS,
  YOUTUBE_DAY_TIMEZONE,
  YOUTUBE_TOTAL_METRICS,
  YOUTUBE_VIDEO_ANALYTICS_METRICS,
  YOUTUBE_VIDEO_METRICS,
  type OrganicDataState,
  type YouTubeDayMetric,
  type YouTubeTotalMetric,
  type YouTubeTotalReason,
  type YouTubeVideoAnalyticsMetric,
  type YouTubeVideoMetric,
} from "./metrics";
import {
  dayRows,
  getSocialPost,
  invalid,
  listSocialPosts,
  socialCapabilitiesOf,
  syncStateOf,
  validRange,
} from "./queries";

/**
 * YouTube analytics reads (ADR 0016, Checkpoints 4 and 8) behind convex/v1/youtubeAnalytics.ts:
 * ONE channel per request, values exactly as YouTube reported them. Checkpoint 8 (approved)
 * adds exactly one kind of derived value: the range totals of ONE channel's reported days
 * (youtubeRangeTotals). Nothing is compared, ranked or combined across channels or platforms
 * (YouTube API Services Developer Policies III.E.2 / III.E.4.h), and per-video ratios
 * (averageViewDuration, averageViewPercentage) are never aggregated. Same tenancy and bounds as
 * ./queries.ts: the org is ctx.tenant.orgId, ids are loaded with getOwned (another tenant's id
 * is NOT_FOUND), every read is orgId-first and budgeted. A non-YouTube id is INVALID_ARGUMENT
 * `not_youtube`.
 *
 * Two calendars, never mixed:
 * - channel days and per-video windows are YouTube Analytics days: PACIFIC TIME day keys,
 *   stored as YouTube reported them (the follower captures stored on the same rows are UTC
 *   capture days and are NOT part of the day series);
 * - video statistics are lifetime values of one capture, on OUR capture day (UTC).
 */

export type YouTubeDayStatus = "reported" | "not_reported" | "unknown";

export type YouTubeDay = {
  date: DateKey;
  /**
   * reported: synced with at least one value; not_reported: synced, YouTube reported nothing
   * for the day; unknown: not synced (yet; the newest days lag by the reporting delay).
   */
  status: YouTubeDayStatus;
  values: Partial<Record<YouTubeDayMetric, number>>;
  /** Metrics a reported day lacks (never 0, never estimated). */
  unavailableMetrics: { metric: YouTubeDayMetric; reason: "not_reported" }[];
};

let registry: ReturnType<typeof createDefaultRegistry> | undefined;

/** The channel's analytics grant, from its connection (status and granted scopes only). */
export type YouTubeAnalyticsAccess =
  "granted" | "scope_missing" | "reauth_required" | "not_linked" | "unknown";

/** A YouTube channel of the caller's org (NOT_FOUND otherwise; not_youtube for another platform). */
async function ownedChannel(
  ctx: TenantCtx,
  id: string,
  field: string,
): Promise<Doc<"socialAccounts">> {
  const account = await getOwned(ctx, "socialAccounts", id);
  if (account.platform !== "youtube") invalid(field, "not_youtube");
  return account;
}

function dayOf(date: DateKey, row: Doc<"socialAccountMetricsDaily"> | undefined): YouTubeDay {
  if (row?.insightsSyncedAt === undefined) {
    return { date, status: "unknown", values: {}, unavailableMetrics: [] };
  }
  const values: Partial<Record<YouTubeDayMetric, number>> = {};
  const missing: YouTubeDayMetric[] = [];
  for (const metric of YOUTUBE_DAY_METRICS) {
    const value = metric === "views" ? row.views : row.extras?.[metric];
    if (value === undefined) missing.push(metric);
    else values[metric] = value;
  }
  if (missing.length === YOUTUBE_DAY_METRICS.length) {
    return { date, status: "not_reported", values: {}, unavailableMetrics: [] };
  }
  return {
    date,
    status: "reported",
    values,
    unavailableMetrics: missing.map((metric) => ({ metric, reason: "not_reported" as const })),
  };
}

/**
 * The analytics grant of a linked channel: the connection must be active and hold every
 * scope the YouTube OAuth spec requires (yt-analytics.readonly can be unticked at consent).
 * Reads the connection's status and granted scopes only, never a credential.
 */
async function analyticsAccessOf(
  ctx: TenantCtx,
  account: Doc<"socialAccounts">,
  budget: SocialReadBudget,
): Promise<YouTubeAnalyticsAccess> {
  if (account.connectionId === undefined) return "not_linked";
  budget.charge(1);
  const connection = await ctx.db.get(account.connectionId);
  if (connection === null || connection.orgId !== ctx.tenant.orgId) return "not_linked";
  if (connection.status === "revoked") return "not_linked";
  if (connection.status === "needs_reauth") return "reauth_required";
  registry ??= createDefaultRegistry();
  if (!registry.hasOAuth("youtube")) return "unknown";
  const granted = new Set(connection.grantedScopes);
  return registry.oauth("youtube").requiredScopes.every((scope) => granted.has(scope))
    ? "granted"
    : "scope_missing";
}

/**
 * One channel's days over the inclusive Pacific Time range: one entry per day, each with the
 * values YouTube reported for it. dataState: reported (every day synced), partial (some),
 * unknown (none).
 */
export async function youtubeChannelDays(
  ctx: TenantCtx,
  args: { socialAccountId: string; range: DateRange },
) {
  const range = validRange(args.range, "range");
  const budget = new SocialReadBudget();
  const account = await ownedChannel(ctx, args.socialAccountId, "socialAccountId");
  budget.charge(2); // the channel and its sync state
  const sync = await syncStateOf(ctx, account._id);
  const rows = await dayRows(ctx, budget, account._id, range);
  const byDate = new Map(rows.map((row) => [row.date, row]));
  const days = eachDay(range.from, range.to).map((date) => dayOf(date, byDate.get(date)));
  const syncedDays = days.filter((day) => day.status !== "unknown").length;
  const dataState: OrganicDataState =
    syncedDays === 0 ? "unknown" : syncedDays === days.length ? "reported" : "partial";
  const subscribers = await latestSubscribers(ctx, budget, account._id);
  return {
    account,
    range,
    dataState,
    reportingDelayDays: socialCapabilitiesOf("youtube")?.accountMetricsDelayDays ?? 0,
    totals: youtubeRangeTotals(days),
    ...(subscribers !== undefined ? { subscribers } : {}),
    analyticsAccess: await analyticsAccessOf(ctx, account, budget),
    coverage: {
      syncedDays,
      unsyncedDays: days.length - syncedDays,
      ...(sync?.coveredFrom !== undefined && sync.coveredThrough !== undefined
        ? { covered: { from: sync.coveredFrom, through: sync.coveredThrough } }
        : {}),
      ...(sync?.lastSuccessAt !== undefined ? { lastSyncedAt: sync.lastSuccessAt } : {}),
    },
    days,
  };
}

// ---------------------------------------------------------------------------
// Range totals and the subscriber count (Checkpoint 8)
// ---------------------------------------------------------------------------

export type YouTubeRangeTotals = {
  /** Days of the range with status "reported" (the only days the totals cover). */
  reportedDays: number;
  values: Partial<Record<YouTubeTotalMetric, number>>;
  /** Totals that do not exist for the range, with why (never 0). */
  unavailableMetrics: { metric: YouTubeTotalMetric; reason: YouTubeTotalReason }[];
};

const SUMMED_DAY_METRICS = [
  "views",
  "estimatedMinutesWatched",
  "likes",
  "comments",
  "shares",
  "subscribersGained",
  "subscribersLost",
] as const satisfies readonly (YouTubeDayMetric & YouTubeTotalMetric)[];

/**
 * ONE channel's totals over the reported days of a range (ADR 0016 Checkpoint 8, approved):
 * each count summed over the days that report it; subscribersNet over the days that report
 * both subscriber counts; averageViewDuration = estimatedMinutesWatched x 60 / views over the
 * days that report both, in whole seconds (absent as zero_views when those views are 0). A
 * total no reported day carries is absent as not_reported. YouTube's own per-day
 * averageViewDuration values are never averaged.
 */
export function youtubeRangeTotals(days: readonly YouTubeDay[]): YouTubeRangeTotals {
  const reported = days.filter((day) => day.status === "reported");
  const values: Partial<Record<YouTubeTotalMetric, number>> = {};
  const reasons = new Map<YouTubeTotalMetric, YouTubeTotalReason>();
  for (const metric of SUMMED_DAY_METRICS) {
    const reporting = reported.filter((day) => day.values[metric] !== undefined);
    if (reporting.length === 0) reasons.set(metric, "not_reported");
    else values[metric] = reporting.reduce((sum, day) => sum + day.values[metric]!, 0);
  }
  const both = (a: YouTubeDayMetric, b: YouTubeDayMetric) =>
    reported.filter((day) => day.values[a] !== undefined && day.values[b] !== undefined);
  const subscriberDays = both("subscribersGained", "subscribersLost");
  if (subscriberDays.length === 0) reasons.set("subscribersNet", "not_reported");
  else {
    values.subscribersNet = subscriberDays.reduce(
      (sum, day) => sum + day.values.subscribersGained! - day.values.subscribersLost!,
      0,
    );
  }
  const watchDays = both("views", "estimatedMinutesWatched");
  if (watchDays.length === 0) reasons.set("averageViewDuration", "not_reported");
  else {
    const views = watchDays.reduce((sum, day) => sum + day.values.views!, 0);
    const minutes = watchDays.reduce((sum, day) => sum + day.values.estimatedMinutesWatched!, 0);
    if (views === 0) reasons.set("averageViewDuration", "zero_views");
    else values.averageViewDuration = Math.round((minutes * 60) / views);
  }
  return {
    reportedDays: reported.length,
    values,
    unavailableMetrics: YOUTUBE_TOTAL_METRICS.flatMap((metric) => {
      const reason = reasons.get(metric);
      return reason === undefined ? [] : [{ metric, reason }];
    }),
  };
}

/** Newest day rows read to find the latest subscriber capture (captures are the newest rows). */
const SUBSCRIBER_SCAN_ROWS = 7;

/**
 * The channel's current subscriber count: the latest capture of the sync preflight (the profile
 * column group, YouTube's rounded `subscriberCount`), absent when the channel hides it or no
 * capture exists. The capture rows are UTC capture days, newer than any reported Pacific Time
 * day (the reporting delay), so the newest rows hold it.
 */
async function latestSubscribers(
  ctx: TenantCtx,
  budget: SocialReadBudget,
  socialAccountId: Id<"socialAccounts">,
): Promise<{ count: number; capturedAt: number } | undefined> {
  const rows = await ctx.db
    .query("socialAccountMetricsDaily")
    .withIndex("by_org_account_date", (q) =>
      q.eq("orgId", ctx.tenant.orgId).eq("socialAccountId", socialAccountId),
    )
    .order("desc")
    .take(SUBSCRIBER_SCAN_ROWS);
  budget.charge(rows.length);
  const capture = rows.find((row) => row.followersCapturedAt !== undefined);
  if (capture?.followers === undefined || capture.followersCapturedAt === undefined) {
    return undefined;
  }
  return { count: capture.followers, capturedAt: capture.followersCapturedAt };
}

// ---------------------------------------------------------------------------
// Per-video analytics windows (Checkpoint 8)
// ---------------------------------------------------------------------------

export type YouTubeVideoWindowView = {
  /**
   * reported: YouTube's per-video report listed the video (values below);
   * not_in_top: the window was synced for the channel but the video is not among its top 200
   * by views (no values; never 0).
   */
  status: "reported" | "not_in_top";
  from: DateKey;
  to: DateKey;
  syncedAt: number;
  values: Partial<Record<YouTubeVideoAnalyticsMetric, number>>;
};

export type YouTubeVideoAnalyticsView = {
  last28?: YouTubeVideoWindowView;
  lifetime?: YouTubeVideoWindowView;
};

type SyncedWindows = NonNullable<Doc<"syncAccounts">["videoAnalyticsWindows"]>;
const VIDEO_WINDOWS = ["last28", "lifetime"] as const;

function windowValues(row: Doc<"youtubeVideoAnalytics">) {
  const values: Partial<Record<YouTubeVideoAnalyticsMetric, number>> = {};
  for (const metric of YOUTUBE_VIDEO_ANALYTICS_METRICS) {
    const value = row[metric];
    if (value !== undefined) values[metric] = value;
  }
  return values;
}

/**
 * One video's windows. A window is:
 *   reported    the video has a row (the values YouTube reported, the row's days and sync time)
 *   not_in_top  no row, the window was synced for the channel (syncAccounts
 *               .videoAnalyticsWindows) and the video was published (Pacific Time) on or
 *               before the window's last day
 *   absent      never synced for the channel, or the video is newer than the window
 */
async function videoAnalyticsOf(
  ctx: TenantCtx,
  budget: SocialReadBudget,
  post: Doc<"socialPosts">,
  synced: SyncedWindows | undefined,
): Promise<YouTubeVideoAnalyticsView> {
  // At most one row per window; a defensive extra read never returns a second one.
  const rows = await ctx.db
    .query("youtubeVideoAnalytics")
    .withIndex("by_org_post_window", (q) => q.eq("orgId", ctx.tenant.orgId).eq("postId", post._id))
    .take(VIDEO_WINDOWS.length * 2);
  budget.charge(rows.length);
  const publishedDay = toDateKey(post.publishedAt, YOUTUBE_DAY_TIMEZONE);
  const view: YouTubeVideoAnalyticsView = {};
  for (const window of VIDEO_WINDOWS) {
    const row = rows.find((candidate) => candidate.window === window);
    if (row !== undefined) {
      view[window] = {
        status: "reported",
        from: row.from,
        to: row.to,
        syncedAt: row.syncedAt,
        values: windowValues(row),
      };
      continue;
    }
    const mark = synced?.[window];
    if (mark !== undefined && compareDateKeys(publishedDay, mark.to) <= 0) {
      view[window] = {
        status: "not_in_top",
        from: mark.from,
        to: mark.to,
        syncedAt: mark.syncedAt,
        values: {},
      };
    }
  }
  return view;
}

/**
 * One channel's videos by publish instant (./queries.ts listSocialPosts, YouTube only), each
 * with its per-video analytics windows (Checkpoint 8).
 */
export async function listYouTubeVideos(
  ctx: TenantCtx,
  args: {
    socialAccountId: string;
    publishedFrom?: string;
    publishedTo?: string;
    dir?: "asc" | "desc";
    paginationOpts: PaginationOptions;
  },
) {
  const account = await ownedChannel(ctx, args.socialAccountId, "socialAccountId");
  const result = await listSocialPosts(ctx, args);
  const budget = new SocialReadBudget();
  budget.charge(1 + result.page.length * 2); // the sync state; each post and its capture
  const synced = (await syncStateOf(ctx, account._id))?.videoAnalyticsWindows;
  const page = [];
  for (const view of result.page) {
    page.push({ ...view, analytics: await videoAnalyticsOf(ctx, budget, view.post, synced) });
  }
  return { ...result, page };
}

/**
 * One video with its lifetime captures (./queries.ts getSocialPost, YouTube only) and its
 * per-video analytics windows (Checkpoint 8).
 */
export async function getYouTubeVideo(
  ctx: TenantCtx,
  args: { videoId: string; range?: DateRange },
) {
  const post = await getOwned(ctx, "socialPosts", args.videoId);
  if (post.platform !== "youtube") invalid("videoId", "not_youtube");
  const detail = await getSocialPost(ctx, {
    postId: args.videoId,
    ...(args.range !== undefined ? { range: args.range } : {}),
  });
  const budget = new SocialReadBudget();
  budget.charge(2); // the video and its sync state
  const synced = (await syncStateOf(ctx, post.socialAccountId))?.videoAnalyticsWindows;
  return { ...detail, analytics: await videoAnalyticsOf(ctx, budget, post, synced) };
}

export type YouTubeVideoStatistics = {
  dataState: OrganicDataState;
  values: Partial<Record<YouTubeVideoMetric, number>>;
  /** Counts YouTube did not return (hidden or disabled by the owner): never 0. */
  unavailableMetrics: { metric: YouTubeVideoMetric; reason: "not_reported" }[];
};

/** The YouTube statistics of one lifetime capture; no rate or other derived value. */
export function youtubeVideoStatistics(
  snapshot: Doc<"socialPostMetricSnapshots">,
): YouTubeVideoStatistics {
  const values: Partial<Record<YouTubeVideoMetric, number>> = {};
  const unavailableMetrics: YouTubeVideoStatistics["unavailableMetrics"] = [];
  for (const metric of YOUTUBE_VIDEO_METRICS) {
    const value = snapshot[metric];
    if (value === undefined) unavailableMetrics.push({ metric, reason: "not_reported" });
    else values[metric] = value;
  }
  return {
    dataState: unavailableMetrics.length === 0 ? "reported" : "partial",
    values,
    unavailableMetrics,
  };
}
