import { describe, expect, it } from "vitest";
import { buildGaql, GaqlError, jsonPath, readField, type GaqlQuery } from "./gaql";

// Phase 9: typed GAQL — declared fields, typed values, compatibility rules, no injection.

describe("buildGaql", () => {
  it("builds SELECT / FROM / WHERE / ORDER BY / LIMIT from typed parts", () => {
    expect(
      buildGaql({
        from: "customer_client",
        select: ["customer_client.id", "customer_client.level", "customer_client.hidden"],
        where: [
          { field: "customer_client.level", op: ">", value: { int: 0 } },
          { field: "customer_client.hidden", op: "=", value: { bool: false } },
          {
            field: "customer_client.status",
            op: "IN",
            values: [{ enum: "ENABLED" }, { enum: "CANCELED" }],
          },
        ],
        orderBy: [{ field: "customer_client.id" }],
        limit: 10,
      }),
    ).toBe(
      "SELECT customer_client.id, customer_client.level, customer_client.hidden FROM customer_client " +
        "WHERE customer_client.level > 0 AND customer_client.hidden = FALSE AND " +
        "customer_client.status IN (ENABLED, CANCELED) ORDER BY customer_client.id ASC LIMIT 10",
    );
    expect(
      buildGaql({
        from: "campaign",
        select: ["campaign.id", "segments.date", "metrics.clicks"],
        where: [{ field: "segments.date", op: "BETWEEN", from: "2026-03-01", to: "2026-03-07" }],
        orderBy: [{ field: "campaign.id" }, { field: "segments.date", direction: "DESC" }],
      }),
    ).toBe(
      "SELECT campaign.id, segments.date, metrics.clicks FROM campaign WHERE segments.date " +
        "BETWEEN '2026-03-01' AND '2026-03-07' ORDER BY campaign.id ASC, segments.date DESC",
    );
  });

  it.each<[string, GaqlQuery]>([
    ["unknown field", { from: "campaign", select: ["campaign.budget_hack"] }],
    ["field of another resource", { from: "campaign", select: ["ad_group.id"] }],
    ["metrics on a non-metric resource", { from: "customer_client", select: ["metrics.clicks"] }],
    ["segments on a non-metric resource", { from: "customer_client", select: ["segments.date"] }],
    ["empty select", { from: "campaign", select: [] }],
    ["duplicate field", { from: "campaign", select: ["campaign.id", "campaign.id"] }],
    [
      "conversion_action with a non-conversion metric",
      {
        from: "campaign",
        select: ["campaign.id", "segments.conversion_action", "metrics.clicks"],
      },
    ],
    [
      "ORDER BY a field not selected",
      { from: "campaign", select: ["campaign.id"], orderBy: [{ field: "campaign.name" }] },
    ],
    [
      "an injected id",
      {
        from: "customer_client",
        select: ["customer_client.id"],
        where: [{ field: "customer_client.id", op: "=", value: { id: "1 OR 1=1" } }],
      },
    ],
    [
      "an injected enum",
      {
        from: "campaign",
        select: ["campaign.id"],
        where: [{ field: "campaign.status", op: "=", value: { enum: "ENABLED' OR '1" } }],
      },
    ],
    [
      "a mistyped value",
      {
        from: "customer_client",
        select: ["customer_client.id"],
        where: [{ field: "customer_client.hidden", op: "=", value: { id: "1" } }],
      },
    ],
    [
      "an invalid date",
      {
        from: "campaign",
        select: ["campaign.id"],
        where: [{ field: "segments.date", op: "BETWEEN", from: "2026-02-30", to: "2026-03-01" }],
      },
    ],
    [
      "a reversed range",
      {
        from: "campaign",
        select: ["campaign.id"],
        where: [{ field: "segments.date", op: "BETWEEN", from: "2026-03-02", to: "2026-03-01" }],
      },
    ],
    [
      "a string field in WHERE (no string literals exist)",
      {
        from: "campaign",
        select: ["campaign.id"],
        where: [{ field: "campaign.name", op: "=", value: { enum: "X" } }],
      },
    ],
    ["an invalid LIMIT", { from: "campaign", select: ["campaign.id"], limit: 0 }],
    [
      "the network segment on asset groups (never requested, G-D12 / GR10)",
      { from: "asset_group", select: ["asset_group.id", "segments.ad_network_type"] },
    ],
    [
      "a filter on a repeated field",
      {
        from: "ad_group_ad",
        select: ["ad_group_ad.ad.id"],
        where: [{ field: "ad_group_ad.ad.final_urls", op: "=", value: { enum: "X" } }],
      },
    ],
  ])("rejects %s", (_label, query) => {
    expect(() => buildGaql(query)).toThrow(GaqlError);
  });

  it("allows conversion metrics with segments.conversion_action", () => {
    expect(() =>
      buildGaql({
        from: "campaign",
        select: ["campaign.id", "segments.conversion_action", "metrics.all_conversions"],
      }),
    ).not.toThrow();
  });
});

describe("result rows (proto3 JSON)", () => {
  it("maps GAQL field names to camelCase JSON paths", () => {
    expect(jsonPath("customer_client.descriptive_name")).toEqual([
      "customerClient",
      "descriptiveName",
    ]);
    expect(jsonPath("ad_group_ad.ad.id")).toEqual(["adGroupAd", "ad", "id"]);
    const row = { adGroupAd: { ad: { id: "42" } }, metrics: { costMicros: "123" } };
    expect(readField(row, "ad_group_ad.ad.id")).toBe("42");
    expect(readField(row, "metrics.cost_micros")).toBe("123");
    expect(readField(row, "metrics.clicks")).toBeUndefined();
    expect(readField(null, "campaign.id")).toBeUndefined();
  });
});
