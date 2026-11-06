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
      <AuthPageShell>
        <p>form</p>
      </AuthPageShell>,
    );
    const main = screen.getByRole("main");
    expect(main).toHaveAttribute("id", "main-content");
    expect(within(main).getByText("form")).toBeInTheDocument();
    const panel = screen.getByRole("complementary");
    expect(panel).toHaveTextContent("Ads, organic and messaging, in one place.");
    expect(within(panel).getAllByRole("listitem")).toHaveLength(3);
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
