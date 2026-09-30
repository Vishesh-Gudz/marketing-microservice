import { describe, expect, it } from "vitest";
import { organicAggregate, postSnapshot } from "@/tests/unit/organic-fixtures";
import {
  ORGANIC_DETAILS,
  ORGANIC_HEADLINE,
  organicLabel,
  organicValueView,
  postValueView,
} from "./organic-values";

// Organic values come from the API only: "—" plus the API reason when missing (never 0), the
// exact value when present (0 stays 0), the engagement rate only when the API returns it.

const LOCALE = "en-US";

describe("organicValueView", () => {
  it("shows reported values exactly, including explicit zeros", () => {
    const aggregate = organicAggregate();
    expect(organicValueView("views", aggregate, LOCALE)).toEqual({
      kind: "value",
      text: "5,400",
      partial: false,
    });
    expect(organicValueView("comments", aggregate, LOCALE)).toEqual({
      kind: "value",
      text: "0",
      partial: false,
    });
  });

  it("missing values show — with the API reason, never 0", () => {
    const aggregate = organicAggregate();
    expect(organicValueView("reach", aggregate, LOCALE)).toEqual({
      kind: "unavailable",
      text: "—",
      reason:
        "Only available for one day (unique accounts cannot be added up across days or accounts)",
    });
    const small = organicAggregate({
      metrics: {
        unavailableMetrics: [{ metric: "followerDelta", reason: "below_follower_threshold" }],
        partialMetrics: [],
      },
    });
    expect(organicValueView("followerDelta", small, LOCALE)).toMatchObject({
      kind: "unavailable",
      reason: "Instagram does not report this for accounts under 100 followers",
    });
    const notReported = organicAggregate({
      metrics: {
        unavailableMetrics: [{ metric: "views", reason: "not_reported" }],
        partialMetrics: [],
      },
    });
    expect(organicValueView("views", notReported, LOCALE)).toMatchObject({
      reason: "Not reported by Instagram",
    });
  });

  it("partial values and partial ranges are marked", () => {
    const partialMetric = organicAggregate({
      metrics: { views: 10, unavailableMetrics: [], partialMetrics: ["views"] },
    });
    expect(organicValueView("views", partialMetric, LOCALE)).toMatchObject({ partial: true });
    const partialRange = organicAggregate({ dataState: "partial" });
    expect(organicValueView("likes", partialRange, LOCALE)).toMatchObject({ partial: true });
  });

  it("unknown / unsupported ranges explain themselves without an error", () => {
    const unknown = organicAggregate({
      dataState: "unknown",
      metrics: { unavailableMetrics: [], partialMetrics: [] },
    });
    expect(organicValueView("views", unknown, LOCALE)).toMatchObject({
      kind: "unavailable",
      reason: "No account data synced for this period yet.",
    });
    const unsupported = organicAggregate({
      dataState: "unsupported",
      metrics: { unavailableMetrics: [], partialMetrics: [] },
    });
    expect(organicValueView("views", unsupported, LOCALE)).toMatchObject({
      reason: "Not supported for this account.",
    });
  });

  it("engagement rate: the API value, or the API reason; never recomputed", () => {
    const single = organicAggregate({
      metrics: { reach: 200, totalInteractions: 30, unavailableMetrics: [], partialMetrics: [] },
      kpis: { engagementRate: 0.15, unavailableKpis: [] },
    });
    expect(organicValueView("engagementRate", single, LOCALE)).toEqual({
      kind: "value",
      text: "15.00%",
      partial: false,
    });
    // Both inputs present but no rate from the API: stays unavailable (no frontend division).
    const noRate = organicAggregate({
      metrics: { reach: 200, totalInteractions: 30, unavailableMetrics: [], partialMetrics: [] },
      kpis: { unavailableKpis: [{ kpi: "engagementRate", reason: "non_additive" }] },
    });
    expect(organicValueView("engagementRate", noRate, LOCALE)).toEqual({
      kind: "unavailable",
      text: "—",
      reason: "Only available for a single day — choose Today or Yesterday",
    });
    for (const [reason, text] of [
      ["numerator_unavailable", "Total interactions not reported"],
      ["denominator_unavailable", "Reach not reported"],
      ["zero_denominator", "Not defined (reach is 0)"],
    ] as const) {
      const aggregate = organicAggregate({
        kpis: { unavailableKpis: [{ kpi: "engagementRate", reason }] },
      });
      expect(organicValueView("engagementRate", aggregate, LOCALE)).toMatchObject({ reason: text });
    }
  });

  it("cards cover only the approved organic metrics", () => {
    const keys = [...ORGANIC_HEADLINE, ...ORGANIC_DETAILS];
    expect(new Set(keys).size).toBe(13);
    for (const forbidden of [
      "impressions",
      "profileViews",
      "websiteClicks",
      "reposts",
      "follows",
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys.map(organicLabel)).toContain("Profile link taps");
  });
});

describe("postValueView", () => {
  it("lifetime values of the latest capture; missing and uncaptured explained", () => {
    const snapshot = postSnapshot();
    expect(postValueView("shares", snapshot, LOCALE)).toEqual({
      kind: "value",
      text: "0",
      partial: false,
    });
    expect(postValueView("engagementRate", snapshot, LOCALE)).toMatchObject({ text: "15.50%" });
    const partial = postSnapshot({
      metrics: { likes: 3, unavailableMetrics: [{ metric: "views", reason: "not_reported" }] },
      kpis: { unavailableKpis: [{ kpi: "engagementRate", reason: "denominator_unavailable" }] },
    });
    expect(postValueView("views", partial, LOCALE)).toMatchObject({
      reason: "Not reported by Instagram",
    });
    expect(postValueView("engagementRate", partial, LOCALE)).toMatchObject({
      reason: "Reach not reported",
    });
    expect(postValueView("views", undefined, LOCALE)).toMatchObject({
      kind: "unavailable",
      reason: "Not captured yet (posts from the last 90 days are captured daily).",
    });
  });
});
