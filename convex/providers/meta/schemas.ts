import { validate } from "convex-helpers/validators";
import { v, type Infer, type Validator } from "convex/values";
import type { ProviderOperation } from "../types";
import { metaError } from "./errors";

/**
 * Raw Graph response validators (Phase 8, D3: Convex `v` + convex-helpers
 * `validate`, no Zod). Unknown fields are allowed (Meta adds fields over time);
 * missing or mistyped required fields are a non-retryable "data" error.
 * Only STRUCTURE is checked here; semantic mapping lives in normalize.ts and
 * (for structure/metrics) in mapping.ts with the definitions of semantics.ts.
 */

export const pagedEnvelope = v.object({
  data: v.array(v.any()),
  paging: v.optional(
    v.object({
      cursors: v.optional(
        v.object({ before: v.optional(v.string()), after: v.optional(v.string()) }),
      ),
      next: v.optional(v.string()),
      previous: v.optional(v.string()),
    }),
  ),
});
export type PagedEnvelope = Infer<typeof pagedEnvelope>;

export const rawAdAccount = v.object({
  id: v.string(),
  account_id: v.string(),
  name: v.string(),
  currency: v.string(),
  timezone_name: v.string(),
  account_status: v.number(),
  disable_reason: v.optional(v.number()),
  business: v.optional(v.object({ id: v.string() })),
});
export type RawAdAccount = Infer<typeof rawAdAccount>;

/** Account currency and time zone, read by entity listings (budgets and dates). */
export const rawAccountInfo = v.object({ currency: v.string(), timezone_name: v.string() });
export type RawAccountInfo = Infer<typeof rawAccountInfo>;

/** Meta returns numbers as strings; tolerate JSON numbers too. */
const numeric = v.union(v.string(), v.number());

export const rawCampaign = v.object({
  id: v.string(),
  name: v.string(),
  status: v.string(),
  effective_status: v.optional(v.string()),
  objective: v.optional(v.string()),
  daily_budget: v.optional(numeric),
  lifetime_budget: v.optional(numeric),
  bid_strategy: v.optional(v.string()),
  start_time: v.optional(v.string()),
  stop_time: v.optional(v.string()),
  created_time: v.optional(v.string()),
  updated_time: v.optional(v.string()),
});
export type RawCampaign = Infer<typeof rawCampaign>;

export const rawAdSet = v.object({
  id: v.string(),
  name: v.string(),
  campaign_id: v.string(),
  status: v.string(),
  effective_status: v.optional(v.string()),
  daily_budget: v.optional(numeric),
  lifetime_budget: v.optional(numeric),
  optimization_goal: v.optional(v.string()),
  attribution_spec: v.optional(
    v.array(v.object({ event_type: v.string(), window_days: v.number() })),
  ),
  start_time: v.optional(v.string()),
  end_time: v.optional(v.string()),
});
export type RawAdSet = Infer<typeof rawAdSet>;

export const rawAd = v.object({
  id: v.string(),
  name: v.string(),
  campaign_id: v.string(),
  adset_id: v.string(),
  status: v.string(),
  effective_status: v.optional(v.string()),
  creative: v.optional(v.object({ id: v.string(), object_type: v.optional(v.string()) })),
});
export type RawAd = Infer<typeof rawAd>;

export const rawCreative = v.object({
  id: v.string(),
  object_type: v.optional(v.string()),
  title: v.optional(v.string()),
  body: v.optional(v.string()),
  call_to_action_type: v.optional(v.string()),
  link_url: v.optional(v.string()),
  thumbnail_url: v.optional(v.string()),
  image_url: v.optional(v.string()),
  video_id: v.optional(v.string()),
  effective_object_story_id: v.optional(v.string()),
  effective_instagram_media_id: v.optional(v.string()),
});
export type RawCreative = Infer<typeof rawCreative>;

/** One entry of actions / action_values / video_*_actions (window keys read separately). */
const rawActionEntry = v.object({ action_type: v.string(), value: v.optional(numeric) });
export type RawActionEntry = Infer<typeof rawActionEntry> & Record<string, unknown>;

export const rawInsight = v.object({
  date_start: v.string(),
  date_stop: v.string(),
  account_id: v.optional(v.string()),
  account_currency: v.string(),
  campaign_id: v.optional(v.string()),
  adset_id: v.optional(v.string()),
  ad_id: v.optional(v.string()),
  publisher_platform: v.optional(v.string()),
  spend: v.optional(numeric),
  impressions: v.optional(numeric),
  clicks: v.optional(numeric),
  reach: v.optional(numeric),
  inline_link_clicks: v.optional(numeric),
  actions: v.optional(v.array(rawActionEntry)),
  action_values: v.optional(v.array(rawActionEntry)),
  video_play_actions: v.optional(v.array(rawActionEntry)),
  video_p100_watched_actions: v.optional(v.array(rawActionEntry)),
});
type ActionListKey =
  "actions" | "action_values" | "video_play_actions" | "video_p100_watched_actions";
/** Validated insights row; action entries also carry window keys ("1d_click", …). */
export type RawInsight = Omit<Infer<typeof rawInsight>, ActionListKey> &
  Partial<Record<ActionListKey, RawActionEntry[]>>;

export const rawTokenResponse = v.object({
  access_token: v.string(),
  token_type: v.optional(v.string()),
  expires_in: v.optional(v.number()),
});

export const rawDebugToken = v.object({
  data: v.object({
    app_id: v.string(),
    is_valid: v.boolean(),
    user_id: v.optional(v.string()),
    scopes: v.optional(v.array(v.string())),
    granular_scopes: v.optional(
      v.array(v.object({ scope: v.string(), target_ids: v.optional(v.array(v.string())) })),
    ),
    expires_at: v.optional(v.number()),
    data_access_expires_at: v.optional(v.number()),
  }),
});
export type RawDebugToken = Infer<typeof rawDebugToken>;

export const rawMe = v.object({ id: v.string(), name: v.optional(v.string()) });

export const rawPermissions = v.object({
  data: v.array(v.object({ permission: v.string(), status: v.string() })),
});

/** Validates a raw payload; failures become "data" errors without echoing the payload. */
export function parseRaw<T extends Validator<unknown, "required", string>>(
  validator: T,
  value: unknown,
  operation: ProviderOperation,
  what: string,
  providerCodePrefix?: string,
): Infer<T> {
  if (!validate(validator, value, { allowUnknownFields: true })) {
    throw metaError(
      "data",
      operation,
      providerCodePrefix ? `${providerCodePrefix}:schema` : "schema",
      `Unexpected Meta ${what} payload`,
    );
  }
  return value as Infer<T>;
}
