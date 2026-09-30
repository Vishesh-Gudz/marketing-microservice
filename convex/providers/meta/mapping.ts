import { AD_METRICS, type AdMetricKey } from "../../domain/metrics";
import { addDays, compareDateKeys, toDateKey } from "../../lib/dates";
import type {
  MetricsRequest,
  ProviderActionRow,
  ProviderAd,
  ProviderAdGroup,
  ProviderCampaign,
  ProviderCreative,
  ProviderMetricRow,
  ProviderOperation,
} from "../types";
import type { CarrySpec } from "./carry";
import {
  normalizeAd,
  normalizeAdSet,
  normalizeCampaign,
  normalizeCreative,
  normalizeInsightActions,
  normalizeInsightRow,
  type InsightsStage,
  type MetaAccountInfo,
} from "./normalize";
import { parseRaw, rawAd, rawAdSet, rawCampaign, rawCreative, rawInsight } from "./schemas";
import {
  ACTION_REPORT_TIME,
  ACTION_WINDOWS,
  EFFECTIVE_STATUSES,
  GRAPH_LEVEL,
  REACH_MAX_AGE_DAYS,
} from "./semantics";

/**
 * The semantic seam of the Meta provider (Phase 8).
 *
 * The provider engine (index.ts) owns plumbing: request validation, config and
 * credential checks, the account lookup, the request-bound (staged) cursor, Graph calls,
 * error classification, envelope validation and record validation. EVERYTHING
 * Meta-semantic about structure and metrics lives here and in normalize.ts /
 * semantics.ts: which edges, fields and filters to request, and how a raw object becomes
 * a canonical record.
 *
 * Stage B status: implemented from the Marketing API reference and the canonical model.
 * The choices tagged [PROVISIONAL] in semantics.ts are NOT verified against a real ad
 * account yet (docs/providers/meta.md, "Real-account validation required").
 *
 * An operation without a mapping entry fails CLOSED with ProviderError "unknown" /
 * "meta_mapping_pending_g1" before any network call — never "unsupported" (which would
 * skip the task and could advance coverage over missing data).
 */

export type MetaRequestPlan = {
  /** Graph path relative to the version, e.g. "act_123/campaigns". */
  path: string;
  /** Query parameters (the engine adds limit, after and appsecret_proof). */
  params: Record<string, string>;
};

export type MetaEntityContext = {
  accountExternalId: string;
  /** Present when the mapping declares `needsAccount` (fetched by the engine). */
  account?: MetaAccountInfo;
};

export type MetaEntityMapping<R> = {
  /** The engine reads the account's currency and time zone first (one extra GET). */
  needsAccount?: boolean;
  plan(request: { accountExternalId: string; updatedSince?: number }): MetaRequestPlan;
  /** One raw Graph object → one record. Throwing makes the page a "data" error. */
  normalize(raw: unknown, context: MetaEntityContext): R;
};

export type MetaInsightsContext = { request: MetricsRequest; stage: InsightsStage };

export type MetaInsightsMapping<R> = {
  /**
   * The ordered Graph requests ("stages") that together answer ONE MetricsRequest. The
   * engine pages through them in order; the cursor records the stage.
   */
  stages(request: MetricsRequest, now: number): MetaRequestPlan[];
  /** One page of raw rows of one stage → one record per raw row and canonical key. */
  normalizePage(rows: unknown[], context: MetaInsightsContext): R[];
  /**
   * Records whose canonical key can collect several raw rows (placement "other") are
   * accumulated by the engine across ALL Graph pages of the stage (carry.ts) and emitted
   * once complete; every other record is emitted with its page.
   */
  carry: CarrySpec;
};

export type MetaMapping = {
  campaigns?: MetaEntityMapping<ProviderCampaign>;
  adGroups?: MetaEntityMapping<ProviderAdGroup>;
  ads?: MetaEntityMapping<ProviderAd>;
  creatives?: MetaEntityMapping<ProviderCreative>;
  dailyMetrics?: MetaInsightsMapping<ProviderMetricRow>;
  actionMetrics?: MetaInsightsMapping<ProviderActionRow>;
};

export const META_MAPPING_PENDING = "meta_mapping_pending_g1";

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

const CAMPAIGN_FIELDS =
  "id,name,status,effective_status,objective,daily_budget,lifetime_budget,bid_strategy," +
  "start_time,stop_time,created_time,updated_time";
const ADSET_FIELDS =
  "id,name,campaign_id,status,effective_status,daily_budget,lifetime_budget," +
  "optimization_goal,attribution_spec,start_time,end_time";
const AD_FIELDS = "id,name,campaign_id,adset_id,status,effective_status,creative{id,object_type}";
const CREATIVE_FIELDS =
  "id,object_type,title,body,call_to_action_type,link_url,thumbnail_url,image_url,video_id," +
  "effective_object_story_id,effective_instagram_media_id";

function requireAccount(context: MetaEntityContext): MetaAccountInfo {
  if (context.account === undefined) throw new Error("account info missing");
  return context.account;
}

/** Full listings, including DELETED and ARCHIVED objects (semantics.ts R6). */
function listing(edge: string, fields: string, statuses?: readonly string[]) {
  return ({ accountExternalId }: { accountExternalId: string }): MetaRequestPlan => ({
    path: `act_${accountExternalId}/${edge}`,
    params: {
      fields,
      ...(statuses !== undefined ? { effective_status: JSON.stringify(statuses) } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/** Wide metric fields (reach is added on stage 0 only). [doc] */
const METRIC_FIELDS = [
  "spend",
  "impressions",
  "clicks",
  "inline_link_clicks",
  "actions",
  "action_values",
  "video_play_actions",
  "video_p100_watched_actions",
];
const ACTION_FIELDS = ["actions", "action_values"];

/** Id fields of a level (the entity's own id and its parents). */
const ID_FIELDS = {
  account: ["account_id"],
  campaign: ["account_id", "campaign_id"],
  ad_group: ["account_id", "campaign_id", "adset_id"],
  ad: ["account_id", "campaign_id", "adset_id", "ad_id"],
} as const;

const STATUS_FILTER = {
  campaign: EFFECTIVE_STATUSES.campaign,
  ad_group: EFFECTIVE_STATUSES.adset,
  ad: EFFECTIVE_STATUSES.ad,
} as const;

function insightsPlan(
  request: MetricsRequest,
  fields: readonly string[],
  extra: Record<string, string>,
): MetaRequestPlan {
  const graph = GRAPH_LEVEL[request.level];
  const filtering: Record<string, string> =
    request.level === "account" || graph.statusField === undefined
      ? {}
      : {
          filtering: JSON.stringify([
            { field: graph.statusField, operator: "IN", value: STATUS_FILTER[request.level] },
          ]),
        };
  return {
    path: `act_${request.accountExternalId}/insights`,
    params: {
      level: graph.level,
      time_range: JSON.stringify({ since: request.from, until: request.to }),
      time_increment: "1",
      action_report_time: ACTION_REPORT_TIME,
      fields: [
        "date_start",
        "date_stop",
        "account_currency",
        ...ID_FIELDS[request.level],
        ...fields,
      ].join(","),
      ...filtering,
      ...extra,
    },
  };
}

/** Stage 0 ("all") and, for the placement breakdown, stage 1 (publisher_platform). */
function staged(
  request: MetricsRequest,
  stage0: MetaRequestPlan,
  breakdownFields: readonly string[],
  extra: Record<string, string>,
): MetaRequestPlan[] {
  if (request.breakdown === "none") return [stage0];
  return [
    stage0,
    insightsPlan(request, breakdownFields, { ...extra, breakdowns: "publisher_platform" }),
  ];
}

/** Reach only for windows that start within the cutoff (semantics.ts R12). */
function reachAllowed(request: MetricsRequest, now: number): boolean {
  const cutoff = addDays(toDateKey(now, "UTC"), -REACH_MAX_AGE_DAYS);
  return compareDateKeys(request.from, cutoff) >= 0;
}

/** Wide metrics use each ad set's attribution setting (Ads Manager default, R15). */
const UNIFIED = { use_unified_attribution_setting: "true" };
/** Action rows use fixed attribution windows (R16). */
const WINDOWS = { action_attribution_windows: JSON.stringify(ACTION_WINDOWS) };

/** Fields restored from the request when a carry is decoded (never stored in the cursor). */
const DERIVED = ["platform", "accountExternalId", "level"] as const;

/** Unknown publisher_platform values all map to "other" (R9): accumulate across pages. */
const accumulatesOther = (record: Record<string, unknown>) => record.placement === "other";

const METRIC_CARRY: CarrySpec = {
  key: (r) => [r.entityExternalId, r.date, r.placement].join("|"),
  accumulates: accumulatesOther,
  additive: (Object.keys(AD_METRICS) as AdMetricKey[]).filter((k) => AD_METRICS[k].additive),
  bigints: ["spendMicros", "conversionValueMicros"],
  derived: DERIVED,
};

const ACTION_CARRY: CarrySpec = {
  key: (r) =>
    [r.entityExternalId, r.date, r.placement, r.rawActionType, r.attributionWindow].join("|"),
  accumulates: accumulatesOther,
  additive: ["count", "valueMicros"],
  bigints: ["valueMicros"],
  derived: DERIVED,
};

function insightRows(rows: unknown[], operation: ProviderOperation) {
  return rows.map((raw) => parseRaw(rawInsight, raw, operation, "insights row"));
}

// ---------------------------------------------------------------------------
// The production mapping
// ---------------------------------------------------------------------------

/**
 * THE production Meta mapping, imported directly by the provider engine (index.ts). It is
 * not injectable: the provider factory takes no mapping option.
 */
export const META_MAPPING: MetaMapping = Object.freeze({
  campaigns: {
    needsAccount: true,
    plan: listing("campaigns", CAMPAIGN_FIELDS, EFFECTIVE_STATUSES.campaign),
    normalize: (raw, context) =>
      normalizeCampaign(
        parseRaw(rawCampaign, raw, "listCampaigns", "campaign"),
        context.accountExternalId,
        requireAccount(context),
      ),
  },
  adGroups: {
    needsAccount: true,
    plan: listing("adsets", ADSET_FIELDS, EFFECTIVE_STATUSES.adset),
    normalize: (raw, context) =>
      normalizeAdSet(
        parseRaw(rawAdSet, raw, "listAdGroups", "ad set"),
        context.accountExternalId,
        requireAccount(context),
      ),
  },
  ads: {
    plan: listing("ads", AD_FIELDS, EFFECTIVE_STATUSES.ad),
    normalize: (raw, context) =>
      normalizeAd(parseRaw(rawAd, raw, "listAds", "ad"), context.accountExternalId),
  },
  creatives: {
    plan: listing("adcreatives", CREATIVE_FIELDS),
    normalize: (raw, context) =>
      normalizeCreative(
        parseRaw(rawCreative, raw, "listCreatives", "creative"),
        context.accountExternalId,
      ),
  },
  dailyMetrics: {
    stages: (request, now) =>
      staged(
        request,
        insightsPlan(
          request,
          reachAllowed(request, now) ? [...METRIC_FIELDS, "reach"] : METRIC_FIELDS,
          UNIFIED,
        ),
        METRIC_FIELDS,
        UNIFIED,
      ),
    normalizePage: (rows, { request, stage }) =>
      insightRows(rows, "fetchDailyMetrics").map((raw) => normalizeInsightRow(raw, request, stage)),
    carry: METRIC_CARRY,
  },
  actionMetrics: {
    stages: (request) =>
      staged(request, insightsPlan(request, ACTION_FIELDS, WINDOWS), ACTION_FIELDS, WINDOWS),
    normalizePage: (rows, { request, stage }) =>
      insightRows(rows, "fetchActionMetrics").flatMap((raw) =>
        normalizeInsightActions(raw, request, stage),
      ),
    carry: ACTION_CARRY,
  },
} satisfies MetaMapping);
