import { validate } from "convex-helpers/validators";
import { v, type Infer, type Validator } from "convex/values";
import type { ProviderOperation } from "../types";
import { youtubeError } from "./errors";

/**
 * Raw YouTube response validators (ADR 0016; Convex `v` + convex-helpers `validate`, no Zod).
 * Unknown fields are allowed (Google adds fields over time); missing or mistyped required
 * fields are a non-retryable "data" error with a generic message. Raw shapes never leave the
 * YouTube provider: callers get our own read types. [doc] Data API counts are uint64 values
 * serialized as decimal strings; JSON numbers are tolerated.
 */

const count = v.union(v.string(), v.number());

export const rawTokenResponse = v.object({
  access_token: v.string(),
  expires_in: v.optional(v.number()),
  scope: v.optional(v.string()),
  token_type: v.optional(v.string()),
});

/** List envelopes: items are validated one by one (below). */
export const rawListResponse = v.object({
  items: v.optional(v.array(v.any())),
  nextPageToken: v.optional(v.string()),
});
export type RawListResponse = Infer<typeof rawListResponse>;

/** [doc] `channels` resource, parts snippet, statistics, contentDetails. */
export const rawChannel = v.object({
  id: v.string(),
  snippet: v.optional(
    v.object({
      title: v.optional(v.string()),
      customUrl: v.optional(v.string()),
    }),
  ),
  statistics: v.optional(
    v.object({
      subscriberCount: v.optional(count),
      hiddenSubscriberCount: v.optional(v.boolean()),
    }),
  ),
  contentDetails: v.optional(
    v.object({
      relatedPlaylists: v.optional(v.object({ uploads: v.optional(v.string()) })),
    }),
  ),
});
export type RawChannel = Infer<typeof rawChannel>;

/** [doc] `playlistItems` resource, part contentDetails. */
export const rawPlaylistItem = v.object({
  contentDetails: v.object({
    videoId: v.string(),
    videoPublishedAt: v.optional(v.string()),
  }),
});
export type RawPlaylistItem = Infer<typeof rawPlaylistItem>;

/** [doc] `videos` resource, part snippet. */
export const rawVideo = v.object({
  id: v.string(),
  snippet: v.optional(
    v.object({
      publishedAt: v.optional(v.string()),
      channelId: v.optional(v.string()),
      title: v.optional(v.string()),
      liveBroadcastContent: v.optional(v.string()),
    }),
  ),
});
export type RawVideo = Infer<typeof rawVideo>;

/** Validates a raw payload; failures become "data" errors without echoing the payload. */
export function parseRaw<T extends Validator<unknown, "required", string>>(
  validator: T,
  value: unknown,
  operation: ProviderOperation,
  what: string,
): Infer<T> {
  if (!validate(validator, value, { allowUnknownFields: true })) {
    throw youtubeError("data", operation, "schema", `Unexpected YouTube ${what} payload`);
  }
  return value as Infer<T>;
}

/** A Data API count as a safe integer, or undefined when absent or malformed. */
export function parseCount(raw: string | number | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const text = typeof raw === "number" ? String(raw) : raw;
  if (!/^\d{1,16}$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : undefined;
}
