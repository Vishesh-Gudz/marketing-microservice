import { fireEvent, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import {
  aggregate,
  amounts,
  metrics,
  money,
  overview,
  performanceRow,
  point,
  REPORTED,
  usd,
} from "@/tests/unit/analytics-fixtures";
import {
  lastArgs,
  queryResults,
  renderWithOrg,
  resetHarness,
  setUrl,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { OverviewView } from "./overview-view";

const comparison = {
  range: { from: "2026-07-27", to: "2026-08-25" },
  previous: REPORTED,
  deltas: {
    spend: { percent: 0.1 },
    clicks: { percent: 0.25 },
    cpc: { percent: -0.2 },
    conversions: { reason: "previous_zero" as const },
  },
};

describe("OverviewView", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  });
  afterAll(() => vi.useRealTimers());

  beforeEach(() => {
    resetHarness();
    queryResults.set("v1/analytics:overview", overview({ comparison }));
    queryResults.set("v1/analytics:timeSeries", {
      range: { from: "2026-08-26", to: "2026-09-24" },
      granularity: "day",
      level: "account",
      points: [point("2026-09-01"), point("2026-09-02")],
      coverage: { dataState: "reported", accounts: [] },
      fx: { reportingCurrency: "USD", status: "not_needed" },
    });
    queryResults.set("v1/analytics:performance", {
      page: [performanceRow()],
      isDone: true,
      continueCursor: "",
      range: { from: "2026-08-26", to: "2026-09-24" },
      fx: { reportingCurrency: "USD", status: "not_needed" },
    });
    queryResults.set("v1/adAccounts:list", []);
  });

  it("resolves the default preset from the org's today and compares with the previous period", () => {
    renderWithOrg(<OverviewView />);
    expect(lastArgs("v1/analytics:overview")).toEqual({
      range: { from: "2026-08-26", to: "2026-09-24" },
      compare: "previous_period",
    });
    // 30 days -> auto day granularity (D13).
    expect(lastArgs("v1/analytics:timeSeries")).toEqual({
      range: { from: "2026-08-26", to: "2026-09-24" },
      granularity: "day",
    });
    expect(screen.getByTestId("resolved-range")).toHaveTextContent(
      "Aug 26, 2026 – Sep 24, 2026 · compared with Jul 27, 2026 – Aug 25, 2026",
    );
  });

  it("passes URL filters to every query (never an org id)", () => {
    setUrl(
      "/",
      "preset=custom&from=2026-01-01&to=2026-06-30&compare=off&platforms=meta&accounts=a1&granularity=month",
    );
    renderWithOrg(<OverviewView />);
    const filters = { platforms: ["meta"], accountIds: ["a1"] };
    expect(lastArgs("v1/analytics:overview")).toEqual({
      range: { from: "2026-01-01", to: "2026-06-30" },
      filters,
    });
    expect(lastArgs("v1/analytics:timeSeries")).toMatchObject({ granularity: "month", filters });
    expect(JSON.stringify(lastArgs("v1/analytics:performance"))).not.toMatch(/org/i);
  });

  it("shows the 10 KPIs with exact values and comparison chips", () => {
    renderWithOrg(<OverviewView />);
    const totals = screen.getByTestId("overview-totals");
    expect(within(totals).getAllByRole("heading", { level: 3 })).toHaveLength(10);
    const spend = totals.querySelector('[data-kpi="spend"]') as HTMLElement;
    expect(spend).toHaveTextContent("$1,234.56");
    expect(within(spend).getByText("+10.0%").closest("[data-slot=delta]")).toHaveAttribute(
      "data-tone",
      "neutral",
    );
    const cpc = totals.querySelector('[data-kpi="cpc"]') as HTMLElement;
    expect(cpc.querySelector("[data-slot=delta]")).toHaveAttribute("data-tone", "positive");
    const conversions = totals.querySelector('[data-kpi="conversions"]') as HTMLElement;
    expect(conversions).toHaveTextContent("New (no previous value)");
  });

  it("shows skeletons while loading", () => {
    queryResults.delete("v1/analytics:overview");
    renderWithOrg(<OverviewView />);
    expect(screen.getByTestId("kpi-skeleton")).toBeInTheDocument();
  });

  it("shows an empty state without accounts", () => {
    queryResults.set("v1/analytics:overview", overview({ accountCount: 0 }));
    renderWithOrg(<OverviewView />);
    expect(screen.getByText("No ad accounts in this scope")).toBeInTheDocument();
  });

  it("explains partial coverage, missing FX and multi-currency totals", () => {
    queryResults.set(
      "v1/analytics:overview",
      overview({
        totals: aggregate({
          dataState: "partial",
          metrics: metrics({
            spend: amounts([money("EUR", 10), money("USD", 5)]),
            partialMetrics: ["spend"],
          }),
        }),
        coverage: {
          dataState: "partial",
          accounts: [
            { accountId: "a1", daysUncovered: 3, supported: true },
            { accountId: "a2", daysUncovered: 0, supported: true },
          ],
        },
        fx: {
          reportingCurrency: "USD",
          status: "missing",
          missing: [{ currency: "EUR", days: 4 }],
        },
      }),
    );
    renderWithOrg(<OverviewView />);
    expect(screen.getByLabelText("Partial data")).toHaveTextContent(
      "Partial: 3 days not yet synced",
    );
    expect(screen.getByLabelText("Currency conversion incomplete")).toHaveTextContent(
      "EUR (4 days)",
    );
    const spend = document.querySelector('[data-kpi="spend"]') as HTMLElement;
    expect(spend).toHaveTextContent("Multiple currencies");
    fireEvent.click(
      within(spend).getByRole("button", {
        name: "Multiple currencies (partial data): show amounts per currency",
      }),
    );
    const amountsList = screen.getByText(
      "Amounts per currency (not added together)",
    ).parentElement!;
    expect(amountsList).toHaveTextContent("€10.00");
    expect(amountsList).toHaveTextContent("$5.00");
  });

  it("shows unknown values as unavailable with a reason, never 0", () => {
    queryResults.set(
      "v1/analytics:overview",
      overview({ totals: aggregate({ dataState: "unknown" }) }),
    );
    renderWithOrg(<OverviewView />);
    const clicks = document.querySelector('[data-kpi="clicks"]') as HTMLElement;
    expect(clicks).not.toHaveTextContent("0");
    expect(clicks).toHaveTextContent("Not available: No data synced for this period.");
  });

  it("says 'No delivery' on cards instead of 0", () => {
    queryResults.set(
      "v1/analytics:overview",
      overview({ totals: aggregate({ dataState: "no_delivery" }) }),
    );
    renderWithOrg(<OverviewView />);
    const spend = document.querySelector('[data-kpi="spend"]') as HTMLElement;
    expect(spend).toHaveTextContent("No delivery");
    expect(spend).not.toHaveTextContent("$0.00");
  });

  it("shows data freshness, the platform split and the reconnect warning", () => {
    queryResults.set(
      "v1/analytics:overview",
      overview({
        coverage: {
          dataState: "reported",
          accounts: [
            {
              accountId: "a1",
              coveredThrough: "2026-09-24",
              daysUncovered: 0,
              lastSyncedAt: "2026-09-25T06:00:00.000Z",
              supported: true,
            },
          ],
        },
      }),
    );
    queryResults.set("v1/analytics:breakdown", {
      by: "platform",
      level: "account",
      range: { from: "2026-08-26", to: "2026-09-24" },
      groups: [
        { key: "meta", platform: "meta", ...aggregate({ metrics: metrics({ spend: usd(75) }) }) },
        {
          key: "google_ads",
          platform: "google_ads",
          ...aggregate({ metrics: metrics({ spend: usd(25) }) }),
        },
      ],
      coverage: { dataState: "reported", accounts: [] },
      fx: { reportingCurrency: "USD", status: "not_needed" },
    });
    queryResults.set("v1/connections:list", [
      { id: "c1", provider: "meta", status: "needs_reauth", displayName: "Meta (Dev)" },
    ]);
    renderWithOrg(<OverviewView />);
    expect(screen.getByTestId("freshness")).toHaveTextContent(
      "Data through Sep 24, 2026 · last synced Sep 25, 2026, 6:00 AM (UTC)",
    );
    expect(lastArgs("v1/analytics:breakdown")).toEqual({
      by: "platform",
      range: { from: "2026-08-26", to: "2026-09-24" },
    });
    const meta = document.querySelector('[data-share-key="meta"]') as HTMLElement;
    expect(meta).toHaveTextContent("Meta$75.0075%");
    expect(screen.getByLabelText("Reconnect required")).toHaveTextContent("Meta (Dev)");
  });

  it("isolates a too_many_rows failure to its region", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    queryResults.set("v1/analytics:timeSeries", () => {
      throw apiError("INVALID_ARGUMENT", "Too many rows.", {
        reason: "too_many_rows",
        maxRows: 8000,
        budget: "metrics",
      });
    });
    renderWithOrg(<OverviewView />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-error-kind", "too_many_rows");
    expect(alert).toHaveTextContent("Too much data for one view");
    expect(screen.getByTestId("overview-totals")).toBeInTheDocument();
  });
});
