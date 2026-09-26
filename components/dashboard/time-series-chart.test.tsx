import { fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { aggregate, amounts, metrics, money, point, usd } from "@/tests/unit/analytics-fixtures";
import { renderWithOrg } from "@/tests/unit/dashboard-harness";
import { TimeSeriesChart } from "./time-series-chart";

const points = [
  point("2026-09-01", aggregate({ metrics: metrics({ spend: usd(10), clicks: 4 }) })),
  point("2026-09-02", aggregate({ dataState: "no_delivery" })),
  point("2026-09-03", aggregate({ dataState: "unknown" })),
  point("2026-09-04", { partial: true, ...aggregate({ metrics: metrics({ spend: usd(2.5) }) }) }),
];

function renderChart(overrides: Partial<Parameters<typeof TimeSeriesChart>[0]> = {}) {
  const onMetricChange = vi.fn();
  renderWithOrg(
    <TimeSeriesChart
      points={points}
      granularity="day"
      reportingCurrency="USD"
      metric="spend"
      onMetricChange={onMetricChange}
      {...overrides}
    />,
  );
  return onMetricChange;
}

describe("TimeSeriesChart", () => {
  it("renders an accessible chart with a description", () => {
    renderChart();
    expect(screen.getByRole("img", { name: "Spend (USD) by day" })).toBeInTheDocument();
    expect(
      screen.getByText(/Dashed segments and hollow points are partial buckets/),
    ).toBeInTheDocument();
  });

  it("has an equivalent table view with honest gaps", () => {
    renderChart();
    fireEvent.click(screen.getByRole("button", { name: "View as table" }));
    const rows = within(screen.getByRole("table")).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "2026-09-01$10.00Reported",
      "2026-09-02$0.00No delivery",
      "2026-09-03—Not synced",
      "2026-09-04$2.50Reported (partial bucket)",
    ]);
    expect(screen.getByRole("button", { name: "View as chart" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("refuses to chart money across currencies without exchange rates", () => {
    renderChart({
      points: [
        point("2026-09-01", aggregate({ metrics: metrics({ spend: amounts([money("EUR", 1)]) }) })),
        point("2026-09-02", aggregate({ metrics: metrics({ spend: amounts([money("GBP", 1)]) }) })),
      ],
    });
    expect(screen.getByText("This metric cannot be charted in one currency")).toBeInTheDocument();
  });

  it("says so when no bucket has a value", () => {
    renderChart({ points: [point("2026-09-01", aggregate({ dataState: "unknown" }))] });
    expect(screen.getByText("Nothing to chart for this range")).toBeInTheDocument();
  });
});
