import { vi } from "vitest";
import type { GoogleCredential } from "./credential";

/**
 * Fake Google Ads API (Phase 9 test harness). A `fetch`-compatible function serving the
 * OAuth token endpoint, OpenID userinfo, customers:listAccessibleCustomers and
 * customers/{id}/googleAds:search through a GAQL-SUBSET evaluator, with proto3-JSON shapes
 * (camelCase, int64 as strings, `false`/empty omitted).
 *
 * It models the DOCUMENTED API (fixed 10,000-row pages by default, page tokens, the
 * login-customer-id rules, the Google Cloud project access level (a "test" project may only
 * reach test accounts: CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION; developer tokens were
 * sunset on 2026-09-09 and the header is ignored), GoogleAdsFailure error bodies with
 * google.rpc.RetryInfo, the documented `conversions` / `all_conversions` definitions, the
 * segments.conversion_action compatibility rule) and contains no recorded data — it is not
 * evidence of real account behavior. Every call is logged and counted (operation counters)
 * so tests can assert transport invariants and the cost of provider-side slicing.
 *
 * Modeling assumptions (NOT documented Google behavior; see "Real-account validation
 * required"): asset groups refuse segments.ad_network_type (GR10 — the provider never asks);
 * a metric is present on an aggregated row only if every contributing fact reported it, and
 * rows can be told to omit metrics (GR12); zero-delivery rows are never invented; an action
 * whose primary_for_goal is not reported counts in `conversions` (Google's creation default).
 * Two dots: never deployed.
 */

export const FAKE_GOOGLE_CLIENT_ID = "1234567890-fakeclient.apps.googleusercontent.com";
export const FAKE_GOOGLE_CLIENT_SECRET = "test-google-client-secret";
export const FAKE_GOOGLE_CONFIG = {
  clientId: FAKE_GOOGLE_CLIENT_ID,
  clientSecret: FAKE_GOOGLE_CLIENT_SECRET,
};
export const FAKE_GOOGLE_VERSION = "v25";

export type FakeGoogleUser = {
  /** OpenID subject. */
  sub: string;
  /** Customers the user can access directly (listAccessibleCustomers). */
  accessible: string[];
  /** listAccessibleCustomers fails with AuthenticationError.NOT_ADS_USER. */
  notAdsUser?: boolean;
  /** The token endpoint issues no refresh token. */
  omitRefreshToken?: boolean;
};

export const FAKE_GOOGLE_USERS: Record<string, FakeGoogleUser> = {
  u1: { sub: "100000000000000000001", accessible: ["1110000001", "7770000001"] },
  u2: { sub: "100000000000000000002", accessible: ["7770000001"] },
  noads: { sub: "100000000000000000009", accessible: [], notAdsUser: true },
  norefresh: { sub: "100000000000000000003", accessible: ["7770000001"], omitRefreshToken: true },
};

export type FakeCustomer = {
  id: string;
  descriptiveName?: string;
  currencyCode: string;
  timeZone: string;
  manager?: boolean;
  status: string;
  testAccount?: boolean;
  /** Direct children (managers only). */
  children?: { id: string; hidden?: boolean }[];
};

/** One conversion attributed to a leaf fact (all_conversions of `actionId`). */
export type FakeConversion = { actionId: string; count: number; value?: number };

/** Leaf delivery (an ad or an asset group) on one day and network. */
export type FakeFact = {
  customerId: string;
  campaignId: string;
  adGroupId?: string;
  adId?: string;
  assetGroupId?: string;
  date: string;
  network: string;
  impressions: number;
  clicks: number;
  costMicros: number;
  conversions?: FakeConversion[];
};

export type FakeCampaign = {
  id: string;
  name: string;
  status: string;
  servingStatus?: string;
  advertisingChannelType?: string;
  biddingStrategyType?: string;
  /** "yyyy-MM-dd HH:mm:ss" (customer time zone). */
  startDateTime?: string;
  endDateTime?: string;
  budget?: {
    id: string;
    period: string;
    amountMicros?: string;
    totalAmountMicros?: string;
    explicitlyShared?: boolean;
  };
};

export type FakeAdGroup = {
  id: string;
  name: string;
  status: string;
  campaignId: string;
  type?: string;
};

export type FakeAd = {
  id: string;
  status: string;
  adGroupId: string;
  campaignId: string;
  type?: string;
  name?: string;
  finalUrls?: string[];
  responsiveSearchAd?: { headlines?: string[]; descriptions?: string[] };
  responsiveDisplayAd?: {
    headlines?: string[];
    descriptions?: string[];
    callToActionText?: string;
  };
};

export type FakeConversionAction = {
  id: string;
  /** Display name (mutable; the provider does not read it). */
  name: string;
  status: string;
  category: string;
  /**
   * primary_for_goal. true → counted in `conversions` (conversion-goals guide); false → only
   * in `all_conversions` unless used in a custom goal. Absent: the flag is not reported; the
   * fake then applies Google's documented default ("true if not set") to its own metrics.
   */
  primaryForGoal?: boolean;
  /** Campaigns whose custom conversion goal uses this action (counted whatever the flag). */
  customGoalCampaigns?: string[];
  /** Current lookback settings (never read by the provider; see GOOGLE_ACTION_WINDOW). */
  clickThroughLookbackWindowDays?: number;
  viewThroughLookbackWindowDays?: number;
};

export type FakeGoogleDataset = {
  customers: FakeCustomer[];
  campaigns: Record<string, FakeCampaign[]>;
  adGroups: Record<string, FakeAdGroup[]>;
  assetGroups: Record<string, Omit<FakeAdGroup, "type">[]>;
  ads: Record<string, FakeAd[]>;
  conversionActions: Record<string, FakeConversionAction[]>;
  facts: FakeFact[];
};

const DAYS = Array.from({ length: 7 }, (_, i) => `2026-03-0${i + 1}`);
export const FAKE_GOOGLE_RANGE = { from: DAYS[0]!, to: DAYS[6]! };

/** Conversion actions of 222-000-0001 (ids used by the facts below). */
export const FAKE_ACTIONS = {
  purchase: "900000001",
  signup: "900000002",
  storeVisit: "900000003",
  oldLead: "900000004",
} as const;

/**
 * Manager 111-000-0001 (accessible to u1) → clients 222-000-0001 (USD, with delivery),
 * 222-000-0002 (JPY, test account), sub-manager 333-000-0001 → 444-000-0001 (EUR),
 * 555-000-0001 (hidden), 666-000-0001 (CANCELED), 777-000-0001 (also directly accessible).
 *
 * 222-000-0001 has four campaigns: Search (daily budget), Performance Max (one asset group,
 * no ads; a SHARED daily budget), a REMOVED Search campaign (custom-period budget, delivery on
 * the first two days only) and a paused Display campaign sharing the Performance Max budget
 * (no delivery). Delivery: Search ads on SEARCH (3 shares) and SEARCH_PARTNERS (1 share);
 * the asset group on MIXED (3 shares) and GOOGLE_TV (1 share); one extra GOOGLE_OWNED_CHANNELS
 * row on the first day. Ad 40000000002 reports 0 clicks and 0 cost on SEARCH_PARTNERS.
 * Conversions (dyadic fractions, so every sum is exact): purchases (primary), newsletter
 * signups (secondary; the Search campaign's custom goal uses them, so they count in that
 * campaign's `conversions` but not in Performance Max's), store visits (flag not reported) and a removed lead action
 * (primary).
 */
export function fakeGoogleDataset(options: { cancelled?: boolean } = {}): FakeGoogleDataset {
  const cancelled = options.cancelled ?? true;
  const facts: FakeFact[] = [];
  DAYS.forEach((date, d) => {
    const leaf = (
      f: Pick<FakeFact, "campaignId" | "adGroupId" | "adId" | "assetGroupId">,
      n: number,
      networks: readonly (readonly [string, number])[],
      conversions: (network: string) => FakeConversion[] | undefined,
      zeroOn?: string,
    ) => {
      for (const [network, share] of networks) {
        const impressions = (100 + n * 37 + d * 11) * share;
        const zero = network === zeroOn;
        const converted = conversions(network);
        facts.push({
          customerId: "2220000001",
          date,
          network,
          impressions,
          clicks: zero ? 0 : Math.floor(impressions / 20),
          costMicros: zero ? 0 : impressions * 1_250,
          ...(converted !== undefined ? { conversions: converted } : {}),
          ...f,
        });
      }
    };
    const search = [
      ["SEARCH", 3],
      ["SEARCH_PARTNERS", 1],
    ] as const;
    leaf(
      { campaignId: "10000000001", adGroupId: "20000000001", adId: "40000000001" },
      1,
      search,
      (network) =>
        network === "SEARCH"
          ? [
              { actionId: FAKE_ACTIONS.purchase, count: 1 + (d % 2) * 0.5, value: 25.5 },
              { actionId: FAKE_ACTIONS.signup, count: 0.25 },
              ...(d < 3 ? [{ actionId: FAKE_ACTIONS.storeVisit, count: 1 }] : []),
            ]
          : undefined,
    );
    leaf(
      { campaignId: "10000000001", adGroupId: "20000000001", adId: "40000000002" },
      2,
      search,
      (network) =>
        network === "SEARCH"
          ? [{ actionId: FAKE_ACTIONS.purchase, count: 0.5, value: 10.75 }]
          : undefined,
      "SEARCH_PARTNERS",
    );
    if (d < 2) {
      leaf(
        { campaignId: "10000000003", adGroupId: "20000000002", adId: "40000000003" },
        3,
        search,
        (network) =>
          network === "SEARCH" ? [{ actionId: FAKE_ACTIONS.oldLead, count: 1 }] : undefined,
      );
    }
    leaf(
      { campaignId: "10000000002", assetGroupId: "30000000001" },
      4,
      [
        ["MIXED", 3],
        ["GOOGLE_TV", 1],
      ],
      (network) =>
        network === "MIXED"
          ? [
              { actionId: FAKE_ACTIONS.purchase, count: 2, value: 80.25 },
              { actionId: FAKE_ACTIONS.signup, count: 0.5 },
            ]
          : undefined,
    );
    if (d === 0) {
      facts.push({
        customerId: "2220000001",
        campaignId: "10000000002",
        assetGroupId: "30000000001",
        date,
        network: "GOOGLE_OWNED_CHANNELS",
        impressions: 40,
        clicks: 1,
        costMicros: 30_000,
      });
    }
  });
  return {
    customers: [
      {
        id: "1110000001",
        descriptiveName: "Fake Manager",
        currencyCode: "USD",
        timeZone: "America/New_York",
        manager: true,
        status: "ENABLED",
        children: [
          { id: "2220000001" },
          { id: "2220000002" },
          { id: "3330000001" },
          { id: "5550000001", hidden: true },
          ...(cancelled ? [{ id: "6660000001" }] : []),
          { id: "7770000001" },
        ],
      },
      {
        id: "2220000001",
        descriptiveName: "Fake Shop USD",
        currencyCode: "USD",
        timeZone: "America/New_York",
        status: "ENABLED",
      },
      {
        id: "2220000002",
        descriptiveName: "Fake Shop JPY",
        currencyCode: "JPY",
        timeZone: "Asia/Tokyo",
        status: "ENABLED",
        testAccount: true,
      },
      {
        id: "3330000001",
        descriptiveName: "Fake Sub-manager",
        currencyCode: "EUR",
        timeZone: "Europe/Berlin",
        manager: true,
        status: "ENABLED",
        children: [{ id: "4440000001" }],
      },
      {
        id: "4440000001",
        descriptiveName: "Fake Shop EUR",
        currencyCode: "EUR",
        timeZone: "Europe/Berlin",
        status: "ENABLED",
      },
      {
        id: "5550000001",
        descriptiveName: "Fake Hidden",
        currencyCode: "USD",
        timeZone: "America/New_York",
        status: "ENABLED",
      },
      ...(cancelled
        ? [
            {
              id: "6660000001",
              descriptiveName: "Fake Cancelled",
              currencyCode: "USD",
              timeZone: "America/Chicago",
              status: "CANCELED",
            },
          ]
        : []),
      {
        id: "7770000001",
        descriptiveName: "",
        currencyCode: "GBP",
        timeZone: "Europe/London",
        status: "ENABLED",
      },
    ],
    campaigns: {
      "2220000001": [
        {
          id: "10000000001",
          name: "Search US",
          status: "ENABLED",
          servingStatus: "SERVING",
          advertisingChannelType: "SEARCH",
          biddingStrategyType: "MAXIMIZE_CONVERSIONS",
          startDateTime: "2026-01-15 00:00:00",
          budget: {
            id: "5000001",
            period: "DAILY",
            amountMicros: "50000000",
            explicitlyShared: false,
          },
        },
        {
          id: "10000000002",
          name: "Performance Max",
          status: "ENABLED",
          servingStatus: "SERVING",
          advertisingChannelType: "PERFORMANCE_MAX",
          biddingStrategyType: "MAXIMIZE_CONVERSION_VALUE",
          startDateTime: "2026-02-01 00:00:00",
          endDateTime: "2026-12-31 23:59:59",
          budget: {
            id: "5000002",
            period: "DAILY",
            amountMicros: "120000000",
            explicitlyShared: true,
          },
        },
        {
          id: "10000000003",
          name: "Removed campaign",
          status: "REMOVED",
          servingStatus: "ENDED",
          advertisingChannelType: "SEARCH",
          biddingStrategyType: "MANUAL_CPC",
          startDateTime: "2026-01-01 00:00:00",
          endDateTime: "2026-03-02 23:59:59",
          budget: {
            id: "5000003",
            period: "CUSTOM_PERIOD",
            totalAmountMicros: "300000000",
            explicitlyShared: false,
          },
        },
        {
          id: "10000000004",
          name: "Display remarketing",
          status: "PAUSED",
          advertisingChannelType: "DISPLAY",
          startDateTime: "2026-02-15 00:00:00",
          budget: {
            id: "5000002",
            period: "DAILY",
            amountMicros: "120000000",
            explicitlyShared: true,
          },
        },
      ],
    },
    adGroups: {
      "2220000001": [
        {
          id: "20000000001",
          name: "Brand",
          status: "ENABLED",
          campaignId: "10000000001",
          type: "SEARCH_STANDARD",
        },
        {
          id: "20000000002",
          name: "Old",
          status: "REMOVED",
          campaignId: "10000000003",
          type: "SEARCH_STANDARD",
        },
        {
          id: "20000000003",
          name: "Retargeting",
          status: "PAUSED",
          campaignId: "10000000004",
          type: "DISPLAY_STANDARD",
        },
      ],
    },
    assetGroups: {
      "2220000001": [
        { id: "30000000001", name: "All products", status: "ENABLED", campaignId: "10000000002" },
      ],
    },
    ads: {
      "2220000001": [
        {
          id: "40000000001",
          status: "ENABLED",
          adGroupId: "20000000001",
          campaignId: "10000000001",
          type: "RESPONSIVE_SEARCH_AD",
          finalUrls: ["https://shop.example.test/"],
          responsiveSearchAd: {
            headlines: ["Fake Shop", "Free delivery"],
            descriptions: ["Everything for the fake home."],
          },
        },
        {
          id: "40000000002",
          status: "PAUSED",
          adGroupId: "20000000001",
          campaignId: "10000000001",
          type: "RESPONSIVE_SEARCH_AD",
          responsiveSearchAd: { headlines: ["Fake Shop sale"] },
        },
        {
          id: "40000000003",
          status: "REMOVED",
          adGroupId: "20000000002",
          campaignId: "10000000003",
          type: "EXPANDED_TEXT_AD",
          finalUrls: ["https://shop.example.test/old"],
        },
        {
          id: "40000000004",
          status: "PAUSED",
          adGroupId: "20000000003",
          campaignId: "10000000004",
          type: "RESPONSIVE_DISPLAY_AD",
          name: "Remarketing banner",
          finalUrls: ["https://shop.example.test/back"],
          responsiveDisplayAd: {
            headlines: ["Come back"],
            descriptions: ["Your cart is waiting."],
            callToActionText: "Shop now",
          },
        },
      ],
    },
    conversionActions: {
      "2220000001": [
        {
          id: FAKE_ACTIONS.purchase,
          name: "Purchase",
          status: "ENABLED",
          category: "PURCHASE",
          primaryForGoal: true,
          clickThroughLookbackWindowDays: 30,
          viewThroughLookbackWindowDays: 1,
        },
        {
          id: FAKE_ACTIONS.signup,
          name: "Newsletter signup",
          status: "ENABLED",
          category: "SIGNUP",
          primaryForGoal: false,
          // A custom conversion goal of the Search campaign uses this secondary action.
          customGoalCampaigns: ["10000000001"],
          clickThroughLookbackWindowDays: 7,
        },
        {
          id: FAKE_ACTIONS.storeVisit,
          name: "Store visit",
          status: "ENABLED",
          category: "STORE_VISIT",
        },
        {
          id: FAKE_ACTIONS.oldLead,
          name: "Old lead form",
          status: "REMOVED",
          category: "SUBMIT_LEAD_FORM",
          primaryForGoal: true,
        },
      ],
    },
    facts,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type FakeResponse = { status: number; body?: unknown };

/** A GoogleAdsFailure error body (with an optional google.rpc.RetryInfo). */
export function adsError(
  status: number,
  rpcStatus: string,
  family: string,
  code: string,
  retryDelay?: string,
): FakeResponse {
  return {
    status,
    body: {
      error: {
        code: status,
        message: "Fake Google Ads error",
        status: rpcStatus,
        details: [
          {
            "@type": `type.googleapis.com/google.ads.googleads.${FAKE_GOOGLE_VERSION}.errors.GoogleAdsFailure`,
            errors: [{ errorCode: { [family]: code }, message: "Fake error message" }],
            requestId: "fakeRequestId000000001",
          },
          ...(retryDelay !== undefined
            ? [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay }]
            : []),
        ],
      },
    },
  };
}

export function oauthErrorResponse(status: number, error: string): FakeResponse {
  return { status, body: { error, error_description: "Fake OAuth error description" } };
}

const permissionDenied = () =>
  adsError(403, "PERMISSION_DENIED", "authorizationError", "USER_PERMISSION_DENIED");
const queryError = (code: string) => adsError(400, "INVALID_ARGUMENT", "queryError", code);

// ---------------------------------------------------------------------------
// GAQL subset
// ---------------------------------------------------------------------------

type Comparison = "=" | "!=" | ">" | ">=" | "<" | "<=";
type Condition =
  | { field: string; op: Comparison; value: string }
  | { field: string; op: "IN"; values: string[] }
  | { field: string; op: "BETWEEN"; from: string; to: string };

type ParsedQuery = {
  select: string[];
  from: string;
  where: Condition[];
  orderBy: { field: string; direction: "ASC" | "DESC" }[];
  limit?: number;
};

const SEGMENT_FIELDS = new Set([
  "segments.date",
  "segments.ad_network_type",
  "segments.conversion_action",
  "segments.conversion_action_name",
  "segments.conversion_action_category",
]);
const METRIC_FIELDS = new Set([
  "metrics.impressions",
  "metrics.clicks",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.conversions_value",
  "metrics.all_conversions",
  "metrics.all_conversions_value",
]);
const CONVERSION_METRICS = new Set([
  "metrics.conversions",
  "metrics.conversions_value",
  "metrics.all_conversions",
  "metrics.all_conversions_value",
]);
const CUSTOMER_ATTRIBUTES = ["customer.id", "customer.currency_code", "customer.time_zone"];
const RESOURCE_FIELDS: Record<
  string,
  { fields: string[]; metrics: boolean; refusedSegments?: string[] }
> = {
  customer: {
    fields: [
      ...CUSTOMER_ATTRIBUTES,
      "customer.descriptive_name",
      "customer.manager",
      "customer.status",
      "customer.test_account",
    ],
    metrics: true,
  },
  customer_client: {
    fields: [
      "customer_client.id",
      "customer_client.client_customer",
      "customer_client.descriptive_name",
      "customer_client.currency_code",
      "customer_client.time_zone",
      "customer_client.manager",
      "customer_client.status",
      "customer_client.level",
      "customer_client.hidden",
      "customer_client.test_account",
    ],
    metrics: false,
  },
  campaign: {
    fields: [
      ...CUSTOMER_ATTRIBUTES,
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
    metrics: true,
  },
  ad_group: {
    fields: [
      ...CUSTOMER_ATTRIBUTES,
      "ad_group.id",
      "ad_group.name",
      "ad_group.status",
      "ad_group.type",
      "campaign.id",
    ],
    metrics: true,
  },
  asset_group: {
    fields: [
      ...CUSTOMER_ATTRIBUTES,
      "asset_group.id",
      "asset_group.name",
      "asset_group.status",
      "campaign.id",
    ],
    metrics: true,
    refusedSegments: ["segments.ad_network_type"],
  },
  ad_group_ad: {
    fields: [
      ...CUSTOMER_ATTRIBUTES,
      "ad_group_ad.ad.id",
      "ad_group_ad.ad.type",
      "ad_group_ad.ad.name",
      "ad_group_ad.ad.final_urls",
      "ad_group_ad.ad.responsive_search_ad.headlines",
      "ad_group_ad.ad.responsive_search_ad.descriptions",
      "ad_group_ad.ad.responsive_display_ad.headlines",
      "ad_group_ad.ad.responsive_display_ad.descriptions",
      "ad_group_ad.ad.responsive_display_ad.call_to_action_text",
      "ad_group_ad.status",
      "ad_group.id",
      "campaign.id",
    ],
    metrics: true,
  },
  conversion_action: {
    fields: [
      "conversion_action.id",
      "conversion_action.name",
      "conversion_action.status",
      "conversion_action.category",
      "conversion_action.primary_for_goal",
      "conversion_action.click_through_lookback_window_days",
      "conversion_action.view_through_lookback_window_days",
    ],
    metrics: false,
  },
};

class QueryFailure extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function parseCondition(text: string): [Condition, string] {
  let m = /^(\S+) BETWEEN '([^']*)' AND '([^']*)'/.exec(text);
  if (m) return [{ field: m[1]!, op: "BETWEEN", from: m[2]!, to: m[3]! }, text.slice(m[0].length)];
  m = /^(\S+) IN \(([^)]*)\)/.exec(text);
  if (m) {
    return [
      { field: m[1]!, op: "IN", values: m[2]!.split(",").map((v) => v.trim()) },
      text.slice(m[0].length),
    ];
  }
  m = /^(\S+) (!=|>=|<=|=|>|<) (\S+)/.exec(text);
  if (m) return [{ field: m[1]!, op: m[2] as Comparison, value: m[3]! }, text.slice(m[0].length)];
  throw new QueryFailure("INVALID_WHERE_CLAUSE");
}

export function parseGaql(query: string): ParsedQuery {
  const m = /^SELECT (.+?) FROM (\w+)(?: WHERE (.+?))?(?: ORDER BY (.+?))?(?: LIMIT (\d+))?$/.exec(
    query.trim(),
  );
  if (!m) throw new QueryFailure("UNEXPECTED_INPUT");
  const where: Condition[] = [];
  let rest = m[3] ?? "";
  while (rest !== "") {
    const [condition, after] = parseCondition(rest);
    where.push(condition);
    rest = after.replace(/^\s+AND\s+/, "");
    if (rest === after && rest !== "") throw new QueryFailure("INVALID_WHERE_CLAUSE");
  }
  return {
    select: m[1]!.split(",").map((f) => f.trim()),
    from: m[2]!,
    where,
    orderBy: (m[4] ?? "")
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part !== "")
      .map((part) => {
        const [field, direction] = part.split(/\s+/);
        return { field: field!, direction: direction === "DESC" ? "DESC" : "ASC" };
      }),
    ...(m[5] !== undefined ? { limit: Number(m[5]) } : {}),
  };
}

function validateQuery(q: ParsedQuery) {
  const resource = RESOURCE_FIELDS[q.from];
  if (!resource) throw new QueryFailure("INVALID_RESOURCE_NAME");
  const known = (field: string) =>
    resource.fields.includes(field) ||
    (resource.metrics && (SEGMENT_FIELDS.has(field) || METRIC_FIELDS.has(field)));
  for (const field of [
    ...q.select,
    ...q.where.map((c) => c.field),
    ...q.orderBy.map((o) => o.field),
  ]) {
    if (!known(field)) throw new QueryFailure("UNRECOGNIZED_FIELD");
    if (resource.refusedSegments?.includes(field)) {
      throw new QueryFailure("PROHIBITED_SEGMENT_IN_SELECT_OR_WHERE_CLAUSE");
    }
  }
  if (
    q.select.some((f) => f.startsWith("segments.conversion_action")) &&
    q.select.some((f) => METRIC_FIELDS.has(f) && !CONVERSION_METRICS.has(f))
  ) {
    throw new QueryFailure("PROHIBITED_METRIC_IN_SELECT_OR_WHERE_CLAUSE");
  }
}

function camel(field: string): string[] {
  return field
    .split(".")
    .map((part) => part.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase()));
}

function read(source: Record<string, unknown>, field: string): unknown {
  let value: unknown = source;
  for (const key of camel(field)) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function assign(target: Record<string, unknown>, field: string, value: unknown) {
  const keys = camel(field);
  let node = target;
  for (const key of keys.slice(0, -1)) {
    node[key] ??= {};
    node = node[key] as Record<string, unknown>;
  }
  node[keys[keys.length - 1]!] = value;
}

function literal(text: string): string {
  if (/^'.*'$/.test(text)) return text.slice(1, -1);
  if (text === "TRUE") return "true";
  if (text === "FALSE") return "false";
  return text;
}

function compareValues(a: unknown, b: unknown): number {
  const sa = a === undefined ? "" : String(a);
  const sb = b === undefined ? "" : String(b);
  if (/^-?\d+$/.test(sa) && /^-?\d+$/.test(sb)) {
    const diff = BigInt(sa) - BigInt(sb);
    return diff < 0n ? -1 : diff > 0n ? 1 : 0;
  }
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function matches(source: Record<string, unknown>, condition: Condition): boolean {
  const value = read(source, condition.field);
  const actual =
    value === undefined
      ? condition.field.endsWith("hidden") || condition.field.endsWith("manager")
        ? "false"
        : ""
      : String(value);
  switch (condition.op) {
    case "BETWEEN":
      return actual >= condition.from && actual <= condition.to;
    case "IN":
      return condition.values.map(literal).includes(actual);
    default: {
      const expected = literal(condition.value);
      const cmp = compareValues(actual, expected);
      return {
        "=": cmp === 0,
        "!=": cmp !== 0,
        ">": cmp > 0,
        ">=": cmp >= 0,
        "<": cmp < 0,
        "<=": cmp <= 0,
      }[condition.op];
    }
  }
}

// ---------------------------------------------------------------------------
// The fake
// ---------------------------------------------------------------------------

export type GoogleLogEntry = {
  method: string;
  host: string;
  path: string;
  /** Operation kind. */
  kind: "token_exchange" | "token_refresh" | "userinfo" | "accessible" | "search" | "other";
  hasBearer: boolean;
  /** A `developer-token` header was sent (obsolete since the 2026-09-09 sunset: must never be). */
  developerTokenHeader: boolean;
  loginCustomerId?: string;
  customerId?: string;
  query?: string;
  pageToken?: boolean;
  /** Form field names of token requests. */
  formFields: string[];
  /** True if the URL carries a token, secret or code. */
  secretInUrl: boolean;
};

export type GoogleInjectRule = {
  match: (entry: GoogleLogEntry) => boolean;
  times?: number;
  response: FakeResponse | "network" | "hang";
};

export type FakeGoogleAds = {
  fetch: typeof fetch;
  log: GoogleLogEntry[];
  /** A single-use authorization code for `user`, bound to the PKCE challenge. */
  issueCode(user: string, codeChallenge: string, redirectUri?: string): string;
  /** Registers the user's refresh token as a completed consent would, and returns it. */
  grantRefreshToken(user: string): string;
  inject(rule: GoogleInjectRule): void;
  /** Revokes the user's refresh token (subsequent refreshes fail with invalid_grant). */
  revoke(user: string): void;
  /** Invalidates every page token issued so far (EXPIRED_PAGE_TOKEN). */
  expirePageTokens(): void;
  /** Changes the Cloud project's access level (e.g. an approval lost or not yet granted). */
  setAccessLevel(level: "test" | "explorer"): void;
  /** Operation counters by kind. */
  counts(): Record<GoogleLogEntry["kind"], number>;
  /** Search calls per customer id. */
  searchesFor(customerId: string): number;
};

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  let binary = "";
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function formKeys(body: string): string[] {
  const keys: string[] = [];
  new URLSearchParams(body).forEach((_value, key) => keys.push(key));
  return keys;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function toResponse(fake: FakeResponse): Response {
  return json(fake.status, fake.body ?? {});
}

export function createFakeGoogleAds(
  options: {
    dataset?: FakeGoogleDataset;
    users?: Record<string, FakeGoogleUser>;
    /** Rows per Google search page (default 10,000 — the documented fixed page size). */
    pageSize?: number;
    /**
     * Access level of the Google Cloud project that owns the OAuth client (default
     * "explorer"): a "test" project may only reach test accounts.
     */
    accessLevel?: "test" | "explorer";
    /** Metrics to leave out of a segmented result row (GR12 missing-vs-zero scenarios). */
    omitMetrics?: (context: { from: string; row: Record<string, unknown> }) => string[];
  } = {},
): FakeGoogleAds {
  const dataset = options.dataset ?? fakeGoogleDataset();
  const users = options.users ?? FAKE_GOOGLE_USERS;
  const pageSize = options.pageSize ?? 10_000;
  let accessLevel = options.accessLevel ?? "explorer";
  const log: GoogleLogEntry[] = [];
  const rules: GoogleInjectRule[] = [];
  const codes = new Map<
    string,
    { user: string; challenge: string; redirectUri?: string; used: boolean }
  >();
  const refreshTokens = new Map<string, string>(); // token -> user
  const accessTokens = new Map<string, string>(); // token -> user
  let validPageTokens = new Map<string, { key: string; offset: number }>();
  let seq = 0;

  const customersById = new Map(dataset.customers.map((c) => [c.id, c]));
  const customer = (id: string) => customersById.get(id);

  /** Descendants of a manager with their level and (per this manager) hidden flag. */
  function descendants(managerId: string): { id: string; level: number; hidden: boolean }[] {
    const out: { id: string; level: number; hidden: boolean }[] = [];
    const walk = (id: string, level: number) => {
      for (const child of customer(id)?.children ?? []) {
        out.push({ id: child.id, level, hidden: child.hidden === true });
        walk(child.id, level + 1);
      }
    };
    walk(managerId, 1);
    return out;
  }

  function customerObject(c: FakeCustomer) {
    return {
      resourceName: `customers/${c.id}`,
      id: c.id,
      ...(c.descriptiveName ? { descriptiveName: c.descriptiveName } : {}),
      currencyCode: c.currencyCode,
      timeZone: c.timeZone,
      ...(c.manager ? { manager: true } : {}),
      status: c.status,
      ...(c.testAccount ? { testAccount: true } : {}),
    };
  }

  /** Drops undefined values (proto3 JSON omits unset fields). */
  function defined<T extends Record<string, unknown>>(value: T): T {
    return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
  }

  const textAssets = (texts: string[] | undefined) => texts?.map((text) => ({ text }));

  function campaignSource(customerId: string, c: FakeCampaign) {
    return defined({
      campaign: defined({
        id: c.id,
        name: c.name,
        status: c.status,
        servingStatus: c.servingStatus,
        advertisingChannelType: c.advertisingChannelType,
        biddingStrategyType: c.biddingStrategyType,
        startDateTime: c.startDateTime,
        endDateTime: c.endDateTime,
        campaignBudget: c.budget
          ? `customers/${customerId}/campaignBudgets/${c.budget.id}`
          : undefined,
      }),
      campaignBudget: c.budget ? defined({ ...c.budget }) : undefined,
    });
  }

  function adSource(a: FakeAd) {
    return {
      adGroupAd: defined({
        status: a.status,
        ad: defined({
          id: a.id,
          type: a.type,
          name: a.name,
          finalUrls: a.finalUrls,
          responsiveSearchAd: a.responsiveSearchAd
            ? defined({
                headlines: textAssets(a.responsiveSearchAd.headlines),
                descriptions: textAssets(a.responsiveSearchAd.descriptions),
              })
            : undefined,
          responsiveDisplayAd: a.responsiveDisplayAd
            ? defined({
                headlines: textAssets(a.responsiveDisplayAd.headlines),
                descriptions: textAssets(a.responsiveDisplayAd.descriptions),
                callToActionText: a.responsiveDisplayAd.callToActionText,
              })
            : undefined,
        }),
      }),
      adGroup: { id: a.adGroupId },
      campaign: { id: a.campaignId },
    };
  }

  /** Source rows (camelCase, all fields) of a resource for one customer. */
  function sources(customerId: string, q: ParsedQuery): Record<string, unknown>[] {
    const self = customer(customerId)!;
    const customerAttrs = { id: self.id, currencyCode: self.currencyCode, timeZone: self.timeZone };
    const actions = dataset.conversionActions[customerId] ?? [];
    if (q.from === "conversion_action") {
      return actions.map((a) => ({
        conversionAction: defined({
          resourceName: `customers/${customerId}/conversionActions/${a.id}`,
          id: a.id,
          name: a.name,
          status: a.status,
          category: a.category,
          primaryForGoal: a.primaryForGoal,
          clickThroughLookbackWindowDays:
            a.clickThroughLookbackWindowDays !== undefined
              ? String(a.clickThroughLookbackWindowDays)
              : undefined,
          viewThroughLookbackWindowDays:
            a.viewThroughLookbackWindowDays !== undefined
              ? String(a.viewThroughLookbackWindowDays)
              : undefined,
        }),
      }));
    }
    const segmented =
      q.select.some((f) => f.startsWith("segments.") || f.startsWith("metrics.")) ||
      q.where.some((c) => c.field.startsWith("segments."));
    if (q.from === "customer_client") {
      const self0 = { ...customerObject(self), level: "0", clientCustomer: `customers/${self.id}` };
      return [
        { customerClient: self0 },
        ...descendants(customerId).map((d) => {
          const c = customer(d.id)!;
          return {
            customerClient: {
              ...customerObject(c),
              clientCustomer: `customers/${c.id}`,
              level: String(d.level),
              ...(d.hidden ? { hidden: true } : {}),
            },
          };
        }),
      ];
    }
    const campaigns = dataset.campaigns[customerId] ?? [];
    const adGroups = dataset.adGroups[customerId] ?? [];
    const assetGroups = dataset.assetGroups[customerId] ?? [];
    const ads = dataset.ads[customerId] ?? [];
    const withCustomer = (source: Record<string, unknown>) => ({
      customer: customerAttrs,
      ...source,
    });
    const adGroupSource = (g: FakeAdGroup) => ({
      adGroup: defined({ id: g.id, name: g.name, status: g.status, type: g.type }),
      campaign: { id: g.campaignId },
    });
    const assetGroupSource = (g: Omit<FakeAdGroup, "type">) => ({
      assetGroup: { id: g.id, name: g.name, status: g.status },
      campaign: { id: g.campaignId },
    });

    if (!segmented) {
      switch (q.from) {
        case "customer":
          return [{ customer: customerObject(self) }];
        case "campaign":
          return campaigns.map((c) => withCustomer(campaignSource(customerId, c)));
        case "ad_group":
          return adGroups.map((g) => withCustomer(adGroupSource(g)));
        case "asset_group":
          return assetGroups.map((g) => withCustomer(assetGroupSource(g)));
        case "ad_group_ad":
          return ads.map((a) => withCustomer(adSource(a)));
      }
      return [];
    }

    const entityOf = (fact: FakeFact) => {
      switch (q.from) {
        case "customer":
          return { key: "customer", source: { customer: customerObject(self) } };
        case "campaign": {
          const c = campaigns.find((x) => x.id === fact.campaignId);
          return c ? { key: c.id, source: withCustomer(campaignSource(customerId, c)) } : undefined;
        }
        case "ad_group": {
          const g = adGroups.find((x) => x.id === fact.adGroupId);
          return g ? { key: g.id, source: withCustomer(adGroupSource(g)) } : undefined;
        }
        case "asset_group": {
          const g = assetGroups.find((x) => x.id === fact.assetGroupId);
          return g ? { key: g.id, source: withCustomer(assetGroupSource(g)) } : undefined;
        }
        case "ad_group_ad": {
          const a = ads.find((x) => x.id === fact.adId && x.adGroupId === fact.adGroupId);
          return a
            ? { key: `${a.adGroupId}~${a.id}`, source: withCustomer(adSource(a)) }
            : undefined;
        }
      }
      return undefined;
    };
    const byDate =
      q.select.includes("segments.date") || q.where.some((c) => c.field === "segments.date");
    const byNetwork = q.select.includes("segments.ad_network_type");
    const byAction = q.select.some((f) => f.startsWith("segments.conversion_action"));
    /** Google's Conversions: primary actions, plus custom-goal actions of the campaign. */
    const included = (actionId: string, campaignId: string) => {
      const action = actions.find((a) => a.id === actionId);
      return (
        action?.primaryForGoal !== false || (action.customGoalCampaigns ?? []).includes(campaignId)
      );
    };

    type Part = { fact: FakeFact; conversion?: FakeConversion };
    const groups = new Map<string, { source: Record<string, unknown>; parts: Part[] }>();
    const add = (key: string[], source: Record<string, unknown>, part: Part) => {
      const k = key.join("|");
      const group = groups.get(k) ?? { source, parts: [] };
      group.parts.push(part);
      groups.set(k, group);
    };
    for (const fact of dataset.facts.filter((f) => f.customerId === customerId)) {
      const entity = entityOf(fact);
      if (!entity) continue;
      const base = [entity.key, byDate ? fact.date : "", byNetwork ? fact.network : ""];
      const segments = {
        ...(byDate ? { date: fact.date } : {}),
        ...(byNetwork ? { adNetworkType: fact.network } : {}),
      };
      if (!byAction) {
        add(base, { ...entity.source, segments }, { fact });
        continue;
      }
      for (const conversion of fact.conversions ?? []) {
        const action = actions.find((a) => a.id === conversion.actionId)!;
        add(
          [...base, conversion.actionId],
          {
            ...entity.source,
            segments: {
              ...segments,
              conversionAction: `customers/${customerId}/conversionActions/${action.id}`,
              conversionActionName: action.name,
              conversionActionCategory: action.category,
            },
          },
          { fact, conversion },
        );
      }
    }

    const rows: Record<string, unknown>[] = [];
    for (const { source, parts } of groups.values()) {
      const attributed = parts.flatMap((p) =>
        (p.conversion ? [p.conversion] : (p.fact.conversions ?? [])).map((c) => ({
          c,
          campaignId: p.fact.campaignId,
        })),
      );
      const conversions = attributed.map((a) => a.c);
      const sum = (list: FakeConversion[], pick: (c: FakeConversion) => number) =>
        list.reduce((total, c) => total + pick(c), 0);
      const counted = attributed
        .filter((a) => included(a.c.actionId, a.campaignId))
        .map((a) => a.c);
      const metrics: Record<string, unknown> = {
        conversions: sum(counted, (c) => c.count),
        conversionsValue: sum(counted, (c) => c.value ?? 0),
        allConversions: sum(conversions, (c) => c.count),
        allConversionsValue: sum(conversions, (c) => c.value ?? 0),
      };
      if (!byAction) {
        metrics.impressions = String(parts.reduce((t, p) => t + p.fact.impressions, 0));
        metrics.clicks = String(parts.reduce((t, p) => t + p.fact.clicks, 0));
        metrics.costMicros = String(parts.reduce((t, p) => t + p.fact.costMicros, 0));
      }
      const row = { ...source, metrics };
      for (const name of options.omitMetrics?.({ from: q.from, row }) ?? []) delete metrics[name];
      rows.push(row);
    }
    return rows;
  }

  function search(customerId: string, q: ParsedQuery): Record<string, unknown>[] {
    const rows = sources(customerId, q).filter((source) =>
      q.where.every((c) => matches(source, c)),
    );
    if (q.orderBy.length > 0) {
      rows.sort((a, b) => {
        for (const { field, direction } of q.orderBy) {
          const cmp = compareValues(read(a, field), read(b, field));
          if (cmp !== 0) return direction === "DESC" ? -cmp : cmp;
        }
        return 0;
      });
    }
    const limited = q.limit !== undefined ? rows.slice(0, q.limit) : rows;
    return limited.map((source) => {
      const row: Record<string, unknown> = {};
      for (const field of q.select) {
        const value = read(source, field);
        if (value !== undefined) assign(row, field, value);
      }
      return row;
    });
  }

  async function route(entry: GoogleLogEntry, request: Request): Promise<Response> {
    // --- OAuth token endpoint ------------------------------------------------
    if (entry.kind === "token_exchange" || entry.kind === "token_refresh") {
      const form = new URLSearchParams(await request.text());
      if (
        form.get("client_id") !== FAKE_GOOGLE_CLIENT_ID ||
        form.get("client_secret") !== FAKE_GOOGLE_CLIENT_SECRET
      ) {
        return toResponse(oauthErrorResponse(401, "invalid_client"));
      }
      const issueAccess = (user: string) => {
        seq += 1;
        const token = `test-access-${user}-${seq}`;
        accessTokens.set(token, user);
        return token;
      };
      if (form.get("grant_type") === "refresh_token") {
        const user = refreshTokens.get(form.get("refresh_token") ?? "");
        if (user === undefined) return toResponse(oauthErrorResponse(400, "invalid_grant"));
        return json(200, {
          access_token: issueAccess(user),
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/adwords openid",
          token_type: "Bearer",
        });
      }
      const issued = codes.get(form.get("code") ?? "");
      if (
        !issued ||
        issued.used ||
        form.get("grant_type") !== "authorization_code" ||
        (issued.redirectUri !== undefined && form.get("redirect_uri") !== issued.redirectUri) ||
        (await s256(form.get("code_verifier") ?? "")) !== issued.challenge
      ) {
        return toResponse(oauthErrorResponse(400, "invalid_grant"));
      }
      issued.used = true;
      const user = users[issued.user]!;
      const refreshToken = `test-refresh-${issued.user}`;
      refreshTokens.set(refreshToken, issued.user);
      return json(200, {
        access_token: issueAccess(issued.user),
        expires_in: 3599,
        ...(user.omitRefreshToken ? {} : { refresh_token: refreshToken }),
        scope: "https://www.googleapis.com/auth/adwords openid",
        token_type: "Bearer",
        id_token: "fake-id-token",
      });
    }

    const bearer = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
    const userId = accessTokens.get(bearer);
    const user = userId !== undefined ? users[userId] : undefined;
    if (!user) {
      return toResponse(
        adsError(401, "UNAUTHENTICATED", "authenticationError", "OAUTH_TOKEN_INVALID"),
      );
    }
    if (entry.kind === "userinfo") return json(200, { sub: user.sub });

    // --- Google Ads API (no developer token: sunset 2026-09-09, the header is ignored) ---
    if (entry.kind === "accessible") {
      if (user.notAdsUser) {
        return toResponse(adsError(401, "UNAUTHENTICATED", "authenticationError", "NOT_ADS_USER"));
      }
      return json(200, {
        ...(user.accessible.length > 0
          ? { resourceNames: user.accessible.map((id) => `customers/${id}`) }
          : {}),
      });
    }
    if (entry.kind !== "search")
      return toResponse(adsError(404, "NOT_FOUND", "requestError", "UNKNOWN"));

    // --- search: access rules -------------------------------------------------------
    const customerId = entry.customerId!;
    const login = entry.loginCustomerId;
    const target = customer(customerId);
    if (!target) {
      return toResponse(
        adsError(400, "INVALID_ARGUMENT", "authenticationError", "CUSTOMER_NOT_FOUND"),
      );
    }
    if (login === undefined) {
      if (!user.accessible.includes(customerId)) return toResponse(permissionDenied());
    } else if (
      !user.accessible.includes(login) ||
      (login !== customerId && !descendants(login).some((d) => d.id === customerId))
    ) {
      return toResponse(permissionDenied());
    }
    if (target.status === "CANCELED" || target.status === "CLOSED") {
      return toResponse(
        adsError(403, "PERMISSION_DENIED", "authorizationError", "CUSTOMER_NOT_ENABLED"),
      );
    }
    if (accessLevel === "test" && !target.testAccount) {
      return toResponse(
        adsError(
          403,
          "PERMISSION_DENIED",
          "authorizationError",
          "CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION",
        ),
      );
    }

    const body = (await request.json()) as { query?: string; pageToken?: string };
    let q: ParsedQuery;
    try {
      q = parseGaql(body.query ?? "");
      validateQuery(q);
    } catch (error) {
      if (error instanceof QueryFailure) return toResponse(queryError(error.code));
      throw error;
    }
    const key = `${customerId}|${body.query}`;
    let offset = 0;
    if (body.pageToken !== undefined) {
      const token = validPageTokens.get(body.pageToken);
      if (token === undefined) {
        return toResponse(
          adsError(
            400,
            "INVALID_ARGUMENT",
            "requestError",
            /^pt_/.test(body.pageToken) ? "EXPIRED_PAGE_TOKEN" : "INVALID_PAGE_TOKEN",
          ),
        );
      }
      if (token.key !== key) {
        return toResponse(adsError(400, "INVALID_ARGUMENT", "requestError", "INVALID_PAGE_TOKEN"));
      }
      offset = token.offset;
    }
    const rows = search(customerId, q);
    const page = rows.slice(offset, offset + pageSize);
    const hasMore = offset + pageSize < rows.length;
    let nextPageToken: string | undefined;
    if (hasMore) {
      nextPageToken = `pt_${btoa(`${key}|${offset + pageSize}`)
        .replace(/[^A-Za-z0-9]/g, "")
        .slice(0, 40)}_${offset + pageSize}`;
      validPageTokens.set(nextPageToken, { key, offset: offset + pageSize });
    }
    return json(200, {
      ...(page.length > 0 ? { results: page } : {}),
      ...(nextPageToken !== undefined ? { nextPageToken } : {}),
      fieldMask: q.select.map((f) => camel(f).join(".")).join(","),
    });
  }

  const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const searchMatch = /^\/(v\d+)\/customers\/(\d{10})\/googleAds:search$/.exec(url.pathname);
    const kind: GoogleLogEntry["kind"] =
      url.host === "oauth2.googleapis.com" && url.pathname === "/token"
        ? new URLSearchParams(await request.clone().text()).get("grant_type") === "refresh_token"
          ? "token_refresh"
          : "token_exchange"
        : url.host === "openidconnect.googleapis.com" && url.pathname === "/v1/userinfo"
          ? "userinfo"
          : url.host === "googleads.googleapis.com" &&
              /^\/v\d+\/customers:listAccessibleCustomers$/.test(url.pathname)
            ? "accessible"
            : url.host === "googleads.googleapis.com" && searchMatch
              ? "search"
              : "other";
    const text =
      request.method === "POST" && kind === "search" ? await request.clone().text() : undefined;
    const searchBody =
      text !== undefined ? (JSON.parse(text) as { query?: string; pageToken?: string }) : undefined;
    const formFields =
      kind === "token_exchange" || kind === "token_refresh"
        ? formKeys(await request.clone().text())
        : [];
    const allTokens = [...accessTokens.keys(), ...refreshTokens.keys(), FAKE_GOOGLE_CLIENT_SECRET];
    const entry: GoogleLogEntry = {
      method: request.method,
      host: url.host,
      path: url.pathname,
      kind,
      hasBearer: (request.headers.get("authorization") ?? "").startsWith("Bearer "),
      developerTokenHeader: request.headers.has("developer-token"),
      ...(request.headers.get("login-customer-id") !== null
        ? { loginCustomerId: request.headers.get("login-customer-id")! }
        : {}),
      ...(searchMatch ? { customerId: searchMatch[2]! } : {}),
      ...(searchBody?.query !== undefined ? { query: searchBody.query } : {}),
      ...(searchBody !== undefined ? { pageToken: searchBody.pageToken !== undefined } : {}),
      formFields,
      secretInUrl:
        ["access_token", "refresh_token", "client_secret", "code"].some((p) =>
          url.searchParams.has(p),
        ) || allTokens.some((token) => request.url.includes(token)),
    };
    log.push(entry);
    for (const rule of rules) {
      if ((rule.times ?? 1) > 0 && rule.match(entry)) {
        rule.times = (rule.times ?? 1) - 1;
        if (rule.response === "network") throw new TypeError("fetch failed");
        if (rule.response === "hang") {
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          });
        }
        return toResponse(rule.response);
      }
    }
    if (kind === "other") return toResponse(adsError(404, "NOT_FOUND", "requestError", "UNKNOWN"));
    return await route(entry, request);
  };

  return {
    fetch: fakeFetch as typeof fetch,
    log,
    issueCode(user, codeChallenge, redirectUri) {
      seq += 1;
      const code = `test-gcode-${seq}`;
      codes.set(code, {
        user,
        challenge: codeChallenge,
        ...(redirectUri !== undefined ? { redirectUri } : {}),
        used: false,
      });
      return code;
    },
    grantRefreshToken(user) {
      const token = `test-refresh-${user}`;
      refreshTokens.set(token, user);
      return token;
    },
    inject(rule) {
      rules.push(rule);
    },
    revoke(user) {
      for (const [token, owner] of refreshTokens) if (owner === user) refreshTokens.delete(token);
    },
    expirePageTokens() {
      validPageTokens = new Map();
    },
    setAccessLevel(level) {
      accessLevel = level;
    },
    counts() {
      const out = {
        token_exchange: 0,
        token_refresh: 0,
        userinfo: 0,
        accessible: 0,
        search: 0,
        other: 0,
      };
      for (const entry of log) out[entry.kind] += 1;
      return out;
    },
    searchesFor(customerId) {
      return log.filter((e) => e.kind === "search" && e.customerId === customerId).length;
    },
  };
}

/** A stored-credential shape for a refresh token granted by the fake. */
export function fakeGoogleCredential(
  refreshToken: string,
  clientId: string = FAKE_GOOGLE_CLIENT_ID,
): GoogleCredential {
  return {
    kind: "google",
    v: 1,
    refreshToken,
    clientId,
    issuedAt: 1,
    scopes: ["https://www.googleapis.com/auth/adwords", "openid"],
  };
}

/** Installs the fake as the runtime's global `fetch` (undo with vi.unstubAllGlobals()). */
export function installFakeGoogleAds(fake: FakeGoogleAds = createFakeGoogleAds()): FakeGoogleAds {
  vi.stubGlobal("fetch", fake.fetch);
  return fake;
}
