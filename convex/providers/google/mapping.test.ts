import { describe, expect, it } from "vitest";
import { ENTITY_LEVELS, PLACEMENTS } from "../../domain/types";
import type { MetricsRequest } from "../types";
import { GOOGLE_CAPABILITIES } from "./capabilities";
import { buildGaql } from "./gaql";
import { GOOGLE_MAPPING } from "./mapping";
import {
  normalizeActionRow,
  normalizeAd,
  normalizeAdGroup,
  normalizeAssetGroup,
  normalizeCampaign,
  normalizeCreative,
  normalizeMetricRow,
} from "./normalize";
import type { RawCampaignRow, RawMetricRow } from "./schemas";
import {
  ACTION_CATEGORY,
  CHANNEL_TYPE,
  GOOGLE_PLACEMENTS,
  NETWORK_PLACEMENT,
  WIDE_METRICS,
} from "./semantics";

// Phase 9 Stage B: every Google → canonical mapping decision, on synthetic GAQL rows.

const ACCOUNT = "2220000001";

const campaign = (
  fields: Partial<RawCampaignRow["campaign"]> = {},
  budget?: RawCampaignRow["campaignBudget"],
): RawCampaignRow => ({
  campaign: { id: "10000000001", name: "C", status: "ENABLED", ...fields },
  ...(budget !== undefined ? { campaignBudget: budget } : {}),
});

describe("semantic tables", () => {
  it("maps exactly the documented v25 ad_network_type values with a canonical placement", () => {
    expect(NETWORK_PLACEMENT).toEqual({
      SEARCH: "google_search",
      SEARCH_PARTNERS: "search_partners",
      CONTENT: "google_display",
      YOUTUBE: "youtube",
      GMAIL: "gmail",
      DISCOVER: "discover",
      MIXED: "cross_network",
    });
    for (const unmapped of [
      "GOOGLE_TV",
      "GOOGLE_OWNED_CHANNELS",
      "MAPS",
      "UNKNOWN",
      "UNSPECIFIED",
    ]) {
      expect(NETWORK_PLACEMENT[unmapped]).toBeUndefined();
    }
  });

  it("capabilities declare exactly what the mapping emits", () => {
    expect(new Set(GOOGLE_PLACEMENTS)).toEqual(
      new Set(["all", ...Object.values(NETWORK_PLACEMENT), "other"]),
    );
    expect(GOOGLE_CAPABILITIES.placements).toEqual(GOOGLE_PLACEMENTS);
    expect(GOOGLE_PLACEMENTS.every((p) => (PLACEMENTS as readonly string[]).includes(p))).toBe(
      true,
    );
    expect(new Set(GOOGLE_CAPABILITIES.reportedMetrics)).toEqual(
      new Set(Object.keys(WIDE_METRICS)),
    );
    expect(GOOGLE_CAPABILITIES.reportedMetrics).not.toContain("reach");
    expect(GOOGLE_CAPABILITIES.reportedMetrics).not.toContain("linkClicks");
    expect(GOOGLE_CAPABILITIES.attributionWindows).toEqual(["action_setting"]);
  });
});

describe("campaigns", () => {
  it.each([
    ["ENABLED", "active"],
    ["PAUSED", "paused"],
    ["REMOVED", "removed"],
    ["UNKNOWN", "unknown"],
  ])("status %s → %s (raw kept)", (raw, expected) => {
    expect(normalizeCampaign(campaign({ status: raw }), ACCOUNT)).toMatchObject({
      status: expected,
      rawStatus: raw,
    });
  });

  it("absent status → unknown without rawStatus", () => {
    const record = normalizeCampaign(campaign({ status: undefined }), ACCOUNT);
    expect(record.status).toBe("unknown");
    expect(record).not.toHaveProperty("rawStatus");
  });

  it.each([
    ["SERVING", "delivering"],
    ["ENDED", "ended"],
    ["PENDING", "scheduled"],
    ["SUSPENDED", "not_delivering"],
    ["NONE", "unknown"],
    ["UNKNOWN", "unknown"],
  ])("serving_status %s → %s (GR5)", (raw, expected) => {
    expect(normalizeCampaign(campaign({ servingStatus: raw }), ACCOUNT).deliveryStatus).toBe(
      expected,
    );
  });

  it("absent serving_status → no deliveryStatus; objective is always unknown", () => {
    const record = normalizeCampaign(campaign(), ACCOUNT);
    expect(record).not.toHaveProperty("deliveryStatus");
    expect(record.objective).toBe("unknown");
    expect(record).not.toHaveProperty("rawObjective");
  });

  it.each([
    ...Object.entries(CHANNEL_TYPE),
    ["HOTEL", "other"],
    ["LOCAL_SERVICES", "other"],
    ["UNKNOWN", "other"],
  ])("advertising_channel_type %s → %s (raw kept)", (raw, expected) => {
    expect(normalizeCampaign(campaign({ advertisingChannelType: raw }), ACCOUNT)).toMatchObject({
      channelType: expected,
      attributes: { advertisingChannelType: raw },
    });
  });

  it("absent or UNSPECIFIED channel → no channelType", () => {
    expect(normalizeCampaign(campaign(), ACCOUNT)).not.toHaveProperty("channelType");
    expect(
      normalizeCampaign(campaign({ advertisingChannelType: "UNSPECIFIED" }), ACCOUNT),
    ).not.toHaveProperty("channelType");
  });

  it("no budget → budgetType none (campaign level)", () => {
    expect(normalizeCampaign(campaign(), ACCOUNT)).toMatchObject({
      budgetType: "none",
      budgetLevel: "campaign",
    });
    expect(normalizeCampaign(campaign(), ACCOUNT)).not.toHaveProperty("budgetMicros");
  });

  it("DAILY → daily amount_micros; CUSTOM_PERIOD → lifetime total_amount_micros (exact)", () => {
    expect(
      normalizeCampaign(
        campaign(
          {},
          { id: "1", period: "DAILY", amountMicros: "123456789012345678", totalAmountMicros: "5" },
        ),
        ACCOUNT,
      ),
    ).toMatchObject({ budgetType: "daily", budgetMicros: 123_456_789_012_345_678n });
    expect(
      normalizeCampaign(
        campaign(
          {},
          { id: "2", period: "CUSTOM_PERIOD", amountMicros: "5", totalAmountMicros: "300000000" },
        ),
        ACCOUNT,
      ),
    ).toMatchObject({
      budgetType: "lifetime",
      budgetMicros: 300_000_000n,
      attributes: { campaignBudgetId: "2", budgetPeriod: "CUSTOM_PERIOD" },
    });
  });

  it("a budget without an amount keeps the type and leaves the amount ABSENT (not 0)", () => {
    const record = normalizeCampaign(campaign({}, { id: "1", period: "DAILY" }), ACCOUNT);
    expect(record.budgetType).toBe("daily");
    expect(record).not.toHaveProperty("budgetMicros");
    expect(record).not.toHaveProperty("isSharedBudget");
  });

  it("shared budgets: isSharedBudget from explicitly_shared, the SHARED amount (GR7)", () => {
    expect(
      normalizeCampaign(
        campaign({}, { id: "9", period: "DAILY", amountMicros: "1000000", explicitlyShared: true }),
        ACCOUNT,
      ),
    ).toMatchObject({
      isSharedBudget: true,
      budgetMicros: 1_000_000n,
      attributes: { campaignBudgetId: "9" },
    });
  });

  it.each([
    ["an unclassifiable period", campaign({}, { id: "1", period: "UNKNOWN", amountMicros: "1" })],
    ["a period-less budget", campaign({}, { id: "1", amountMicros: "1" })],
    [
      "a budget reference without budget fields",
      campaign({ campaignBudget: "customers/1/campaignBudgets/1" }),
    ],
    ["a negative amount", campaign({}, { id: "1", period: "DAILY", amountMicros: "-1" })],
    ["a missing name", campaign({ name: undefined })],
    ["an empty name", campaign({ name: " " })],
    ["a date without time", campaign({ startDateTime: "2026-01-15" })],
    ["an impossible date", campaign({ startDateTime: "2026-02-30 00:00:00" })],
  ])("fails closed on %s", (_label, raw) => {
    expect(() => normalizeCampaign(raw, ACCOUNT)).toThrow();
  });

  it("dates are the account-local day of start/end_date_time; absent end = indefinite", () => {
    expect(
      normalizeCampaign(
        campaign({ startDateTime: "2026-01-15 00:00:00", endDateTime: "2026-06-30 23:59:59" }),
        ACCOUNT,
      ),
    ).toMatchObject({ startDate: "2026-01-15", endDate: "2026-06-30" });
    expect(
      normalizeCampaign(campaign({ startDateTime: "2026-01-15 00:00:00" }), ACCOUNT),
    ).not.toHaveProperty("endDate");
    // A far-future end value is stored as returned (GR8), never reinterpreted.
    expect(
      normalizeCampaign(campaign({ endDateTime: "2037-12-30 23:59:59" }), ACCOUNT).endDate,
    ).toBe("2037-12-30");
  });

  it("bid strategy is the raw type; UNKNOWN / UNSPECIFIED are absent", () => {
    expect(
      normalizeCampaign(campaign({ biddingStrategyType: "TARGET_CPA" }), ACCOUNT).bidStrategy,
    ).toBe("TARGET_CPA");
    for (const raw of ["UNKNOWN", "UNSPECIFIED"]) {
      expect(normalizeCampaign(campaign({ biddingStrategyType: raw }), ACCOUNT)).not.toHaveProperty(
        "bidStrategy",
      );
    }
  });
});

describe("ad groups and asset groups", () => {
  it("ad group: identity, campaign, status, raw type", () => {
    expect(
      normalizeAdGroup(
        {
          adGroup: { id: "20000000001", name: "G", status: "PAUSED", type: "SEARCH_STANDARD" },
          campaign: { id: "10000000001" },
        },
        ACCOUNT,
      ),
    ).toEqual({
      platform: "google_ads",
      accountExternalId: ACCOUNT,
      campaignExternalId: "10000000001",
      externalId: "20000000001",
      name: "G",
      kind: "ad_group",
      status: "paused",
      rawStatus: "PAUSED",
      attributes: { adGroupType: "SEARCH_STANDARD" },
    });
  });

  it("asset group: kind asset_group, no budget, no delivery status", () => {
    expect(
      normalizeAssetGroup(
        {
          assetGroup: { id: "30000000001", name: "A", status: "REMOVED" },
          campaign: { id: "10000000002" },
        },
        ACCOUNT,
      ),
    ).toEqual({
      platform: "google_ads",
      accountExternalId: ACCOUNT,
      campaignExternalId: "10000000002",
      externalId: "30000000001",
      name: "A",
      kind: "asset_group",
      status: "removed",
      rawStatus: "REMOVED",
    });
  });

  it("fails closed without a name", () => {
    expect(() =>
      normalizeAdGroup({ adGroup: { id: "1" }, campaign: { id: "2" } }, ACCOUNT),
    ).toThrow();
  });
});

describe("ads and creatives", () => {
  const row = (ad: Record<string, unknown>, status = "ENABLED") => ({
    adGroup: { id: "20000000001" },
    campaign: { id: "10000000001" },
    adGroupAd: { status, ad: { id: "40000000001", ...ad } },
  });

  it.each([
    ["RESPONSIVE_SEARCH_AD", "responsive_search"],
    ["RESPONSIVE_DISPLAY_AD", "responsive_display"],
    ["EXPANDED_TEXT_AD", "text"],
    ["IMAGE_AD", "image"],
    ["VIDEO_RESPONSIVE_AD", "video"],
    ["DEMAND_GEN_CAROUSEL_AD", "carousel"],
    ["HOTEL_AD", "other"],
    ["UNKNOWN", "other"],
  ])("ad.type %s → format %s (GR9; raw kept)", (type, format) => {
    expect(normalizeAd(row({ type }), ACCOUNT)).toMatchObject({
      format,
      attributes: { adType: type },
    });
  });

  it("composite id, one creative per ad, id-based display name when ad.name is not set", () => {
    const ad = normalizeAd(row({ type: "RESPONSIVE_SEARCH_AD" }, "REMOVED"), ACCOUNT);
    expect(ad).toMatchObject({
      externalId: "20000000001~40000000001",
      creativeExternalId: "20000000001~40000000001",
      adGroupExternalId: "20000000001",
      campaignExternalId: "10000000001",
      name: "Ad 40000000001",
      status: "removed",
    });
    expect(normalizeAd(row({ name: "Banner" }), ACCOUNT)).toMatchObject({ name: "Banner" });
    expect(normalizeAd(row({}), ACCOUNT)).not.toHaveProperty("format");
  });

  it("an ad row without its campaign fails closed", () => {
    expect(() =>
      normalizeAd({ adGroup: { id: "1" }, adGroupAd: { ad: { id: "2" } } }, ACCOUNT),
    ).toThrow();
  });

  it("creatives: RSA and RDA texts, first final URL, call to action; missing fields stay absent", () => {
    expect(
      normalizeCreative(
        row({
          type: "RESPONSIVE_SEARCH_AD",
          finalUrls: ["https://a.example.test/", "https://b.example.test/"],
          responsiveSearchAd: {
            headlines: [{ text: "H1" }, {}, { text: "H2" }],
            descriptions: [{ text: "D1" }],
          },
        }),
        ACCOUNT,
      ),
    ).toEqual({
      platform: "google_ads",
      accountExternalId: ACCOUNT,
      externalId: "20000000001~40000000001",
      format: "responsive_search",
      headlines: ["H1", "H2"],
      descriptions: ["D1"],
      linkUrl: "https://a.example.test/",
      attributes: { adType: "RESPONSIVE_SEARCH_AD" },
    });
    expect(
      normalizeCreative(
        row({
          type: "RESPONSIVE_DISPLAY_AD",
          responsiveDisplayAd: { headlines: [{ text: "R" }], callToActionText: "Buy" },
        }),
        ACCOUNT,
      ),
    ).toMatchObject({ headlines: ["R"], callToAction: "Buy" });
    const bare = normalizeCreative(row({}), ACCOUNT);
    expect(bare.format).toBe("other");
    for (const field of ["headlines", "descriptions", "linkUrl", "callToAction", "attributes"]) {
      expect(bare).not.toHaveProperty(field);
    }
  });
});

describe("metric rows", () => {
  const request = (level: MetricsRequest["level"] = "campaign"): MetricsRequest => ({
    accountExternalId: ACCOUNT,
    level,
    from: "2026-03-01",
    to: "2026-03-07",
    breakdown: "placement",
  });
  const metricRow = (fields: Partial<RawMetricRow> = {}): RawMetricRow => ({
    customer: { id: ACCOUNT, currencyCode: "USD" },
    campaign: { id: "10000000001" },
    segments: { date: "2026-03-02" },
    ...fields,
  });

  it("'all' stage: placement all without raw value", () => {
    const row = normalizeMetricRow(metricRow(), request(), false);
    expect(row).toEqual({
      platform: "google_ads",
      accountExternalId: ACCOUNT,
      level: "campaign",
      entityExternalId: "10000000001",
      date: "2026-03-02",
      placement: "all",
      currency: "USD",
    });
  });

  it.each([
    ...Object.entries(NETWORK_PLACEMENT),
    ["GOOGLE_TV", "other"],
    ["GOOGLE_OWNED_CHANNELS", "other"],
    ["MAPS", "other"],
    ["UNKNOWN", "other"],
  ])("network %s → %s (raw kept)", (network, placement) => {
    expect(
      normalizeMetricRow(
        metricRow({ segments: { date: "2026-03-02", adNetworkType: network } }),
        request(),
        true,
      ),
    ).toMatchObject({ placement, rawPlacement: network });
  });

  it("a network row without a value is 'other' / UNSPECIFIED, never guessed", () => {
    expect(normalizeMetricRow(metricRow(), request(), true)).toMatchObject({
      placement: "other",
      rawPlacement: "UNSPECIFIED",
    });
  });

  it("reported zeros stay 0; absent metrics stay absent", () => {
    const zero = normalizeMetricRow(
      metricRow({
        metrics: {
          costMicros: "0",
          impressions: "0",
          clicks: "0",
          conversions: 0,
          conversionsValue: 0,
          allConversions: 0,
        },
      }),
      request(),
      false,
    );
    expect(zero).toMatchObject({
      spendMicros: 0n,
      impressions: 0,
      clicks: 0,
      conversions: 0,
      conversionValueMicros: 0n,
      allConversions: 0,
    });
    const partial = normalizeMetricRow(
      metricRow({ metrics: { impressions: "12" } }),
      request(),
      false,
    );
    expect(partial.impressions).toBe(12);
    for (const field of [
      "spendMicros",
      "clicks",
      "conversions",
      "conversionValueMicros",
      "allConversions",
    ]) {
      expect(partial).not.toHaveProperty(field);
    }
    const none = normalizeMetricRow(metricRow(), request(), false);
    expect(Object.keys(none).some((k) => k in WIDE_METRICS)).toBe(false);
  });

  it("money is exact integer micros: cost_micros beyond 2^53 stays exact; doubles round to micros", () => {
    const row = normalizeMetricRow(
      metricRow({
        metrics: { costMicros: "9007199254740993", conversionsValue: 25.5, conversions: 1.75 },
      }),
      request(),
      false,
    );
    expect(row.spendMicros).toBe(9_007_199_254_740_993n);
    expect(row.conversionValueMicros).toBe(25_500_000n);
    expect(row.conversions).toBe(1.75);
    expect(
      normalizeMetricRow(metricRow({ metrics: { conversionsValue: 0.1 } }), request(), false)
        .conversionValueMicros,
    ).toBe(100_000n);
  });

  it.each([
    ["an int64 count beyond 2^53", { metrics: { impressions: "9007199254740993" } }],
    ["a negative count", { metrics: { clicks: "-1" } }],
    ["a negative cost", { metrics: { costMicros: "-5" } }],
    ["a non-numeric count", { metrics: { clicks: "1e3" } }],
    ["a non-finite double", { metrics: { conversions: Infinity } }],
    ["a bad date", { segments: { date: "2026-3-2" } }],
    ["another customer's row", { customer: { id: "9999999999", currencyCode: "USD" } }],
    ["a row without its entity id", { campaign: undefined }],
  ])("fails closed on %s", (_label, fields) => {
    expect(() =>
      normalizeMetricRow(metricRow(fields as Partial<RawMetricRow>), request(), false),
    ).toThrow();
  });

  it("resolves the entity of every level", () => {
    const raw = metricRow({
      adGroup: { id: "20000000001" },
      adGroupAd: { ad: { id: "40000000001" } },
    });
    expect(normalizeMetricRow(raw, request("account"), false).entityExternalId).toBe(ACCOUNT);
    expect(normalizeMetricRow(raw, request("ad_group"), false).entityExternalId).toBe(
      "20000000001",
    );
    expect(normalizeMetricRow(raw, request("ad"), false).entityExternalId).toBe(
      "20000000001~40000000001",
    );
    expect(
      normalizeMetricRow(
        metricRow({ assetGroup: { id: "30000000001" } }),
        request("ad_group"),
        false,
      ).entityExternalId,
    ).toBe("30000000001");
  });
});

describe("conversion-action rows", () => {
  const request: MetricsRequest = {
    accountExternalId: ACCOUNT,
    level: "campaign",
    from: "2026-03-01",
    to: "2026-03-07",
    breakdown: "none",
  };
  const resource = (id: string, owner = ACCOUNT) => `customers/${owner}/conversionActions/${id}`;
  const actionRow = (
    segments: Partial<RawMetricRow["segments"]> = {},
    metrics: RawMetricRow["metrics"] = { allConversions: 2.5, allConversionsValue: 10.25 },
  ): RawMetricRow => ({
    customer: { id: ACCOUNT, currencyCode: "USD" },
    campaign: { id: "10000000001" },
    segments: {
      date: "2026-03-02",
      conversionAction: resource("900000001"),
      conversionActionName: "Purchase",
      conversionActionCategory: "PURCHASE",
      ...segments,
    },
    ...(metrics !== undefined ? { metrics } : {}),
  });
  const primaryForGoal = new Map([
    ["900000001", true],
    ["900000002", false],
  ]);

  it("identity = resource name + id; count/value = all_conversions; window = the 'action_setting' bucket", () => {
    expect(normalizeActionRow(actionRow(), request, false, primaryForGoal)).toEqual({
      platform: "google_ads",
      accountExternalId: ACCOUNT,
      level: "campaign",
      entityExternalId: "10000000001",
      date: "2026-03-02",
      placement: "all",
      currency: "USD",
      actionType: "purchase",
      rawActionType: resource("900000001"),
      conversionActionExternalId: "900000001",
      attributionWindow: "action_setting",
      attributionBasis: "impression_or_click_date",
      count: 2.5,
      valueMicros: 10_250_000n,
      isPrimary: true,
    });
  });

  it("a renamed action keeps its identity (the display name is never read)", () => {
    const before = normalizeActionRow(actionRow(), request, false, primaryForGoal);
    const renamed = normalizeActionRow(
      actionRow({ conversionActionName: "Purchase (all channels)" }),
      request,
      false,
      primaryForGoal,
    );
    expect(renamed).toEqual(before);
    const unnamed = normalizeActionRow(
      actionRow({ conversionActionName: undefined }),
      request,
      false,
      primaryForGoal,
    );
    expect(unnamed).toEqual(before);
  });

  it("two actions with the same display name but different ids never share a key", () => {
    const a = normalizeActionRow(actionRow(), request, false, primaryForGoal);
    const b = normalizeActionRow(
      actionRow({ conversionAction: resource("900000077") }),
      request,
      false,
      primaryForGoal,
    );
    expect(a.rawActionType).not.toBe(b.rawActionType);
    expect(b).toMatchObject({ conversionActionExternalId: "900000077" });
    // Actions owned by another customer (for example a manager) keep their own resource name.
    const managerOwned = normalizeActionRow(
      actionRow({ conversionAction: resource("900000001", "1110000001") }),
      request,
      false,
      primaryForGoal,
    );
    expect(managerOwned.rawActionType).toBe(resource("900000001", "1110000001"));
  });

  it("isPrimary = primary_for_goal; absent when not reported (no default assumed)", () => {
    const secondary = actionRow({ conversionAction: resource("900000002") });
    expect(normalizeActionRow(secondary, request, false, primaryForGoal).isPrimary).toBe(false);
    const unknown = actionRow({ conversionAction: resource("900000009") });
    expect(normalizeActionRow(unknown, request, false, primaryForGoal)).not.toHaveProperty(
      "isPrimary",
    );
  });

  it("the window bucket never depends on the action or its settings (deterministic)", () => {
    const windows = new Set(
      ["900000001", "900000002", "900000009"].map(
        (id) =>
          normalizeActionRow(
            actionRow({ conversionAction: resource(id) }),
            request,
            false,
            primaryForGoal,
          ).attributionWindow,
      ),
    );
    expect(windows).toEqual(new Set(["action_setting"]));
  });

  it.each([
    ...Object.entries(ACTION_CATEGORY),
    ["DEFAULT", "other"],
    ["STORE_VISIT", "other"],
    ["DOWNLOAD", "other"],
    ["UNKNOWN", "other"],
  ])("category %s → %s", (category, actionType) => {
    expect(
      normalizeActionRow(
        actionRow({ conversionActionCategory: category }),
        request,
        false,
        primaryForGoal,
      ).actionType,
    ).toBe(actionType);
  });

  it("a zero count stays 0; an unreported value stays absent", () => {
    const row = normalizeActionRow(
      actionRow({}, { allConversions: 0 }),
      request,
      false,
      primaryForGoal,
    );
    expect(row.count).toBe(0);
    expect(row).not.toHaveProperty("valueMicros");
  });

  it.each([
    ["no all_conversions", actionRow({}, { allConversionsValue: 3 })],
    ["no metrics", (({ metrics: _m, ...rest }) => rest)(actionRow())],
    ["a malformed conversion action", actionRow({ conversionAction: "conversionActions/1" })],
    ["no conversion action", actionRow({ conversionAction: undefined })],
  ])("fails closed on %s", (_label, raw) => {
    expect(() => normalizeActionRow(raw, request, false, primaryForGoal)).toThrow();
  });
});

describe("production GAQL", () => {
  const request = (level: MetricsRequest["level"], breakdown: MetricsRequest["breakdown"]) => ({
    accountExternalId: ACCOUNT,
    level,
    breakdown,
    from: "2026-03-01",
    to: "2026-03-07",
  });

  it("builds every structure query; no status filter (removed resources included, GR6)", () => {
    for (const entry of [
      GOOGLE_MAPPING.campaigns!,
      GOOGLE_MAPPING.adGroups!,
      GOOGLE_MAPPING.ads!,
      GOOGLE_MAPPING.creatives!,
    ]) {
      for (const query of entry.stages({ accountExternalId: ACCOUNT }).map(buildGaql)) {
        expect(query).not.toMatch(/WHERE/);
        expect(query).toMatch(/ORDER BY/);
      }
    }
  });

  it.each(
    ENTITY_LEVELS.flatMap(
      (level) =>
        [
          [level, "none"],
          [level, "placement"],
        ] as const,
    ),
  )(
    "%s / %s: 'all' stages first, network stages only on segmentable resources",
    (level, breakdown) => {
      for (const entry of [GOOGLE_MAPPING.dailyMetrics!, GOOGLE_MAPPING.actionMetrics!]) {
        const queries = entry.stages(request(level, breakdown)).map(buildGaql);
        for (const query of queries) {
          expect(query).toMatch(/WHERE segments\.date BETWEEN '2026-03-01' AND '2026-03-07'/);
          expect(query).toMatch(/ORDER BY/);
          if (/FROM asset_group/.test(query)) expect(query).not.toMatch(/ad_network_type/);
        }
        if (breakdown === "none")
          expect(queries.every((q) => !/ad_network_type/.test(q))).toBe(true);
      }
      for (const query of GOOGLE_MAPPING.actionMetrics!.stages(request(level, breakdown)).map(
        buildGaql,
      )) {
        expect(query).toMatch(/segments\.conversion_action\b/);
        // Identity is the resource name: the mutable display name is never selected.
        expect(query).not.toMatch(/conversion_action_name/);
        expect(query).not.toMatch(/metrics\.(impressions|clicks|cost_micros|conversions\b)/);
      }
    },
  );

  it("the conversion-action lookup reads every action (no status filter)", () => {
    const query = buildGaql(GOOGLE_MAPPING.actionMetrics!.lookup!.query);
    expect(query).toBe(
      "SELECT conversion_action.id, conversion_action.primary_for_goal FROM conversion_action ORDER BY conversion_action.id ASC",
    );
  });
});
