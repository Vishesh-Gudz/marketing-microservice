import { fireEvent, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { entity, performanceRow, REPORTED } from "@/tests/unit/analytics-fixtures";
import {
  lastArgs,
  lastReplacedQuery,
  queryResults,
  renderWithOrg,
  resetHarness,
  setUrl,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { PerformanceTable } from "./performance-table";

function page(rows: ReturnType<typeof performanceRow>[], isDone: boolean, continueCursor = "") {
  return {
    page: rows,
    isDone,
    continueCursor,
    range: { from: "2026-08-26", to: "2026-09-24" },
    fx: { reportingCurrency: "USD", status: "not_needed" },
  };
}

// A fresh element per render: the mocked useSearchParams is not a React subscription, so a
// re-render with new URL state needs new props (in the app, Next's context re-renders it).
const campaignsTable = () => (
  <PerformanceTable
    level="campaign"
    useAccountFilters
    caption="Campaigns"
    hrefFor={(row) => `/campaigns/${row.entity.id}`}
  />
);

describe("PerformanceTable", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  });
  afterAll(() => vi.useRealTimers());

  beforeEach(() => {
    resetHarness();
    setUrl("/campaigns", "platforms=meta&preset=last_7_days");
    queryResults.set("v1/analytics:performance", (args: Record<string, unknown>) => {
      const cursor = (args.paginationOpts as { cursor: string | null }).cursor;
      return cursor === null
        ? page(
            [
              performanceRow(),
              performanceRow({
                entity: entity({ id: "campaign2", name: "Gone", removed: true }),
                dataState: "no_delivery",
                metrics: { unavailableMetrics: [], partialMetrics: [] },
                kpis: { unavailableKpis: [], partialKpis: [] },
              }),
            ],
            false,
            "next-1",
          )
        : page([performanceRow({ entity: entity({ id: "campaign3", name: "Page two" }) })], true);
    });
  });

  it("requests the server-sorted first page with filters and comparison", () => {
    renderWithOrg(campaignsTable());
    expect(lastArgs("v1/analytics:performance")).toEqual({
      level: "campaign",
      range: { from: "2026-09-18", to: "2026-09-24" },
      sort: { by: "spend", dir: "desc" },
      filters: { platforms: ["meta"] },
      compare: "previous_period",
      paginationOpts: { numItems: 25, cursor: null },
    });
  });

  it("renders rows with links that keep the global filters, and data states", () => {
    renderWithOrg(campaignsTable());
    expect(screen.getByRole("link", { name: "Spring Sale" })).toHaveAttribute(
      "href",
      "/campaigns/campaign1?preset=last_7_days&platforms=meta",
    );
    const gone = screen.getByText("Gone").closest("tr") as HTMLElement;
    expect(within(gone).getByText("Removed")).toBeInTheDocument();
    expect(within(gone).getByText("No delivery")).toBeInTheDocument();
    // D10: a "No delivery" badge and no zeros.
    expect(gone).not.toHaveTextContent("$0.00");
    expect(gone).toHaveTextContent("Not available: No delivery in this period.");
  });

  it("marks the sorted column and changes sort through the URL", () => {
    renderWithOrg(campaignsTable());
    const spend = screen.getByRole("columnheader", { name: /Spend/ });
    expect(spend).toHaveAttribute("aria-sort", "descending");
    expect(screen.getByRole("columnheader", { name: /Name/ })).toHaveAttribute("aria-sort", "none");
    fireEvent.click(within(screen.getByRole("columnheader", { name: /Name/ })).getByRole("button"));
    expect(lastReplacedQuery().get("sort")).toBe("name");
    expect(lastReplacedQuery().get("dir")).toBe("asc");
    expect(lastReplacedQuery().get("platforms")).toBe("meta");
  });

  it("reads the sort from the URL; page size is UI state (default 25)", () => {
    setUrl("/campaigns", "sort=clicks&dir=asc&size=100");
    renderWithOrg(campaignsTable());
    expect(lastArgs("v1/analytics:performance")).toMatchObject({
      sort: { by: "clicks", dir: "asc" },
      paginationOpts: { numItems: 25, cursor: null },
    });
    expect(screen.getByRole("columnheader", { name: /Clicks/ })).toHaveAttribute(
      "aria-sort",
      "ascending",
    );
  });

  it("pages with the API cursor and back", () => {
    renderWithOrg(campaignsTable());
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(lastArgs("v1/analytics:performance")).toMatchObject({
      paginationOpts: { numItems: 25, cursor: "next-1" },
    });
    expect(screen.getByText("Page two")).toBeInTheDocument();
    expect(screen.getByText("Page 2")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText("Spring Sale")).toBeInTheDocument();
  });

  it("restarts at the first page when the arguments change", () => {
    const { rerender } = renderWithOrg(campaignsTable());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    setUrl("/campaigns", "platforms=google_ads&preset=last_7_days");
    rerender(campaignsTable());
    expect(lastArgs("v1/analytics:performance")).toMatchObject({
      filters: { platforms: ["google_ads"] },
      paginationOpts: { cursor: null },
    });
  });

  it("uses the parent instead of account filters for child tables", () => {
    renderWithOrg(
      <PerformanceTable
        level="ad_group"
        parent={{ campaignId: "campaign1" }}
        useAccountFilters={false}
        caption="Ad groups"
      />,
    );
    const args = lastArgs("v1/analytics:performance");
    expect(args).toMatchObject({ level: "ad_group", parent: { campaignId: "campaign1" } });
    expect(args).not.toHaveProperty("filters");
  });

  it("shows an empty state for an empty scope", () => {
    queryResults.set("v1/analytics:performance", page([], true));
    renderWithOrg(campaignsTable());
    expect(screen.getByText("No campaigns in this scope")).toBeInTheDocument();
  });

  it("keeps the comparison delta next to spend", () => {
    queryResults.set(
      "v1/analytics:performance",
      page(
        [
          performanceRow({
            comparison: {
              range: { from: "a", to: "b" },
              previous: REPORTED,
              deltas: { spend: { percent: 0.5 } },
            },
          }),
        ],
        true,
      ),
    );
    renderWithOrg(campaignsTable());
    expect(screen.getByText("+50.0%")).toBeInTheDocument();
  });
});
