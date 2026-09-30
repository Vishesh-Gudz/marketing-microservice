"use node";

import {
  addDays,
  compareDateKeys,
  diffDays,
  eachDay,
  isDateKey,
  type DateKey,
} from "../../../lib/dates";
import { isProviderError } from "../../errors";
import type {
  ProviderSocialAccountDay,
  ProviderSocialPost,
  ProviderSocialPostSnapshot,
  SocialProvider,
} from "../../social/types";
import { assertValidSocialRecord } from "../../social/validate";
import type { PageRequest, ProviderContext, ProviderOperation } from "../../types";
import { INSTAGRAM_CAPABILITIES } from "../capabilities";
import {
  INSTAGRAM_CONFIG_INVALID,
  INSTAGRAM_PROVIDER_ID,
  isInstagramId,
  isValidInstagramAppId,
  SYNC_TIMEOUT_MS,
} from "../config";
import { isInstagramCredential, type InstagramCredential } from "../credential";
import {
  decodeInstagramCursor,
  encodeInstagramCursor,
  instagramRequestFingerprint,
} from "../cursor";
import { instagramError } from "../errors";
import { createInstagramGraphReader } from "../graphReader";
import {
  classifyMedia,
  mapAccountDay,
  mapMedia,
  mapPostSnapshot,
  mapProfile,
  parseInstagramTimestamp,
} from "../mapping";
import { ACCOUNT_DAYS_PER_CALL } from "../semantics";
import { RequestBudget } from "../transport";
import { createInstagramSdkSession, type InstagramMediaRead } from "./sdk";

/**
 * The Instagram SocialProvider (Phase 10), resolved only in Node (social/nodeRegistry.ts)
 * because its reads go through @opencoredev/social-sdk (./sdk.ts) and the Graph reader.
 *
 * Every operation first checks, before any network access, the configuration (the
 * credential's app must be INSTAGRAM_APP_ID), the credential shape, and that the requested
 * account is the one the token belongs to. Then (Stage B), with an explicit per-call
 * RequestBudget (capabilities.requestBudget, approved I-D6):
 *
 *   getAccount           2 requests: SDK profile + reader /me (account_type)
 *   listPosts            1 request per page (100 media, newest first)
 *   fetchPostMetrics     1 listing request (10 media) + 3 per post (SDK type + SDK
 *                        insights + reader views/total_interactions) <= 31; at most 3 in
 *                        flight; ends at the first post older than `publishedFrom`
 *   fetchAccountMetrics  2 requests per UTC day (request A + request B), 15 days per call
 *                        (30 <= 31); one record per requested day, also when empty
 *
 * Semantics and mapping: ../semantics.ts, ../mapping.ts. AD / STORY media are skipped
 * before any insights request; media without a product type (or timestamp), and posts
 * deleted between the listing and their insights (not_found), are counted `unresolved`.
 */

const CAPS = INSTAGRAM_CAPABILITIES;

/**
 * Runs `work` for every item with at most `limit` in flight (one `slot` per worker). After
 * the first failure no further item is started; the call waits for the requests already in
 * flight (nothing outlives the provider call) and then rejects with that first failure.
 */
async function pool<T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T, slot: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  let failure: { error: unknown } | undefined;
  const worker = async (slot: number) => {
    while (failure === undefined && next < items.length) {
      const index = next++;
      try {
        results[index] = await work(items[index]!, slot);
      } catch (error) {
        failure ??= { error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, (_, s) => worker(s)));
  if (failure !== undefined) throw failure.error;
  return results;
}

function dayStartMs(day: DateKey): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function paging(request: PageRequest) {
  return request.cursor !== undefined ? { cursor: request.cursor } : {};
}

export function createInstagramSocialProvider(options: { appId?: string }): SocialProvider {
  const reader = createInstagramGraphReader({ timeoutMs: SYNC_TIMEOUT_MS });

  const verify = (
    operation: ProviderOperation,
    ctx: ProviderContext,
    accountExternalId: string,
  ): InstagramCredential => {
    if (!isValidInstagramAppId(options.appId)) {
      throw instagramError(
        "unknown",
        operation,
        INSTAGRAM_CONFIG_INVALID,
        "Instagram app configuration is missing or invalid",
      );
    }
    if (!isInstagramCredential(ctx.credential)) {
      throw instagramError(
        "auth",
        operation,
        "credential_invalid",
        "Unusable Instagram credential",
      );
    }
    if (ctx.credential.appId !== options.appId) {
      throw instagramError(
        "auth",
        operation,
        "app_id_mismatch",
        "Instagram token was issued to a different app",
      );
    }
    if (!isInstagramId(accountExternalId)) {
      throw instagramError("invalid_request", operation, "account_invalid", "Invalid account id");
    }
    if (accountExternalId !== ctx.credential.userId) {
      throw instagramError(
        "permission",
        operation,
        "account_mismatch",
        "The token does not belong to this Instagram account",
      );
    }
    return ctx.credential;
  };

  const session = (credential: InstagramCredential, budget: RequestBudget) =>
    createInstagramSdkSession({ credential, budget, concurrency: 1 });

  return Object.freeze({
    platform: "instagram" as const,
    providerId: INSTAGRAM_PROVIDER_ID,
    capabilities: CAPS,

    async getAccount(ctx, request) {
      const operation = "getSocialAccount" as const;
      const credential = verify(operation, ctx, request.accountExternalId);
      const budget = new RequestBudget(2);
      const profile = await session(credential, budget).profile(operation);
      const identity = await reader.readIdentity(credential.accessToken, { operation, budget });
      if (identity.userId !== credential.userId) {
        throw instagramError(
          "permission",
          operation,
          "account_mismatch",
          "The token does not belong to this Instagram account",
        );
      }
      const record = mapProfile(profile, identity, credential.userId);
      assertValidSocialRecord("socialAccount", record, "instagram", operation);
      return record;
    },

    async listPosts(ctx, request) {
      const operation = "listSocialPosts" as const;
      const credential = verify(operation, ctx, request.accountExternalId);
      const page = await session(credential, new RequestBudget(1)).listMedia(operation, {
        limit: CAPS.defaultPageSize,
        ...paging(request),
      });
      const items: ProviderSocialPost[] = [];
      let unresolved = 0;
      for (const media of page.items) {
        const mapped = mapMedia(media, credential.userId);
        if (mapped.kind === "unresolved") unresolved++;
        if (mapped.kind !== "post") continue; // excluded (AD / STORY): never counted
        assertValidSocialRecord("socialPost", mapped.record, "instagram", operation);
        items.push(mapped.record);
      }
      return {
        items,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
        ...(unresolved > 0 ? { unresolved } : {}),
      };
    },

    async fetchPostMetrics(ctx, request) {
      const operation = "fetchPostMetrics" as const;
      const credential = verify(operation, ctx, request.accountExternalId);
      if (!isDateKey(request.publishedFrom)) {
        throw instagramError("invalid_request", operation, "window_invalid", "Invalid window");
      }
      const windowStart = dayStartMs(request.publishedFrom);
      const budget = new RequestBudget(CAPS.requestBudget.maxRequestsPerProviderCall);
      const page = await session(credential, budget).listMedia(operation, {
        limit: CAPS.postMetricsPageSize,
        ...paging(request),
      });

      const targets: InstagramMediaRead[] = [];
      let unresolved = 0;
      let reachedWindowEnd = false;
      for (const media of page.items) {
        const publishedAt = parseInstagramTimestamp(media.timestamp);
        if (publishedAt !== undefined && publishedAt < windowStart) {
          reachedWindowEnd = true; // newest first: everything after is older
          break;
        }
        const classified = classifyMedia(media);
        if (classified.kind === "excluded") continue; // never an insights request (F20, I-D14)
        if (classified.kind === "unresolved" || publishedAt === undefined) {
          unresolved++;
          continue;
        }
        targets.push(media);
      }

      // One SDK session per slot: failures are classified per post, the budget is shared.
      const slots = CAPS.requestBudget.maxConcurrentRequests;
      const sessions = Array.from({ length: slots }, () => session(credential, budget));
      const capturedAt = Date.now();
      const snapshots = await pool(targets, slots, async (media, slot) => {
        try {
          const sdk = await sessions[slot]!.postMetrics(operation, media.id);
          const values = await reader.readPostInsights(credential.accessToken, media.id, {
            operation,
            budget,
          });
          return mapPostSnapshot({
            operation,
            accountExternalId: credential.userId,
            postExternalId: media.id,
            capturedAt,
            sdk,
            reader: values,
          });
        } catch (error) {
          // Deleted since the listing: skip this post only (counted, never zero-filled).
          if (isProviderError(error) && error.kind === "not_found") return undefined;
          throw error;
        }
      });
      const items: ProviderSocialPostSnapshot[] = [];
      for (const snapshot of snapshots) {
        if (snapshot === undefined) {
          unresolved++;
          continue;
        }
        assertValidSocialRecord("socialPostSnapshot", snapshot, "instagram", operation);
        items.push(snapshot);
      }
      return {
        items,
        ...(!reachedWindowEnd && page.nextCursor !== undefined
          ? { nextCursor: page.nextCursor }
          : {}),
        ...(unresolved > 0 ? { unresolved } : {}),
      };
    },

    async fetchAccountMetrics(ctx, request) {
      const operation = "fetchAccountMetrics" as const;
      const credential = verify(operation, ctx, request.accountExternalId);
      const { from, to } = request;
      if (
        !isDateKey(from) ||
        !isDateKey(to) ||
        compareDateKeys(from, to) > 0 ||
        diffDays(from, to) + 1 > CAPS.maxAccountMetricsRangeDays
      ) {
        throw instagramError("invalid_request", operation, "window_invalid", "Invalid window");
      }
      const fp = instagramRequestFingerprint(operation, [credential.userId, from, to]);
      const start =
        request.cursor === undefined
          ? from
          : await decodeInstagramCursor(request.cursor, fp, operation);
      if (!isDateKey(start) || compareDateKeys(start, from) < 0 || compareDateKeys(start, to) > 0) {
        throw instagramError(
          "invalid_request",
          operation,
          "cursor_invalid",
          "Cursor is malformed or belongs to a different request.",
        );
      }
      const days = eachDay(start, to).slice(0, ACCOUNT_DAYS_PER_CALL);
      const budget = new RequestBudget(CAPS.requestBudget.maxRequestsPerProviderCall);
      const call = { operation, budget };
      const jobs = days.flatMap((day) => [
        { day, read: "insights" as const },
        { day, read: "follows" as const },
      ]);
      const results = await pool(jobs, CAPS.requestBudget.maxConcurrentRequests, (job) =>
        job.read === "insights"
          ? reader.readAccountInsights(credential.accessToken, credential.userId, job.day, call)
          : reader.readFollowBreakdown(credential.accessToken, credential.userId, job.day, call),
      );
      const items: ProviderSocialAccountDay[] = days.map((date, i) => {
        const record = mapAccountDay({
          operation,
          accountExternalId: credential.userId,
          date,
          insights: results[2 * i] ?? {},
          follows: results[2 * i + 1],
        });
        assertValidSocialRecord("socialAccountDay", record, "instagram", operation);
        return record;
      });
      const nextDay = addDays(days[days.length - 1]!, 1);
      return compareDateKeys(nextDay, to) <= 0
        ? { items, nextCursor: await encodeInstagramCursor(fp, operation, nextDay) }
        : { items };
    },
  } satisfies SocialProvider);
}
