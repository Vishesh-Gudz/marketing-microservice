import { screen } from "@testing-library/react";
import { Component, type ReactNode } from "react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import { entity, overview, point } from "@/tests/unit/analytics-fixtures";
import {
  lastArgs,
  notFoundMock,
  queryResults,
  renderWithOrg,
  resetHarness,
  setUrl,
  useQueryMock,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { AdGroupDetailView, CampaignDetailView } from "./campaign-detail-view";

/** Catches what escapes the view (the real notFound() is handled by Next's boundary). */
class Escaped extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    return this.state.error ? <p>escaped: {this.state.error.message}</p> : this.props.children;
  }
}

const campaign = entity({
  id: "campaign1",
  name: "Spring Sale",
  objective: "sales",
  budgetType: "daily",
  budget: { currency: "USD", micros: "50000000" },
});
const adGroup = entity({
  id: "adgroup1",
  level: "ad_group",
  name: "Lookalikes",
  campaignId: "campaign1",
});

function registerEntities() {
  queryResults.set("v1/analytics:overview", (args: Record<string, unknown>) => {
    const target = args.entity as { level: string; id: string };
    if (target.id === "campaign1") return overview({ entity: campaign });
    if (target.id === "adgroup1") return overview({ entity: adGroup });
    if (target.id === "adgroupX") return overview({ entity: { ...adGroup, campaignId: "other" } });
    throw apiError("NOT_FOUND", "Not found.");
  });
}

describe("entity detail views (D5)", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  });
  afterAll(() => vi.useRealTimers());

  beforeEach(() => {
    resetHarness();
    setUrl("/campaigns/campaign1", "preset=last_7_days&platforms=meta");
    registerEntities();
    queryResults.set("v1/analytics:timeSeries", {
      range: { from: "2026-09-18", to: "2026-09-24" },
      granularity: "day",
      level: "campaign",
      points: [point("2026-09-18")],
      coverage: { dataState: "reported", accounts: [] },
      fx: { reportingCurrency: "USD", status: "not_needed" },
    });
    queryResults.set("v1/analytics:performance", {
      page: [],
      isDone: true,
      continueCursor: "",
      range: { from: "2026-09-18", to: "2026-09-24" },
      fx: { reportingCurrency: "USD", status: "not_needed" },
    });
  });

  it("loads the campaign through overview with entity, without account filters", () => {
    renderWithOrg(<CampaignDetailView campaignId="campaign1" />);
    expect(lastArgs("v1/analytics:overview")).toEqual({
      range: { from: "2026-09-18", to: "2026-09-24" },
      entity: { level: "campaign", id: "campaign1" },
      compare: "previous_period",
    });
    expect(lastArgs("v1/analytics:timeSeries")).toEqual({
      range: { from: "2026-09-18", to: "2026-09-24" },
      granularity: "day",
      entity: { level: "campaign", id: "campaign1" },
    });
    expect(lastArgs("v1/analytics:performance")).toMatchObject({
      level: "ad_group",
      parent: { campaignId: "campaign1" },
    });
    expect(lastArgs("v1/analytics:performance")).not.toHaveProperty("filters");
  });

  it("shows the entity summary, breadcrumbs and KPIs", () => {
    renderWithOrg(<CampaignDetailView campaignId="campaign1" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Spring Sale");
    expect(screen.getByText("$50.00 daily")).toBeInTheDocument();
    expect(screen.getByText("Sales")).toBeInTheDocument();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs).toHaveTextContent("CampaignsSpring Sale");
    expect(screen.getByRole("link", { name: "Campaigns" })).toHaveAttribute(
      "href",
      "/campaigns?preset=last_7_days&platforms=meta",
    );
    expect(screen.getByTestId("entity-totals")).toHaveTextContent("$1,234.56");
    expect(screen.getByRole("tab", { name: "Ad groups" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("table", { name: "Ad groups" })).toBeInTheDocument();
  });

  it("shows the ads and conversions tabs from the URL", () => {
    setUrl("/campaigns/campaign1", "tab=ads");
    renderWithOrg(<CampaignDetailView campaignId="campaign1" />);
    expect(lastArgs("v1/analytics:performance")).toMatchObject({
      level: "ad",
      parent: { campaignId: "campaign1" },
    });

    setUrl("/campaigns/campaign1", "tab=conversions");
    queryResults.set("v1/analytics:actions", {
      range: { from: "2026-08-26", to: "2026-09-24" },
      level: "campaign",
      dataState: "reported",
      groups: [],
      coverage: { dataState: "reported", accounts: [] },
      fx: { reportingCurrency: "USD", status: "not_needed" },
    });
    renderWithOrg(<CampaignDetailView campaignId="campaign1" />);
    expect(lastArgs("v1/analytics:actions")).toEqual({
      range: { from: "2026-08-26", to: "2026-09-24" },
      entity: { level: "campaign", id: "campaign1" },
    });
  });

  it("renders the not-found page for a foreign, unknown or malformed id", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    renderWithOrg(
      <Escaped>
        <CampaignDetailView campaignId="someone-elses" />
      </Escaped>,
    );
    expect(notFoundMock).toHaveBeenCalled();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
  });

  it("shows an ad group with its campaign in the breadcrumbs and lists its ads", () => {
    setUrl("/campaigns/campaign1/ad-groups/adgroup1");
    renderWithOrg(<AdGroupDetailView campaignId="campaign1" adGroupId="adgroup1" />);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Lookalikes");
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toHaveTextContent(
      "CampaignsSpring SaleLookalikes",
    );
    expect(lastArgs("v1/analytics:performance")).toMatchObject({
      level: "ad",
      parent: { adGroupId: "adgroup1" },
    });
  });

  it("treats an ad group under the wrong campaign path as not found", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    setUrl("/campaigns/campaign1/ad-groups/adgroupX");
    renderWithOrg(<AdGroupDetailView campaignId="campaign1" adGroupId="adgroupX" />);
    expect(notFoundMock).toHaveBeenCalled();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    const performanceCalls = useQueryMock.mock.calls.filter(
      ([, args]) =>
        typeof args === "object" && args !== null && "level" in args && "paginationOpts" in args,
    );
    expect(performanceCalls).toEqual([]);
  });
});
