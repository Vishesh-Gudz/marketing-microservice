import { render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

// Clerk is not mounted in unit tests: ClerkLoading behaves as "still loading".
vi.mock("@clerk/nextjs", () => ({
  ClerkLoading: ({ children }: { children: ReactNode }) => children,
}));

import { AuthPageShell, ClerkCardPlaceholder } from "./auth-page";

describe("AuthPageShell", () => {
  it("frames the form with the brand, what the product covers and the legal links", () => {
    render(
      <AuthPageShell title="Sign in to Gudz Marketing" description="Welcome back.">
        <p>form</p>
      </AuthPageShell>,
    );
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    // The form's own heading is the page's one h1 (the brand panel is hidden on phones).
    expect(
      within(main).getByRole("heading", { level: 1, name: "Sign in to Gudz Marketing" }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(within(main).getByText("Welcome back.")).toBeInTheDocument();
    expect(within(main).getByText("form")).toBeInTheDocument();
    const panel = screen.getByRole("complementary", { name: "Gudz Marketing" });
    expect(panel).toHaveTextContent("All your channels,in one place.");
    expect(
      within(panel)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual([
      "Paid results in one currencyGoogle Ads and Meta Ads campaigns, converted to your reporting currency.",
      "Organic performanceInstagram posts and YouTube videos with their metrics, day by day.",
      "One inboxWhatsApp and Instagram conversations, with saved replies and templates.",
    ]);
    for (const legal of screen.getAllByRole("navigation", { name: "Legal" })) {
      expect(within(legal).getByRole("link", { name: "Privacy policy" })).toHaveAttribute(
        "href",
        "/privacy",
      );
      expect(within(legal).getByRole("link", { name: "Data deletion" })).toHaveAttribute(
        "href",
        "/data-deletion",
      );
    }
  });

  it("holds the Clerk card's place while Clerk loads", () => {
    render(<ClerkCardPlaceholder />);
    expect(screen.getByRole("status", { name: "Loading sign-in" })).toBeInTheDocument();
  });
});
