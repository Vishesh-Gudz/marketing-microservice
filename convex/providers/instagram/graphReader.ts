import type { SocialAccountType } from "../../domain/types";
import { addDays, type DateKey } from "../../lib/dates";
import type { ProviderOperation } from "../types";
import { GRAPH_ORIGIN, INSTAGRAM_GRAPH_VERSION, isInstagramId } from "./config";
import { classifyInstagramFailure, instagramError, instagramProviderError } from "./errors";
import {
  ACCOUNT_INSIGHT_METRICS,
  FOLLOW_TYPE_BREAKDOWN,
  FOLLOWS_METRIC,
  READER_POST_METRICS,
} from "./semantics";
import { canonicalId, mapAccountType, parseRaw, rawIdentity, rawInsights } from "./schemas";
import { READER_IDENTITY_FIELDS, sendInstagram, type RequestBudget } from "./transport";

/**
 * The MINIMAL direct Instagram Graph reader (Phase 10, I-D3 option B). It exists only for
 * documented social-sdk gaps and is NOT a generic Graph client:
 * - read-only GETs on graph.instagram.com/v25.0, on the "graph_reader" allowlist of
 *   transport.ts (any other URL, method, parameter or secret-in-URL is refused before the
 *   network);
 * - the token travels only in the Authorization header;
 * - every call spends from an explicit RequestBudget;
 * - responses are shape-validated and reduced to our own types here; raw Graph payloads
 *   never leave this module; failures are classified ProviderErrors (errors.ts).
 *
 * Reads (Stage A: identity; Stage B: insights, with the exact request shapes of R2):
 * - readIdentity         /me?fields=user_id,username,account_type
 * - readPostInsights     /{media-id}/insights?metric=views,total_interactions&period=lifetime
 * - readAccountInsights  /{ig-id}/insights?metric=<account set>&period=day
 *                          &metric_type=total_value&since=<D 00:00Z>&until=<D+1 00:00Z>
 * - readFollowBreakdown  the same day window, metric=follows_and_unfollows
 *                          &breakdown=follow_type
 * Insight values are returned under Instagram's metric names; a metric Instagram does not
 * report is simply absent ([doc] "empty data set instead of 0"). Mapping is ./mapping.ts.
 */

export type InstagramIdentity = {
  /** Instagram professional account id (`/me.user_id`). */
  userId: string;
  username?: string;
  /** I-D16: business | creator; any other platform value failed closed. */
  accountType: SocialAccountType;
};

export type ReaderCall = {
  operation: ProviderOperation;
  /** D28b stage prefix of providerCode (OAuth callback), e.g. "identity". */
  stage?: string;
  budget: RequestBudget;
};

const USERNAME = /^[A-Za-z0-9._]{1,30}$/;

/** Unix seconds of a UTC day's midnight. */
function utcMidnightSeconds(day: DateKey): number {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 1000;
}

/**
 * [doc][F2] The window of ONE UTC day: since = D 00:00Z, until = D+1 00:00Z. Meta documents
 * since/until as inclusive; how Instagram assigns a total_value day to this window is
 * [PROVISIONAL IR6].
 */
export function utcDayWindow(day: DateKey): { since: string; until: string } {
  return {
    since: String(utcMidnightSeconds(day)),
    until: String(utcMidnightSeconds(addDays(day, 1))),
  };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

type Entry = Record<string, unknown>;

/**
 * The `data` entries of an insights response, keyed by metric name. Every entry must name a
 * REQUESTED metric, at most once; anything else is a data error (fail closed).
 */
function insightEntries(
  body: unknown,
  requested: ReadonlySet<string>,
  operation: ProviderOperation,
): Map<string, Entry> {
  const raw = parseRaw(rawInsights, body, operation, "insights");
  const entries = new Map<string, Entry>();
  for (const item of raw.data) {
    const entry = item as Entry | null;
    const name = entry === null || typeof entry !== "object" ? undefined : entry["name"];
    if (typeof name !== "string" || !requested.has(name) || entries.has(name)) {
      throw instagramError("data", operation, "insights_unexpected", "Unexpected insight");
    }
    entries.set(name, entry!);
  }
  return entries;
}

function invalidValue(operation: ProviderOperation): never {
  throw instagramError("data", operation, "insights_invalid", "Invalid insight value");
}

/** total_value.value of an entry (absent -> undefined; malformed -> data error). */
function totalValue(entry: Entry, operation: ProviderOperation): number | undefined {
  const total = entry["total_value"];
  if (total === undefined) return undefined;
  if (total === null || typeof total !== "object") invalidValue(operation);
  const value = (total as Entry)["value"];
  if (value === undefined) return undefined;
  return isCount(value) ? value : invalidValue(operation);
}

/** [doc] Lifetime media insights: values[0].value (total_value.value is also documented). */
function lifetimeValue(entry: Entry, operation: ProviderOperation): number | undefined {
  const values = entry["values"];
  if (values !== undefined) {
    if (!Array.isArray(values) || values.length > 1) invalidValue(operation);
    const first = values[0] as Entry | undefined;
    if (first === undefined) return undefined;
    if (first === null || typeof first !== "object") invalidValue(operation);
    const value = first["value"];
    if (value === undefined) return undefined;
    return isCount(value) ? value : invalidValue(operation);
  }
  return totalValue(entry, operation);
}

/** [doc] total_value.breakdowns[{dimension_keys:[key], results:[{dimension_values, value}]}]. */
function breakdownValues(
  entry: Entry,
  key: string,
  operation: ProviderOperation,
): Record<string, number> | undefined {
  const total = entry["total_value"];
  if (total === undefined) return undefined;
  if (total === null || typeof total !== "object") invalidValue(operation);
  const breakdowns = (total as Entry)["breakdowns"];
  if (breakdowns === undefined) return undefined;
  if (!Array.isArray(breakdowns) || breakdowns.length !== 1) invalidValue(operation);
  const breakdown = breakdowns[0] as Entry | null;
  if (breakdown === null || typeof breakdown !== "object") invalidValue(operation);
  const keys = breakdown["dimension_keys"];
  if (!Array.isArray(keys) || keys.length !== 1 || keys[0] !== key) invalidValue(operation);
  const results = breakdown["results"];
  if (!Array.isArray(results) || results.length > 16) invalidValue(operation);
  const values: Record<string, number> = {};
  for (const item of results) {
    const result = item as Entry | null;
    if (result === null || typeof result !== "object") invalidValue(operation);
    const dimension = result["dimension_values"];
    const value = result["value"];
    if (
      !Array.isArray(dimension) ||
      dimension.length !== 1 ||
      typeof dimension[0] !== "string" ||
      !/^[A-Z_]{1,32}$/.test(dimension[0]) ||
      dimension[0] in values ||
      !isCount(value)
    ) {
      invalidValue(operation);
    }
    values[dimension[0]] = value;
  }
  return values;
}

const POST_METRICS = new Set(READER_POST_METRICS);
const ACCOUNT_METRICS = new Set(ACCOUNT_INSIGHT_METRICS);
const FOLLOWS = new Set([FOLLOWS_METRIC]);

export function createInstagramGraphReader(options: { timeoutMs: number }) {
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

  function insightsUrl(id: string, params: Record<string, string>, call: ReaderCall): URL {
    if (!isInstagramId(id)) {
      throw instagramError("invalid_request", call.operation, "id_invalid", "Invalid id");
    }
    const url = new URL(`${GRAPH_ORIGIN}/${INSTAGRAM_GRAPH_VERSION}/${id}/insights`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return url;
  }

  return Object.freeze({
    /** GET /v25.0/me?fields=user_id,username,account_type */
    async readIdentity(accessToken: string, call: ReaderCall): Promise<InstagramIdentity> {
      const url = new URL(`${GRAPH_ORIGIN}/${INSTAGRAM_GRAPH_VERSION}/me`);
      url.searchParams.set("fields", READER_IDENTITY_FIELDS);
      const body = await get(url, accessToken, call);
      const raw = parseRaw(rawIdentity, body, call.operation, "identity", call.stage);
      const userId = canonicalId(raw.user_id);
      if (userId === undefined) {
        throw instagramError(
          "data",
          call.operation,
          call.stage ? `${call.stage}:identity_invalid` : "identity_invalid",
          "Unexpected Instagram account identity",
        );
      }
      const accountType = mapAccountType(raw.account_type);
      if (accountType === undefined) {
        throw instagramError(
          "permission",
          call.operation,
          call.stage ? `${call.stage}:account_type_unsupported` : "account_type_unsupported",
          "Only Instagram business and creator accounts are supported",
        );
      }
      const username =
        raw.username !== undefined && USERNAME.test(raw.username) ? raw.username : undefined;
      return { userId, ...(username !== undefined ? { username } : {}), accountType };
    },

    /** [doc] Lifetime `views` / `total_interactions` of one media item (1 request). */
    async readPostInsights(
      accessToken: string,
      mediaId: string,
      call: ReaderCall,
    ): Promise<Record<string, number>> {
      const url = insightsUrl(
        mediaId,
        {
          metric: READER_POST_METRICS.join(","),
          period: "lifetime",
        },
        call,
      );
      const entries = insightEntries(
        await get(url, accessToken, call),
        POST_METRICS,
        call.operation,
      );
      const values: Record<string, number> = {};
      for (const [name, entry] of entries) {
        const value = lifetimeValue(entry, call.operation);
        if (value !== undefined) values[name] = value;
      }
      return values;
    },

    /** [doc][F2] Request A: the day totals of the account insight set (1 request). */
    async readAccountInsights(
      accessToken: string,
      userId: string,
      day: DateKey,
      call: ReaderCall,
    ): Promise<Record<string, number>> {
      const url = insightsUrl(
        userId,
        {
          metric: ACCOUNT_INSIGHT_METRICS.join(","),
          period: "day",
          metric_type: "total_value",
          ...utcDayWindow(day),
        },
        call,
      );
      const entries = insightEntries(
        await get(url, accessToken, call),
        ACCOUNT_METRICS,
        call.operation,
      );
      const values: Record<string, number> = {};
      for (const [name, entry] of entries) {
        const value = totalValue(entry, call.operation);
        if (value !== undefined) values[name] = value;
      }
      return values;
    },

    /**
     * [doc][F3] Request B: follows_and_unfollows by follow_type for one day (1 request).
     * Undefined when not reported ([doc] never under 100 followers).
     */
    async readFollowBreakdown(
      accessToken: string,
      userId: string,
      day: DateKey,
      call: ReaderCall,
    ): Promise<Record<string, number> | undefined> {
      const url = insightsUrl(
        userId,
        {
          metric: FOLLOWS_METRIC,
          period: "day",
          metric_type: "total_value",
          breakdown: FOLLOW_TYPE_BREAKDOWN,
          ...utcDayWindow(day),
        },
        call,
      );
      const entry = insightEntries(await get(url, accessToken, call), FOLLOWS, call.operation).get(
        FOLLOWS_METRIC,
      );
      return entry === undefined
        ? undefined
        : breakdownValues(entry, FOLLOW_TYPE_BREAKDOWN, call.operation);
    },
  });
}

export type InstagramGraphReader = ReturnType<typeof createInstagramGraphReader>;
