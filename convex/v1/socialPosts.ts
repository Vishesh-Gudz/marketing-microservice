import { paginationOptsValidator } from "convex/server";
import { v } from "convex/values";
import { getSocialPost, listSocialPosts } from "../analytics/organic/queries";
import { paginatedDto } from "../lib/dto";
import { orgQuery } from "../lib/tenancy";
import {
  socialPostDetailDto,
  socialPostDto,
  toSocialPostDetailDto,
  toSocialPostDto,
} from "./dto/socialPost";

/**
 * Organic posts (Phase 10 Stage B): read-only, tenant-scoped, lifetime snapshots only.
 * `publishedFrom` / `publishedTo` are inclusive calendar days in the ORGANIZATION timezone
 * (unlike account metrics, which are UTC days). 1-100 posts per page, by publish instant.
 */
export const list = orgQuery({
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
  returns: paginatedDto(socialPostDto),
  handler: async (ctx, args) => {
    const result = await listSocialPosts(ctx, {
      socialAccountId: args.socialAccountId,
      ...(args.publishedFrom !== undefined ? { publishedFrom: args.publishedFrom } : {}),
      ...(args.publishedTo !== undefined ? { publishedTo: args.publishedTo } : {}),
      ...(args.sort?.dir !== undefined ? { dir: args.sort.dir } : {}),
      paginationOpts: args.paginationOpts,
    });
    return {
      page: result.page.map(toSocialPostDto),
      isDone: result.isDone,
      continueCursor: result.continueCursor,
    };
  },
});

/**
 * One post with its latest capture and its lifetime captures (oldest first), optionally
 * limited to capture days (UTC) [range.from, range.to]. Another org's id is NOT_FOUND.
 */
export const get = orgQuery({
  args: {
    postId: v.string(),
    range: v.optional(v.object({ from: v.string(), to: v.string() })),
  },
  returns: socialPostDetailDto,
  handler: async (ctx, args) => {
    return toSocialPostDetailDto(
      await getSocialPost(ctx, {
        postId: args.postId,
        ...(args.range !== undefined ? { range: args.range } : {}),
      }),
    );
  },
});
