import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryResults, renderWithOrg, resetHarness } from "@/tests/unit/dashboard-harness";
import { organicSeries, seriesPoint } from "@/tests/unit/organic-fixtures";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { OrganicSeriesPanel } from "./organic-series-panel";

// The organic series: UTC labels, honest gaps (never zero), partial periods, and the
// day-only explanation for non-additive metrics at week/month granularity.

const ARGS = {
  socialAccountId: "acct_ig_1",
  range: { from: "2026-09-01", to: "2026-09-03" },
  granularity: "day" as const,
};

describe("OrganicSeriesPanel", () => {
  beforeEach(() => resetHarness());

  it("labels UTC and shows missing days as gaps in the table view", () => {
    queryResults.set(
      "v1/organicAnalytics:accountSeries",
      organicSeries([
        seriesPoint("2026-09-01"),
        seriesPoint("2026-09-02", {
          dataState: "unknown",
          metrics: {
            unavailableMetrics: [{ metric: "views", reason: "not_reported" }],
            partialMetrics: [],
          },
        }),
        seriesPoint("2026-09-03", {
          partial: true,
          metrics: { views: 0, unavailableMetrics: [], partialMetrics: [] },
        }),
      ]),
    );
    renderWithOrg(<OrganicSeriesPanel args={ARGS} />);
    expect(
      screen.getByRole("heading", { name: "Account metrics over time (UTC)" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Views by day (UTC)" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View as table" }));
    const table = screen.getByRole("table");
    expect(within(table).getByRole("columnheader", { name: "Period (UTC)" })).toBeInTheDocument();
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "2026-09-01100Reported",
      "2026-09-02—Not synced",
      "2026-09-030Reported (partial bucket)",
    ]);
  });

  it("explains that non-additive metrics exist per day only", () => {
    queryResults.set("v1/organicAnalytics:accountSeries", {
      ...organicSeries([
        seriesPoint("2026-08-31", {
          from: "2026-09-01",
          to: "2026-09-06",
          partial: true,
          metrics: {
            views: 700,
            unavailableMetrics: [
              { metric: "reach", reason: "non_additive" },
              { metric: "accountsEngaged", reason: "non_additive" },
            ],
            partialMetrics: [],
          },
          kpis: { unavailableKpis: [{ kpi: "engagementRate", reason: "non_additive" }] },
        }),
      ]),
      granularity: "week",
    });
    renderWithOrg(<OrganicSeriesPanel args={{ ...ARGS, granularity: "week" }} />);
    expect(screen.getByRole("img", { name: "Views by week (UTC)" })).toBeInTheDocument();
  });

  it("shows nothing-to-chart instead of zeros when no period has a value", () => {
    queryResults.set(
      "v1/organicAnalytics:accountSeries",
      organicSeries([
        seriesPoint("2026-09-01", {
          dataState: "unknown",
          metrics: { unavailableMetrics: [], partialMetrics: [] },
          kpis: { unavailableKpis: [] },
        }),
      ]),
    );
    renderWithOrg(<OrganicSeriesPanel args={ARGS} />);
    expect(screen.getByText("Nothing to chart for this range")).toBeInTheDocument();
    expect(screen.getByText(/never drawn as zero/)).toBeInTheDocument();
  });
});
