import { normalizeMetaAdAccountId, normalizeNumericId } from "../../domain/identity";
import type {
  ActionType,
  AdAccountStatus,
  CreativeFormat,
  DeliveryStatus,
  EntityStatus,
  Objective,
  Placement,
} from "../../domain/types";
import { toDateKey, type DateKey } from "../../lib/dates";
import {
  currencyMinorUnits,
  microsToDecimalString,
  parseDecimalToMicros,
  sumMicros,
} from "../../lib/money";
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
  type ActionCell,
  type LeafGenerator,
  type LeafSpec,
  type NeutralMetrics,
  type NeutralRow,
} from "./generator";

// Meta-like mock. Raw payloads mimic Marketing API shapes: "act_" account ids,
// numbers as strings, spend as decimal strings, budgets in minor units,
// ISO times with "+hhmm" offsets, publisher_platform, actions/action_values.

// ---------------------------------------------------------------------------
// Raw shapes
// ---------------------------------------------------------------------------

type MetaRawAccount = {
  id: string;
  account_id: string;
  name: string;
  currency: string;
  timezone_name: string;
  account_status: number;
  business?: { id: string };
};
type MetaRawCampaign = {
  id: string;
  account_id: string;
  name: string;
  status: string;
  effective_status: string;
  objective: string;
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  start_time: string;
  stop_time?: string;
  created_time: string;
  updated_time: string;
};
type MetaRawAdSet = {
  id: string;
  campaign_id: string;
  account_id: string;
  name: string;
  status: string;
  effective_status: string;
  daily_budget?: string;
  optimization_goal: string;
  attribution_spec?: { event_type: "CLICK_THROUGH" | "VIEW_THROUGH"; window_days: number }[];
  start_time: string;
  end_time?: string;
  updated_time: string;
};
type MetaRawAd = {
  id: string;
  adset_id: string;
  campaign_id: string;
  account_id: string;
  name: string;
  status: string;
  effective_status: string;
  creative?: { id: string };
  updated_time: string;
};
type MetaRawCreative = {
  id: string;
  account_id: string;
  object_type: "PHOTO" | "VIDEO" | "SHARE";
  child_attachments_count?: number;
  title?: string;
  body?: string;
  call_to_action_type?: string;
  link_url?: string;
  thumbnail_url?: string;
  effective_instagram_media_id?: string;
  effective_object_story_id?: string;
};
type MetaAction = { action_type: string; value: string; "1d_click"?: string };
type MetaRawInsight = {
  account_id: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
  date_start: string;
  date_stop: string;
  publisher_platform?: string;
  account_currency: string;
  spend: string;
  impressions: string;
  clicks: string;
  reach?: string;
  inline_link_clicks?: string;
  video_play_actions?: MetaAction[];
  actions?: MetaAction[];
  action_values?: MetaAction[];
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ACCOUNTS: MetaRawAccount[] = [
  {
    id: "act_1001",
    account_id: "1001",
    name: "Acme Retail US",
    currency: "USD",
    timezone_name: "America/New_York",
    account_status: 1,
    business: { id: "5550001" },
  },
  {
    id: "act_1002",
    account_id: "1002",
    name: "Acme Indonesia",
    currency: "IDR",
    timezone_name: "Asia/Jakarta",
    account_status: 1,
  },
  {
    id: "act_1003",
    account_id: "1003",
    name: "Empty sandbox",
    currency: "EUR",
    timezone_name: "Europe/Berlin",
    account_status: 2,
  },
];

type MetaTree = {
  campaigns: MetaRawCampaign[];
  adsets: MetaRawAdSet[];
  ads: MetaRawAd[];
  creatives: MetaRawCreative[];
  /** Internal delivery windows (not part of raw payloads): by campaign id / ad id override. */
  delivery: Record<string, { from: DateKey; to?: DateKey }>;
  adDeliveryTo: Record<string, DateKey>;
  cpmMicros: bigint;
  aovMicros: bigint;
};

const T0 = "2026-01-01T00:00:00-0500";

const TREES: Record<string, MetaTree> = {
  "1001": {
    campaigns: [
      {
        id: "120210000000101",
        account_id: "1001",
        name: "Prospecting — CBO",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        objective: "OUTCOME_SALES",
        daily_budget: "15000",
        bid_strategy: "LOWEST_COST_WITHOUT_CAP",
        start_time: T0,
        created_time: "2025-12-20T09:00:00-0500",
        updated_time: "2026-02-01T10:00:00-0500",
      },
      {
        id: "120210000000102",
        account_id: "1001",
        name: "Lead gen — ABO",
        status: "PAUSED",
        effective_status: "PAUSED",
        objective: "OUTCOME_LEADS",
        start_time: "2026-03-01T00:00:00-0500",
        stop_time: "2026-06-30T23:59:59-0400",
        created_time: "2026-02-25T09:00:00-0500",
        updated_time: "2026-04-16T08:00:00-0400",
      },
      {
        id: "120210000000103",
        account_id: "1001",
        name: "Holiday awareness",
        status: "ARCHIVED",
        effective_status: "ARCHIVED",
        objective: "OUTCOME_AWARENESS",
        lifetime_budget: "500000",
        start_time: "2025-11-01T00:00:00-0400",
        stop_time: "2025-12-31T23:59:59-0500",
        created_time: "2025-10-20T09:00:00-0400",
        updated_time: "2026-01-05T09:00:00-0500",
      },
    ],
    adsets: [
      {
        id: "120210000000201",
        campaign_id: "120210000000101",
        account_id: "1001",
        name: "Broad US",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        optimization_goal: "OFFSITE_CONVERSIONS",
        attribution_spec: [
          { event_type: "CLICK_THROUGH", window_days: 7 },
          { event_type: "VIEW_THROUGH", window_days: 1 },
        ],
        start_time: T0,
        updated_time: "2026-01-10T10:00:00-0500",
      },
      {
        id: "120210000000202",
        campaign_id: "120210000000101",
        account_id: "1001",
        name: "Lookalike 1%",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        optimization_goal: "OFFSITE_CONVERSIONS",
        attribution_spec: [{ event_type: "CLICK_THROUGH", window_days: 1 }],
        start_time: T0,
        updated_time: "2026-01-12T10:00:00-0500",
      },
      {
        id: "120210000000203",
        campaign_id: "120210000000102",
        account_id: "1001",
        name: "Retargeting 30d",
        status: "PAUSED",
        effective_status: "CAMPAIGN_PAUSED",
        daily_budget: "4000",
        optimization_goal: "LEAD_GENERATION",
        start_time: "2026-03-01T00:00:00-0500",
        end_time: "2026-06-30T23:59:59-0400",
        updated_time: "2026-04-16T08:00:00-0400",
      },
      {
        id: "120210000000204",
        campaign_id: "120210000000103",
        account_id: "1001",
        name: "Holiday broad",
        status: "ARCHIVED",
        effective_status: "ARCHIVED",
        optimization_goal: "REACH",
        start_time: "2025-11-01T00:00:00-0400",
        end_time: "2025-12-31T23:59:59-0500",
        updated_time: "2026-01-05T09:00:00-0500",
      },
    ],
    ads: [
      ad(
        "120210000000301",
        "120210000000201",
        "120210000000101",
        "UGC video A",
        "ACTIVE",
        "ACTIVE",
        "120210000000401",
      ),
      ad(
        "120210000000302",
        "120210000000201",
        "120210000000101",
        "Static image B",
        "ACTIVE",
        "ACTIVE",
        "120210000000402",
      ),
      ad(
        "120210000000303",
        "120210000000202",
        "120210000000101",
        "Carousel C",
        "ACTIVE",
        "ACTIVE",
        "120210000000403",
      ),
      ad(
        "120210000000304",
        "120210000000202",
        "120210000000101",
        "Old test ad",
        "DELETED",
        "DELETED",
      ),
      ad(
        "120210000000305",
        "120210000000203",
        "120210000000102",
        "Lead form",
        "PAUSED",
        "CAMPAIGN_PAUSED",
        "120210000000404",
      ),
      ad(
        "120210000000306",
        "120210000000204",
        "120210000000103",
        "Holiday ad",
        "ARCHIVED",
        "ARCHIVED",
        "120210000000402",
      ),
    ],
    creatives: [
      {
        id: "120210000000401",
        account_id: "1001",
        object_type: "VIDEO",
        title: "See it in action",
        body: "Our bestseller, filmed by customers.",
        call_to_action_type: "SHOP_NOW",
        link_url: "https://shop.example.test/bestseller",
        thumbnail_url: "https://cdn.example.test/thumb/401.jpg",
        effective_instagram_media_id: "17900000000000401",
        effective_object_story_id: "5550001_900000401",
      },
      {
        id: "120210000000402",
        account_id: "1001",
        object_type: "PHOTO",
        title: "New season",
        body: "Fresh arrivals are here.",
        call_to_action_type: "LEARN_MORE",
        link_url: "https://shop.example.test/new",
        thumbnail_url: "https://cdn.example.test/thumb/402.jpg",
      },
      {
        id: "120210000000403",
        account_id: "1001",
        object_type: "SHARE",
        child_attachments_count: 3,
        body: "Swipe to see the collection.",
        call_to_action_type: "SHOP_NOW",
        link_url: "https://shop.example.test/collection",
        effective_instagram_media_id: "17900000000000403",
      },
      {
        id: "120210000000404",
        account_id: "1001",
        object_type: "PHOTO",
        title: "Get a quote",
        call_to_action_type: "SIGN_UP",
      },
    ],
    delivery: {
      "120210000000101": { from: "2026-01-01" },
      "120210000000102": { from: "2026-03-01", to: "2026-04-15" },
      "120210000000103": { from: "2025-11-01", to: "2025-12-31" },
    },
    adDeliveryTo: { "120210000000304": "2026-02-15" },
    cpmMicros: 9_000_000n,
    aovMicros: 65_000_000n,
  },
  "1002": {
    campaigns: [
      {
        id: "120210000000501",
        account_id: "1002",
        name: "Jakarta always-on",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        objective: "OUTCOME_TRAFFIC",
        daily_budget: "150000000",
        start_time: "2026-02-01T00:00:00+0700",
        created_time: "2026-01-25T09:00:00+0700",
        updated_time: "2026-02-01T09:00:00+0700",
      },
    ],
    adsets: [
      {
        id: "120210000000601",
        campaign_id: "120210000000501",
        account_id: "1002",
        name: "Jakarta 18-44",
        status: "ACTIVE",
        effective_status: "ACTIVE",
        optimization_goal: "LINK_CLICKS",
        start_time: "2026-02-01T00:00:00+0700",
        updated_time: "2026-02-01T09:00:00+0700",
      },
    ],
    ads: [
      ad(
        "120210000000701",
        "120210000000601",
        "120210000000501",
        "Promo banner",
        "ACTIVE",
        "ACTIVE",
        "120210000000801",
        "1002",
      ),
    ],
    creatives: [
      {
        id: "120210000000801",
        account_id: "1002",
        object_type: "PHOTO",
        title: "Promo",
        link_url: "https://shop.example.test/id",
      },
    ],
    delivery: { "120210000000501": { from: "2026-02-01" } },
    adDeliveryTo: {},
    // IDR: large per-impression cost so yearly aggregates exceed 2^53 micros.
    cpmMicros: 30_000_000_000_000n,
    aovMicros: 0n,
  },
  "1003": {
    campaigns: [],
    adsets: [],
    ads: [],
    creatives: [],
    delivery: {},
    adDeliveryTo: {},
    cpmMicros: 0n,
    aovMicros: 0n,
  },
};

function ad(
  id: string,
  adsetId: string,
  campaignId: string,
  name: string,
  status: string,
  effective: string,
  creativeId?: string,
  accountId = "1001",
): MetaRawAd {
  return {
    id,
    adset_id: adsetId,
    campaign_id: campaignId,
    account_id: accountId,
    name,
    status,
    effective_status: effective,
    ...(creativeId ? { creative: { id: creativeId } } : {}),
    updated_time: "2026-01-15T10:00:00-0500",
  };
}

/** Raw record that fails normalization (malformed scenario). */
const MALFORMED_CAMPAIGN: MetaRawCampaign = {
  id: "120210000000999",
  account_id: "1001",
  name: "Broken",
  status: "ACTIVE",
  effective_status: "ACTIVE",
  objective: "OUTCOME_SALES",
  start_time: "not-a-date",
  created_time: T0,
  updated_time: T0,
};

// ---------------------------------------------------------------------------
// Normalization (raw -> provider records)
// ---------------------------------------------------------------------------

const ACCOUNT_STATUS: Record<number, AdAccountStatus> = {
  1: "active",
  2: "disabled",
  3: "disabled",
  7: "pending",
  9: "active",
  101: "closed",
};
const STATUS: Record<string, EntityStatus> = {
  ACTIVE: "active",
  PAUSED: "paused",
  ARCHIVED: "archived",
  DELETED: "removed",
  IN_PROCESS: "pending",
  WITH_ISSUES: "pending",
};
const DELIVERY: Record<string, DeliveryStatus> = {
  ACTIVE: "delivering",
  PAUSED: "not_delivering",
  CAMPAIGN_PAUSED: "not_delivering",
  ADSET_PAUSED: "not_delivering",
  PENDING_REVIEW: "not_delivering",
  DISAPPROVED: "not_delivering",
  ARCHIVED: "ended",
  DELETED: "ended",
};
const OBJECTIVE: Record<string, Objective> = {
  OUTCOME_SALES: "sales",
  OUTCOME_LEADS: "leads",
  OUTCOME_AWARENESS: "awareness",
  OUTCOME_TRAFFIC: "traffic",
  OUTCOME_ENGAGEMENT: "engagement",
  OUTCOME_APP_PROMOTION: "app_promotion",
};
const PLACEMENT: Record<string, Placement> = {
  facebook: "facebook",
  instagram: "instagram",
  audience_network: "audience_network",
  messenger: "messenger",
  threads: "threads",
};
const RAW_PLACEMENT: Partial<Record<Placement, string>> = Object.fromEntries(
  Object.entries(PLACEMENT).map(([raw, p]) => [p, raw]),
);

/** Conversion action types kept in actionMetricsDaily (engagement actions go to wide columns). */
const CONVERSION_TYPES: Record<string, { actionType: ActionType; primary: boolean }> = {
  "offsite_conversion.fb_pixel_purchase": { actionType: "purchase", primary: true },
  "offsite_conversion.fb_pixel_add_to_cart": { actionType: "add_to_cart", primary: false },
  lead: { actionType: "lead", primary: true },
};
const DEFAULT_WINDOW = "7d_click_1d_view";
const ONE_DAY_CLICK = "1d_click";

/** Meta times use "+hhmm" offsets; convert to "+hh:mm" before parsing. */
function parseMetaTime(value: string): number {
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (Number.isNaN(ms)) throw new Error(`Invalid Meta time "${value}"`);
  return ms;
}

function metaDay(value: string | undefined, timezone: string): DateKey | undefined {
  return value === undefined ? undefined : toDateKey(parseMetaTime(value), timezone);
}

/** Meta budgets are integer minor units of the account currency. */
function minorToMicros(value: string | undefined, currency: string): bigint | undefined {
  if (value === undefined) return undefined;
  return BigInt(value) * 10n ** BigInt(6 - currencyMinorUnits(currency));
}

function accountOf(accountId: string): MockAccountInfo {
  const raw = ACCOUNTS.find((a) => a.account_id === accountId);
  if (!raw) throw new Error(`Unknown Meta account ${accountId}`);
  return {
    externalId: normalizeMetaAdAccountId(raw.id),
    currency: raw.currency,
    timezone: raw.timezone_name,
    isManager: false,
  };
}

function normalizeAccount(raw: MetaRawAccount): ProviderAdAccount {
  return compact({
    platform: "meta" as const,
    externalId: normalizeMetaAdAccountId(raw.id),
    name: raw.name,
    currency: raw.currency,
    timezone: raw.timezone_name,
    status: ACCOUNT_STATUS[raw.account_status] ?? "unknown",
    rawStatus: String(raw.account_status),
    isManager: false,
    parentExternalId: raw.business?.id,
  });
}

function normalizeCampaign(raw: MetaRawCampaign): ProviderCampaign {
  const account = accountOf(raw.account_id);
  const daily = minorToMicros(raw.daily_budget, account.currency);
  const lifetime = minorToMicros(raw.lifetime_budget, account.currency);
  return compact({
    platform: "meta" as const,
    accountExternalId: account.externalId,
    externalId: normalizeNumericId(raw.id),
    name: raw.name,
    status: STATUS[raw.status] ?? "unknown",
    rawStatus: raw.status,
    deliveryStatus: DELIVERY[raw.effective_status] ?? "unknown",
    objective: OBJECTIVE[raw.objective] ?? "other",
    rawObjective: raw.objective,
    channelType: "social" as const,
    budgetType: daily !== undefined ? "daily" : lifetime !== undefined ? "lifetime" : "none",
    budgetMicros: daily ?? lifetime,
    // No campaign budget = ABO: budgets live on ad sets.
    budgetLevel: daily !== undefined || lifetime !== undefined ? "campaign" : "ad_group",
    bidStrategy: raw.bid_strategy,
    startDate: metaDay(raw.start_time, account.timezone),
    endDate: metaDay(raw.stop_time, account.timezone),
    platformCreatedAt: parseMetaTime(raw.created_time),
    platformUpdatedAt: parseMetaTime(raw.updated_time),
  } satisfies ProviderCampaign);
}

function attributionLabel(spec: MetaRawAdSet["attribution_spec"]): string | undefined {
  if (!spec?.length) return undefined;
  const click = spec.find((s) => s.event_type === "CLICK_THROUGH")?.window_days;
  const view = spec.find((s) => s.event_type === "VIEW_THROUGH")?.window_days;
  return [click && `${click}d_click`, view && `${view}d_view`].filter(Boolean).join("_");
}

function normalizeAdSet(raw: MetaRawAdSet): ProviderAdGroup {
  const account = accountOf(raw.account_id);
  const daily = minorToMicros(raw.daily_budget, account.currency);
  return compact({
    platform: "meta" as const,
    accountExternalId: account.externalId,
    campaignExternalId: normalizeNumericId(raw.campaign_id),
    externalId: normalizeNumericId(raw.id),
    name: raw.name,
    kind: "ad_set" as const,
    status: STATUS[raw.status] ?? "unknown",
    rawStatus: raw.status,
    deliveryStatus: DELIVERY[raw.effective_status] ?? "unknown",
    budgetType: daily !== undefined ? ("daily" as const) : undefined,
    budgetMicros: daily,
    optimizationGoal: raw.optimization_goal,
    attributionSetting: attributionLabel(raw.attribution_spec),
    startDate: metaDay(raw.start_time, account.timezone),
    endDate: metaDay(raw.end_time, account.timezone),
  } satisfies ProviderAdGroup);
}

function creativeFormat(raw: MetaRawCreative): CreativeFormat {
  if (raw.object_type === "VIDEO") return "video";
  if (raw.object_type === "SHARE" && (raw.child_attachments_count ?? 0) > 1) return "carousel";
  return "image";
}

function normalizeAd(raw: MetaRawAd, creatives: MetaRawCreative[]): ProviderAd {
  const account = accountOf(raw.account_id);
  const creative = creatives.find((c) => c.id === raw.creative?.id);
  return compact({
    platform: "meta" as const,
    accountExternalId: account.externalId,
    campaignExternalId: normalizeNumericId(raw.campaign_id),
    adGroupExternalId: normalizeNumericId(raw.adset_id),
    creativeExternalId: raw.creative ? normalizeNumericId(raw.creative.id) : undefined,
    externalId: normalizeNumericId(raw.id),
    name: raw.name,
    status: STATUS[raw.status] ?? "unknown",
    rawStatus: raw.status,
    deliveryStatus: DELIVERY[raw.effective_status] ?? "unknown",
    format: creative ? creativeFormat(creative) : undefined,
  } satisfies ProviderAd);
}

function normalizeCreative(raw: MetaRawCreative): ProviderCreative {
  const account = accountOf(raw.account_id);
  return compact({
    platform: "meta" as const,
    accountExternalId: account.externalId,
    externalId: normalizeNumericId(raw.id),
    format: creativeFormat(raw),
    title: raw.title,
    body: raw.body,
    callToAction: raw.call_to_action_type,
    linkUrl: raw.link_url,
    thumbnailUrl: raw.thumbnail_url,
    instagramMediaExternalId: raw.effective_instagram_media_id,
    facebookPostExternalId: raw.effective_object_story_id,
  } satisfies ProviderCreative);
}

function indexActions(list: MetaAction[] | undefined): Map<string, MetaAction> {
  return new Map((list ?? []).map((a) => [a.action_type, a]));
}

function optionalCount(action: MetaAction | undefined): number | undefined {
  return action === undefined ? undefined : toCount(action.value);
}

function entityOf(raw: MetaRawInsight, level: ProviderMetricRow["level"]): string {
  const id =
    level === "account"
      ? raw.account_id
      : level === "campaign"
        ? raw.campaign_id
        : level === "ad_group"
          ? raw.adset_id
          : raw.ad_id;
  if (id === undefined) throw new Error(`Insight row is missing the ${level} id`);
  return level === "account" ? normalizeMetaAdAccountId(id) : normalizeNumericId(id);
}

function normalizeInsight(
  raw: MetaRawInsight,
  level: ProviderMetricRow["level"],
): ProviderMetricRow {
  const actions = indexActions(raw.actions);
  const values = indexActions(raw.action_values);
  const primary = Object.entries(CONVERSION_TYPES)
    .filter(([, t]) => t.primary)
    .map(([type]) => type);
  const primaryCounts = primary
    .map((type) => optionalCount(actions.get(type)))
    .filter((n) => n !== undefined);
  const primaryValues = primary.map((type) => {
    const v = values.get(type);
    return v === undefined ? undefined : parseDecimalToMicros(v.value);
  });
  const videoPlays = raw.video_play_actions?.reduce((sum, a) => sum + toCount(a.value), 0);

  return compact({
    platform: "meta" as const,
    accountExternalId: normalizeMetaAdAccountId(raw.account_id),
    level,
    entityExternalId: entityOf(raw, level),
    date: raw.date_start,
    placement: raw.publisher_platform ? (PLACEMENT[raw.publisher_platform] ?? "other") : "all",
    rawPlacement: raw.publisher_platform,
    currency: raw.account_currency,
    spendMicros: parseDecimalToMicros(raw.spend),
    impressions: toCount(raw.impressions),
    clicks: toCount(raw.clicks),
    reach: raw.reach === undefined ? undefined : toCount(raw.reach),
    linkClicks: raw.inline_link_clicks === undefined ? undefined : toCount(raw.inline_link_clicks),
    videoPlays,
    videoViews: optionalCount(actions.get("video_view")),
    engagements: optionalCount(actions.get("post_engagement")),
    reactions: optionalCount(actions.get("post_reaction")),
    comments: optionalCount(actions.get("comment")),
    shares: optionalCount(actions.get("post")),
    saves: optionalCount(actions.get("onsite_conversion.post_save")),
    follows: optionalCount(actions.get("like")),
    // Absent when no primary conversion action was reported (never 0 for "unknown").
    conversions: primaryCounts.length ? primaryCounts.reduce((a, b) => a + b, 0) : undefined,
    conversionValueMicros: sumMicros(primaryValues),
  } satisfies ProviderMetricRow);
}

function normalizeInsightActions(
  raw: MetaRawInsight,
  level: ProviderMetricRow["level"],
): ProviderActionRow[] {
  const values = indexActions(raw.action_values);
  const rows: ProviderActionRow[] = [];
  for (const action of raw.actions ?? []) {
    const type = CONVERSION_TYPES[action.action_type];
    if (!type) continue;
    const value = values.get(action.action_type);
    const windows: [string, string | undefined, string | undefined][] = [
      [DEFAULT_WINDOW, action.value, value?.value],
      [ONE_DAY_CLICK, action["1d_click"], value?.["1d_click"]],
    ];
    for (const [window, count, amount] of windows) {
      if (count === undefined) continue;
      rows.push(
        compact({
          platform: "meta" as const,
          accountExternalId: normalizeMetaAdAccountId(raw.account_id),
          level,
          entityExternalId: entityOf(raw, level),
          date: raw.date_start,
          placement: raw.publisher_platform
            ? (PLACEMENT[raw.publisher_platform] ?? "other")
            : "all",
          rawPlacement: raw.publisher_platform,
          currency: raw.account_currency,
          actionType: type.actionType,
          rawActionType: action.action_type,
          attributionWindow: window,
          attributionBasis: "impression_or_click_date" as const,
          count: toCount(count),
          valueMicros: amount === undefined ? undefined : parseDecimalToMicros(amount),
          isPrimary: type.primary,
        } satisfies ProviderActionRow),
      );
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Neutral rows -> raw insights
// ---------------------------------------------------------------------------

function toRawInsight(account: MockAccountInfo, row: NeutralRow): MetaRawInsight {
  const m = row.metrics;
  const accountId = account.externalId;
  const entityKey =
    row.level === "campaign"
      ? { campaign_id: row.entityExternalId }
      : row.level === "ad_group"
        ? { adset_id: row.entityExternalId }
        : row.level === "ad"
          ? { ad_id: row.entityExternalId }
          : {};
  const engagementActions: [string, number | undefined][] = [
    ["post_engagement", m.engagements],
    ["post_reaction", m.reactions],
    ["comment", m.comments],
    ["post", m.shares],
    ["onsite_conversion.post_save", m.saves],
    ["like", m.follows],
    ["video_view", m.videoViews],
  ];
  const conversions = new Map<string, { count?: ActionCell; oneDay?: ActionCell }>();
  for (const cell of m.actions) {
    const entry = conversions.get(cell.rawActionType) ?? {};
    if (cell.window === ONE_DAY_CLICK) entry.oneDay = cell;
    else entry.count = cell;
    conversions.set(cell.rawActionType, entry);
  }

  const actions: MetaAction[] = [
    ...engagementActions
      .filter(([, value]) => value !== undefined)
      .map(([type, value]) => ({ action_type: type, value: String(value) })),
    ...[...conversions].flatMap(([type, { count, oneDay }]) =>
      count
        ? [
            {
              action_type: type,
              value: String(count.count),
              ...(oneDay ? { "1d_click": String(oneDay.count) } : {}),
            },
          ]
        : [],
    ),
  ];
  const actionValues: MetaAction[] = [...conversions].flatMap(([type, { count, oneDay }]) =>
    count?.valueMicros !== undefined
      ? [
          {
            action_type: type,
            value: microsToDecimalString(count.valueMicros),
            ...(oneDay?.valueMicros !== undefined
              ? { "1d_click": microsToDecimalString(oneDay.valueMicros) }
              : {}),
          },
        ]
      : [],
  );

  return compact({
    account_id: accountId,
    ...entityKey,
    date_start: row.date,
    date_stop: row.date,
    publisher_platform: row.placement === "all" ? undefined : RAW_PLACEMENT[row.placement],
    account_currency: account.currency,
    spend: microsToDecimalString(m.spendMicros),
    impressions: String(m.impressions),
    clicks: String(m.clicks),
    reach: m.reach === undefined ? undefined : String(m.reach),
    inline_link_clicks: m.linkClicks === undefined ? undefined : String(m.linkClicks),
    video_play_actions:
      m.videoPlays === undefined
        ? undefined
        : [{ action_type: "video_view", value: String(m.videoPlays) }],
    actions: actions.length ? actions : undefined,
    action_values: actionValues.length ? actionValues : undefined,
  });
}

// ---------------------------------------------------------------------------
// Leaf generation
// ---------------------------------------------------------------------------

const PLACEMENTS: Placement[] = ["facebook", "instagram", "audience_network"];

function leafGenerator(accountId: string): LeafGenerator {
  const tree = TREES[accountId];
  const account = accountOf(accountId);
  const minor = currencyMinorUnits(account.currency);
  return {
    cell(random, leaf, placement): NeutralMetrics | undefined {
      if (placement === "audience_network" && random() < 0.5) return undefined;
      const scale = placement === "audience_network" ? 0.3 : 1;
      const impressions = Math.floor(randomInt(random, 300, 6000) * scale);
      const clicks = Math.floor(impressions * (0.003 + random() * 0.025));
      const linkClicks = Math.floor(clicks * (0.55 + random() * 0.3));
      const reactions = randomInt(random, 0, 20);
      const comments = randomInt(random, 0, 5);
      const shares = randomInt(random, 0, 4);
      const saves = randomInt(random, 0, 3);
      const follows = randomInt(random, 0, 2);
      const videoPlays = leaf.traits.video ? Math.floor(impressions * 0.3) : undefined;
      const actions: ActionCell[] = [];
      if (leaf.traits.conversions === "purchase" && random() >= 0.35) {
        const count = randomInt(random, 1, 4);
        const value = toMinorUnitMicros(
          (BigInt(count) * tree!.aovMicros * BigInt(randomInt(random, 70, 130))) / 100n,
          minor,
        );
        const oneDay = Math.floor(count * 0.6);
        actions.push({
          rawActionType: "offsite_conversion.fb_pixel_purchase",
          window: "default",
          count,
          valueMicros: value,
        });
        if (oneDay > 0) {
          actions.push({
            rawActionType: "offsite_conversion.fb_pixel_purchase",
            window: ONE_DAY_CLICK,
            count: oneDay,
            valueMicros: toMinorUnitMicros((value * BigInt(oneDay)) / BigInt(count), minor),
          });
        }
        actions.push({
          rawActionType: "offsite_conversion.fb_pixel_add_to_cart",
          window: "default",
          count: count + randomInt(random, 0, 6),
        });
      } else if (leaf.traits.conversions === "lead" && random() >= 0.3) {
        actions.push({ rawActionType: "lead", window: "default", count: randomInt(random, 1, 3) });
      }
      return compact({
        spendMicros: toMinorUnitMicros((BigInt(impressions) * tree!.cpmMicros) / 1000n, minor),
        impressions,
        clicks,
        linkClicks,
        videoPlays,
        videoViews: videoPlays === undefined ? undefined : Math.floor(videoPlays * 0.5),
        engagements: reactions + comments + shares + saves + follows + linkClicks,
        reactions,
        comments,
        shares,
        saves,
        follows,
        actions,
      });
    },
    reach: (random, impressions) => Math.floor(impressions * (0.55 + random() * 0.35)),
  };
}

function leaves(accountId: string): LeafSpec[] {
  const tree = TREES[accountId];
  if (!tree) return [];
  return tree.ads.map((raw) => {
    const campaign = tree.campaigns.find((c) => c.id === raw.campaign_id)!;
    const creative = tree.creatives.find((c) => c.id === raw.creative?.id);
    const window = tree.delivery[raw.campaign_id]!;
    const to = tree.adDeliveryTo[raw.id] ?? window.to;
    return compact({
      level: "ad" as const,
      externalId: raw.id,
      campaignExternalId: raw.campaign_id,
      adGroupExternalId: raw.adset_id,
      deliveryFrom: window.from,
      deliveryTo: to,
      placements: PLACEMENTS,
      traits: {
        video: creative?.object_type === "VIDEO",
        conversions:
          campaign.objective === "OUTCOME_SALES"
            ? ("purchase" as const)
            : campaign.objective === "OUTCOME_LEADS"
              ? ("lead" as const)
              : ("none" as const),
      },
    });
  });
}

// ---------------------------------------------------------------------------
// Flavor
// ---------------------------------------------------------------------------

export const META_MOCK_CAPABILITIES: AdsProviderCapabilities = {
  entities: { campaigns: true, adGroups: true, ads: true, creatives: true },
  adGroupKinds: ["ad_set"],
  incrementalEntities: true,
  metricLevels: ["account", "campaign", "ad_group", "ad"],
  placementBreakdown: true,
  placements: ["all", "facebook", "instagram", "audience_network"],
  reportedMetrics: [
    "spendMicros",
    "impressions",
    "reach",
    "clicks",
    "linkClicks",
    "videoPlays",
    "videoViews",
    "engagements",
    "reactions",
    "comments",
    "shares",
    "saves",
    "follows",
    "conversions",
    "conversionValueMicros",
  ],
  actionMetrics: true,
  attributionWindows: [DEFAULT_WINDOW, ONE_DAY_CLICK],
  maxMetricsRangeDays: 93,
  defaultPageSize: 25,
  maxPageSize: 100,
  restatementLookbackDays: 28,
};

function entries<Raw extends { id: string }, T>(
  raws: Raw[],
  normalize: (raw: Raw) => T,
  updatedAt?: (raw: Raw) => number,
): RawEntry<T>[] {
  return bySortKey(
    raws.map((raw) =>
      compact({
        sortKey: raw.id,
        updatedAt: updatedAt?.(raw),
        normalize: () => normalize(raw),
      }),
    ),
  );
}

export const metaFlavor: MockFlavor = {
  platform: "meta",
  capabilities: META_MOCK_CAPABILITIES,
  deniedAccountExternalId: "1002",
  accounts: () => entries(ACCOUNTS, normalizeAccount),
  accountInfo(externalId) {
    return ACCOUNTS.some((a) => a.account_id === externalId) ? accountOf(externalId) : undefined;
  },
  campaigns(accountId, malformed) {
    const raws = [...(TREES[accountId]?.campaigns ?? [])];
    if (malformed && accountId === "1001") raws.push(MALFORMED_CAMPAIGN);
    return entries(raws, normalizeCampaign, (r) => parseMetaTime(r.updated_time));
  },
  adGroups: (accountId) =>
    entries(TREES[accountId]?.adsets ?? [], normalizeAdSet, (r) => parseMetaTime(r.updated_time)),
  ads(accountId) {
    const creatives = TREES[accountId]?.creatives ?? [];
    return entries(
      TREES[accountId]?.ads ?? [],
      (raw) => normalizeAd(raw, creatives),
      (r) => parseMetaTime(r.updated_time),
    );
  },
  creatives: (accountId) => entries(TREES[accountId]?.creatives ?? [], normalizeCreative),
  leaves,
  generator: leafGenerator,
  metricRows: (account, rows) =>
    rows.map((row) => normalizeInsight(toRawInsight(account, row), row.level)),
  actionRows: (account, rows) =>
    rows.flatMap((row) => normalizeInsightActions(toRawInsight(account, row), row.level)),
};
