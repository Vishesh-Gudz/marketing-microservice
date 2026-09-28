"use node";

import {
  connectedAccountRef,
  createSocial,
  platformPostRef,
  SocialError,
  type JsonObject,
} from "@opencoredev/social-sdk";
import { instagram } from "@opencoredev/social-sdk/instagram";
import type { ProviderError } from "../../errors";
import type { ProviderOperation } from "../../types";
import { isInstagramId, SYNC_TIMEOUT_MS } from "../config";
import type { InstagramCredential } from "../credential";
import {
  decodeInstagramCursor,
  encodeInstagramCursor,
  instagramRequestFingerprint,
} from "../cursor";
import { classifyInstagramFailure, instagramError, instagramProviderError } from "../errors";
import { createSdkFetch, type FailureCapture, type RequestBudget } from "../transport";

/**
 * THE @opencoredev/social-sdk@0.5.0 adapter (Phase 10). "use node": the SDK is ESM-only and
 * requires Node >= 22.12 (Gate V1: the Convex cloud Node 22 runtime is 22.23.2).
 *
 * Isolation (ESLint-enforced): only files in convex/providers/instagram/node/** may import
 * the SDK; only convex/providers/social/nodeRegistry.ts may import this directory; only the
 * "use node" social worker may import the node registry. Nothing SDK-specific leaves this
 * module: no SDK type, error, reference or cursor. Callers get our own read types, our own
 * `ig1.` cursors and ProviderErrors.
 *
 * - One SDK client per session; the token exists only in this closure (action memory).
 * - Every SDK request goes through our injected fetch (transport.ts, "sdk" caller): the
 *   exact allowlisted requests of the reads below, Bearer header only, an explicit
 *   RequestBudget, and failure capture (Meta error code + usage headers) that REPLACES the
 *   SDK's status-only error mapping.
 * - SDK retries are off (one attempt): the sync engine owns retries.
 * - Concurrency: at most `concurrency` SDK requests in flight (approved budget: 3).
 *
 * Stage A: the session is the infrastructure seam; the provider operations (provider.ts)
 * still fail closed with instagram_mapping_pending, and Stage B maps these reads.
 */

/** createSocial's instance name for a single backend (SDK: `{ default: backend }`). */
const BACKEND = "default";

/** Profile of the connected professional account. Biography and website are dropped. */
export type InstagramProfileRead = {
  userId: string;
  username?: string;
  name?: string;
  followersCount?: number;
  profilePictureUrl?: string;
};

/** One media item of the account's listing (raw Instagram media vocabulary). */
export type InstagramMediaRead = {
  id: string;
  caption?: string;
  mediaType?: string;
  mediaProductType?: string;
  permalink?: string;
  timestamp?: string;
};

/** One lifetime insight value of a media item, under Instagram's metric name. */
export type InstagramPostMetricRead = { name: string; value: number };

/** [SDK] the lifetime metric names social-sdk 0.5.0 requests for media. */
const SDK_POST_METRIC_NAMES: ReadonlySet<string> = new Set([
  "likes",
  "comments",
  "saved",
  "shares",
  "reach",
]);

const SDK_ERROR_KINDS: Readonly<Record<string, ProviderError["kind"]>> = {
  rate_limited: "rate_limited",
  reconnect_required: "auth",
  unauthorized: "auth",
  missing_permission: "permission",
  ineligible_account: "permission",
  not_found: "not_found",
  gone: "not_found",
  timeout: "transient",
  invalid_input: "invalid_request",
  unsupported_capability: "unsupported",
};

/**
 * Maps anything the SDK threw into a ProviderError. Our capture wins (Meta error code,
 * usage headers, allowlist refusals, budget); otherwise the SDK error CODE only. SDK
 * messages, paths, correlation ids and causes are never read or propagated.
 */
function toProviderError(
  error: unknown,
  capture: FailureCapture,
  operation: ProviderOperation,
): ProviderError {
  if (capture.last !== undefined) {
    return instagramProviderError(classifyInstagramFailure(capture.last), operation);
  }
  if (error instanceof SocialError) {
    if (error.code === "upstream_failure") {
      // No failed HTTP response was captured: the SDK rejected the response shape.
      return instagramError(
        "data",
        operation,
        "sdk_invalid_response",
        "Unexpected Instagram payload",
      );
    }
    return instagramError(
      SDK_ERROR_KINDS[error.code] ?? "unknown",
      operation,
      `sdk_${error.code}`,
      "Instagram request failed",
    );
  }
  return instagramError("unknown", operation, "sdk_internal", "Instagram request failed");
}

function optionalString(value: unknown, max = 4_096): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function mediaRead(item: JsonObject, operation: ProviderOperation): InstagramMediaRead {
  const id = item["id"];
  if (!isInstagramId(id)) {
    throw instagramError("data", operation, "sdk_invalid_response", "Unexpected Instagram media");
  }
  const fields = {
    caption: optionalString(item["caption"], 8_192),
    mediaType: optionalString(item["media_type"], 64),
    mediaProductType: optionalString(item["media_product_type"], 64),
    permalink: optionalString(item["permalink"], 2_048),
    timestamp: optionalString(item["timestamp"], 64),
  };
  return {
    id,
    ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
  };
}

export type InstagramSdkSession = ReturnType<typeof createInstagramSdkSession>;

export function createInstagramSdkSession(options: {
  credential: InstagramCredential;
  budget: RequestBudget;
  timeoutMs?: number;
  concurrency?: number;
}) {
  const { credential } = options;
  const capture: FailureCapture = {};
  const client = createSocial({
    backend: instagram({
      auth: {
        accessToken: credential.accessToken,
        accountId: credential.userId,
        flavor: "instagram-login",
      },
      fetch: createSdkFetch({ budget: options.budget, capture }),
    }),
    concurrency: options.concurrency ?? 3,
  });
  const account = connectedAccountRef({
    backend: BACKEND,
    platform: "instagram",
    accountId: credential.userId,
  });
  const callOptions = {
    retryBudget: { maxAttempts: 1, maxElapsedMs: options.timeoutMs ?? SYNC_TIMEOUT_MS },
  };

  async function run<T>(operation: ProviderOperation, work: () => Promise<T>): Promise<T> {
    capture.last = undefined;
    try {
      return await work();
    } catch (error) {
      throw toProviderError(error, capture, operation);
    }
  }

  return Object.freeze({
    /** [SDK] graph.getProfile: GET /{ig-id}?fields=user_id,id,username,name,... (1 request). */
    async profile(operation: ProviderOperation): Promise<InstagramProfileRead> {
      const record = await run(operation, () => client.graph.getProfile(account, {}, callOptions));
      const native = (record.native ?? {}) as JsonObject;
      const userId = record.ref.profileId;
      if (userId !== credential.userId) {
        throw instagramError(
          "data",
          operation,
          "identity_mismatch",
          "Unexpected Instagram account",
        );
      }
      const fields = {
        username: optionalString(native["username"], 30),
        name: optionalString(native["name"], 256),
        followersCount: optionalCount(native["followers_count"]),
        profilePictureUrl: optionalString(native["profile_picture_url"], 2_048),
      };
      return {
        userId,
        ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)),
      };
    },

    /**
     * [SDK] posts.list: GET /{ig-id}/media (1 request per page, limit 1..100). `cursor` is
     * our ig1 cursor of the SAME request (account + limit); the SDK cursor stays inside.
     */
    async listMedia(
      operation: ProviderOperation,
      request: { cursor?: string; limit: number },
    ): Promise<{ items: InstagramMediaRead[]; nextCursor?: string }> {
      const fp = instagramRequestFingerprint(operation, [credential.userId, request.limit]);
      const sdkCursor =
        request.cursor === undefined
          ? undefined
          : await decodeInstagramCursor(request.cursor, fp, operation);
      const page = await run(operation, () =>
        client.posts.list(account, {
          ...callOptions,
          limit: request.limit,
          ...(sdkCursor !== undefined ? { cursor: sdkCursor } : {}),
        }),
      );
      const items = page.items.map((item) => mediaRead(item, operation));
      return page.nextCursor === undefined
        ? { items }
        : { items, nextCursor: await encodeInstagramCursor(fp, operation, page.nextCursor) };
    },

    /**
     * [SDK] analytics.getPostMetrics: GET /{media-id}?fields=media_product_type, then
     * GET /{media-id}/insights?metric=likes,comments,saved,shares,reach (2 requests).
     * Lifetime values under Instagram's metric names; unknown names fail closed.
     */
    async postMetrics(
      operation: ProviderOperation,
      mediaId: string,
    ): Promise<InstagramPostMetricRead[]> {
      if (!isInstagramId(mediaId)) {
        throw instagramError("invalid_request", operation, "media_invalid", "Invalid media id");
      }
      const post = platformPostRef({
        backend: BACKEND,
        platform: "instagram",
        accountId: credential.userId,
        postId: mediaId,
      });
      const values = await run(operation, () => client.analytics.getPostMetrics(post, callOptions));
      return values.map((metric) => {
        if (!SDK_POST_METRIC_NAMES.has(metric.name) || optionalCount(metric.value) === undefined) {
          throw instagramError("data", operation, "sdk_invalid_response", "Unexpected metric");
        }
        return { name: metric.name, value: metric.value };
      });
    },
  });
}
