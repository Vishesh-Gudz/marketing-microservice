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
});
