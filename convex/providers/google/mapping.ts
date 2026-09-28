import { AD_METRICS, type AdMetricKey } from "../../domain/metrics";
import type { EntityLevel } from "../../domain/types";
import type {
  MetricsRequest,
  ProviderActionRow,
  ProviderAd,
  ProviderAdGroup,
  ProviderCampaign,
  ProviderCreative,
  ProviderMetricRow,
} from "../types";
import type { CarrySpec } from "./carry";
import type { GaqlQuery, GaqlResource } from "./gaql";
import {
  normalizeActionRow,
  normalizeAd,
  normalizeAdGroup,
  normalizeAssetGroup,
  normalizeCampaign,
  normalizeCreative,
  normalizeMetricRow,
} from "./normalize";
import {
  parseRaw,
  rawAdGroupAdRow,
  rawAdGroupRow,
  rawAssetGroupRow,
  rawCampaignRow,
  rawConversionActionRow,
  rawMetricRow,
} from "./schemas";
import {
  ACTION_METRICS,
  ASSET_GROUP_NETWORK_SEGMENTATION,
  PRIMARY_FLAG,
  WIDE_METRICS,
} from "./semantics";

/**
 * The semantic seam of the Google Ads provider (Phase 9).
 *
 * The provider engine (index.ts) owns plumbing: request validation, config and credential
 * checks, the per-call access token, the login-customer-id route, GAQL paging with provider
 * slicing, the lookup, the carry, cursors, error classification and record validation.
 * EVERYTHING semantic about structure, metrics and conversions lives here and in
 * normalize.ts / semantics.ts: which GAQL queries to run (stages) and how a result row
 * becomes a canonical record.
 *
 * Stage B status: implemented from the Google Ads API v25 reference and the canonical model.
 * The choices tagged [PROVISIONAL GRn] in semantics.ts are NOT verified against a real
 * account (docs/providers/google-ads.md, "Real-account validation required").
 *
 * An operation without a mapping entry fails CLOSED with ProviderError "unknown" /
 * "google_mapping_pending" before any network call — never "unsupported" (which would skip
 * the task and could advance coverage over missing data).
 */

export type GoogleEntityContext = { accountExternalId: string; stage: number };

export type GoogleEntityMapping<R> = {
  /** Ordered GAQL queries whose rows together form the listing (e.g. ad groups + asset groups). */
  stages(request: { accountExternalId: string }): GaqlQuery[];
  /** One result row → one record. Throwing makes the page a "data" error. */
  normalize(row: unknown, context: GoogleEntityContext): R;
};

/**
 * Per-request reference data read ONCE, on the first page of a request, before stage 0
 * (for action rows: each conversion action's primary_for_goal). The engine reads every
 * Google page of the lookup query (at most MAX_LOOKUP_ENTRIES rows, else it fails closed),
 * keeps id → flag in the request cursor and hands it to every normalizePage call.
 */
export type GoogleLookupSpec = {
  query: GaqlQuery;
  /** One lookup row → [id, flag]; a flag of undefined means "not reported" (not stored). */
  entry(row: unknown): [id: string, flag: boolean | undefined];
};

export type GoogleInsightsContext = {
  request: MetricsRequest;
  stage: number;
  /** The lookup result (empty without a lookup). */
  lookup: ReadonlyMap<string, boolean>;
};

export type GoogleInsightsMapping<R> = {
  /** Ordered GAQL queries that together answer ONE MetricsRequest. */
  stages(request: MetricsRequest): GaqlQuery[];
  lookup?: GoogleLookupSpec;
  /** One slice of result rows of one stage → one record per canonical key. */
  normalizePage(rows: unknown[], context: GoogleInsightsContext): R[];
  /** Records whose key can collect several rows are accumulated across pages (carry.ts). */
  carry: CarrySpec;
};

export type GoogleMapping = {
  campaigns?: GoogleEntityMapping<ProviderCampaign>;
  adGroups?: GoogleEntityMapping<ProviderAdGroup>;
  ads?: GoogleEntityMapping<ProviderAd>;
  creatives?: GoogleEntityMapping<ProviderCreative>;
  dailyMetrics?: GoogleInsightsMapping<ProviderMetricRow>;
  actionMetrics?: GoogleInsightsMapping<ProviderActionRow>;
};

export const GOOGLE_MAPPING_PENDING = "google_mapping_pending";

// ---------------------------------------------------------------------------
// Structure (no status filters: removed resources are listed, G-D14 / GR6)
// ---------------------------------------------------------------------------

const CAMPAIGN_QUERY: GaqlQuery = {
  from: "campaign",
  select: [
    "campaign.id",
    "campaign.name",
    "campaign.status",
    "campaign.serving_status",
    "campaign.advertising_channel_type",
    "campaign.bidding_strategy_type",
    "campaign.start_date_time",
    "campaign.end_date_time",
    "campaign.campaign_budget",
    "campaign_budget.id",
    "campaign_budget.period",
    "campaign_budget.amount_micros",
    "campaign_budget.total_amount_micros",
    "campaign_budget.explicitly_shared",
  ],
  orderBy: [{ field: "campaign.id" }],
};

const AD_GROUP_QUERY: GaqlQuery = {
  from: "ad_group",
  select: ["ad_group.id", "ad_group.name", "ad_group.status", "ad_group.type", "campaign.id"],
  orderBy: [{ field: "ad_group.id" }],
};

const ASSET_GROUP_QUERY: GaqlQuery = {
  from: "asset_group",
  select: ["asset_group.id", "asset_group.name", "asset_group.status", "campaign.id"],
  orderBy: [{ field: "asset_group.id" }],
};

const AD_ORDER = [{ field: "ad_group.id" }, { field: "ad_group_ad.ad.id" }] as const;

const AD_QUERY: GaqlQuery = {
  from: "ad_group_ad",
  select: [
    "ad_group.id",
    "ad_group_ad.ad.id",
    "campaign.id",
    "ad_group_ad.status",
    "ad_group_ad.ad.type",
    "ad_group_ad.ad.name",
  ],
  orderBy: AD_ORDER,
};

const CREATIVE_QUERY: GaqlQuery = {
  from: "ad_group_ad",
  select: [
    "ad_group.id",
    "ad_group_ad.ad.id",
    "ad_group_ad.ad.type",
    "ad_group_ad.ad.final_urls",
    "ad_group_ad.ad.responsive_search_ad.headlines",
    "ad_group_ad.ad.responsive_search_ad.descriptions",
    "ad_group_ad.ad.responsive_display_ad.headlines",
    "ad_group_ad.ad.responsive_display_ad.descriptions",
    "ad_group_ad.ad.responsive_display_ad.call_to_action_text",
  ],
  orderBy: AD_ORDER,
};

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/** The metric resource(s) of each level with their entity id fields. [doc] */
const LEVEL_RESOURCES: Record<EntityLevel, { from: GaqlResource; ids: string[] }[]> = {
  account: [{ from: "customer", ids: ["customer.id"] }],
  campaign: [{ from: "campaign", ids: ["campaign.id"] }],
  // Ad groups and Performance Max asset groups are both canonical ad groups. [GR10, GR20]
  ad_group: [
    { from: "ad_group", ids: ["ad_group.id"] },
    { from: "asset_group", ids: ["asset_group.id"] },
  ],
  ad: [{ from: "ad_group_ad", ids: ["ad_group.id", "ad_group_ad.ad.id"] }],
};

const NETWORK = "segments.ad_network_type";

/** Resources that are queried with the network segment (never asset groups, G-D12 / GR10). */
function segmentable(from: GaqlResource): boolean {
  return from !== "asset_group" || ASSET_GROUP_NETWORK_SEGMENTATION;
}

function levelQuery(
  request: MetricsRequest,
  spec: { from: GaqlResource; ids: string[] },
  segments: readonly string[],
  metrics: readonly string[],
): GaqlQuery {
  const select = [
    ...new Set([...spec.ids, "customer.id", "customer.currency_code", "segments.date"]),
    ...segments,
    ...metrics,
  ];
  return {
    from: spec.from,
    select,
    where: [{ field: "segments.date", op: "BETWEEN", from: request.from, to: request.to }],
    // Deterministic order over the row key: slicing offsets rely on it (G-D16).
    orderBy: [
      ...spec.ids,
      "segments.date",
      ...segments.filter((f) => f === "segments.conversion_action" || f === NETWORK),
    ].map((field) => ({ field })),
  };
}

/**
 * Stages of a metrics request: every level resource WITHOUT the network segment ("all"
 * rows), then — for the placement breakdown — every segmentable resource WITH it.
 */
function metricStages(
  request: MetricsRequest,
  segments: readonly string[],
  metrics: readonly string[],
): GaqlQuery[] {
  const resources = LEVEL_RESOURCES[request.level];
  const all = resources.map((spec) => levelQuery(request, spec, segments, metrics));
  if (request.breakdown === "none") return all;
  const byNetwork = resources
    .filter((spec) => segmentable(spec.from))
    .map((spec) => levelQuery(request, spec, [...segments, NETWORK], metrics));
  return [...all, ...byNetwork];
}

/** Stage index → does it carry the network segment? (all stages precede network stages) */
function isNetworkStage(request: MetricsRequest, stage: number): boolean {
  return stage >= LEVEL_RESOURCES[request.level].length;
}

const WIDE_METRIC_FIELDS = Object.values(WIDE_METRICS);
/** The action's identity is its resource name; the mutable display name is not read. */
const ACTION_SEGMENTS = ["segments.conversion_action", "segments.conversion_action_category"];
const ACTION_METRIC_FIELDS = Object.values(ACTION_METRICS);

/** Fields restored from the request when a carry is decoded (never stored in the cursor). */
const DERIVED = ["platform", "accountExternalId", "level"] as const;

/** Unmapped ad_network_type values all map to "other": accumulate across pages (GR11). */
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

/**
 * isPrimary source: every conversion action's primary_for_goal (semantics.ts; no status
 * filter, so removed actions keep their flag). Read once per request, all Google pages.
 */
const CONVERSION_ACTION_LOOKUP: GoogleLookupSpec = {
  query: {
    from: "conversion_action",
    select: ["conversion_action.id", PRIMARY_FLAG],
    orderBy: [{ field: "conversion_action.id" }],
  },
  entry: (row) => {
    const { conversionAction } = parseRaw(
      rawConversionActionRow,
      row,
      "fetchActionMetrics",
      "conversion action",
    );
    return [conversionAction.id, conversionAction.primaryForGoal];
  },
};

// ---------------------------------------------------------------------------
// The production mapping
// ---------------------------------------------------------------------------

/**
 * THE production Google mapping, imported directly by the engine (not injectable): the
 * provider factory takes no mapping option.
 */
export const GOOGLE_MAPPING: GoogleMapping = Object.freeze({
  campaigns: {
    stages: () => [CAMPAIGN_QUERY],
    normalize: (row, { accountExternalId }) =>
      normalizeCampaign(
        parseRaw(rawCampaignRow, row, "listCampaigns", "campaign"),
        accountExternalId,
      ),
  },
  adGroups: {
    stages: () => [AD_GROUP_QUERY, ASSET_GROUP_QUERY],
    normalize: (row, { accountExternalId, stage }) =>
      stage === 0
        ? normalizeAdGroup(
            parseRaw(rawAdGroupRow, row, "listAdGroups", "ad group"),
            accountExternalId,
          )
        : normalizeAssetGroup(
            parseRaw(rawAssetGroupRow, row, "listAdGroups", "asset group"),
            accountExternalId,
          ),
  },
  ads: {
    stages: () => [AD_QUERY],
    normalize: (row, { accountExternalId }) =>
      normalizeAd(parseRaw(rawAdGroupAdRow, row, "listAds", "ad"), accountExternalId),
  },
  creatives: {
    stages: () => [CREATIVE_QUERY],
    normalize: (row, { accountExternalId }) =>
      normalizeCreative(parseRaw(rawAdGroupAdRow, row, "listCreatives", "ad"), accountExternalId),
  },
  dailyMetrics: {
    stages: (request) => metricStages(request, [], WIDE_METRIC_FIELDS),
    normalizePage: (rows, { request, stage }) =>
      rows.map((row) =>
        normalizeMetricRow(
          parseRaw(rawMetricRow, row, "fetchDailyMetrics", "metric row"),
          request,
          isNetworkStage(request, stage),
        ),
      ),
    carry: METRIC_CARRY,
  },
  actionMetrics: {
    stages: (request) => metricStages(request, ACTION_SEGMENTS, ACTION_METRIC_FIELDS),
    lookup: CONVERSION_ACTION_LOOKUP,
    normalizePage: (rows, { request, stage, lookup }) =>
      rows.map((row) =>
        normalizeActionRow(
          parseRaw(rawMetricRow, row, "fetchActionMetrics", "conversion row"),
          request,
          isNetworkStage(request, stage),
          lookup,
        ),
      ),
    carry: ACTION_CARRY,
  },
} satisfies GoogleMapping);
