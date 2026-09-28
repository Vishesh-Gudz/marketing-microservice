import {
  googleAdExternalId,
  normalizeGoogleCustomerId,
  normalizeNumericId,
} from "../../domain/identity";
import type { AdAccountStatus, EntityLevel, Placement } from "../../domain/types";
import { isDateKey, type DateKey } from "../../lib/dates";
import { numberToMicros } from "../../lib/money";
import type {
  MetricsRequest,
  ProviderActionRow,
  ProviderAd,
  ProviderAdAccount,
  ProviderAdGroup,
  ProviderCampaign,
  ProviderCreative,
  ProviderMetricRow,
} from "../types";
import type {
  RawAdGroupAdRow,
  RawAdGroupRow,
  RawAssetGroupRow,
  RawCampaignRow,
  RawCustomerClientRow,
  RawCustomerRow,
  RawMetricRow,
} from "./schemas";
import {
  ACTION_CATEGORY,
  AD_FORMAT,
  adDisplayName,
  BUDGET_PERIOD,
  CHANNEL_TYPE,
  CONVERSION_ACTION_RESOURCE,
  DATE_TIME,
  ENTITY_STATUS,
  GOOGLE_ACTION_WINDOW,
  GOOGLE_ATTRIBUTION_BASIS,
  NETWORK_PLACEMENT,
  SERVING_STATUS,
} from "./semantics";

/**
 * Google → provider-record normalization (Phase 9). Stage A: customer (ad account) metadata
 * from documented `customer` / `customer_client` fields (G-D17). Stage B: campaigns, ad
 * groups, asset groups, ads, creatives, metric rows and conversion-action rows, using the
 * named definitions of semantics.ts ([doc] / [PROVISIONAL GRn]). Normalizers throw on
 * anything they cannot represent exactly; the engine turns that into a "data" error.
 */

/** Customer status enum [doc]. Unlisted values → "unknown" (never guessed). */
const CUSTOMER_STATUS: Readonly<Record<string, AdAccountStatus>> = {
  ENABLED: "active",
  CANCELED: "closed",
  CLOSED: "closed",
  SUSPENDED: "disabled",
};

type CustomerFields = {
  id: string;
  descriptiveName?: string;
  currencyCode: string;
  timeZone: string;
  manager?: boolean;
  status?: string;
  testAccount?: boolean;
};

function accountRecord(fields: CustomerFields, parentExternalId: string | undefined) {
  const externalId = normalizeGoogleCustomerId(fields.id);
  const name =
    fields.descriptiveName !== undefined && fields.descriptiveName.trim() !== ""
      ? fields.descriptiveName
      : `${externalId.slice(0, 3)}-${externalId.slice(3, 6)}-${externalId.slice(6)}`;
  return {
    platform: "google_ads" as const,
    externalId,
    name,
    currency: fields.currencyCode,
    timezone: fields.timeZone,
    status: (fields.status !== undefined ? CUSTOMER_STATUS[fields.status] : undefined) ?? "unknown",
    ...(fields.status !== undefined ? { rawStatus: fields.status } : {}),
    // proto3 JSON omits `false`: absent means not a manager / not a test account.
    isManager: fields.manager === true,
    ...(parentExternalId !== undefined
      ? { parentExternalId: normalizeGoogleCustomerId(parentExternalId) }
      : {}),
    ...(fields.testAccount === true ? { attributes: { testAccount: "true" } } : {}),
  } satisfies ProviderAdAccount;
}

/** A directly accessible customer (`FROM customer`): no routing manager. */
export function normalizeCustomer(raw: RawCustomerRow): ProviderAdAccount {
  return accountRecord(raw.customer, undefined);
}

/** A customer reached through a manager's hierarchy (`FROM customer_client`). */
export function normalizeCustomerClient(
  raw: RawCustomerClientRow,
  routingManager: string,
): ProviderAdAccount {
  return accountRecord(raw.customerClient, routingManager);
}

/** "customers/1234567890" → "1234567890"; anything else throws. */
export function customerIdFromResourceName(resourceName: string): string {
  const match = /^customers\/(\d{10})$/.exec(resourceName);
  if (!match) throw new Error("unexpected customer resource name");
  return match[1]!;
}

// ---------------------------------------------------------------------------
// Stage B helpers (proto3 JSON: int64 as strings, doubles as numbers)
// ---------------------------------------------------------------------------

const UNSIGNED = /^\d{1,19}$/;

/** int64 count → number (exact; beyond 2^53 cannot be represented). */
function int64Count(value: string | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!UNSIGNED.test(value)) throw new Error(`${label} is not an unsigned int64`);
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`${label} exceeds 2^53`);
  return n;
}

/** int64 micros → bigint (exact). */
function int64Micros(value: string | undefined, label: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (!UNSIGNED.test(value)) throw new Error(`${label} is not an unsigned int64`);
  return BigInt(value);
}

function finite(value: number | undefined, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value)) throw new Error(`${label} is not finite`);
  return value;
}

function required(value: string | undefined, label: string): string {
  if (value === undefined || value.trim() === "") throw new Error(`${label} is missing`);
  return value;
}

/** Drops undefined-valued keys (absent stays absent). */
function compact<T extends Record<string, unknown>>(record: T): T {
  return Object.fromEntries(Object.entries(record).filter(([, v]) => v !== undefined)) as T;
}

function status(raw: string | undefined) {
  return {
    status: (raw !== undefined ? ENTITY_STATUS[raw] : undefined) ?? ("unknown" as const),
    ...(raw !== undefined ? { rawStatus: raw } : {}),
  };
}

/** "yyyy-MM-dd HH:mm:ss" (customer time zone) → the account-local day. */
function localDay(value: string | undefined, label: string): DateKey | undefined {
  if (value === undefined || value === "") return undefined;
  const match = DATE_TIME.exec(value);
  if (!match || !isDateKey(match[1])) throw new Error(`${label} is not "yyyy-MM-dd HH:mm:ss"`);
  return match[1];
}

function attributes(values: Record<string, string | undefined>) {
  const kept = Object.entries(values).filter(
    (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== "",
  );
  return kept.length > 0 ? { attributes: Object.fromEntries(kept) } : {};
}

function texts(assets: { text?: string }[] | undefined): string[] | undefined {
  const list = (assets ?? []).map((a) => a.text).filter((t): t is string => !!t && t !== "");
  return list.length > 0 ? list : undefined;
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

/** FROM campaign (+ attributed campaign_budget). */
export function normalizeCampaign(
  raw: RawCampaignRow,
  accountExternalId: string,
): ProviderCampaign {
  const c = raw.campaign;
  const budget = raw.campaignBudget;
  let budgetFields: Pick<ProviderCampaign, "budgetType" | "budgetMicros" | "isSharedBudget">;
  if (budget === undefined) {
    if (c.campaignBudget !== undefined && c.campaignBudget !== "") {
      throw new Error("campaign budget reference without budget fields");
    }
    budgetFields = { budgetType: "none" };
  } else {
    const period = budget.period !== undefined ? BUDGET_PERIOD[budget.period] : undefined;
    if (period === undefined) throw new Error("campaign budget period cannot be classified");
    budgetFields = compact({
      budgetType: period.budgetType,
      budgetMicros: int64Micros(budget[period.amountField], "campaign budget amount"),
      isSharedBudget: budget.explicitlyShared,
    });
  }
  const channel =
    c.advertisingChannelType !== undefined && c.advertisingChannelType !== "UNSPECIFIED"
      ? (CHANNEL_TYPE[c.advertisingChannelType] ?? "other")
      : undefined;
  const bidStrategy =
    c.biddingStrategyType !== undefined &&
    c.biddingStrategyType !== "UNSPECIFIED" &&
    c.biddingStrategyType !== "UNKNOWN"
      ? c.biddingStrategyType
      : undefined;
  return compact({
    platform: "google_ads" as const,
    accountExternalId,
    externalId: normalizeNumericId(c.id, "campaign id"),
    name: required(c.name, "campaign name"),
    ...status(c.status),
    deliveryStatus:
      c.servingStatus !== undefined ? (SERVING_STATUS[c.servingStatus] ?? "unknown") : undefined,
    objective: "unknown" as const,
    channelType: channel,
    ...budgetFields,
    budgetLevel: "campaign" as const,
    bidStrategy,
    startDate: localDay(c.startDateTime, "campaign start_date_time"),
    endDate: localDay(c.endDateTime, "campaign end_date_time"),
    ...attributes({
      advertisingChannelType: c.advertisingChannelType,
      campaignBudgetId:
        budget?.id !== undefined ? normalizeNumericId(budget.id, "campaign budget id") : undefined,
      budgetPeriod: budget?.period,
    }),
  } satisfies ProviderCampaign);
}

/** FROM ad_group (kind "ad_group"). */
export function normalizeAdGroup(raw: RawAdGroupRow, accountExternalId: string): ProviderAdGroup {
  const g = raw.adGroup;
  return compact({
    platform: "google_ads" as const,
    accountExternalId,
    campaignExternalId: normalizeNumericId(raw.campaign.id, "campaign id"),
    externalId: normalizeNumericId(g.id, "ad group id"),
    name: required(g.name, "ad group name"),
    kind: "ad_group" as const,
    ...status(g.status),
    ...attributes({ adGroupType: g.type }),
  } satisfies ProviderAdGroup);
}

/** FROM asset_group (Performance Max; kind "asset_group"). [PROVISIONAL GR10, GR20] */
export function normalizeAssetGroup(
  raw: RawAssetGroupRow,
  accountExternalId: string,
): ProviderAdGroup {
  const g = raw.assetGroup;
  return compact({
    platform: "google_ads" as const,
    accountExternalId,
    campaignExternalId: normalizeNumericId(raw.campaign.id, "campaign id"),
    externalId: normalizeNumericId(g.id, "asset group id"),
    name: required(g.name, "asset group name"),
    kind: "asset_group" as const,
    ...status(g.status),
  } satisfies ProviderAdGroup);
}

function adFormat(type: string | undefined) {
  return type !== undefined ? (AD_FORMAT[type] ?? "other") : undefined;
}

/**
 * FROM ad_group_ad. The canonical id is "{adGroupId}~{adId}" [doc: ad ids are unique within
 * their ad group; canonical model]; Google ads embed their creative, so each ad has exactly
 * one creative with the SAME external id (no duplicate creative records).
 */
export function normalizeAd(raw: RawAdGroupAdRow, accountExternalId: string): ProviderAd {
  const ad = raw.adGroupAd.ad;
  const adId = normalizeNumericId(ad.id, "ad id");
  const id = googleAdExternalId(raw.adGroup.id, adId);
  if (raw.campaign === undefined) throw new Error("ad row without campaign");
  return compact({
    platform: "google_ads" as const,
    accountExternalId,
    campaignExternalId: normalizeNumericId(raw.campaign.id, "campaign id"),
    adGroupExternalId: normalizeNumericId(raw.adGroup.id, "ad group id"),
    externalId: id,
    creativeExternalId: id,
    name: ad.name !== undefined && ad.name.trim() !== "" ? ad.name : adDisplayName(adId),
    ...status(raw.adGroupAd.status),
    format: adFormat(ad.type),
    ...attributes({ adType: ad.type }),
  } satisfies ProviderAd);
}

/** FROM ad_group_ad (creative fields of the embedded ad). */
export function normalizeCreative(
  raw: RawAdGroupAdRow,
  accountExternalId: string,
): ProviderCreative {
  const ad = raw.adGroupAd.ad;
  const rsa = ad.responsiveSearchAd;
  const rda = ad.responsiveDisplayAd;
  return compact({
    platform: "google_ads" as const,
    accountExternalId,
    externalId: googleAdExternalId(raw.adGroup.id, normalizeNumericId(ad.id, "ad id")),
    format: adFormat(ad.type) ?? "other",
    headlines: texts(rsa?.headlines) ?? texts(rda?.headlines),
    descriptions: texts(rsa?.descriptions) ?? texts(rda?.descriptions),
    callToAction: rda?.callToActionText !== "" ? rda?.callToActionText : undefined,
    linkUrl: ad.finalUrls?.[0],
    ...attributes({ adType: ad.type }),
  } satisfies ProviderCreative);
}

// ---------------------------------------------------------------------------
// Metric and conversion-action rows
// ---------------------------------------------------------------------------

/** The entity a row describes at the requested level (checked against the account). */
export function rowEntity(raw: RawMetricRow, request: MetricsRequest): string {
  if (raw.customer.id !== undefined && raw.customer.id !== request.accountExternalId) {
    throw new Error("row of another customer");
  }
  const level: EntityLevel = request.level;
  switch (level) {
    case "account":
      return request.accountExternalId;
    case "campaign":
      return normalizeNumericId(required(raw.campaign?.id, "campaign id"), "campaign id");
    case "ad_group": {
      const id = raw.adGroup?.id ?? raw.assetGroup?.id;
      return normalizeNumericId(required(id, "ad group id"), "ad group id");
    }
    case "ad":
      return googleAdExternalId(
        required(raw.adGroup?.id, "ad group id"),
        required(raw.adGroupAd?.ad.id, "ad id"),
      );
  }
}

/** Placement of a row: "all" without a network segment, else the mapped network. */
function placementOf(
  raw: RawMetricRow,
  segmented: boolean,
): { placement: Placement; rawPlacement?: string } {
  if (!segmented) return { placement: "all" };
  const network = raw.segments.adNetworkType ?? "UNSPECIFIED";
  return { placement: NETWORK_PLACEMENT[network] ?? "other", rawPlacement: network };
}

function dimensions(raw: RawMetricRow, request: MetricsRequest, segmented: boolean) {
  if (!isDateKey(raw.segments.date)) throw new Error("segments.date is not YYYY-MM-DD");
  return {
    platform: "google_ads" as const,
    accountExternalId: request.accountExternalId,
    level: request.level,
    entityExternalId: rowEntity(raw, request),
    date: raw.segments.date,
    ...placementOf(raw, segmented),
    currency: raw.customer.currencyCode,
  };
}

/** One wide metric row. Absent metrics stay absent; an explicit 0 stays 0 (G-D13). */
export function normalizeMetricRow(
  raw: RawMetricRow,
  request: MetricsRequest,
  segmented: boolean,
): ProviderMetricRow {
  const m = raw.metrics ?? {};
  const conversionsValue = finite(m.conversionsValue, "conversions_value");
  return compact({
    ...dimensions(raw, request, segmented),
    spendMicros: int64Micros(m.costMicros, "cost_micros"),
    impressions: int64Count(m.impressions, "impressions"),
    clicks: int64Count(m.clicks, "clicks"),
    conversions: finite(m.conversions, "conversions"),
    conversionValueMicros:
      conversionsValue !== undefined ? numberToMicros(conversionsValue) : undefined,
    allConversions: finite(m.allConversions, "all_conversions"),
  } satisfies ProviderMetricRow);
}

/** segments.conversion_action (a resource name) → [resource name, conversion action id]. */
export function conversionActionIdentity(resourceName: string | undefined): [string, string] {
  const match = CONVERSION_ACTION_RESOURCE.exec(resourceName ?? "");
  if (!match) throw new Error("unexpected conversion action resource name");
  return [resourceName!, match[1]!];
}

/**
 * One conversion-action row (semantics.ts): identity = the action's resource name
 * (rawActionType) and id; count = all_conversions of the action, valueMicros =
 * all_conversions_value; isPrimary = the action's primary_for_goal when known; the window is
 * the "action_setting" bucket.
 */
export function normalizeActionRow(
  raw: RawMetricRow,
  request: MetricsRequest,
  segmented: boolean,
  primaryForGoal: ReadonlyMap<string, boolean>,
): ProviderActionRow {
  const [resourceName, actionId] = conversionActionIdentity(raw.segments.conversionAction);
  const count = finite(raw.metrics?.allConversions, "all_conversions");
  if (count === undefined) throw new Error("conversion action row without all_conversions");
  const value = finite(raw.metrics?.allConversionsValue, "all_conversions_value");
  const category = raw.segments.conversionActionCategory;
  return compact({
    ...dimensions(raw, request, segmented),
    actionType: (category !== undefined ? ACTION_CATEGORY[category] : undefined) ?? "other",
    rawActionType: resourceName,
    conversionActionExternalId: actionId,
    attributionWindow: GOOGLE_ACTION_WINDOW,
    attributionBasis: GOOGLE_ATTRIBUTION_BASIS,
    count,
    valueMicros: value !== undefined ? numberToMicros(value) : undefined,
    isPrimary: primaryForGoal.get(actionId),
  } satisfies ProviderActionRow);
}
