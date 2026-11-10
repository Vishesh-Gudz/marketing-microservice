import type { DateRange } from "@/convex/analytics/periods";
import { filterParamsOnly } from "./filters";

/**
 * Organic dashboard URL state (/social). The global filters (preset, from/to, compare,
 * granularity) are the existing ones (./filters.ts); on /social their presets resolve against
 * TODAY IN UTC (account metrics are keyed by UTC day, R12); with `platform=youtube` they
 * resolve against today in Pacific Time (YouTube channel days, ADR 0016). Page parameters:
 *   platform "youtube" for the YouTube view (absent -> Instagram, the original page)
 *   account  the selected social account id (absent -> the first listed account)
 *   pdir     post / video order by publish time: "desc" (default) or "asc"
 *   vwin     YouTube videos table period: "lifetime" (absent -> the last 28 days)
 */

/** Mirrors the API limits (checked against convex/analytics/organic/config in tests/unit). */
export const ORGANIC_MAX_RANGE_DAYS = 400;
export const ORGANIC_MAX_PAGE_SIZE = 100;
export const SOCIAL_POST_PAGE_SIZES = [25, 50, 100] as const;

export type PostOrder = "desc" | "asc";

export type SocialPlatformView = "instagram" | "youtube";

export type SocialParams = {
  platform: SocialPlatformView;
  account?: string;
  postOrder: PostOrder;
};

const ACCOUNT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseSocialParams(params: URLSearchParams): SocialParams {
  const account = params.get("account") ?? undefined;
  const pdir = params.get("pdir");
  return {
    platform: params.get("platform") === "youtube" ? "youtube" : "instagram",
    ...(account !== undefined && ACCOUNT_ID.test(account) ? { account } : {}),
    postOrder: pdir === "asc" ? "asc" : "desc",
  };
}

/** The YouTube videos table's period (ADR 0016 Checkpoint 8): last 28 days unless `vwin`. */
export type VideoWindow = "last28" | "lifetime";

export function parseVideoWindow(params: URLSearchParams): VideoWindow {
  return params.get("vwin") === "lifetime" ? "lifetime" : "last28";
}

/** The YouTube list's own parameters, besides the global filters (kept when drilling down). */
const YOUTUBE_LIST_PARAMS = ["account", "pdir", "vwin"] as const;

function withListParams(query: URLSearchParams, params: URLSearchParams): URLSearchParams {
  for (const name of YOUTUBE_LIST_PARAMS) {
    const value = params.get(name);
    if (value !== null) query.set(name, value);
  }
  return query;
}

/**
 * A YouTube video's page: the global filters and the list's channel, order and period ride
 * along, so the page's back link returns to the same list.
 */
export function youtubeVideoHref(
  video: { id: string; socialAccountId: string },
  params: URLSearchParams,
): string {
  const query = withListParams(filterParamsOnly(params), params);
  query.set("account", video.socialAccountId);
  return `/social/youtube/videos/${encodeURIComponent(video.id)}?${query.toString()}`;
}

/** The YouTube list a video page was opened from (`params`: the video page's query). */
export function youtubeListHref(params: URLSearchParams): string {
  const query = filterParamsOnly(params);
  query.set("platform", "youtube");
  return `/social?${withListParams(query, params).toString()}`;
}

/**
 * Posts are filtered by publish day in the ORGANIZATION timezone (B2 semantics): the same
 * inclusive date keys as the selected range, interpreted by the API in the org timezone.
 */
export function postPublishFilter(range: DateRange): {
  publishedFrom: string;
  publishedTo: string;
} {
  return { publishedFrom: range.from, publishedTo: range.to };
}
