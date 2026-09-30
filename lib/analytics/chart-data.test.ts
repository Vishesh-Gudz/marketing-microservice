import { describe, expect, it } from "vitest";
import {
  aggregate,
  amounts,
  kpis,
  metrics,
  money,
  point,
  usd,
} from "@/tests/unit/analytics-fixtures";
import {
  bucketLabel,
  buildSeries,
  formatRange,
  plotRows,
  seriesCurrency,
  spendShares,
  type ChartRow,
} from "./chart-data";

const L = "en-US";

describe("buildSeries", () => {
  it("gaps unknown / unsupported buckets and plots no_delivery as 0", () => {
    const points = [
      point("2026-09-01", aggregate({ metrics: metrics({ clicks: 10, spend: usd(5) }) })),
      point("2026-09-02", aggregate({ dataState: "no_delivery" })),
      point("2026-09-03", aggregate({ dataState: "unknown" })),
      point("2026-09-04", aggregate({ dataState: "unsupported" })),
    ];
    const clicks = buildSeries(points, "clicks", "USD", L);
    expect(clicks.available && clicks.rows.map((r) => r.value)).toEqual([10, 0, null, null]);
    const spend = buildSeries(points, "spend", "USD", L);
    expect(spend.available && spend.rows.map((r) => r.display)).toEqual([
      "$5.00",
      "$0.00",
      "—",
      "—",
    ]);
  });

  it("keeps ratios undefined when nothing was delivered", () => {
    const points = [
      point("2026-09-01", aggregate({ kpis: kpis({ ctr: 0.05 }) })),
      point("2026-09-02", aggregate({ dataState: "no_delivery" })),
    ];
    const series = buildSeries(points, "ctr", "USD", L);
    expect(series.available && series.rows.map((r) => [r.value, r.display])).toEqual([
      [0.05, "5.00%"],
      [null, "—"],
    ]);
  });

  it("flags partial buckets and partially synced buckets", () => {
    const points = [
      point("2026-09-01", { partial: true }),
      point("2026-09-02", aggregate({ dataState: "partial" })),
      point("2026-09-03"),
    ];
    const series = buildSeries(points, "clicks", "USD", L);
    expect(series.available && series.rows.map((r) => r.incomplete)).toEqual([true, true, false]);
  });

  it("uses the reporting currency when every value has it", () => {
    const points = [
      point(
        "2026-09-01",
        aggregate({ metrics: metrics({ spend: amounts([money("EUR", 9)], money("USD", 10)) }) }),
      ),
      point("2026-09-02", aggregate({ metrics: metrics({ spend: usd(20) }) })),
    ];
    const series = buildSeries(points, "spend", "USD", L);
    expect(series).toMatchObject({ available: true, currency: "USD" });
    expect(series.available && series.rows.map((r) => r.value)).toEqual([10, 20]);
  });

  it("falls back to a single native currency, and refuses to mix currencies", () => {
    const eurOnly = [
      point("2026-09-01", aggregate({ metrics: metrics({ spend: amounts([money("EUR", 9)]) }) })),
    ];
    expect(buildSeries(eurOnly, "spend", "USD", L)).toMatchObject({ currency: "EUR" });
    const mixed = [
      point("2026-09-01", aggregate({ metrics: metrics({ spend: amounts([money("EUR", 9)]) }) })),
      point("2026-09-02", aggregate({ metrics: metrics({ spend: amounts([money("GBP", 9)]) }) })),
    ];
    expect(buildSeries(mixed, "spend", "USD", L)).toEqual({
      available: false,
      metric: "spend",
      reason: "mixed_currency",
    });
  });

  it("seriesCurrency ignores missing values", () => {
    expect(seriesCurrency([undefined, undefined], "USD")).toBeUndefined();
  });
});

describe("plotRows (dashed partial segments)", () => {
  const row = (value: number | null, incomplete = false): ChartRow => ({
    bucket: "b",
    from: "f",
    to: "t",
    dataState: "reported",
    incomplete,
    value,
    display: "",
  });

  it("draws complete buckets solid and segments touching a partial bucket dashed", () => {
    const rows = plotRows([row(1, true), row(2), row(3), row(4), row(5, true)]);
    expect(rows.map((r) => r.solid)).toEqual([null, 2, 3, 4, null]);
    expect(rows.map((r) => r.dashed)).toEqual([1, 2, null, 4, 5]);
  });

  it("keeps gaps in both lines", () => {
    const rows = plotRows([row(1), row(null), row(3, true)]);
    expect(rows.map((r) => [r.solid, r.dashed])).toEqual([
      [1, null],
      [null, null],
      [null, 3],
    ]);
  });
});

describe("spendShares", () => {
  it("computes shares in one currency only", () => {
    expect(spendShares([usd(75), usd(25), undefined], "USD")).toEqual({
      available: true,
      currency: "USD",
      shares: [0.75, 0.25, null],
    });
    expect(spendShares([amounts([money("EUR", 1)]), amounts([money("GBP", 1)])], "USD")).toEqual({
      available: false,
      reason: "mixed_currency",
    });
    expect(spendShares([undefined], "USD")).toEqual({ available: false, reason: "no_spend" });
  });
});

describe("labels", () => {
  it("formats bucket keys and ranges without time-zone shifts", () => {
    expect(bucketLabel("2026-09-03", "day", L)).toBe("Sep 3");
    expect(bucketLabel("2026-08-31", "week", L)).toBe("Aug 31");
    expect(bucketLabel("2026-09", "month", L)).toBe("Sep 2026");
    expect(formatRange({ from: "2026-09-01", to: "2026-09-30" }, L)).toBe(
      "Sep 1, 2026 – Sep 30, 2026",
    );
    expect(formatRange({ from: "2026-09-01", to: "2026-09-01" }, L)).toBe("Sep 1, 2026");
  });
});
