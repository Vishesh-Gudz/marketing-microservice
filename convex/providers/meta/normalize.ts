import { normalizeMetaAdAccountId, normalizeNumericId } from "../../domain/identity";
import type { AdAccountStatus } from "../../domain/types";
import { isDateKey, toDateKey, type DateKey } from "../../lib/dates";
import { parseDecimalToMicros, sumMicros } from "../../lib/money";
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
  RawActionEntry,
  RawAd,
  RawAdAccount,
  RawAdSet,
  RawCampaign,
  RawCreative,
  RawInsight,
} from "./schemas";
import {
  ACTION_WINDOWS,
  ATTRIBUTION_EVENT,
  budgetUnitMicros,
  CONVERSION_ACTIONS,
  CREATIVE_FORMAT,
  CUSTOM_CONVERSION_PREFIX,
  DELIVERY_STATUS,
  ENGAGEMENT_ACTIONS,
  ENTITY_STATUS,
  GRAPH_LEVEL,
  OBJECTIVE,
  PLACEMENT,
  PRIMARY_CONVERSION_ACTIONS,
} from "./semantics";

/**
 * Meta → provider-record normalization (Phase 8). Pure functions of validated raw Graph
 * objects; every Meta-specific semantic choice comes from semantics.ts (provisional items
 * are tagged there). Records never carry undefined values: absent stays absent.
 */

/** Graph fields requested for accounts (discovery and the sync preflight). */
export const ACCOUNT_FIELDS =
  "id,account_id,name,currency,timezone_name,account_status,disable_reason,business{id}";

/** Meta account_status codes [doc✓]. Unlisted codes → "unknown" (never guessed). */
const ACCOUNT_STATUS: Readonly<Record<number, AdAccountStatus>> = {
  1: "active", //    ACTIVE
  2: "disabled", //  DISABLED
  3: "disabled", //  UNSETTLED
  7: "pending", //   PENDING_RISK_REVIEW
  8: "pending", //   PENDING_SETTLEMENT
  9: "active", //    IN_GRACE_PERIOD
  100: "disabled", // PENDING_CLOSURE
  101: "closed", //  CLOSED
};

/** D10: stable attributes only (listAccounts and getAccount must return identical records). */
export function normalizeAdAccount(raw: RawAdAccount): ProviderAdAccount {
  const externalId = normalizeMetaAdAccountId(raw.account_id);
  if (normalizeMetaAdAccountId(raw.id) !== externalId) {
    throw new Error("id and account_id disagree");
  }
  const disableReason =
    raw.disable_reason !== undefined && raw.disable_reason !== 0
      ? String(raw.disable_reason)
      : undefined;
  return {
    platform: "meta",
    externalId,
    name: raw.name,
    currency: raw.currency,
    timezone: raw.timezone_name,
    status: ACCOUNT_STATUS[raw.account_status] ?? "unknown",
    rawStatus: String(raw.account_status),
    isManager: false,
    ...(raw.business?.id !== undefined
      ? { parentExternalId: normalizeNumericId(raw.business.id, "Meta business id") }
      : {}),
    ...(disableReason !== undefined ? { attributes: { disableReason } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Account facts entity listings need (budgets are in account currency; dates are local). */
export type MetaAccountInfo = { currency: string; timezone: string };

/** Drops undefined-valued keys (records omit absent fields). */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

/** Meta datetime with a "+hhmm" offset ("2026-01-01T00:00:00-0500") → epoch ms. */
export function parseMetaTime(value: string): number {
  const ms = Date.parse(value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
  if (!Number.isFinite(ms)) throw new Error("invalid Meta datetime");
  return ms;
}

/** An instant as the ad account's calendar day. */
function accountDay(value: string | undefined, timezone: string): DateKey | undefined {
  return value === undefined ? undefined : toDateKey(parseMetaTime(value), timezone);
}

/** Meta count ("123" or 123) → number; absent stays absent. Invalid → throws (data error). */
export function metaCount(value: string | number | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") throw new Error("empty count");
  const n = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isFinite(n) || n < 0) throw new Error("invalid count");
  return n;
}

/** Meta decimal money string ("12.34") → micros; absent stays absent. */
function metaMoney(value: string | number | undefined): bigint | undefined {
  if (value === undefined) return undefined;
  const micros = parseDecimalToMicros(String(value));
  if (micros < 0n) throw new Error("negative amount");
  return micros;
}

type Budget = { micros?: bigint; raw?: string };

/**
 * Meta budget integer in currency offset units → micros (semantics.ts R10). "0" and
 * absent mean "no budget". When the unit is not safely known, only the raw integer is kept.
 */
function metaBudget(value: string | number | undefined, currency: string): Budget | undefined {
  if (value === undefined) return undefined;
  const text = String(value).trim();
  if (!/^\d{1,18}$/.test(text)) throw new Error("invalid budget");
  if (/^0+$/.test(text)) return undefined;
  const unit = budgetUnitMicros(currency);
  return unit === undefined ? { raw: text } : { micros: BigInt(text) * unit };
}

function budgetFields(
  daily: Budget | undefined,
  lifetime: Budget | undefined,
): { type?: "daily" | "lifetime"; micros?: bigint; attributes: Record<string, string> } {
  const attributes: Record<string, string> = {};
  if (daily?.raw !== undefined) attributes.rawDailyBudget = daily.raw;
  if (lifetime?.raw !== undefined) attributes.rawLifetimeBudget = lifetime.raw;
  if (daily !== undefined) return { type: "daily", micros: daily.micros, attributes };
  if (lifetime !== undefined) return { type: "lifetime", micros: lifetime.micros, attributes };
  return { attributes };
}

function attributesOf(
  values: Record<string, string | undefined>,
): Record<string, string> | undefined {
  const kept = compact(values) as Record<string, string>;
  return Object.keys(kept).length > 0 ? kept : undefined;
}

function deliveryOf(effective: string | undefined) {
  return effective === undefined ? undefined : (DELIVERY_STATUS[effective] ?? "unknown");
}

// ---------------------------------------------------------------------------
// Structure
// ---------------------------------------------------------------------------

export function normalizeCampaign(
  raw: RawCampaign,
  accountExternalId: string,
  account: MetaAccountInfo,
): ProviderCampaign {
  const budget = budgetFields(
    metaBudget(raw.daily_budget, account.currency),
    metaBudget(raw.lifetime_budget, account.currency),
  );
  return compact({
    platform: "meta" as const,
    accountExternalId,
    externalId: normalizeNumericId(raw.id, "Meta campaign id"),
    name: raw.name,
    status: ENTITY_STATUS[raw.status] ?? "unknown",
    rawStatus: raw.status,
    deliveryStatus: deliveryOf(raw.effective_status),
    objective:
      raw.objective === undefined ? ("unknown" as const) : (OBJECTIVE[raw.objective] ?? "other"),
    rawObjective: raw.objective,
    channelType: "social" as const,
    budgetType: budget.type ?? ("none" as const),
    budgetMicros: budget.micros,
    // A campaign budget means CBO; without one the budgets live on the ad sets (ABO).
    budgetLevel: budget.type !== undefined ? ("campaign" as const) : ("ad_group" as const),
    bidStrategy: raw.bid_strategy,
    startDate: accountDay(raw.start_time, account.timezone),
    endDate: accountDay(raw.stop_time, account.timezone),
    platformCreatedAt: raw.created_time === undefined ? undefined : parseMetaTime(raw.created_time),
    platformUpdatedAt: raw.updated_time === undefined ? undefined : parseMetaTime(raw.updated_time),
    attributes: attributesOf({ effectiveStatus: raw.effective_status, ...budget.attributes }),
  } satisfies ProviderCampaign);
}

/** attribution_spec → "7d_click_1d_view" (click, view, engaged-view order). */
export function attributionLabel(spec: RawAdSet["attribution_spec"]): string | undefined {
  if (spec === undefined || spec.length === 0) return undefined;
  const parts: string[] = [];
  for (const [eventType, suffix] of Object.entries(ATTRIBUTION_EVENT)) {
    const days = spec.find((s) => s.event_type === eventType)?.window_days;
    if (days !== undefined) parts.push(`${days}d_${suffix}`);
  }
  return parts.length > 0 ? parts.join("_") : undefined;
}

export function normalizeAdSet(
  raw: RawAdSet,
  accountExternalId: string,
  account: MetaAccountInfo,
): ProviderAdGroup {
  const budget = budgetFields(
    metaBudget(raw.daily_budget, account.currency),
    metaBudget(raw.lifetime_budget, account.currency),
  );
  return compact({
    platform: "meta" as const,
    accountExternalId,
    campaignExternalId: normalizeNumericId(raw.campaign_id, "Meta campaign id"),
    externalId: normalizeNumericId(raw.id, "Meta ad set id"),
    name: raw.name,
    kind: "ad_set" as const,
    status: ENTITY_STATUS[raw.status] ?? "unknown",
    rawStatus: raw.status,
    deliveryStatus: deliveryOf(raw.effective_status),
    budgetType: budget.type,
    budgetMicros: budget.micros,
    optimizationGoal: raw.optimization_goal,
    attributionSetting: attributionLabel(raw.attribution_spec),
    startDate: accountDay(raw.start_time, account.timezone),
    endDate: accountDay(raw.end_time, account.timezone),
    attributes: attributesOf({ effectiveStatus: raw.effective_status, ...budget.attributes }),
  } satisfies ProviderAdGroup);
}

export function normalizeAd(raw: RawAd, accountExternalId: string): ProviderAd {
  const objectType = raw.creative?.object_type;
  return compact({
    platform: "meta" as const,
    accountExternalId,
    campaignExternalId: normalizeNumericId(raw.campaign_id, "Meta campaign id"),
    adGroupExternalId: normalizeNumericId(raw.adset_id, "Meta ad set id"),
    creativeExternalId:
      raw.creative === undefined
        ? undefined
        : normalizeNumericId(raw.creative.id, "Meta creative id"),
    externalId: normalizeNumericId(raw.id, "Meta ad id"),
    name: raw.name,
    status: ENTITY_STATUS[raw.status] ?? "unknown",
    rawStatus: raw.status,
    deliveryStatus: deliveryOf(raw.effective_status),
    format: objectType === undefined ? undefined : (CREATIVE_FORMAT[objectType] ?? "other"),
    attributes: attributesOf({ effectiveStatus: raw.effective_status }),
  } satisfies ProviderAd);
}

export function normalizeCreative(raw: RawCreative, accountExternalId: string): ProviderCreative {
  return compact({
    platform: "meta" as const,
    accountExternalId,
    externalId: normalizeNumericId(raw.id, "Meta creative id"),
    format:
      raw.object_type === undefined
        ? ("other" as const)
        : (CREATIVE_FORMAT[raw.object_type] ?? "other"),
    title: raw.title,
    body: raw.body,
    callToAction: raw.call_to_action_type,
    linkUrl: raw.link_url,
    thumbnailUrl: raw.thumbnail_url,
    imageUrl: raw.image_url,
    videoExternalId: raw.video_id,
    instagramMediaExternalId: raw.effective_instagram_media_id,
    facebookPostExternalId: raw.effective_object_story_id,
    attributes: attributesOf({ objectType: raw.object_type }),
  } satisfies ProviderCreative);
}

// ---------------------------------------------------------------------------
// Insights
// ---------------------------------------------------------------------------

/** Stage 0 = rows without breakdown ("all"); stage 1 = publisher_platform breakdown rows. */
export type InsightsStage = 0 | 1;

type Dimensions = {
  entityExternalId: string;
  date: DateKey;
  placement: ProviderMetricRow["placement"];
  rawPlacement?: string;
  currency: string;
};

function dimensions(raw: RawInsight, request: MetricsRequest, stage: InsightsStage): Dimensions {
  // time_increment=1: every row is exactly one account-local day. [doc]
  if (raw.date_start !== raw.date_stop || !isDateKey(raw.date_start)) {
    throw new Error("insights row is not a single day");
  }
  if (
    raw.account_id !== undefined &&
    normalizeMetaAdAccountId(raw.account_id) !== request.accountExternalId
  ) {
    throw new Error("insights row of another account");
  }
  let entityExternalId: string;
  if (request.level === "account") {
    entityExternalId = request.accountExternalId;
  } else {
    const field = GRAPH_LEVEL[request.level].idField as "campaign_id" | "adset_id" | "ad_id";
    const id = raw[field];
    if (id === undefined) throw new Error("insights row without entity id");
    entityExternalId = normalizeNumericId(id, "Meta entity id");
  }
  const base = { entityExternalId, date: raw.date_start, currency: raw.account_currency };
  if (stage === 0) {
    if (raw.publisher_platform !== undefined) throw new Error("unexpected breakdown value");
    return { ...base, placement: "all" };
  }
  if (raw.publisher_platform === undefined) throw new Error("breakdown row without placement");
  return {
    ...base,
    placement: PLACEMENT[raw.publisher_platform] ?? "other",
    rawPlacement: raw.publisher_platform,
  };
}

function actionMap(list: RawActionEntry[] | undefined): Map<string, RawActionEntry> {
  const map = new Map<string, RawActionEntry>();
  for (const entry of list ?? []) {
    if (map.has(entry.action_type)) throw new Error("duplicate action type");
    map.set(entry.action_type, entry);
  }
  return map;
}

/** Sum of an action list's values (video_*_actions); absent when the list is absent/empty. */
function listTotal(list: RawActionEntry[] | undefined): number | undefined {
  let total: number | undefined;
  for (const entry of list ?? []) {
    const n = metaCount(entry.value);
    if (n !== undefined) total = (total ?? 0) + n;
  }
  return total;
}

/** An entry's combined `value` or one attribution-window key ("1d_click"). */
function actionValue(
  entry: RawActionEntry | undefined,
  key = "value",
): string | number | undefined {
  if (entry === undefined) return undefined;
  const value = key === "value" ? entry.value : entry[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" && typeof value !== "number") {
    throw new Error("invalid action value");
  }
  return value;
}

/** One insights row → one wide metric row (semantics.ts R11–R15). */
export function normalizeInsightRow(
  raw: RawInsight,
  request: MetricsRequest,
  stage: InsightsStage,
): ProviderMetricRow {
  const dims = dimensions(raw, request, stage);
  const actions = actionMap(raw.actions);
  const values = actionMap(raw.action_values);
  const engagement = Object.fromEntries(
    Object.entries(ENGAGEMENT_ACTIONS).map(([metric, type]) => [
      metric,
      metaCount(actionValue(actions.get(type))),
    ]),
  ) as Partial<Record<keyof typeof ENGAGEMENT_ACTIONS, number>>;
  const primaryCounts = PRIMARY_CONVERSION_ACTIONS.map((type) =>
    metaCount(actionValue(actions.get(type))),
  ).filter((n): n is number => n !== undefined);
  const primaryValues = PRIMARY_CONVERSION_ACTIONS.map((type) =>
    metaMoney(actionValue(values.get(type))),
  );

  return compact({
    platform: "meta" as const,
    accountExternalId: request.accountExternalId,
    level: request.level,
    ...dims,
    spendMicros: metaMoney(raw.spend),
    impressions: metaCount(raw.impressions),
    clicks: metaCount(raw.clicks),
    // Reach is non-additive: only on "all" rows (never requested for breakdown rows).
    reach: stage === 0 ? metaCount(raw.reach) : undefined,
    linkClicks: metaCount(raw.inline_link_clicks),
    videoPlays: listTotal(raw.video_play_actions),
    videoCompletions: listTotal(raw.video_p100_watched_actions),
    ...engagement,
    conversions: primaryCounts.length > 0 ? primaryCounts.reduce((a, b) => a + b, 0) : undefined,
    conversionValueMicros: sumMicros(primaryValues),
  } satisfies ProviderMetricRow);
}

/** Raw action type → canonical conversion action, or undefined (not stored as an action row). */
export function conversionAction(
  rawActionType: string,
):
  | { actionType: ProviderActionRow["actionType"]; isPrimary: boolean; externalId?: string }
  | undefined {
  const known = CONVERSION_ACTIONS[rawActionType];
  if (known !== undefined) return known;
  if (rawActionType.startsWith(CUSTOM_CONVERSION_PREFIX)) {
    const id = rawActionType.slice(CUSTOM_CONVERSION_PREFIX.length);
    if (/^\d{1,20}$/.test(id)) return { actionType: "custom", isPrimary: false, externalId: id };
  }
  return undefined;
}

/** One insights row → one action row per (conversion action type, requested window). */
export function normalizeInsightActions(
  raw: RawInsight,
  request: MetricsRequest,
  stage: InsightsStage,
): ProviderActionRow[] {
  const dims = dimensions(raw, request, stage);
  const values = actionMap(raw.action_values);
  const rows: ProviderActionRow[] = [];
  for (const entry of actionMap(raw.actions).values()) {
    const action = conversionAction(entry.action_type);
    if (action === undefined) continue;
    for (const window of ACTION_WINDOWS) {
      const count = metaCount(actionValue(entry, window));
      if (count === undefined) continue;
      rows.push(
        compact({
          platform: "meta" as const,
          accountExternalId: request.accountExternalId,
          level: request.level,
          ...dims,
          actionType: action.actionType,
          rawActionType: entry.action_type,
          conversionActionExternalId: action.externalId,
          attributionWindow: window,
          attributionBasis: "impression_or_click_date" as const,
          count,
          valueMicros: metaMoney(actionValue(values.get(entry.action_type), window)),
          isPrimary: action.isPrimary,
        } satisfies ProviderActionRow),
      );
    }
  }
  return rows;
}
