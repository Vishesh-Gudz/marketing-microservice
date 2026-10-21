import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryResults, resetHarness } from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);

import { CoverageNotice, FxNotice, ReauthBanner } from "./notices";

describe("ReauthBanner", () => {
  beforeEach(() => resetHarness());

  it("is silent while every connection works", () => {
    queryResults.set("v1/connections:list", [
      { id: "g1", provider: "google_ads", status: "active" },
    ]);
    const { container } = render(<ReauthBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("links a Google Ads reconnection to the Connections page", () => {
    queryResults.set("v1/connections:list", [
      { id: "g1", provider: "google_ads", status: "needs_reauth" },
    ]);
    render(<ReauthBanner />);
    const banner = screen.getByLabelText("Reconnect required");
    expect(banner).toHaveTextContent("A connection needs to be reconnected (Google Ads).");
    expect(within(banner).getByRole("link", { name: "Reconnect Google Ads" })).toHaveAttribute(
      "href",
      "/connections",
    );
  });

  it.each([
    ["meta", "Meta"],
    ["instagram", "Instagram"],
  ])("keeps the %s banner read-only (no link)", (provider, name) => {
    queryResults.set("v1/connections:list", [{ id: "x1", provider, status: "needs_reauth" }]);
    render(<ReauthBanner />);
    const banner = screen.getByLabelText("Reconnect required");
    expect(banner).toHaveTextContent(`(${name}). Their accounts stop updating`);
    expect(within(banner).queryByRole("link")).toBeNull();
  });
});

describe("FxNotice", () => {
  it("is silent when no conversion is needed", () => {
    const { container } = render(
      <FxNotice fx={{ reportingCurrency: "USD", status: "not_needed" }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("explains a complete conversion", () => {
    render(<FxNotice fx={{ reportingCurrency: "USD", status: "complete" }} />);
    expect(screen.getByLabelText("Currency conversion")).toHaveTextContent(
      "converted to USD with daily exchange rates",
    );
  });

  it("lists missing rates and says totals stay per currency", () => {
    render(
      <FxNotice
        fx={{
          reportingCurrency: "USD",
          status: "missing",
          missing: [
            { currency: "IDR", days: 1 },
            { currency: "JPY", days: 28 },
          ],
        }}
      />,
    );
    const notice = screen.getByLabelText("Currency conversion incomplete");
    expect(notice).toHaveTextContent("IDR (1 day), JPY (28 days)");
    expect(notice).toHaveTextContent("never added together");
  });
});

describe("CoverageNotice", () => {
  it("reports unsynced days and unsupported accounts", () => {
    render(
      <CoverageNotice
        coverage={{
          dataState: "partial",
          accounts: [
            { accountId: "a", daysUncovered: 2, supported: true },
            { accountId: "b", daysUncovered: 3, supported: true },
            { accountId: "c", daysUncovered: 0, supported: false },
          ],
        }}
      />,
    );
    expect(screen.getByLabelText("Partial data")).toHaveTextContent(
      "Partial: 5 days not yet synced across 2 accounts",
    );
    expect(screen.getByLabelText("Partial data")).toHaveTextContent(
      "1 account does not report this view.",
    );
  });

  it("says when nothing is synced", () => {
    render(<CoverageNotice coverage={{ dataState: "unknown", accounts: [] }} />);
    expect(screen.getByLabelText("Data not synced")).toBeInTheDocument();
  });
});
