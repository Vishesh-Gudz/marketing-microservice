import type { PaginationOptions } from "convex/server";
import type { Doc } from "../../_generated/dataModel";
import { eachDay, type DateKey } from "../../lib/dates";
import { getOwned } from "../../lib/tenancy";
import { createDefaultRegistry } from "../../providers";
import type { DateRange } from "../periods";
import type { TenantCtx } from "../scope";
import { SocialReadBudget } from "./budget";
import {
  YOUTUBE_DAY_METRICS,
  YOUTUBE_VIDEO_METRICS,
  type OrganicDataState,
  type YouTubeDayMetric,
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
 * YouTube analytics reads (ADR 0016, Checkpoint 4) behind convex/v1/youtubeAnalytics.ts: ONE
 * channel per request, values exactly as YouTube reported them. Nothing is summed, averaged,
 * compared, ranked or combined, across days, channels or platforms (YouTube API Services
 * Developer Policies III.E.2 / III.E.4.h; open questions in the ADR). Same tenancy and bounds
 * as ./queries.ts: the org is ctx.tenant.orgId, ids are loaded with getOwned (another tenant's
 * id is NOT_FOUND), every read is orgId-first and budgeted. A non-YouTube id is
 * INVALID_ARGUMENT `not_youtube`.
 *
 * Two calendars, never mixed:
 * - channel days are YouTube Analytics days: PACIFIC TIME day keys, stored as YouTube reported
 *   them (the follower captures stored on the same rows are UTC capture days and are NOT part
 *   of the day series);
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
  return {
    account,
    range,
    dataState,
    reportingDelayDays: socialCapabilitiesOf("youtube")?.accountMetricsDelayDays ?? 0,
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

/** One channel's videos by publish instant (./queries.ts listSocialPosts, YouTube only). */
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
  await ownedChannel(ctx, args.socialAccountId, "socialAccountId");
  return await listSocialPosts(ctx, args);
}

/** One video with its lifetime captures (./queries.ts getSocialPost, YouTube only). */
export async function getYouTubeVideo(
  ctx: TenantCtx,
  args: { videoId: string; range?: DateRange },
) {
  const post = await getOwned(ctx, "socialPosts", args.videoId);
  if (post.platform !== "youtube") invalid("videoId", "not_youtube");
  return await getSocialPost(ctx, {
    postId: args.videoId,
    ...(args.range !== undefined ? { range: args.range } : {}),
  });
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
