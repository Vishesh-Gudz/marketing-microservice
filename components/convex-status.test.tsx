import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useQueryMock = vi.fn();
vi.mock("convex/react", () => ({
  useQuery: (...args: unknown[]) => useQueryMock(...args),
}));

import { ConvexStatus } from "./convex-status";

describe("ConvexStatus", () => {
  beforeEach(() => {
    useQueryMock.mockReset();
  });

  it("shows a loading state while the query is pending", () => {
    useQueryMock.mockReturnValue(undefined);
    render(<ConvexStatus />);
    expect(screen.getByText(/connecting to convex/i)).toBeInTheDocument();
  });

  it("shows the service name once connected", () => {
    useQueryMock.mockReturnValue({ ok: true, service: "marketing-microservice" });
    render(<ConvexStatus />);
    expect(screen.getByText("Convex: marketing-microservice")).toBeInTheDocument();
  });

  // Regression: the variant swap must be instant. A color transition made accessibility scans
  // sample an intermediate (failing) text color while the badge changed state.
  it.each([
    ["connecting", undefined],
    ["connected", { ok: true, service: "marketing-microservice" }],
    ["unhealthy", { ok: false, service: "marketing-microservice" }],
  ])("never animates its colors (%s)", (_label, health) => {
    useQueryMock.mockReturnValue(health);
    const { container } = render(<ConvexStatus />);
    const badge = container.querySelector('[data-slot="badge"]')!;
    expect(badge.className).toContain("transition-none");
    expect(badge.className).not.toMatch(/transition-\[color/);
  });
});
