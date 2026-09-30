import { v, type Infer } from "convex/values";
import type { Doc } from "../../_generated/dataModel";
import { postMetricsOf } from "../../analytics/organic/aggregate";
import {
  ORGANIC_DATA_STATES,
  ORGANIC_KPI_REASONS,
  ORGANIC_KPIS,
  ORGANIC_METRIC_REASONS,
  ORGANIC_POST_METRIC_NAMES,
} from "../../analytics/organic/metrics";
import { fixed6ToNumber } from "../../analytics/numeric";
import {
  literalUnion,
  socialPlatformValidator,
  socialPostTypeValidator,
} from "../../domain/validators";
import { toIso } from "../../lib/dto";

/**
 * Organic post DTOs (Phase 10 Stage B). A post is the canonical socialPosts row (organic media
 * only: AD / STORY media and unresolved media are never stored). The only URL is the validated
 * Instagram permalink (F1, R1b); no media, thumbnail or profile URL, no comments or commenters.
 * Metrics are LIFETIME values of one capture (a lifetime snapshot); there are no per-day post
 * deltas (F14). Unavailable values are omitted (never null, never 0) and explained.
 * `type` is the canonical post type the sync derived from Instagram's media_type and
 * media_product_type (reel / image / video / carousel / other); the raw values are not stored.
 */

const optionalNumber = v.optional(v.number());
export const organicDataStateDto = literalUnion(ORGANIC_DATA_STATES);

export const postMetricsDto = v.object({
  views: optionalNumber,
  reach: optionalNumber,
  likes: optionalNumber,
  comments: optionalNumber,
  shares: optionalNumber,
  saves: optionalNumber,
  totalInteractions: optionalNumber,
  unavailableMetrics: v.array(
    v.object({
      metric: literalUnion(ORGANIC_POST_METRIC_NAMES),
      reason: literalUnion(ORGANIC_METRIC_REASONS),
    }),
  ),
});

export const organicKpisDto = v.object({
  /** totalInteractions / reach as a fraction (0.0123 = 1.23%), at most 6 decimals. */
  engagementRate: optionalNumber,
  unavailableKpis: v.array(
    v.object({ kpi: literalUnion(ORGANIC_KPIS), reason: literalUnion(ORGANIC_KPI_REASONS) }),
  ),
});

/** One lifetime capture of a post (capturedDate = UTC capture day). */
export const postSnapshotDto = v.object({
  capturedDate: v.string(),
  capturedAt: v.string(),
  dataState: organicDataStateDto,
  metrics: postMetricsDto,
  kpis: organicKpisDto,
});
export type PostSnapshotDto = Infer<typeof postSnapshotDto>;

const socialPostFields = {
  id: v.string(),
  socialAccountId: v.string(),
  platform: socialPlatformValidator,
  externalId: v.string(),
  type: socialPostTypeValidator,
  /** At most 2,200 characters (F21). */
  caption: v.optional(v.string()),
  /** The validated Instagram permalink: the only URL (F1, R1b). */
  permalink: v.optional(v.string()),
  publishedAt: v.string(),
  /** The post is no longer listed by the platform (bounded removal). */
  removedAt: v.optional(v.string()),
  /** reported / partial: latest capture complete or not; unknown: never captured. */
  dataState: organicDataStateDto,
  latest: v.optional(postSnapshotDto),
};

export const socialPostDto = v.object(socialPostFields);
export type SocialPostDto = Infer<typeof socialPostDto>;

export const socialPostDetailDto = v.object({
  ...socialPostFields,
  /** Capture-day range of `snapshots` when one was requested. */
  snapshotRange: v.optional(v.object({ from: v.string(), to: v.string() })),
  /** Lifetime captures, oldest first (never differenced into per-day values). */
  snapshots: v.array(postSnapshotDto),
});
export type SocialPostDetailDto = Infer<typeof socialPostDetailDto>;

export function toPostSnapshotDto(
  snapshot: Doc<"socialPostMetricSnapshots">,
  postMetrics: readonly string[],
): PostSnapshotDto {
  const metrics = postMetricsOf(snapshot, postMetrics);
  return {
    capturedDate: snapshot.capturedDate,
    capturedAt: toIso(snapshot.capturedAt),
    dataState: metrics.dataState,
    metrics: { ...metrics.values, unavailableMetrics: metrics.unavailableMetrics },
    kpis: {
      ...(metrics.engagementRate !== undefined
        ? { engagementRate: fixed6ToNumber(metrics.engagementRate) }
        : {}),
      unavailableKpis: metrics.unavailableKpis,
    },
  };
}

export function toSocialPostDto(view: {
  post: Doc<"socialPosts">;
  latest: Doc<"socialPostMetricSnapshots"> | null;
  postMetrics: readonly string[];
}): SocialPostDto {
  const { post } = view;
  const latest =
    view.latest === null ? undefined : toPostSnapshotDto(view.latest, view.postMetrics);
  return {
    id: post._id,
    socialAccountId: post.socialAccountId,
    platform: post.platform,
    externalId: post.externalId,
    type: post.type,
    ...(post.caption !== undefined ? { caption: post.caption } : {}),
    ...(post.permalink !== undefined ? { permalink: post.permalink } : {}),
    publishedAt: toIso(post.publishedAt),
    ...(post.removedAt !== undefined ? { removedAt: toIso(post.removedAt) } : {}),
    dataState: latest?.dataState ?? "unknown",
    ...(latest !== undefined ? { latest } : {}),
  };
}

export function toSocialPostDetailDto(view: {
  post: Doc<"socialPosts">;
  latest: Doc<"socialPostMetricSnapshots"> | null;
  snapshots: Doc<"socialPostMetricSnapshots">[];
  postMetrics: readonly string[];
  range?: { from: string; to: string };
}): SocialPostDetailDto {
  return {
    ...toSocialPostDto(view),
    ...(view.range !== undefined ? { snapshotRange: view.range } : {}),
    snapshots: view.snapshots.map((snapshot) => toPostSnapshotDto(snapshot, view.postMetrics)),
  };
}
