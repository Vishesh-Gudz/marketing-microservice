import {
  googleAdExternalId,
  normalizeGoogleCustomerId,
  normalizeNumericId,
} from "../../domain/identity";
import type {
  ActionType,
  AdAccountStatus,
  ChannelType,
  CreativeFormat,
  DeliveryStatus,
  EntityStatus,
  Placement,
} from "../../domain/types";
import type { DateKey } from "../../lib/dates";
import { currencyMinorUnits, numberToMicros } from "../../lib/money";
import type { AdsProviderCapabilities } from "../capabilities";
import type {
  ProviderActionRow,
  ProviderAd,
  ProviderAdAccount,
  ProviderAdGroup,
  ProviderCampaign,
  ProviderCreative,
  ProviderMetricRow,
} from "../types";
import {
  bySortKey,
  compact,
  toCount,
  type MockAccountInfo,
  type MockFlavor,
  type RawEntry,
} from "./flavor";
import {
  randomInt,
  toMinorUnitMicros,
  type LeafGenerator,
  type LeafSpec,
  type NeutralMetrics,
  type NeutralRow,
} from "./generator";

// Google-Ads-like mock. Raw payloads mimic REST/GAQL result rows: camelCase
// resources, int64 values as strings (costMicros, amountMicros), doubles for
// conversions/conversion values, segments.date / segments.adNetworkType,
// ad ids unique only within an ad group, asset groups for Performance Max.

// ---------------------------------------------------------------------------
// Raw shapes
// ---------------------------------------------------------------------------

type GoogleRawCustomer = {
  /** UI-style dashed id, exercising canonical normalization. */
  id: string;
  descriptiveName: string;
  currencyCode: string;
  timeZone: string;
  status: string;
  manager: boolean;
  managerCustomerId?: string;
};
type GoogleRawCampaign = {
  customerId: string;
  campaign: {
    id: string;
    name: string;
    status: string;
    servingStatus: string;
    advertisingChannelType: string;
    biddingStrategyType: string;
    startDate: string;
    endDate: string;
  };
  campaignBudget: { amountMicros: string; explicitlyShared: boolean };
};
type GoogleRawAdGroup = {
  customerId: string;
  campaign: { id: string };
  adGroup?: { id: string; name: string; status: string; type: string };
  assetGroup?: { id: string; name: string; status: string };
};
type GoogleRawAd = {
  customerId: string;
  campaign: { id: string };
  adGroup: { id: string };
  adGroupAd: {
    status: string;
    ad: {
      id: string;
      name?: string;
      type: string;
      finalUrls: string[];
      responsiveSearchAd?: { headlines: { text: string }[]; descriptions: { text: string }[] };
    };
  };
};
type GoogleRawMetricRow = {
  customer: { id: string };
  campaign?: { id: string };
  adGroup?: { id: string };
  assetGroup?: { id: string };
  adGroupAd?: { ad: { id: string }; adGroupId: string };
  segments: {
    date: string;
    adNetworkType?: string;
    conversionAction?: string;
    conversionActionName?: string;
    conversionActionCategory?: string;
  };
  metrics: {
    costMicros: string;
    impressions: string;
    clicks: string;
    conversions: number;
    conversionsValue: number;
    allConversions: number;
    allConversionsValue?: number;
  };
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Google's "no end date" sentinel. */
const NO_END_DATE = "2037-12-30";

const CUSTOMERS: GoogleRawCustomer[] = [
  {
    id: "111-222-3333",
    descriptiveName: "Acme Search US",
    currencyCode: "USD",
    timeZone: "America/Los_Angeles",
    status: "ENABLED",
    manager: false,
    managerCustomerId: "999-000-1111",
  },
  {
    id: "444-555-6666",
    descriptiveName: "Acme Japan",
    currencyCode: "JPY",
    timeZone: "Asia/Tokyo",
    status: "ENABLED",
    manager: false,
    managerCustomerId: "999-000-1111",
  },
  {
    id: "999-000-1111",
    descriptiveName: "Acme MCC",
    currencyCode: "USD",
    timeZone: "America/Los_Angeles",
    status: "ENABLED",
    manager: true,
  },
  {
    id: "777-888-9999",
    descriptiveName: "Closed test account",
    currencyCode: "EUR",
    timeZone: "Europe/Dublin",
    status: "CANCELED",
    manager: false,
  },
];

/** Conversion actions per customer (primary_for_goal decides the wide `conversions` column). */
const CONVERSION_ACTIONS = [
  { id: "555", name: "Purchase", category: "PURCHASE", primary: true },
  { id: "556", name: "Newsletter signup", category: "SIGNUP", primary: false },
] as const;
const CONVERSION_WINDOW = "30d_click";

type GoogleTree = {
  campaigns: GoogleRawCampaign[];
  adGroups: GoogleRawAdGroup[];
  ads: GoogleRawAd[];
  delivery: Record<string, { from: DateKey; to?: DateKey }>;
  adGroupDeliveryTo: Record<string, DateKey>;
  cpcMicros: bigint;
  aovMicros: bigint;
};

function campaign(
  customerId: string,
  id: string,
  name: string,
  status: string,
  servingStatus: string,
  channel: string,
  bidding: string,
  budgetMicros: string,
  startDate: string,
  endDate = NO_END_DATE,
  shared = false,
): GoogleRawCampaign {
  return {
    customerId,
    campaign: {
      id,
      name,
      status,
      servingStatus,
      advertisingChannelType: channel,
      biddingStrategyType: bidding,
      startDate,
      endDate,
    },
    campaignBudget: { amountMicros: budgetMicros, explicitlyShared: shared },
  };
}

function rsa(
  customerId: string,
  campaignId: string,
  adGroupId: string,
  adId: string,
  status: string,
): GoogleRawAd {
  return {
    customerId,
    campaign: { id: campaignId },
    adGroup: { id: adGroupId },
    adGroupAd: {
      status,
      ad: {
        id: adId,
        type: "RESPONSIVE_SEARCH_AD",
        finalUrls: ["https://shop.example.test/"],
        responsiveSearchAd: {
          headlines: [{ text: "Acme Official Store" }, { text: "Free Shipping Today" }],
          descriptions: [{ text: "Shop the full range online." }],
        },
      },
    },
  };
}

const TREES: Record<string, GoogleTree> = {
  "1112223333": {
    campaigns: [
      campaign(
        "1112223333",
        "21000000001",
        "Search — Brand",
        "ENABLED",
        "SERVING",
        "SEARCH",
        "TARGET_CPA",
        "80000000",
        "2026-01-01",
      ),
      campaign(
        "1112223333",
        "21000000002",
        "PMax — Catalog",
        "ENABLED",
        "SERVING",
        "PERFORMANCE_MAX",
        "MAXIMIZE_CONVERSION_VALUE",
        "120000000",
        "2026-02-15",
        NO_END_DATE,
        true,
      ),
      campaign(
        "1112223333",
        "21000000003",
        "Search — Old promo",
        "REMOVED",
        "ENDED",
        "SEARCH",
        "MANUAL_CPC",
        "20000000",
        "2025-10-01",
        "2025-12-31",
      ),
    ],
    adGroups: [
      {
        customerId: "1112223333",
        campaign: { id: "21000000001" },
        adGroup: {
          id: "22000000001",
          name: "Brand exact",
          status: "ENABLED",
          type: "SEARCH_STANDARD",
        },
      },
      {
        customerId: "1112223333",
        campaign: { id: "21000000001" },
        adGroup: {
          id: "22000000002",
          name: "Brand phrase",
          status: "PAUSED",
          type: "SEARCH_STANDARD",
        },
      },
      {
        customerId: "1112223333",
        campaign: { id: "21000000003" },
        adGroup: { id: "22000000003", name: "Promo", status: "REMOVED", type: "SEARCH_STANDARD" },
      },
      {
        customerId: "1112223333",
        campaign: { id: "21000000002" },
        assetGroup: { id: "23000000001", name: "Catalog — all products", status: "ENABLED" },
      },
    ],
    ads: [
      rsa("1112223333", "21000000001", "22000000001", "24000000001", "ENABLED"),
      rsa("1112223333", "21000000001", "22000000001", "24000000002", "PAUSED"),
      rsa("1112223333", "21000000001", "22000000002", "24000000003", "ENABLED"),
      rsa("1112223333", "21000000003", "22000000003", "24000000004", "REMOVED"),
    ],
    delivery: {
      "21000000001": { from: "2026-01-01" },
      "21000000002": { from: "2026-02-15" },
      "21000000003": { from: "2025-10-01", to: "2025-12-31" },
    },
    adGroupDeliveryTo: { "22000000002": "2026-02-28" },
    cpcMicros: 1_200_000n,
    aovMicros: 80_000_000n,
  },
  "4445556666": {
    campaigns: [
      campaign(
        "4445556666",
        "25000000001",
        "Search — JP",
        "ENABLED",
        "SERVING",
        "SEARCH",
        "MAXIMIZE_CLICKS",
        "10000000000",
        "2026-04-01",
      ),
    ],
    adGroups: [
      {
        customerId: "4445556666",
        campaign: { id: "25000000001" },
        adGroup: {
          id: "26000000001",
          name: "JP generic",
          status: "ENABLED",
          type: "SEARCH_STANDARD",
        },
      },
    ],
    ads: [rsa("4445556666", "25000000001", "26000000001", "27000000001", "ENABLED")],
    delivery: { "25000000001": { from: "2026-04-01" } },
    adGroupDeliveryTo: {},
    // JPY has no minor unit.
    cpcMicros: 180_000_000n,
    aovMicros: 9_000_000_000n,
  },
};

/** Raw record that fails normalization (malformed scenario). */
const MALFORMED_AD_GROUP: GoogleRawAdGroup = {
  customerId: "1112223333",
  campaign: { id: "21000000001" },
  adGroup: { id: "not-numeric", name: "Broken", status: "ENABLED", type: "SEARCH_STANDARD" },
};

// ---------------------------------------------------------------------------
// Normalization (raw -> provider records)
// ---------------------------------------------------------------------------

const CUSTOMER_STATUS: Record<string, AdAccountStatus> = {
  ENABLED: "active",
  CANCELED: "closed",
  CLOSED: "closed",
  SUSPENDED: "disabled",
};
const STATUS: Record<string, EntityStatus> = {
  ENABLED: "active",
  PAUSED: "paused",
  REMOVED: "removed",
};
const SERVING: Record<string, DeliveryStatus> = {
  SERVING: "delivering",
  ENDED: "ended",
  PENDING: "scheduled",
  SUSPENDED: "not_delivering",
  NONE: "unknown",
};
const CHANNEL: Record<string, ChannelType> = {
  SEARCH: "search",
  DISPLAY: "display",
  VIDEO: "video",
  SHOPPING: "shopping",
  PERFORMANCE_MAX: "performance_max",
  DEMAND_GEN: "demand_gen",
  MULTI_CHANNEL: "app",
};
const NETWORK: Record<string, Placement> = {
  SEARCH: "google_search",
  SEARCH_PARTNERS: "search_partners",
  CONTENT: "google_display",
  YOUTUBE: "youtube",
  YOUTUBE_SEARCH: "youtube",
  YOUTUBE_WATCH: "youtube",
  DISCOVER: "discover",
  GMAIL: "gmail",
  MIXED: "cross_network",
};
const RAW_NETWORK: Partial<Record<Placement, string>> = {
  google_search: "SEARCH",
  search_partners: "SEARCH_PARTNERS",
  cross_network: "MIXED",
};
const CATEGORY: Record<string, ActionType> = {
  PURCHASE: "purchase",
  SIGNUP: "complete_registration",
  LEAD: "lead",
  ADD_TO_CART: "add_to_cart",
  BEGIN_CHECKOUT: "initiate_checkout",
  PAGE_VIEW: "page_view",
  SUBSCRIBE_PAID: "subscribe",
  CONTACT: "contact",
};
const AD_FORMAT: Record<string, CreativeFormat> = {
  RESPONSIVE_SEARCH_AD: "responsive_search",
  RESPONSIVE_DISPLAY_AD: "responsive_display",
  EXPANDED_TEXT_AD: "text",
  IMAGE_AD: "image",
  VIDEO_AD: "video",
};

function accountOf(customerId: string): MockAccountInfo {
  const raw = CUSTOMERS.find((c) => normalizeGoogleCustomerId(c.id) === customerId);
  if (!raw) throw new Error(`Unknown Google customer ${customerId}`);
  return {
    externalId: normalizeGoogleCustomerId(raw.id),
    currency: raw.currencyCode,
    timezone: raw.timeZone,
    isManager: raw.manager,
  };
}

function normalizeCustomer(raw: GoogleRawCustomer): ProviderAdAccount {
  return compact({
    platform: "google_ads" as const,
    externalId: normalizeGoogleCustomerId(raw.id),
    name: raw.descriptiveName,
    currency: raw.currencyCode,
    timezone: raw.timeZone,
    status: CUSTOMER_STATUS[raw.status] ?? "unknown",
    rawStatus: raw.status,
    isManager: raw.manager,
    parentExternalId: raw.managerCustomerId
      ? normalizeGoogleCustomerId(raw.managerCustomerId)
      : undefined,
  } satisfies ProviderAdAccount);
}

function normalizeCampaign(raw: GoogleRawCampaign): ProviderCampaign {
  const c = raw.campaign;
  return compact({
    platform: "google_ads" as const,
    accountExternalId: normalizeGoogleCustomerId(raw.customerId),
    externalId: normalizeNumericId(c.id),
    name: c.name,
    status: STATUS[c.status] ?? "unknown",
    rawStatus: c.status,
    deliveryStatus: SERVING[c.servingStatus] ?? "unknown",
    // Google campaigns have no objective; the channel carries the intent.
    objective: "unknown" as const,
    channelType: CHANNEL[c.advertisingChannelType] ?? "other",
    budgetType: "daily" as const,
    budgetMicros: BigInt(raw.campaignBudget.amountMicros),
    budgetLevel: "campaign" as const,
    isSharedBudget: raw.campaignBudget.explicitlyShared,
    bidStrategy: c.biddingStrategyType,
    startDate: c.startDate,
    endDate: c.endDate === NO_END_DATE ? undefined : c.endDate,
  } satisfies ProviderCampaign);
}

function normalizeAdGroup(raw: GoogleRawAdGroup): ProviderAdGroup {
  const group = raw.adGroup ?? raw.assetGroup;
  if (!group) throw new Error("Row has neither adGroup nor assetGroup");
  return compact({
    platform: "google_ads" as const,
    accountExternalId: normalizeGoogleCustomerId(raw.customerId),
    campaignExternalId: normalizeNumericId(raw.campaign.id),
    externalId: normalizeNumericId(group.id),
    name: group.name,
    kind: raw.assetGroup ? ("asset_group" as const) : ("ad_group" as const),
    status: STATUS[group.status] ?? "unknown",
    rawStatus: group.status,
  } satisfies ProviderAdGroup);
}

function normalizeAd(raw: GoogleRawAd): ProviderAd {
  const id = googleAdExternalId(raw.adGroup.id, raw.adGroupAd.ad.id);
  return compact({
    platform: "google_ads" as const,
    accountExternalId: normalizeGoogleCustomerId(raw.customerId),
    campaignExternalId: normalizeNumericId(raw.campaign.id),
    adGroupExternalId: normalizeNumericId(raw.adGroup.id),
    // Google ads embed their creative: one creative per ad, same external id.
    creativeExternalId: id,
    externalId: id,
    name: raw.adGroupAd.ad.name ?? `Ad ${raw.adGroupAd.ad.id}`,
    status: STATUS[raw.adGroupAd.status] ?? "unknown",
    rawStatus: raw.adGroupAd.status,
    format: AD_FORMAT[raw.adGroupAd.ad.type] ?? "other",
  } satisfies ProviderAd);
}

function normalizeCreative(raw: GoogleRawAd): ProviderCreative {
  const ad = raw.adGroupAd.ad;
  return compact({
    platform: "google_ads" as const,
    accountExternalId: normalizeGoogleCustomerId(raw.customerId),
    externalId: googleAdExternalId(raw.adGroup.id, ad.id),
    format: AD_FORMAT[ad.type] ?? "other",
    headlines: ad.responsiveSearchAd?.headlines.map((h) => h.text),
    descriptions: ad.responsiveSearchAd?.descriptions.map((d) => d.text),
    linkUrl: ad.finalUrls[0],
  } satisfies ProviderCreative);
}

function entityOf(raw: GoogleRawMetricRow, level: ProviderMetricRow["level"]): string {
  switch (level) {
    case "account":
      return normalizeGoogleCustomerId(raw.customer.id);
    case "campaign":
      return normalizeNumericId(required(raw.campaign?.id, level));
    case "ad_group":
      return normalizeNumericId(required(raw.adGroup?.id ?? raw.assetGroup?.id, level));
    case "ad":
      return googleAdExternalId(
        required(raw.adGroupAd?.adGroupId, level),
        required(raw.adGroupAd?.ad.id, level),
      );
  }
}

function required(value: string | undefined, level: string): string {
  if (value === undefined) throw new Error(`Metric row is missing the ${level} id`);
  return value;
}

function base(raw: GoogleRawMetricRow, level: ProviderMetricRow["level"], currency: string) {
  const network = raw.segments.adNetworkType;
  return {
    platform: "google_ads" as const,
    accountExternalId: normalizeGoogleCustomerId(raw.customer.id),
    level,
    entityExternalId: entityOf(raw, level),
    date: raw.segments.date,
    placement: network ? (NETWORK[network] ?? ("other" as const)) : ("all" as const),
    rawPlacement: network,
    currency,
  };
}

function normalizeMetricRow(
  raw: GoogleRawMetricRow,
  level: ProviderMetricRow["level"],
  currency: string,
): ProviderMetricRow {
  return compact({
    ...base(raw, level, currency),
    spendMicros: BigInt(raw.metrics.costMicros),
    impressions: toCount(raw.metrics.impressions),
    clicks: toCount(raw.metrics.clicks),
    // Google always reports conversions (0.0 when none): a reported zero, not missing data.
    conversions: raw.metrics.conversions,
    conversionValueMicros: numberToMicros(raw.metrics.conversionsValue),
    allConversions: raw.metrics.allConversions,
  } satisfies ProviderMetricRow);
}

function normalizeActionRow(
  raw: GoogleRawMetricRow,
  level: ProviderMetricRow["level"],
  currency: string,
): ProviderActionRow {
  const actionId = raw.segments.conversionAction?.split("/").pop();
  const definition = CONVERSION_ACTIONS.find((a) => a.id === actionId);
  if (!definition || !raw.segments.conversionActionName) {
    throw new Error("Conversion row without a known conversion action");
  }
  return compact({
    ...base(raw, level, currency),
    actionType: CATEGORY[raw.segments.conversionActionCategory ?? ""] ?? "other",
    rawActionType: raw.segments.conversionActionName,
    conversionActionExternalId: normalizeNumericId(definition.id),
    attributionWindow: CONVERSION_WINDOW,
    attributionBasis: "impression_or_click_date" as const,
    count: raw.metrics.allConversions,
    valueMicros:
      raw.metrics.allConversionsValue === undefined
        ? undefined
        : numberToMicros(raw.metrics.allConversionsValue),
    isPrimary: definition.primary,
  } satisfies ProviderActionRow);
}

// ---------------------------------------------------------------------------
// Neutral rows -> raw GAQL rows
// ---------------------------------------------------------------------------

function entityRefs(
  row: NeutralRow,
  leavesById: Map<string, LeafSpec>,
): Partial<GoogleRawMetricRow> {
  switch (row.level) {
    case "account":
      return {};
    case "campaign":
      return { campaign: { id: row.entityExternalId } };
    case "ad_group": {
      const isAssetGroup = [...leavesById.values()].some(
        (l) => l.level === "ad_group" && l.externalId === row.entityExternalId,
      );
      return isAssetGroup
        ? { assetGroup: { id: row.entityExternalId } }
        : { adGroup: { id: row.entityExternalId } };
    }
    case "ad": {
      const leaf = leavesById.get(row.entityExternalId)!;
      return {
        adGroupAd: {
          ad: { id: leaf.externalId.split("~")[1]! },
          adGroupId: leaf.adGroupExternalId!,
        },
      };
    }
  }
}

function microsToDouble(micros: bigint | undefined): number {
  return micros === undefined ? 0 : Number(micros) / 1_000_000;
}

function toRawRow(
  account: MockAccountInfo,
  row: NeutralRow,
  leavesById: Map<string, LeafSpec>,
  conversion?: (typeof CONVERSION_ACTIONS)[number],
): GoogleRawMetricRow {
  const m = row.metrics;
  const network = row.placement === "all" ? undefined : RAW_NETWORK[row.placement];
  const cell = (name: string) => m.actions.find((a) => a.rawActionType === name);
  const primary = CONVERSION_ACTIONS.filter((a) => a.primary).map((a) => cell(a.name));
  const all = CONVERSION_ACTIONS.map((a) => cell(a.name));
  const scoped = conversion ? [cell(conversion.name)] : undefined;
  const sumCount = (cells: (typeof all)[number][]) =>
    cells.reduce((s, c) => s + (c?.count ?? 0), 0);
  const sumValue = (cells: (typeof all)[number][]) =>
    cells.reduce((s, c) => s + microsToDouble(c?.valueMicros), 0);

  return {
    customer: { id: account.externalId },
    ...entityRefs(row, leavesById),
    segments: compact({
      date: row.date,
      adNetworkType: network,
      conversionAction: conversion
        ? `customers/${account.externalId}/conversionActions/${conversion.id}`
        : undefined,
      conversionActionName: conversion?.name,
      conversionActionCategory: conversion?.category,
    }),
    metrics: compact({
      costMicros: m.spendMicros.toString(),
      impressions: String(m.impressions),
      clicks: String(m.clicks),
      conversions: sumCount(scoped ? (conversion?.primary ? scoped : []) : primary),
      conversionsValue: sumValue(scoped ? (conversion?.primary ? scoped : []) : primary),
      allConversions: sumCount(scoped ?? all),
      allConversionsValue: conversion ? sumValue(scoped!) : undefined,
    }),
  };
}

// ---------------------------------------------------------------------------
// Leaf generation
// ---------------------------------------------------------------------------

/** Two-decimal fractional conversions, as produced by data-driven attribution. */
function fractional(random: () => number, max: number): number {
  return Math.round(random() * max * 100) / 100;
}

function leafGenerator(customerId: string): LeafGenerator {
  const tree = TREES[customerId]!;
  const minor = currencyMinorUnits(accountOf(customerId).currency);
  return {
    cell(random, leaf, placement): NeutralMetrics | undefined {
      if (placement === "search_partners" && random() < 0.4) return undefined;
      const scale = placement === "search_partners" ? 0.2 : 1;
      const impressions = Math.floor(randomInt(random, 200, 4000) * scale);
      // Reported zero clicks do happen on low-volume placements.
      const clicks = Math.floor(impressions * (random() * 0.08));
      const purchases = fractional(random, 3);
      const purchaseValue = toMinorUnitMicros(
        numberToMicros(purchases * (Number(tree.aovMicros) / 1_000_000)),
        minor,
      );
      const signups = fractional(random, 2);
      return {
        spendMicros: toMinorUnitMicros(BigInt(clicks) * tree.cpcMicros, minor),
        impressions,
        clicks,
        actions: [
          {
            rawActionType: "Purchase",
            window: CONVERSION_WINDOW,
            count: purchases,
            valueMicros: purchaseValue,
          },
          {
            rawActionType: "Newsletter signup",
            window: CONVERSION_WINDOW,
            count: signups,
            valueMicros: 0n,
          },
        ],
      };
    },
    // Google does not report reach: the capability omits it and rows never carry it.
  };
}

function leaves(customerId: string): LeafSpec[] {
  const tree = TREES[customerId];
  if (!tree) return [];
  const adLeaves = tree.ads.map((raw): LeafSpec => {
    const window = tree.delivery[raw.campaign.id]!;
    return compact({
      level: "ad" as const,
      externalId: googleAdExternalId(raw.adGroup.id, raw.adGroupAd.ad.id),
      campaignExternalId: raw.campaign.id,
      adGroupExternalId: raw.adGroup.id,
      deliveryFrom: window.from,
      deliveryTo: tree.adGroupDeliveryTo[raw.adGroup.id] ?? window.to,
      placements: ["google_search", "search_partners"] as Placement[],
      traits: { conversions: "purchase" as const },
    });
  });
  // Performance Max: asset groups are leaves at the ad_group level (no ads).
  const assetGroupLeaves = tree.adGroups
    .filter((g) => g.assetGroup)
    .map((raw): LeafSpec => {
      const window = tree.delivery[raw.campaign.id]!;
      return compact({
        level: "ad_group" as const,
        externalId: raw.assetGroup!.id,
        campaignExternalId: raw.campaign.id,
        deliveryFrom: window.from,
        deliveryTo: window.to,
        placements: ["cross_network"] as Placement[],
        traits: { conversions: "purchase" as const },
      });
    });
  return [...adLeaves, ...assetGroupLeaves];
}

// ---------------------------------------------------------------------------
// Flavor
// ---------------------------------------------------------------------------

export const GOOGLE_MOCK_CAPABILITIES: AdsProviderCapabilities = {
  entities: { campaigns: true, adGroups: true, ads: true, creatives: true },
  adGroupKinds: ["ad_group", "asset_group"],
  incrementalEntities: false,
  metricLevels: ["account", "campaign", "ad_group", "ad"],
  placementBreakdown: true,
  placements: ["all", "google_search", "search_partners", "cross_network"],
  reportedMetrics: [
    "spendMicros",
    "impressions",
    "clicks",
    "conversions",
    "conversionValueMicros",
    "allConversions",
  ],
  actionMetrics: true,
  attributionWindows: [CONVERSION_WINDOW],
  maxMetricsRangeDays: 93,
  defaultPageSize: 50,
  maxPageSize: 200,
  restatementLookbackDays: 30,
};

function entries<Raw, T>(
  raws: Raw[],
  sortKey: (raw: Raw) => string,
  normalize: (raw: Raw) => T,
): RawEntry<T>[] {
  return bySortKey(raws.map((raw) => ({ sortKey: sortKey(raw), normalize: () => normalize(raw) })));
}

function leafIndex(customerId: string) {
  return new Map(leaves(customerId).map((l) => [l.externalId, l]));
}

export const googleFlavor: MockFlavor = {
  platform: "google_ads",
  capabilities: GOOGLE_MOCK_CAPABILITIES,
  deniedAccountExternalId: "4445556666",
  accounts: () => entries(CUSTOMERS, (c) => normalizeGoogleCustomerId(c.id), normalizeCustomer),
  accountInfo(externalId) {
    return CUSTOMERS.some((c) => normalizeGoogleCustomerId(c.id) === externalId)
      ? accountOf(externalId)
      : undefined;
  },
  campaigns: (customerId) =>
    entries(TREES[customerId]?.campaigns ?? [], (r) => r.campaign.id, normalizeCampaign),
  adGroups(customerId, malformed) {
    const raws = [...(TREES[customerId]?.adGroups ?? [])];
    if (malformed && customerId === "1112223333") raws.push(MALFORMED_AD_GROUP);
    return entries(raws, (r) => (r.adGroup ?? r.assetGroup)!.id, normalizeAdGroup);
  },
  ads: (customerId) =>
    entries(
      TREES[customerId]?.ads ?? [],
      (r) => `${r.adGroup.id}~${r.adGroupAd.ad.id}`,
      normalizeAd,
    ),
  creatives: (customerId) =>
    entries(
      TREES[customerId]?.ads ?? [],
      (r) => `${r.adGroup.id}~${r.adGroupAd.ad.id}`,
      normalizeCreative,
    ),
  leaves,
  generator: leafGenerator,
  metricRows(account, rows) {
    const index = leafIndex(account.externalId);
    return rows.map((row) =>
      normalizeMetricRow(toRawRow(account, row, index), row.level, account.currency),
    );
  },
  actionRows(account, rows) {
    const index = leafIndex(account.externalId);
    return rows.flatMap((row) =>
      CONVERSION_ACTIONS.filter((a) =>
        row.metrics.actions.some((c) => c.rawActionType === a.name),
      ).map((a) =>
        normalizeActionRow(toRawRow(account, row, index, a), row.level, account.currency),
      ),
    );
  },
};
