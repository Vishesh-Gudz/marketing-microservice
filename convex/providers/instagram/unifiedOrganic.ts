import { v } from "convex/values";
import type { SocialAccountType } from "../../domain/types";
import type { DateKey } from "../../lib/dates";
import type { ProviderOperation } from "../types";
import { isInstagramId, UNIFIED_GRAPH_ORIGIN, UNIFIED_GRAPH_VERSION } from "./config";
import {
  decodeInstagramCursor,
  encodeInstagramCursor,
  instagramRequestFingerprint,
} from "./cursor";
import { classifyInstagramFailure, instagramError, instagramProviderError } from "./errors";
import { createInstagramGraphReader, type ReaderCall } from "./graphReader";
import type { MediaInput, ProfileInput } from "./mapping";
import { canonicalId, parseRaw } from "./schemas";
import { SDK_POST_METRIC_COLUMNS, UNIFIED_POST_METRIC_NAMES } from "./semantics";
import { sendInstagram, UNIFIED_MEDIA_FIELDS, UNIFIED_PROFILE_FIELDS } from "./transport";

/**
 * O1: the organic reads of an Instagram API with Unified Login connection (config.ts), in the
 * default runtime and WITHOUT social-sdk (the SDK stays Instagram Login only). Every request is
 * a GET on graph.facebook.com/v26.0 through the "graph_reader" allowlist of transport.ts, with
 * the system-user token in the `Authorization: Bearer` header only (as Unified discovery and
 * messaging send it) and an explicit RequestBudget:
 *
 *   readProfile          /{ig-id}?fields=id,username,name,followers_count,media_count
 *   listMedia            /{ig-id}/media?fields=<UNIFIED_MEDIA_FIELDS>&limit=<n>[&after=<c>]
 *   readPostInsights     /{media-id}/insights?metric=likes,comments,saved,shares,reach,views,
 *                          total_interactions&period=lifetime            (ONE request per post)
 *   readAccountInsights  the Instagram Login reader's request A on this host
 *   readFollowBreakdown  the Instagram Login reader's request B on this host
 *
 * Results are our own read types, the SAME ones the Instagram Login path produces, so
 * ./mapping.ts maps both setups into identical rows. Raw payloads never leave this module.
 *
 * PROVISIONAL (no real-account evidence yet): that a system-user token reads these insights
 * with `instagram_manage_insights` but without `pages_read_engagement`, and that the account
 * insight responses on graph.facebook.com have the graph.instagram.com shape.
 */

/** PROVISIONAL: graph.facebook.com has no account_type field [doc: IG User]; see discovery.ts. */
export const UNIFIED_ACCOUNT_TYPE: SocialAccountType = "business";

const rawProfile = v.object({
  id: v.union(v.string(), v.number()),
  username: v.optional(v.string()),
  name: v.optional(v.string()),
  followers_count: v.optional(v.number()),
  media_count: v.optional(v.number()),
});

const rawMediaPage = v.object({
  data: v.array(v.any()),
  paging: v.optional(
    v.object({
      cursors: v.optional(v.object({ after: v.optional(v.string()) })),
      // Meta's `next` URL embeds the token: only its presence is read, it is never followed.
      next: v.optional(v.string()),
    }),
  ),
});

/** Graph paging cursors: opaque, printable and bounded (the transport's own rule). */
const PAGING_CURSOR = /^[!-~]{1,2048}$/;

function optionalString(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function present<T extends Record<string, unknown>>(fields: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

/** One listed media item, with the same caps as the Instagram Login (SDK) listing. */
function mediaItem(item: unknown, operation: ProviderOperation): MediaInput {
  const raw = (item !== null && typeof item === "object" ? item : {}) as Record<string, unknown>;
  const id = raw["id"];
  if (!isInstagramId(id)) {
    throw instagramError("data", operation, "media_invalid", "Unexpected Instagram media");
  }
  return {
    id,
    ...present({
      caption: optionalString(raw["caption"], 8_192),
      mediaType: optionalString(raw["media_type"], 64),
      mediaProductType: optionalString(raw["media_product_type"], 64),
      permalink: optionalString(raw["permalink"], 2_048),
      timestamp: optionalString(raw["timestamp"], 64),
    }),
  };
}

function graphUrl(path: string): URL {
  return new URL(`${UNIFIED_GRAPH_ORIGIN}/${UNIFIED_GRAPH_VERSION}/${path}`);
}

function checkId(id: string, call: ReaderCall): void {
  if (!isInstagramId(id)) {
    throw instagramError("invalid_request", call.operation, "id_invalid", "Invalid id");
  }
}

export function createUnifiedOrganicReader(options: { timeoutMs: number }) {
  const insights = createInstagramGraphReader({ timeoutMs: options.timeoutMs, graph: "unified" });

  async function get(url: URL, accessToken: string, call: ReaderCall): Promise<unknown> {
    const result = await sendInstagram(
      "graph_reader",
      url,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      },
      { timeoutMs: options.timeoutMs, budget: call.budget },
    );
    if (!result.ok) {
      throw instagramProviderError(
        classifyInstagramFailure(result.failure),
        call.operation,
        call.stage,
      );
    }
    return result.body;
  }

  return Object.freeze({
    /** The account's profile (1 request); the id must be the token's account. */
    async readProfile(
      accessToken: string,
      userId: string,
      call: ReaderCall,
    ): Promise<ProfileInput> {
      checkId(userId, call);
      const url = graphUrl(userId);
      url.searchParams.set("fields", UNIFIED_PROFILE_FIELDS);
      const raw = parseRaw(
        rawProfile,
        await get(url, accessToken, call),
        call.operation,
        "profile",
      );
      if (canonicalId(raw.id) !== userId) {
        throw instagramError(
          "data",
          call.operation,
          "identity_mismatch",
          "Unexpected Instagram account",
        );
      }
      return present({
        username: optionalString(raw.username, 30),
        name: optionalString(raw.name, 256),
        followersCount: optionalCount(raw.followers_count),
      });
    },

    /**
     * One media page, newest first (1 request, limit 1..100). `cursor` is our ig1 cursor of the
     * SAME request (setup, account and limit); Graph's `after` stays inside it.
     */
    async listMedia(
      accessToken: string,
      userId: string,
      request: { cursor?: string; limit: number },
      call: ReaderCall,
    ): Promise<{ items: MediaInput[]; nextCursor?: string }> {
      checkId(userId, call);
      const { operation } = call;
      if (!Number.isSafeInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw instagramError("invalid_request", operation, "limit_invalid", "Invalid page size");
      }
      const fp = instagramRequestFingerprint(operation, [
        "unified",
        UNIFIED_GRAPH_VERSION,
        userId,
        request.limit,
      ]);
      const after =
        request.cursor === undefined
          ? undefined
          : await decodeInstagramCursor(request.cursor, fp, operation);
      const url = graphUrl(`${userId}/media`);
      url.searchParams.set("fields", UNIFIED_MEDIA_FIELDS);
      url.searchParams.set("limit", String(request.limit));
      if (after !== undefined) url.searchParams.set("after", after);
      const page = parseRaw(rawMediaPage, await get(url, accessToken, call), operation, "media");
      const items = page.data.map((item) => mediaItem(item, operation));
      if (page.paging?.next === undefined) return { items };
      const next = page.paging.cursors?.after;
      if (next === undefined || !PAGING_CURSOR.test(next)) {
        throw instagramError("data", operation, "cursor_unexpected", "Unexpected paging position");
      }
      return { items, nextCursor: await encodeInstagramCursor(fp, operation, next) };
    },

    /**
     * Lifetime insights of one media item in ONE request, split back into the two groups the
     * Instagram Login path reads (SDK names, reader names) so mapPostSnapshot maps both alike.
     */
    async readPostInsights(
      accessToken: string,
      mediaId: string,
      call: ReaderCall,
    ): Promise<{ sdk: { name: string; value: number }[]; reader: Record<string, number> }> {
      const values = await insights.readPostInsights(
        accessToken,
        mediaId,
        call,
        UNIFIED_POST_METRIC_NAMES,
      );
      const sdk: { name: string; value: number }[] = [];
      const reader: Record<string, number> = {};
      for (const name of UNIFIED_POST_METRIC_NAMES) {
        const value = values[name];
        if (value === undefined) continue; // not reported: stays absent
        if (name in SDK_POST_METRIC_COLUMNS) sdk.push({ name, value });
        else reader[name] = value;
      }
      return { sdk, reader };
    },

    /** Request A of one UTC day (1 request), as the Instagram Login reader. */
    readAccountInsights(
      accessToken: string,
      userId: string,
      day: DateKey,
      call: ReaderCall,
    ): Promise<Record<string, number>> {
      return insights.readAccountInsights(accessToken, userId, day, call);
    },

    /** Request B of one UTC day (1 request), as the Instagram Login reader. */
    readFollowBreakdown(
      accessToken: string,
      userId: string,
      day: DateKey,
      call: ReaderCall,
    ): Promise<Record<string, number> | undefined> {
      return insights.readFollowBreakdown(accessToken, userId, day, call);
    },
  });
}

export type UnifiedOrganicReader = ReturnType<typeof createUnifiedOrganicReader>;
