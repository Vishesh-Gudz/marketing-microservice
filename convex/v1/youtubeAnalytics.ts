import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import {
  getYouTubeVideo,
  listYouTubeVideos,
  youtubeChannelDays,
} from "../analytics/organic/youtube";
import { paginatedDto } from "../lib/dto";
import { orgQuery } from "../lib/tenancy";
import {
  toYouTubeChannelDaysDto,
  toYouTubeVideoDetailDto,
  toYouTubeVideoDto,
  youtubeChannelDaysDto,
  youtubeVideoDetailDto,
  youtubeVideoDto,
} from "./dto/youtubeAnalytics";

/**
 * YouTube analytics (ADR 0016, Checkpoints 4 and 8): read-only, tenant-scoped, ONE channel per
 * request, values exactly as YouTube reported them. The only derived values are the approved
 * Checkpoint 8 range totals of that one channel (`channelDays.totals`); nothing is compared or
 * combined across channels or platforms (v1/organicAnalytics never aggregates YouTube), and
 * per-video ratios are never aggregated. Never a provider call. Another org's id is NOT_FOUND;
 * a non-YouTube id is INVALID_ARGUMENT `not_youtube`.
 */

const range = v.object({ from: v.string(), to: v.string() });

/**
 * One channel's days over an inclusive range of PACIFIC TIME days (YouTube Analytics days; at
 * most 400): one entry per day with the values YouTube reported for it, the coverage and the
 * channel's analytics grant; Checkpoint 8 adds the range totals over the reported days and the
 * channel's current subscriber count. Fails with INVALID_ARGUMENT `too_many_rows` instead of
 * truncating.
 */
export const channelDays = orgQuery({
  args: { socialAccountId: v.string(), range },
  returns: youtubeChannelDaysDto,
  handler: async (ctx, args) => {
    return toYouTubeChannelDaysDto(await youtubeChannelDays(ctx, args));
  },
});

/**
 * One channel's videos with their latest lifetime statistics and (Checkpoint 8) their
 * per-video analytics windows (`analytics.last28`, `analytics.lifetime`), 1-100 per page by
 * publish instant (newest first unless `sort.dir` is "asc"). `publishedFrom` / `publishedTo`
 * are inclusive publish days in the ORGANIZATION timezone, as in v1/socialPosts.
 */
export const videos = orgQuery({
  args: {
    socialAccountId: v.string(),
    publishedFrom: v.optional(v.string()),
    publishedTo: v.optional(v.string()),
    sort: v.optional(
      v.object({
        by: v.literal("publishedAt"),
        dir: v.optional(v.union(v.literal("asc"), v.literal("desc"))),
      }),
    ),
    paginationOpts: paginationOptsValidator,
  },
  returns: paginatedDto(youtubeVideoDto),
  handler: async (ctx, args) => {
    const result = await listYouTubeVideos(ctx, {
      socialAccountId: args.socialAccountId,
      ...(args.publishedFrom !== undefined ? { publishedFrom: args.publishedFrom } : {}),
      ...(args.publishedTo !== undefined ? { publishedTo: args.publishedTo } : {}),
      ...(args.sort?.dir !== undefined ? { dir: args.sort.dir } : {}),
      paginationOpts: args.paginationOpts,
    });
    return {
      page: result.page.map(toYouTubeVideoDto),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * One video with its latest statistics, its lifetime captures (oldest first), optionally
 * limited to capture days (UTC) [range.from, range.to], and (Checkpoint 8) its per-video
 * analytics windows.
 */
export const video = orgQuery({
  args: { videoId: v.string(), range: v.optional(range) },
  returns: youtubeVideoDetailDto,
  handler: async (ctx, args) => {
    return toYouTubeVideoDetailDto(
      await getYouTubeVideo(ctx, {
        videoId: args.videoId,
        ...(args.range !== undefined ? { range: args.range } : {}),
      }),
    );
  },
});
