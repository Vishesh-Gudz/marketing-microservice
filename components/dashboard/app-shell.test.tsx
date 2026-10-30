import { render, screen, within } from "@testing-library/react";
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

  it("lists Connections last in the main navigation, marked current on /connections", () => {
    auth.isAuthenticated = false;
    setUrl("/connections", "preset=last_7_days&status=connected");
    render(<AppShell>content</AppShell>);
    const nav = screen.getAllByRole("navigation", { name: "Main" })[0]!;
    const links = within(nav).getAllByRole("link");
    expect(links.map((link) => link.textContent)).toEqual([
      "Overview",
      "Campaigns",
      "Breakdowns",
      "Conversions",
      "Accounts",
      "Organic",
      "Organization",
      "Inbox",
      "WhatsApp",
      "Instagram DMs",
      "Connections",
    ]);
    const connections = within(nav).getByRole("link", { name: "Connections" });
    expect(connections).toHaveAttribute("aria-current", "page");
    // Like every link it carries only the global filters, never page or callback params.
    expect(connections).toHaveAttribute("href", "/connections?preset=last_7_days");
    for (const link of links.filter((l) => l !== connections)) {
      expect(link).not.toHaveAttribute("aria-current");
    }
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
