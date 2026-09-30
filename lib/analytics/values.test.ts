import { describe, expect, it } from "vitest";
import {
  aggregate,
  amounts,
  kpis,
  metrics,
  money,
  REPORTED,
} from "@/tests/unit/analytics-fixtures";
import { KPI_CARDS, valueView } from "./values";

const options = { locale: "en-US" };

describe("valueView", () => {
  it("formats every headline KPI of a reported aggregate", () => {
    expect(KPI_CARDS).toHaveLength(10);
    const texts = KPI_CARDS.map((key) => {
      const view = valueView(key, REPORTED, options);
      return view.kind === "value" ? view.text : view.reason;
    });
    expect(texts).toEqual([
      "$1,234.56",
      "100,000",
      "2,000",
      "2.00%",
      "$0.62",
      "$12.35",
      "40",
      "$5,000.00",
      "$30.86",
      "4.05×",
    ]);
  });

  it("explains unavailable metrics and KPIs with the API reason", () => {
    const value = aggregate({
      metrics: metrics({ unavailableMetrics: [{ metric: "clicks", reason: "not_reported" }] }),
      kpis: kpis({ unavailableKpis: [{ kpi: "ctr", reason: "zero_denominator" }] }),
    });
    expect(valueView("clicks", value, options)).toEqual({
      kind: "unavailable",
      text: "—",
      reason: "Not reported by the platform",
    });
    expect(valueView("ctr", value, options)).toMatchObject({
      reason: "Not defined (divides by zero)",
    });
  });

  it("says 'no delivery' instead of showing 0 (D10)", () => {
    const none = aggregate({ dataState: "no_delivery" });
    for (const key of ["spend", "clicks", "ctr"] as const) {
      expect(valueView(key, none, options)).toEqual({
        kind: "unavailable",
        text: "—",
        reason: "No delivery in this period.",
      });
    }
  });

  it("never shows 0 for unsynced data", () => {
    expect(valueView("spend", aggregate({ dataState: "unknown" }), options)).toEqual({
      kind: "unavailable",
      text: "—",
      reason: "No data synced for this period.",
    });
  });

  it("flags partial values and lists currencies it cannot combine", () => {
    const value = aggregate({
      dataState: "partial",
      metrics: metrics({
        spend: amounts([money("EUR", 5), money("GBP", 7)]),
        partialMetrics: ["spend"],
      }),
    });
    expect(valueView("spend", value, options)).toEqual({
      kind: "value",
      text: "Multiple currencies",
      detail: ["€5.00", "£7.00"],
      partial: true,
    });
  });
});
