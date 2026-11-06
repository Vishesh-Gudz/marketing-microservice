import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import { ORG } from "@/tests/unit/analytics-fixtures";
import {
  auth,
  ensureMock,
  queryResults,
  resetHarness,
  setUrl,
} from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { AppShell } from "./app-shell";

describe("AppShell / OrgGate", () => {
  beforeEach(() => {
    resetHarness();
    queryResults.set("health:ping", { ok: true, service: "marketing-microservice" });
    queryResults.set("v1/connections:list", []);
  });

  it("renders navigation and a signed-out message without a token", () => {
    auth.isAuthenticated = false;
    render(<AppShell>content</AppShell>);
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0]!;
    expect(within(nav).getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(screen.getByText("Not signed in")).toBeInTheDocument();
    expect(screen.queryByText("content")).not.toBeInTheDocument();
    expect(ensureMock).not.toHaveBeenCalled();
  });

  it("provisions the org once, then renders the page with the org badge", async () => {
    ensureMock.mockResolvedValue(ORG);
    queryResults.set("v1/orgs:me", ORG);
    render(<AppShell>content</AppShell>);
    expect(await screen.findByText("content")).toBeInTheDocument();
    expect(screen.getByTestId("org-badge")).toHaveTextContent("Dev Organization");
    expect(screen.getByTestId("org-badge")).toHaveTextContent("admin");
    // The reporting currency is shown in the header.
    expect(screen.getByTestId("org-badge")).toHaveTextContent("USD");
    expect(ensureMock).toHaveBeenCalledOnce();
    expect(ensureMock).toHaveBeenCalledWith({});
  });

  it("shows the contract error code when provisioning fails", async () => {
    ensureMock.mockRejectedValue(apiError("APP_NOT_REGISTERED", "unknown issuer"));
    render(<AppShell>content</AppShell>);
    expect(await screen.findByText("APP_NOT_REGISTERED")).toBeInTheDocument();
    expect(screen.getByText("Your organization could not be loaded")).toBeInTheDocument();
    expect(screen.queryByText("unknown issuer")).not.toBeInTheDocument();
  });

  it("carries global filters (not page params) on navigation links", () => {
    auth.isAuthenticated = false;
    setUrl("/campaigns", "preset=last_7_days&sort=name&platforms=meta");
    render(<AppShell>content</AppShell>);
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0]!;
    expect(within(nav).getByRole("link", { name: "Breakdowns" })).toHaveAttribute(
      "href",
      "/breakdowns?preset=last_7_days&platforms=meta",
    );
    expect(within(nav).getByRole("link", { name: "Campaigns" })).toHaveAttribute(
      "aria-current",
      "page",
    );
  });

  it("groups the main navigation and pins Connections and Settings at the bottom", () => {
    auth.isAuthenticated = false;
    setUrl("/connections", "preset=last_7_days&status=connected");
    render(<AppShell>content</AppShell>);
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0]!;
    const links = within(nav).getAllByRole("link");
    // Templates and Settings are closed groups here, so their pages are not listed.
    expect(links.map((link) => link.textContent)).toEqual([
      "Overview",
      "Inbox",
      "Campaigns",
      "Breakdowns",
      "Conversions",
      "Accounts",
      "Organic",
      "WhatsApp",
      "Instagram DMs",
      "Saved replies",
      "Connections",
    ]);
    expect(within(nav).getByRole("group", { name: "Analytics" })).toBeInTheDocument();
    expect(within(nav).getByRole("group", { name: "Messaging" })).toBeInTheDocument();
    for (const name of ["Templates", "Settings"]) {
      expect(within(nav).getByRole("button", { name })).toHaveAttribute("aria-expanded", "false");
    }
    const connections = within(nav).getByRole("link", { name: "Connections" });
    expect(connections).toHaveAttribute("aria-current", "page");
    // Like every link it carries only the global filters, never page or callback params.
    expect(connections).toHaveAttribute("href", "/connections?preset=last_7_days");
    for (const link of links.filter((l) => l !== connections)) {
      expect(link).not.toHaveAttribute("aria-current");
    }
  });

  it("opens the group of the current page and marks only that page", () => {
    auth.isAuthenticated = false;
    setUrl("/whatsapp/templates");
    render(<AppShell>content</AppShell>);
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0]!;
    expect(within(nav).getByRole("button", { name: "Templates" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const current = within(nav).getAllByRole("link", { current: "page" });
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveAccessibleName("WhatsApp templates");
    expect(within(nav).getByRole("link", { name: "WhatsApp" })).not.toHaveAttribute("aria-current");
    // Groups open and close by hand.
    const settings = within(nav).getByRole("button", { name: "Settings" });
    fireEvent.click(settings);
    expect(settings).toHaveAttribute("aria-expanded", "true");
    expect(within(nav).getByRole("link", { name: "WhatsApp settings" })).toHaveAttribute(
      "href",
      "/whatsapp/settings",
    );
    expect(within(nav).getByRole("link", { name: "Organization" })).toBeInTheDocument();
    fireEvent.click(settings);
    expect(within(nav).queryByRole("link", { name: "Organization" })).not.toBeInTheDocument();
  });

  it("marks Saved replies, not Inbox, on the saved replies page", () => {
    auth.isAuthenticated = false;
    setUrl("/inbox/saved-replies");
    render(<AppShell>content</AppShell>);
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0]!;
    expect(within(nav).getByRole("link", { name: "Saved replies" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(nav).getByRole("link", { name: "Inbox" })).not.toHaveAttribute("aria-current");
  });

  it("has a phone dock with the main pages and the full menu", () => {
    auth.isAuthenticated = false;
    setUrl("/campaigns/123", "preset=last_7_days&sort=name");
    render(<AppShell>content</AppShell>);
    const dock = screen.getByRole("navigation", { name: "Shortcuts" });
    const links = within(dock).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Overview",
      "Inbox",
      "Campaigns",
      "Organic",
    ]);
    expect(within(dock).getByRole("link", { name: "Campaigns" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(within(dock).getByRole("link", { name: "Inbox" })).toHaveAttribute(
      "href",
      "/inbox?preset=last_7_days",
    );
    fireEvent.click(within(dock).getByRole("button", { name: "Open menu" }));
    const sheet = screen.getByRole("dialog");
    expect(within(sheet).getByRole("navigation", { name: "Main" })).toBeInTheDocument();
  });

  it("shows where the page sits in the top bar", () => {
    auth.isAuthenticated = false;
    setUrl("/breakdowns");
    render(<AppShell>content</AppShell>);
    expect(screen.getByRole("banner")).toHaveTextContent("AnalyticsBreakdowns");
  });

  it("has a skip link to the main content", () => {
    auth.isAuthenticated = false;
    render(<AppShell>content</AppShell>);
    expect(screen.getByRole("link", { name: "Skip to content" })).toHaveAttribute(
      "href",
      "#main-content",
    );
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
  });
});
