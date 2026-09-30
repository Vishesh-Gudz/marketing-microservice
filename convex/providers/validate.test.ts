import { describe, expect, it } from "vitest";
import { isProviderError } from "./errors";
import type { ProviderAd, ProviderCampaign, ProviderMetricRow } from "./types";
import { assertValidRecord, recordIssues } from "./validate";

const campaign: ProviderCampaign = {
  platform: "meta",
  accountExternalId: "1001",
  externalId: "120210000000101",
  name: "Campaign",
  status: "active",
  objective: "sales",
  budgetType: "daily",
  budgetMicros: 150_000_000n,
  budgetLevel: "campaign",
  startDate: "2026-01-01",
};

const metric: ProviderMetricRow = {
  platform: "meta",
  accountExternalId: "1001",
  level: "campaign",
  entityExternalId: "120210000000101",
  date: "2026-03-01",
  placement: "all",
  currency: "USD",
  spendMicros: 1_000_000n,
  impressions: 10,
  clicks: 0,
};

const googleAd: ProviderAd = {
  platform: "google_ads",
  accountExternalId: "1112223333",
  campaignExternalId: "21000000001",
  adGroupExternalId: "22000000001",
  externalId: "22000000001~24000000001",
  name: "Ad",
  status: "active",
};

describe("recordIssues", () => {
  it("accepts valid records", () => {
    expect(recordIssues("campaign", campaign)).toEqual([]);
    expect(recordIssues("metricRow", metric)).toEqual([]);
    expect(recordIssues("ad", googleAd)).toEqual([]);
  });

  it.each([
    ["tenant id smuggled in", { ...campaign, orgId: "org123" }],
    ["Convex parent id instead of external ref", { ...campaign, adAccountId: "abc" }],
    ["lifecycle timestamp", { ...campaign, createdAt: 1 }],
    ["non-canonical account id", { ...campaign, accountExternalId: "act_1001" }],
    ["unknown status", { ...campaign, status: "running" }],
    ["float budget", { ...campaign, budgetMicros: 1.5 }],
    ["negative budget", { ...campaign, budgetMicros: -1n }],
    ["invalid date", { ...campaign, startDate: "2026-02-30" }],
    ["start after end", { ...campaign, startDate: "2026-03-02", endDate: "2026-03-01" }],
    ["missing required field", (({ name: _n, ...rest }) => rest)(campaign)],
  ])("rejects a campaign with %s", (_label, record) => {
    expect(recordIssues("campaign", record).length).toBeGreaterThan(0);
  });

  it.each([
    ["NaN count", { ...metric, impressions: Number.NaN }],
    ["negative count", { ...metric, clicks: -1 }],
    ["lowercase currency", { ...metric, currency: "usd" }],
    ["unknown placement", { ...metric, placement: "tiktok" }],
    ["account row pointing elsewhere", { ...metric, level: "account", entityExternalId: "999" }],
    ["non-finite extras", { ...metric, extras: { share: Number.POSITIVE_INFINITY } }],
    ["syncedAt (set by mapping, not providers)", { ...metric, syncedAt: 1 }],
  ])("rejects a metric row with %s", (_label, record) => {
    expect(recordIssues("metricRow", record).length).toBeGreaterThan(0);
  });

  it("checks Google composite ad ids against their ad group", () => {
    expect(recordIssues("ad", { ...googleAd, externalId: "24000000001" }).length).toBeGreaterThan(
      0,
    );
    expect(
      recordIssues("ad", { ...googleAd, adGroupExternalId: "22000000009" }).length,
    ).toBeGreaterThan(0);
  });

  it("assertValidRecord raises a non-retryable data error", () => {
    let caught: unknown;
    try {
      assertValidRecord("campaign", { ...campaign, status: "running" }, "meta", "listCampaigns");
    } catch (error) {
      caught = error;
    }
    expect(isProviderError(caught) && caught.kind).toBe("data");
    expect(isProviderError(caught) && caught.retryable).toBe(false);
  });
});
