import { validate } from "convex-helpers/validators";
import { v, type Infer, type Validator } from "convex/values";
import type { ProviderOperation } from "../types";
import { googleError } from "./errors";

/**
 * Raw Google response validators (Convex `v` + convex-helpers `validate`, no Zod). Unknown
 * fields are allowed (Google adds fields over time); missing or mistyped required fields are
 * a non-retryable "data" error. proto3 JSON: camelCase names, int64 as strings, and default
 * values (false, empty lists) may be omitted.
 */

export const rawTokenResponse = v.object({
  access_token: v.string(),
  expires_in: v.optional(v.number()),
  refresh_token: v.optional(v.string()),
  scope: v.optional(v.string()),
  token_type: v.optional(v.string()),
});
export type RawTokenResponse = Infer<typeof rawTokenResponse>;

export const rawUserinfo = v.object({ sub: v.string() });

export const rawAccessibleCustomers = v.object({
  resourceNames: v.optional(v.array(v.string())),
});

export const rawSearchResponse = v.object({
  results: v.optional(v.array(v.any())),
  nextPageToken: v.optional(v.string()),
  fieldMask: v.optional(v.string()),
});
export type RawSearchResponse = Infer<typeof rawSearchResponse>;

export const rawCustomerRow = v.object({
  customer: v.object({
    id: v.string(),
    descriptiveName: v.optional(v.string()),
    currencyCode: v.string(),
    timeZone: v.string(),
    manager: v.optional(v.boolean()),
    status: v.optional(v.string()),
    testAccount: v.optional(v.boolean()),
  }),
});
export type RawCustomerRow = Infer<typeof rawCustomerRow>;

export const rawCustomerClientRow = v.object({
  customerClient: v.object({
    id: v.string(),
    descriptiveName: v.optional(v.string()),
    currencyCode: v.string(),
    timeZone: v.string(),
    manager: v.optional(v.boolean()),
    status: v.optional(v.string()),
    level: v.optional(v.string()),
    hidden: v.optional(v.boolean()),
    testAccount: v.optional(v.boolean()),
  }),
});
export type RawCustomerClientRow = Infer<typeof rawCustomerClientRow>;

/** Validates a raw payload; failures become "data" errors without echoing the payload. */
export function parseRaw<T extends Validator<unknown, "required", string>>(
  validator: T,
  value: unknown,
  operation: ProviderOperation,
  what: string,
  providerCodePrefix?: string,
): Infer<T> {
  if (!validate(validator, value, { allowUnknownFields: true })) {
    throw googleError(
      "data",
      operation,
      providerCodePrefix ? `${providerCodePrefix}:schema` : "schema",
      `Unexpected Google Ads ${what} payload`,
    );
  }
  return value as Infer<T>;
}

// ---------------------------------------------------------------------------
// Stage B: structure, metric and conversion-action rows (GAQL search results)
// ---------------------------------------------------------------------------

const idObject = v.object({ id: v.string() });
const textAssets = v.optional(v.array(v.object({ text: v.optional(v.string()) })));

export const rawCampaignRow = v.object({
  campaign: v.object({
    id: v.string(),
    name: v.optional(v.string()),
    status: v.optional(v.string()),
    servingStatus: v.optional(v.string()),
    advertisingChannelType: v.optional(v.string()),
    biddingStrategyType: v.optional(v.string()),
    startDateTime: v.optional(v.string()),
    endDateTime: v.optional(v.string()),
    campaignBudget: v.optional(v.string()),
  }),
  campaignBudget: v.optional(
    v.object({
      id: v.optional(v.string()),
      period: v.optional(v.string()),
      amountMicros: v.optional(v.string()),
      totalAmountMicros: v.optional(v.string()),
      explicitlyShared: v.optional(v.boolean()),
    }),
  ),
});
export type RawCampaignRow = Infer<typeof rawCampaignRow>;

export const rawAdGroupRow = v.object({
  adGroup: v.object({
    id: v.string(),
    name: v.optional(v.string()),
    status: v.optional(v.string()),
    type: v.optional(v.string()),
  }),
  campaign: idObject,
});
export type RawAdGroupRow = Infer<typeof rawAdGroupRow>;

export const rawAssetGroupRow = v.object({
  assetGroup: v.object({
    id: v.string(),
    name: v.optional(v.string()),
    status: v.optional(v.string()),
  }),
  campaign: idObject,
});
export type RawAssetGroupRow = Infer<typeof rawAssetGroupRow>;

export const rawAdGroupAdRow = v.object({
  adGroup: idObject,
  campaign: v.optional(idObject),
  adGroupAd: v.object({
    status: v.optional(v.string()),
    ad: v.object({
      id: v.string(),
      type: v.optional(v.string()),
      name: v.optional(v.string()),
      finalUrls: v.optional(v.array(v.string())),
      responsiveSearchAd: v.optional(v.object({ headlines: textAssets, descriptions: textAssets })),
      responsiveDisplayAd: v.optional(
        v.object({
          headlines: textAssets,
          descriptions: textAssets,
          callToActionText: v.optional(v.string()),
        }),
      ),
    }),
  }),
});
export type RawAdGroupAdRow = Infer<typeof rawAdGroupAdRow>;

/** A metric or conversion-action row of any level (ids of the level are checked later). */
export const rawMetricRow = v.object({
  customer: v.object({ id: v.optional(v.string()), currencyCode: v.string() }),
  campaign: v.optional(idObject),
  adGroup: v.optional(idObject),
  assetGroup: v.optional(idObject),
  adGroupAd: v.optional(v.object({ ad: idObject })),
  segments: v.object({
    date: v.string(),
    adNetworkType: v.optional(v.string()),
    conversionAction: v.optional(v.string()),
    conversionActionName: v.optional(v.string()),
    conversionActionCategory: v.optional(v.string()),
  }),
  metrics: v.optional(
    v.object({
      costMicros: v.optional(v.string()),
      impressions: v.optional(v.string()),
      clicks: v.optional(v.string()),
      conversions: v.optional(v.number()),
      conversionsValue: v.optional(v.number()),
      allConversions: v.optional(v.number()),
      allConversionsValue: v.optional(v.number()),
    }),
  ),
});
export type RawMetricRow = Infer<typeof rawMetricRow>;

export const rawConversionActionRow = v.object({
  conversionAction: v.object({
    id: v.string(),
    primaryForGoal: v.optional(v.boolean()),
  }),
});
export type RawConversionActionRow = Infer<typeof rawConversionActionRow>;
