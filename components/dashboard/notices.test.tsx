import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);

import { CoverageNotice, FxNotice } from "./notices";

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
