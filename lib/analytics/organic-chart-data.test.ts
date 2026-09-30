import { describe, expect, it } from "vitest";
import { postSnapshot, seriesPoint } from "@/tests/unit/organic-fixtures";
import { organicSeriesRows, postSnapshotRows } from "./organic-chart-data";

// Chart rows come from API points only: gaps are null (never 0), explicit zeros stay 0,
// partial buckets are incomplete, and non-additive metrics are flagged day-only.

const LOCALE = "en-US";

describe("organicSeriesRows", () => {
  it("unknown buckets and unreported values are gaps; zeros are plotted", () => {
    const points = [
      seriesPoint("2026-09-01"),
      seriesPoint("2026-09-02", {
        dataState: "unknown",
        metrics: {
          unavailableMetrics: [{ metric: "views", reason: "not_reported" }],
          partialMetrics: [],
        },
      }),
      seriesPoint("2026-09-03", {
        metrics: { views: 0, unavailableMetrics: [], partialMetrics: [] },
      }),
      seriesPoint("2026-09-04", {
        metrics: {
          unavailableMetrics: [{ metric: "views", reason: "not_reported" }],
          partialMetrics: [],
        },
      }),
    ];
    const { rows, dayOnly } = organicSeriesRows(points, "views", LOCALE);
    expect(rows.map((r) => [r.bucket, r.value, r.display])).toEqual([
      ["2026-09-01", 100, "100"],
      ["2026-09-02", null, "—"],
      ["2026-09-03", 0, "0"],
      ["2026-09-04", null, "—"],
    ]);
    expect(dayOnly).toBe(false);
  });

  it("partial buckets are incomplete", () => {
    const { rows } = organicSeriesRows(
      [
        seriesPoint("2026-09-01", { partial: true }),
        seriesPoint("2026-09-02", { dataState: "partial" }),
      ],
      "views",
      LOCALE,
    );
    expect(rows.map((r) => r.incomplete)).toEqual([true, true]);
  });

  it("non-additive metrics at week/month granularity are day-only (API reason)", () => {
    const week = seriesPoint("2026-08-31", {
      from: "2026-09-01",
      to: "2026-09-06",
      metrics: {
        views: 700,
        unavailableMetrics: [{ metric: "reach", reason: "non_additive" }],
        partialMetrics: [],
      },
      kpis: { unavailableKpis: [{ kpi: "engagementRate", reason: "non_additive" }] },
    });
    expect(organicSeriesRows([week], "reach", LOCALE).dayOnly).toBe(true);
    expect(organicSeriesRows([week], "engagementRate", LOCALE).dayOnly).toBe(true);
    expect(organicSeriesRows([week], "views", LOCALE).dayOnly).toBe(false);
  });

  it("engagement rate is the API's per-day value", () => {
    const { rows } = organicSeriesRows([seriesPoint("2026-09-01")], "engagementRate", LOCALE);
    expect(rows[0]).toMatchObject({ value: 0.1, display: "10.00%" });
  });
});

describe("postSnapshotRows", () => {
  it("lifetime totals per capture day, never differenced", () => {
    const rows = postSnapshotRows(
      [
        postSnapshot({
          capturedDate: "2026-09-27",
          metrics: { likes: 30, unavailableMetrics: [] },
        }),
        postSnapshot(),
      ],
      "likes",
      LOCALE,
    );
    expect(rows.map((r) => [r.bucket, r.value])).toEqual([
      ["2026-09-27", 30],
      ["2026-09-28", 50],
    ]);
  });
});
