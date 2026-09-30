import type {
  ActionType,
  ChannelType,
  CreativeFormat,
  DeliveryStatus,
  EntityStatus,
  Placement,
} from "../../domain/types";

/**
 * Google Ads semantic definitions (Phase 9 Stage B). Every choice that depends on how Google
 * behaves is ONE named definition here, tagged:
 *
 *   [doc]            taken from the Google Ads API v25 reference (proto comments / enums) or
 *                    our canonical model
 *   [PROVISIONAL GRn] implemented but NOT verified against a real Google Ads account
 *                    (docs/providers/google-ads.md, "Real-account validation required")
 *
 * Unknown raw values never become a guessed canonical value: statuses fall back to "unknown",
 * channels to "other", formats to "other", networks to "other" (raw value kept), action
 * categories to "other", and metrics Google did not report stay ABSENT (never 0).
 */

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/**
 * campaign.status / ad_group.status / asset_group.status / ad_group_ad.status → canonical
 * status. [doc: CampaignStatus, AdGroupStatus, AssetGroupStatus, AdGroupAdStatus are
 * ENABLED / PAUSED / REMOVED] UNKNOWN, UNSPECIFIED or absent → "unknown".
 */
export const ENTITY_STATUS: Readonly<Record<string, EntityStatus>> = {
  ENABLED: "active",
  PAUSED: "paused",
  REMOVED: "removed",
};

/**
 * campaign.serving_status → canonical delivery status. [PROVISIONAL GR5: the enum comments
 * are bare ("Serving.", "Ended.", …); the interpretation is ours] NONE, UNKNOWN and
 * UNSPECIFIED → "unknown"; absent → deliveryStatus absent.
 */
export const SERVING_STATUS: Readonly<Record<string, DeliveryStatus>> = {
  SERVING: "delivering",
  ENDED: "ended",
  PENDING: "scheduled",
  SUSPENDED: "not_delivering",
};

// ---------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------

/**
 * advertising_channel_type → canonical channel. [doc: AdvertisingChannelType; MULTI_CHANNEL
 * is "App Campaigns … that run across multiple channels"] HOTEL, LOCAL, SMART,
 * LOCAL_SERVICES, TRAVEL and UNKNOWN → "other" (raw value kept in attributes); absent or
 * UNSPECIFIED → channelType absent. Google campaigns have no objective: `objective` is
 * always "unknown" (the channel carries the intent) [doc: canonical model].
 */
export const CHANNEL_TYPE: Readonly<Record<string, ChannelType>> = {
  SEARCH: "search",
  DISPLAY: "display",
  SHOPPING: "shopping",
  VIDEO: "video",
  PERFORMANCE_MAX: "performance_max",
  DEMAND_GEN: "demand_gen",
  MULTI_CHANNEL: "app",
};

/**
 * campaign_budget.period → canonical budget type. [doc: BudgetPeriod DAILY = "Daily budget"
 * with amount_micros ("used when period is DAILY"); CUSTOM_PERIOD "can be used with
 * total_amount to specify lifetime budget limit" with total_amount_micros ("used only when
 * period is CUSTOM_PERIOD")] Any other period cannot be classified: the campaign fails
 * closed as a "data" error rather than guessing. [PROVISIONAL GR7: representation of
 * shared budgets — budgetMicros is the SHARED amount, isSharedBudget = explicitly_shared,
 * attributes.campaignBudgetId relates the campaigns sharing it]
 */
export const BUDGET_PERIOD: Readonly<
  Record<
    string,
    { budgetType: "daily" | "lifetime"; amountField: "amountMicros" | "totalAmountMicros" }
  >
> = {
  DAILY: { budgetType: "daily", amountField: "amountMicros" },
  CUSTOM_PERIOD: { budgetType: "lifetime", amountField: "totalAmountMicros" },
};

/**
 * campaign.start_date_time / end_date_time: "yyyy-MM-dd HH:mm:ss" in the customer's time
 * zone [doc]; the canonical start/end dates are the account-local day (the date part). An
 * absent end means "running indefinitely" [doc: "To set an existing campaign to run
 * indefinitely, clear this field"]. [PROVISIONAL GR8: whether an indefinite campaign is
 * ever returned with a far-future end value; such a value is stored as returned]
 */
export const DATE_TIME = /^(\d{4}-\d{2}-\d{2}) \d{2}:\d{2}:\d{2}$/;

// ---------------------------------------------------------------------------
// Ads and creatives
// ---------------------------------------------------------------------------

/**
 * ad_group_ad.ad.type → canonical creative format. [PROVISIONAL GR9: our interpretation of
 * the AdType names] Only unambiguous names are mapped; everything else → "other" (raw type
 * kept in attributes.adType).
 */
export const AD_FORMAT: Readonly<Record<string, CreativeFormat>> = {
  RESPONSIVE_SEARCH_AD: "responsive_search",
  RESPONSIVE_DISPLAY_AD: "responsive_display",
  TEXT_AD: "text",
  EXPANDED_TEXT_AD: "text",
  IMAGE_AD: "image",
  VIDEO_AD: "video",
  VIDEO_BUMPER_AD: "video",
  VIDEO_NON_SKIPPABLE_IN_STREAM_AD: "video",
  VIDEO_TRUEVIEW_IN_STREAM_AD: "video",
  VIDEO_RESPONSIVE_AD: "video",
  IN_FEED_VIDEO_AD: "video",
  DEMAND_GEN_CAROUSEL_AD: "carousel",
  EXPANDED_DYNAMIC_SEARCH_AD: "dynamic",
};

/**
 * ad.name is "only supported for DisplayUploadAd, ImageAd, LegacyAppInstallAd,
 * ShoppingComparisonListingAd, VideoAd, VideoResponsiveAd and DemandGen ads" [doc]; other
 * ads get this display name from their id (a label, not data).
 */
export const adDisplayName = (adId: string): string => `Ad ${adId}`;

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * segments.ad_network_type → canonical placement. [doc: AdNetworkType v25 — SEARCH "Google
 * search", SEARCH_PARTNERS "Search partners", CONTENT "Display Network", YOUTUBE "YouTube",
 * GMAIL "Gmail", DISCOVER "Discover Feed", MIXED "Cross-network"] Only these values are
 * mapped 1:1. GOOGLE_TV, GOOGLE_OWNED_CHANNELS (a mix of Discover, Gmail and YouTube), MAPS,
 * UNKNOWN and UNSPECIFIED → "other", accumulated across pages with the raw values kept
 * (carry.ts). No placement is ever synthesized (G-D12). [PROVISIONAL GR11: frequency of
 * unmapped values; whether network rows sum to the "all" row]
 */
export const NETWORK_PLACEMENT: Readonly<Record<string, Placement>> = {
  SEARCH: "google_search",
  SEARCH_PARTNERS: "search_partners",
  CONTENT: "google_display",
  YOUTUBE: "youtube",
  GMAIL: "gmail",
  DISCOVER: "discover",
  MIXED: "cross_network",
};

/** Placements the provider may emit (capabilities). */
export const GOOGLE_PLACEMENTS: readonly Placement[] = [
  "all",
  "google_search",
  "search_partners",
  "google_display",
  "youtube",
  "gmail",
  "discover",
  "cross_network",
  "other",
];

/**
 * Performance Max asset groups are queried WITHOUT segments.ad_network_type: their delivery
 * appears only in their "all" rows, and no placement row is emitted for them (never a
 * synthetic cross_network row, G-D12). Campaign and account placement rows come from
 * Google's own segmentation. [PROVISIONAL GR10: availability of asset-group metrics by
 * date, network segmentation and conversion-action segmentation]
 */
export const ASSET_GROUP_NETWORK_SEGMENTATION = false;

/**
 * Wide metric columns → canonical columns. [doc: metrics.proto]
 * - cost_micros (int64 micros, account currency) → spendMicros (exact bigint);
 * - impressions, clicks (int64) → impressions, clicks;
 * - conversions → conversions: Google's Conversions column — primary actions
 *   (primary_for_goal = true) plus custom-conversion-goal actions (conversion-goals guide;
 *   metrics.proto still words it with the deprecated include_in_conversions_metric);
 * - conversions_value (same actions; double, account currency) → conversionValueMicros
 *   (rounded to micros);
 * - all_conversions: "all conversions regardless of include_in_conversions_metric" →
 *   allConversions (primary and secondary actions).
 * Metrics are proto3 `optional`: a returned 0 stays 0, an absent metric stays ABSENT, a
 * missing row means no delivery (G-D13). [PROVISIONAL GR12: JSON presence of selected zero
 * metrics; whether zero-delivery rows are omitted] [PROVISIONAL GR13: reconciliation with
 * the UI columns] Never reported (no equivalent in this mapping): reach, linkClicks,
 * video and engagement metrics (G-D21, deferred).
 */
export const WIDE_METRICS = {
  spendMicros: "metrics.cost_micros",
  impressions: "metrics.impressions",
  clicks: "metrics.clicks",
  conversions: "metrics.conversions",
  conversionValueMicros: "metrics.conversions_value",
  allConversions: "metrics.all_conversions",
} as const;

// ---------------------------------------------------------------------------
// Conversion actions (action rows)
// ---------------------------------------------------------------------------

/**
 * segments.conversion_action_category → canonical action type. [doc: ConversionActionCategory
 * names/comments for the 1:1 values] [PROVISIONAL GR15: the lead family — SUBMIT_LEAD_FORM,
 * IMPORTED_LEAD, QUALIFIED_LEAD, CONVERTED_LEAD, PHONE_CALL_LEAD — grouped as "lead"]
 * Everything else (DEFAULT, DOWNLOAD, BOOK_APPOINTMENT, REQUEST_QUOTE, GET_DIRECTIONS,
 * OUTBOUND_CLICK, ENGAGEMENT, STORE_VISIT, STORE_SALE, YOUTUBE_FOLLOW_ON_VIEWS,
 * IN_APP_AD_REVENUE, UNKNOWN) → "other".
 */
export const ACTION_CATEGORY: Readonly<Record<string, ActionType>> = {
  PURCHASE: "purchase",
  ADD_TO_CART: "add_to_cart",
  BEGIN_CHECKOUT: "initiate_checkout",
  SIGNUP: "complete_registration",
  SUBSCRIBE_PAID: "subscribe",
  PAGE_VIEW: "page_view",
  CONTACT: "contact",
  SUBMIT_LEAD_FORM: "lead",
  IMPORTED_LEAD: "lead",
  QUALIFIED_LEAD: "lead",
  CONVERTED_LEAD: "lead",
  PHONE_CALL_LEAD: "lead",
};

/**
 * Identity of a conversion action on action rows. [doc]
 * - rawActionType = segments.conversion_action, the conversion action's RESOURCE NAME
 *   ("customers/{customer_id}/conversionActions/{id}"; the resource_name field is
 *   "Immutable"). It is the action's component of the actionMetricsDaily natural key, so a
 *   renamed action stays the same logical action and two actions with the same display name
 *   never collide.
 * - conversionActionExternalId = the id part of that resource name (conversion_action.id).
 * - The display name (segments.conversion_action_name) is mutable and is NOT used: the
 *   canonical action row has no field for it (a readable label needs a future model change).
 */
export const CONVERSION_ACTION_RESOURCE = /^customers\/\d{10}\/conversionActions\/(\d{1,20})$/;

/**
 * Action rows: one row per conversion action (segments.conversion_action, compatible only
 * with conversion metrics [doc]) with count = all_conversions and valueMicros =
 * all_conversions_value of that action — all_conversions includes every action, primary or
 * not [doc], so secondary actions get rows too. [PROVISIONAL GR15]
 */
export const ACTION_METRICS = {
  count: "metrics.all_conversions",
  valueMicros: "metrics.all_conversions_value",
} as const;

/**
 * isPrimary — canonical meaning (Phase 2, convex/tables/metrics.ts): "Counts toward the
 * account's primary `conversions`", with Google's `primary_for_goal` named as the source.
 * Google (v25 conversion-goals guide) [doc]:
 * - primary_for_goal = true → the action's conversions are included in Conversions and All
 *   conversions (and in bidding per the biddable customer/campaign goals);
 * - primary_for_goal = false → not included in bidding or Conversions unless the action is
 *   used in a CustomConversionGoal; it still appears in All conversions;
 * - include_in_conversions_metric is DEPRECATED ("set primary_for_goal instead") and is not
 *   read (metrics.proto still words `conversions` in terms of it).
 * So isPrimary = conversion_action.primary_for_goal, read once per request (the lookup).
 * Absent when Google does not report the flag or the action is not listed by the account's
 * FROM conversion_action (no default is assumed). [PROVISIONAL GR15: the flag is the action's
 * CURRENT setting at sync time — Google reports no per-row flag — so re-synced days follow a
 * change while older stored days keep the value of their last sync]
 */
export const PRIMARY_FLAG = "conversion_action.primary_for_goal";

/*
 * Relationship of the columns (documented; never enforced, never forced):
 * - wide `conversions` / `conversionValueMicros` = Google's Conversions: primary actions
 *   (primary_for_goal = true) plus, for campaigns with a custom conversion goal, the goal's
 *   actions whatever their flag;
 * - wide `allConversions` = all actions regardless of the flag;
 * - action rows = all_conversions per action: expected to add up to the wide allConversions
 *   of the same entity/day [PROVISIONAL GR13];
 * - Σ isPrimary action rows is NOT the wide `conversions` (custom goals, attribution columns)
 *   and is never used to derive or replace it.
 */

/**
 * attributionWindow of every Google action row: the canonical BUCKET "action_setting" = "the
 * conversion action's own lookback-window setting in effect when Google attributed the
 * conversion". It is NOT a factual window: Google reports no window per row (no segment
 * carries one [doc]) and click_through_lookback_window_days / view_through_lookback_window_days
 * are the action's CURRENT settings (not read), so no day count is claimed. A constant label
 * keeps the natural key stable when an action's setting changes (a derived label would split
 * one action into two row groups). The field is required in the canonical model, so it cannot
 * be left absent. [PROVISIONAL GR15]
 * Deferred: splitting rows by segments.conversion_attribution_event_type (impression /
 * interaction / engaged view), which Google does report.
 */
export const GOOGLE_ACTION_WINDOW = "action_setting";
export const GOOGLE_ATTRIBUTION_WINDOWS: readonly string[] = [GOOGLE_ACTION_WINDOW];

/**
 * Conversions are reported on the date of the ad interaction (impression or click) unless
 * the `*_by_conversion_date` variants are selected [doc]; only the interaction-date basis is
 * stored (conversion-date rows would collide on the natural key; deferred).
 */
export const GOOGLE_ATTRIBUTION_BASIS = "impression_or_click_date" as const;
