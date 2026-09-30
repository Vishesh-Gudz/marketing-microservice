import { fireEvent, screen, within } from "@testing-library/react";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  lastReplacedQuery,
  queryResults,
  renderWithOrg,
  resetHarness,
  routerReplace,
  setUrl,
} from "@/tests/unit/dashboard-harness";
import { ORG } from "@/tests/unit/analytics-fixtures";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { FilterBar } from "./filter-bar";

describe("FilterBar", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-25T12:00:00Z"));
  });
  afterAll(() => vi.useRealTimers());

  beforeEach(() => {
    resetHarness();
    setUrl("/campaigns", "sort=name");
    queryResults.set("v1/adAccounts:list", [
      {
        id: "a1",
        name: "Meta EU",
        platform: "meta",
        currency: "EUR",
        isManager: false,
        linked: true,
      },
      {
        id: "m1",
        name: "Manager",
        platform: "google_ads",
        currency: "USD",
        isManager: true,
        linked: true,
      },
    ]);
  });

  it("toggles platforms through the URL and keeps page params", () => {
    renderWithOrg(<FilterBar />);
    const group = screen.getByRole("group", { name: "Platforms" });
    const meta = within(group).getByRole("button", { name: "Meta" });
    expect(meta).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(meta);
    expect(routerReplace).toHaveBeenCalledWith("/campaigns?sort=name&platforms=meta", {
      scroll: false,
    });
  });

  it("validates a custom range before applying it", () => {
    setUrl("/", "preset=custom&from=2026-09-01&to=2026-09-10");
    renderWithOrg(<FilterBar />);
    const range = screen.getByRole("group", { name: "Custom date range" });
    const from = within(range).getByLabelText("From");
    const to = within(range).getByLabelText("To");
    expect(from).toHaveValue("2026-09-01");

    fireEvent.change(to, { target: { value: "2026-08-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The start date must not be after the end date.",
    );
    expect(within(range).getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(to).toHaveAttribute("aria-invalid", "true");

    fireEvent.change(from, { target: { value: "2024-01-01" } });
    fireEvent.change(to, { target: { value: "2026-01-01" } });
    expect(screen.getByRole("alert")).toHaveTextContent("at most 400 days");

    fireEvent.change(from, { target: { value: "2026-07-01" } });
    fireEvent.change(to, { target: { value: "2026-07-31" } });
    fireEvent.click(within(range).getByRole("button", { name: "Apply" }));
    expect(lastReplacedQuery().toString()).toBe("preset=custom&from=2026-07-01&to=2026-07-31");
  });

  it("describes the resolved range and comparison", () => {
    setUrl("/", "preset=previous_month&compare=custom&cfrom=2025-08-01&cto=2025-08-31");
    renderWithOrg(<FilterBar />);
    expect(screen.getByTestId("resolved-range")).toHaveTextContent(
      "Aug 1, 2026 – Aug 31, 2026 · compared with Aug 1, 2025 – Aug 31, 2025",
    );
  });

  it("hides controls a view does not support", () => {
    renderWithOrg(<FilterBar accounts={false} compare={false} />);
    expect(screen.queryByRole("group", { name: "Platforms" })).not.toBeInTheDocument();
    expect(screen.queryByText("Compare")).not.toBeInTheDocument();
    expect(screen.getByTestId("resolved-range")).not.toHaveTextContent("compared");
  });

  it("offers linked and unlinked ad accounts but not manager accounts", () => {
    renderWithOrg(<FilterBar />);
    fireEvent.click(screen.getByRole("button", { name: /Accounts All accounts/ }));
    expect(screen.getByLabelText(/Meta EU/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Manager/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/Meta EU/));
    expect(lastReplacedQuery().get("accounts")).toBe("a1");
  });

  it("keeps org-day presets by default and resolves UTC presets with dayBasis='utc'", () => {
    // 2026-09-25T12:00Z is still Sep 25 in UTC but already Sep 26 in Auckland.
    const org = { ...ORG, timezone: "Pacific/Auckland" };
    setUrl("/", "preset=yesterday");
    const { unmount } = renderWithOrg(<FilterBar />, org);
    expect(screen.getByTestId("resolved-range")).toHaveTextContent("Sep 25, 2026");
    expect(screen.getByText(/each ad account's local days; presets use Pacific\/Auckland/));
    expect(screen.queryByTestId("day-basis")).not.toBeInTheDocument();
    unmount();

    renderWithOrg(<FilterBar dayBasis="utc" accounts={false} />, org);
    expect(screen.getByTestId("resolved-range")).toHaveTextContent("Sep 24, 2026");
    expect(screen.getByTestId("day-basis")).toHaveTextContent(
      "Account metrics use UTC days and presets use UTC; post publish dates use Pacific/Auckland.",
    );
  });
});
