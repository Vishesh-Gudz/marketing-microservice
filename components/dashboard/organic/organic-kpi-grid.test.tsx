import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderWithOrg } from "@/tests/unit/dashboard-harness";
import { organicAggregate } from "@/tests/unit/organic-fixtures";
import { OrganicKpiGrid } from "./organic-kpi-grid";

// Organic KPI cards: API values (zero stays zero), "—" + API reason (never 0), partial "*",
// followers "as of", comparison deltas only where the API provides them, and no card for
// deprecated, paid or other unapproved metrics.

function card(name: string) {
  return screen.getByRole("heading", { name }).closest("[data-kpi]") as HTMLElement;
}

describe("OrganicKpiGrid", () => {
  it("renders the 13 approved organic cards only", () => {
    renderWithOrg(<OrganicKpiGrid aggregate={organicAggregate()} />);
    const kpis = [...document.querySelectorAll("[data-kpi]")].map((el) =>
      el.getAttribute("data-kpi"),
    );
    expect(kpis).toEqual([
      "followers",
      "followerDelta",
      "reach",
      "views",
      "totalInteractions",
      "engagementRate",
      "accountsEngaged",
      "likes",
      "comments",
      "shares",
      "saves",
      "replies",
      "profileLinksTaps",
    ]);
    for (const name of [
      "Impressions",
      "Profile views",
      "Website clicks",
      "Spend",
      "Profile visits",
    ]) {
      expect(screen.queryByRole("heading", { name })).toBeNull();
    }
  });

  it("values, zeros, unavailable reasons and followers 'as of'", () => {
    renderWithOrg(<OrganicKpiGrid aggregate={organicAggregate()} />);
    expect(card("Views")).toHaveTextContent("5,400");
    expect(card("Comments")).toHaveTextContent("0");
    const reach = card("Reach");
    expect(reach).toHaveTextContent("—");
    expect(
      within(reach).getByText(/Not available: Only available for one day/),
    ).toBeInTheDocument();
    expect(card("Followers")).toHaveTextContent(/1,234as of/);
    const rate = card("Engagement rate");
    expect(rate).toHaveTextContent("—");
    expect(within(rate).getByText(/choose Today or Yesterday/)).toBeInTheDocument();
  });

  it("partial values carry the partial marker", () => {
    renderWithOrg(
      <OrganicKpiGrid
        aggregate={organicAggregate({
          metrics: { views: 10, unavailableMetrics: [], partialMetrics: ["views"] },
        })}
      />,
    );
    expect(within(card("Views")).getByLabelText("(partial data)")).toBeInTheDocument();
  });

  it("a single-day engagement rate is the API value; zero reach is explained", () => {
    const { unmount } = renderWithOrg(
      <OrganicKpiGrid
        aggregate={organicAggregate({
          metrics: {
            reach: 200,
            totalInteractions: 30,
            unavailableMetrics: [],
            partialMetrics: [],
          },
          kpis: { engagementRate: 0.15, unavailableKpis: [] },
        })}
      />,
    );
    expect(card("Engagement rate")).toHaveTextContent("15.00%");
    unmount();
    renderWithOrg(
      <OrganicKpiGrid
        aggregate={organicAggregate({
          metrics: { reach: 0, totalInteractions: 3, unavailableMetrics: [], partialMetrics: [] },
          kpis: { unavailableKpis: [{ kpi: "engagementRate", reason: "zero_denominator" }] },
        })}
      />,
    );
    expect(
      within(card("Engagement rate")).getByText(/Not defined \(reach is 0\)/),
    ).toBeInTheDocument();
  });

  it("comparison deltas come from the API (additive metrics only)", () => {
    renderWithOrg(
      <OrganicKpiGrid
        aggregate={organicAggregate()}
        comparison={{
          range: { from: "2026-07-27", to: "2026-08-25" },
          previous: organicAggregate(),
          deltas: { views: { absolute: 400, percent: 0.08 }, likes: { reason: "previous_zero" } },
        }}
      />,
    );
    expect(card("Views")).toHaveTextContent("+8.0%");
    expect(card("Likes")).toHaveTextContent("New (no previous value)");
    expect(card("Followers")).not.toHaveTextContent(/%/);
    expect(card("Reach")).not.toHaveTextContent(/%/);
  });
});
