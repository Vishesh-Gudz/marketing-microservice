import type {
  ActionType,
  CreativeFormat,
  DeliveryStatus,
  EntityLevel,
  EntityStatus,
  Objective,
  Placement,
} from "../../domain/types";
import { currencyMinorUnits } from "../../lib/money";

/**
 * Meta semantic definitions (Phase 8 Stage B). Every choice that depends on how Meta
 * actually behaves is ONE named definition here, tagged:
 *
 *   [doc]          taken from the Marketing API reference / our canonical model
 *   [PROVISIONAL]  a documented or reasoned assumption NOT yet verified against a real
 *                  ad account ("Real-account validation required" in docs/providers/meta.md,
 *                  item ids R1…R20). Changing one of these must not require touching the
 *                  provider engine or the sync engine.
 *
 * Unknown raw values never become a guessed canonical value: statuses fall back to
 * "unknown", objectives to "other", formats to "other", placements to "other" (with the
 * raw value kept), and metrics that are not reported stay ABSENT (never 0).
 */

// ---------------------------------------------------------------------------
// Levels and statuses
// ---------------------------------------------------------------------------

/** Canonical level → Graph insights `level` / id field / effective_status filter field. [doc] */
export const GRAPH_LEVEL: Readonly<
  Record<EntityLevel, { level: string; idField: string; statusField?: string }>
> = {
  account: { level: "account", idField: "account_id" },
  campaign: { level: "campaign", idField: "campaign_id", statusField: "campaign.effective_status" },
  ad_group: { level: "adset", idField: "adset_id", statusField: "adset.effective_status" },
  ad: { level: "ad", idField: "ad_id", statusField: "ad.effective_status" },
};

/**
 * The COMPLETE documented effective_status enum per object type. [doc] Listings pass it
 * as `effective_status` and insights as a `filtering` IN-clause so that DELETED and
 * ARCHIVED objects (and their delivery) are included. [PROVISIONAL R6: Meta excludes
 * deleted/archived objects unless asked; if Meta rejects a value the request fails
 * visibly with invalid_request instead of silently dropping rows.]
 */
export const EFFECTIVE_STATUSES = {
  campaign: ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"],
  adset: [
    "ACTIVE",
    "PAUSED",
    "DELETED",
    "CAMPAIGN_PAUSED",
    "ARCHIVED",
    "IN_PROCESS",
    "WITH_ISSUES",
  ],
  ad: [
    "ACTIVE",
    "PAUSED",
    "DELETED",
    "PENDING_REVIEW",
    "DISAPPROVED",
    "PREAPPROVED",
    "PENDING_BILLING_INFO",
    "CAMPAIGN_PAUSED",
    "ARCHIVED",
    "ADSET_PAUSED",
    "IN_PROCESS",
    "WITH_ISSUES",
  ],
} as const;

/** Configured `status` → canonical status. [doc] Anything else → "unknown". */
export const ENTITY_STATUS: Readonly<Record<string, EntityStatus>> = {
  ACTIVE: "active",
  PAUSED: "paused",
  ARCHIVED: "archived",
  DELETED: "removed",
};

/**
 * `effective_status` → canonical delivery status. [PROVISIONAL R5] Anything else →
 * "unknown". "limited" is used only for WITH_ISSUES; review/billing states are
 * "not_delivering" (the ad is not serving).
 */
export const DELIVERY_STATUS: Readonly<Record<string, DeliveryStatus>> = {
  ACTIVE: "delivering",
  PAUSED: "not_delivering",
  CAMPAIGN_PAUSED: "not_delivering",
  ADSET_PAUSED: "not_delivering",
  PENDING_REVIEW: "not_delivering",
  DISAPPROVED: "not_delivering",
  PREAPPROVED: "not_delivering",
  PENDING_BILLING_INFO: "not_delivering",
  IN_PROCESS: "not_delivering",
  WITH_ISSUES: "limited",
  ARCHIVED: "ended",
  DELETED: "ended",
};

/**
 * Campaign objective → canonical objective. ODAX `OUTCOME_*` values plus the legacy
 * objectives older campaigns still carry. [doc] Absent → "unknown"; unlisted → "other"
 * (the raw objective is always kept in `rawObjective`).
 */
export const OBJECTIVE: Readonly<Record<string, Objective>> = {
  OUTCOME_SALES: "sales",
  OUTCOME_LEADS: "leads",
  OUTCOME_AWARENESS: "awareness",
  OUTCOME_TRAFFIC: "traffic",
  OUTCOME_ENGAGEMENT: "engagement",
  OUTCOME_APP_PROMOTION: "app_promotion",
  CONVERSIONS: "sales",
  PRODUCT_CATALOG_SALES: "sales",
  LEAD_GENERATION: "leads",
  BRAND_AWARENESS: "awareness",
  REACH: "awareness",
  LINK_CLICKS: "traffic",
  POST_ENGAGEMENT: "engagement",
  PAGE_LIKES: "engagement",
  EVENT_RESPONSES: "engagement",
  MESSAGES: "engagement",
  VIDEO_VIEWS: "video_views",
  APP_INSTALLS: "app_promotion",
  STORE_VISITS: "local",
};

/**
 * Creative `object_type` → canonical format. [PROVISIONAL R8] Only unambiguous types are
 * mapped; SHARE (link ads, which may be single-image or carousel) and everything else →
 * "other" (the raw type is kept in attributes.objectType). No carousel is guessed.
 */
export const CREATIVE_FORMAT: Readonly<Record<string, CreativeFormat>> = {
  PHOTO: "image",
  VIDEO: "video",
  STATUS: "text",
};

/** Ad set attribution_spec event types → window label suffix. [doc] */
export const ATTRIBUTION_EVENT: Readonly<Record<string, string>> = {
  CLICK_THROUGH: "click",
  VIEW_THROUGH: "view",
  ENGAGED_VIDEO_VIEW: "ev",
};

// ---------------------------------------------------------------------------
// Money (budgets)
// ---------------------------------------------------------------------------

/**
 * Meta budgets (daily_budget, lifetime_budget) are integers in the currency's "offset"
 * unit [doc: Marketing API currencies]. [PROVISIONAL R10] We convert only when Meta's
 * offset is unambiguous for us:
 * - ISO 4217 currencies with 2 minor digits → offset 100 (cents),
 * - currencies with 0 minor digits (JPY, KRW, VND, …) → offset 1,
 * EXCEPT the currencies below, which have 2 ISO minor digits but for which Meta is
 * understood to use offset 1. For those (and for 3-digit currencies) the budget is NOT
 * converted: budgetMicros stays absent and the raw integer is kept in attributes.
 */
export const AMBIGUOUS_BUDGET_CURRENCIES: ReadonlySet<string> = new Set([
  "COP",
  "CRC",
  "HUF",
  "IDR",
  "TWD",
]);

/** Micros per Meta budget unit for `currency`, or undefined when not safely known. */
export function budgetUnitMicros(currency: string): bigint | undefined {
  if (AMBIGUOUS_BUDGET_CURRENCIES.has(currency)) return undefined;
  let minor: number;
  try {
    minor = currencyMinorUnits(currency);
  } catch {
    return undefined;
  }
  if (minor === 2) return 10_000n;
  if (minor === 0) return 1_000_000n;
  return undefined;
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/**
 * publisher_platform → canonical placement. [doc] Unlisted values → "other" (raw kept),
 * accumulated across all pages of a request (carry.ts, R9).
 */
export const PLACEMENT: Readonly<Record<string, Placement>> = {
  facebook: "facebook",
  instagram: "instagram",
  audience_network: "audience_network",
  messenger: "messenger",
  threads: "threads",
};

/** Placements the provider may emit (capabilities). */
export const META_PLACEMENTS: readonly Placement[] = [
  "all",
  "facebook",
  "instagram",
  "audience_network",
  "messenger",
  "threads",
  "other",
];

/**
 * Reach is requested on "all" rows only (non-additive; never on breakdown rows) and only
 * for windows that start within this many days. [PROVISIONAL R12: Meta restricts reach
 * for old date ranges (~13 months); beyond the cutoff reach stays absent, never 0.]
 */
export const REACH_MAX_AGE_DAYS = 380;

/**
 * Reporting-date basis of every action/conversion value: requests set
 * action_report_time=impression explicitly, so actions are reported on the date of the
 * ad impression (click-through conversions: of the clicked impression). [PROVISIONAL R14]
 */
export const ACTION_REPORT_TIME = "impression";

/**
 * Engagement action types → wide metric columns (value of the action entry). [PROVISIONAL R13]
 * An action type missing from a row's `actions` array stays ABSENT (not 0). [PROVISIONAL R11]
 */
export const ENGAGEMENT_ACTIONS = {
  videoViews: "video_view",
  engagements: "post_engagement",
  reactions: "post_reaction",
  comments: "comment",
  shares: "post",
  saves: "onsite_conversion.post_save",
  follows: "like",
} as const;

/**
 * Wide `conversions` / `conversionValueMicros` = Meta's aggregated purchases plus leads,
 * using each ad set's attribution setting (use_unified_attribution_setting=true, i.e.
 * the Ads Manager default). [PROVISIONAL R15 / D19] Absent when neither type is reported.
 */
export const PRIMARY_CONVERSION_ACTIONS: readonly string[] = ["omni_purchase", "lead"];

/**
 * Action types written to actionMetricsDaily (conversions only; engagement goes to wide
 * columns). [PROVISIONAL R16 / D20] Only Meta's aggregated `omni_*` types, `lead` and custom
 * conversions (`offsite_conversion.custom.<id>`) are kept, so channel-specific duplicates
 * (e.g. offsite_conversion.fb_pixel_purchase inside omni_purchase) never appear twice.
 */
export const CONVERSION_ACTIONS: Readonly<
  Record<string, { actionType: ActionType; isPrimary: boolean }>
> = {
  omni_purchase: { actionType: "purchase", isPrimary: true },
  lead: { actionType: "lead", isPrimary: true },
  omni_add_to_cart: { actionType: "add_to_cart", isPrimary: false },
  omni_initiated_checkout: { actionType: "initiate_checkout", isPrimary: false },
  omni_complete_registration: { actionType: "complete_registration", isPrimary: false },
  omni_view_content: { actionType: "view_content", isPrimary: false },
  omni_app_install: { actionType: "app_install", isPrimary: false },
};
export const CUSTOM_CONVERSION_PREFIX = "offsite_conversion.custom.";

/**
 * Attribution windows of action rows: fixed windows requested with
 * action_attribution_windows (the combined `value` is NOT stored). Each window is its own
 * row and is never summed with another. [PROVISIONAL R16 / D20]
 */
export const ACTION_WINDOWS = ["1d_click", "7d_click", "1d_view"] as const;
export type ActionWindow = (typeof ACTION_WINDOWS)[number];
