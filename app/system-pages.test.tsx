import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { renderWithOrg } from "@/tests/unit/dashboard-harness";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);

import DashboardError from "./(dashboard)/error";
import DashboardNotFound from "./(dashboard)/not-found";
import OrganizationPage, { metadata } from "./(dashboard)/organization/[[...organization]]/page";
import NotFound from "./not-found";

// The system pages (revamp Phase 11): each says what happened in a heading and offers one way
// on. Their wording is the contract the e2e and visual specs read.

describe("system pages", () => {
  it("an unknown URL says so and leads back to the overview", () => {
    render(<NotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "Page not found" })).toBeInTheDocument();
    expect(screen.getByText("404")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Go to the overview" })).toHaveAttribute("href", "/");
  });

  it("a missing item inside the dashboard keeps its way back to campaigns", () => {
    render(<DashboardNotFound />);
    expect(screen.getByRole("heading", { level: 1, name: "Not found" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Back to campaigns" })).toHaveAttribute(
      "href",
      "/campaigns",
    );
  });

  it("the error boundary shows only the contract text and retries on request", () => {
    const retry = vi.fn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<DashboardError error={new Error("raw server text")} retry={retry} />);
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Something went wrong");
    expect(alert).not.toHaveTextContent("raw server text");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("the organization page is titled even without Clerk (dev token builds)", () => {
    expect(metadata.title).toBe("Organization");
    // Inside the dashboard (OrgGate): the Reporting card reads the organization (C1).
    renderWithOrg(<OrganizationPage />);
    expect(screen.getByRole("heading", { level: 1, name: "Organization" })).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Reporting" })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Organization settings" }),
    ).toBeInTheDocument();
  });
});
