import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ORG } from "@/tests/unit/analytics-fixtures";
import { queryResults, renderWithOrg, resetHarness } from "@/tests/unit/dashboard-harness";

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

  it("links a Meta Ads connection to the Connections page too", () => {
    queryResults.set("v1/connections:list", [
      { id: "m1", provider: "meta", status: "needs_reauth" },
    ]);
    render(<ReauthBanner />);
    const banner = screen.getByLabelText("Reconnect required");
    expect(banner).toHaveTextContent("(Meta). Their accounts stop updating");
    expect(within(banner).getByRole("link", { name: "Reconnect Meta Ads" })).toHaveAttribute(
      "href",
      "/connections",
    );
    expect(within(banner).queryByRole("link", { name: /Google/ })).toBeNull();
  });

  it("offers one link per broken ad platform", () => {
    queryResults.set("v1/connections:list", [
      { id: "g1", provider: "google_ads", status: "needs_reauth" },
      { id: "m1", provider: "meta", status: "needs_reauth" },
    ]);
    render(<ReauthBanner />);
    const links = within(screen.getByLabelText("Reconnect required")).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Reconnect Google Ads",
      "Reconnect Meta Ads",
    ]);
  });

  it("links a WhatsApp reconnection to the WhatsApp settings (Embedded Signup)", () => {
    queryResults.set("v1/connections:list", [
      { id: "w1", provider: "whatsapp", status: "needs_reauth", displayName: "Acme Coaching" },
      { id: "g1", provider: "google_ads", status: "needs_reauth" },
    ]);
    render(<ReauthBanner />);
    const banner = screen.getByLabelText("Reconnect required");
    expect(banner).toHaveTextContent("(Acme Coaching, Google Ads)");
    const links = within(banner).getAllByRole("link");
    expect(links.map((link) => [link.textContent, link.getAttribute("href")])).toEqual([
      ["Reconnect Google Ads", "/connections"],
      ["Reconnect WhatsApp", "/whatsapp/settings"],
    ]);
  });

  it("keeps the Instagram banner read-only (no link)", () => {
    queryResults.set("v1/connections:list", [
      { id: "x1", provider: "instagram", status: "needs_reauth" },
    ]);
    render(<ReauthBanner />);
    const banner = screen.getByLabelText("Reconnect required");
    expect(banner).toHaveTextContent("(Instagram). Their accounts stop updating");
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

describe("FxNotice: the reporting currency the accounts suggest (C1)", () => {
  beforeEach(() => resetHarness());

  const missingInr = {
    reportingCurrency: "USD",
    status: "missing" as const,
    missing: [{ currency: "INR", days: 30 }],
  };
  const account = (currency: string, extra: Record<string, unknown> = {}) => ({
    id: currency,
    currency,
    linked: true,
    isManager: false,
    ...extra,
  });

  it("points admins to the Organization page when every account reports in one other currency", () => {
    queryResults.set("v1/adAccounts:list", [account("INR"), account("INR", { id: "b" })]);
    renderWithOrg(<FxNotice fx={missingInr} />);
    const notice = screen.getByLabelText("Currency conversion incomplete");
    expect(notice).toHaveTextContent(
      "Your ad accounts all report in INR. Use INR as the reporting currency to see totals without exchange rates.",
    );
    expect(
      within(notice).getByRole("link", { name: "Use INR as the reporting currency" }),
    ).toHaveAttribute("href", "/organization#reporting");
  });

  it("asks others to ask an admin", () => {
    queryResults.set("v1/adAccounts:list", [account("INR")]);
    renderWithOrg(<FxNotice fx={missingInr} />, { ...ORG, role: "viewer" });
    const notice = screen.getByLabelText("Currency conversion incomplete");
    expect(notice).toHaveTextContent("Ask an admin to use INR as the reporting currency");
    expect(within(notice).queryByRole("link")).toBeNull();
  });

  it.each([
    ["the accounts use several currencies", [account("INR"), account("JPY")]],
    ["only a manager account differs", [account("USD"), account("INR", { isManager: true })]],
    ["the accounts are not loaded yet", undefined],
  ])("says nothing more when %s", (_case, accounts) => {
    if (accounts !== undefined) queryResults.set("v1/adAccounts:list", accounts);
    renderWithOrg(<FxNotice fx={missingInr} />);
    expect(screen.getByLabelText("Currency conversion incomplete")).not.toHaveTextContent(
      "Your ad accounts all report",
    );
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
