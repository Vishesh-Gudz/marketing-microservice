import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import { lastReplacedQuery, resetHarness, setUrl } from "@/tests/unit/dashboard-harness";

vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { QueryBoundary } from "./query-boundary";

let failure: Error | undefined;
function Region() {
  if (failure) throw failure;
  return <p>region content</p>;
}

describe("QueryBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    failure = undefined;
    resetHarness();
  });

  it("shows the mapped contract error and clears it when the arguments change", () => {
    failure = apiError("INVALID_ARGUMENT", "Too many rows.", {
      reason: "too_many_rows",
      maxRows: 8000,
      budget: "metrics",
    });
    const { rerender } = render(
      <QueryBoundary resetKey="a" title="Chart">
        <Region />
      </QueryBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Chart: Too much data for one view");
    expect(screen.queryByRole("button", { name: "Try again" })).not.toBeInTheDocument();

    failure = undefined;
    rerender(
      <QueryBoundary resetKey="b" title="Chart">
        <Region />
      </QueryBoundary>,
    );
    expect(screen.getByText("region content")).toBeInTheDocument();
  });

  it("offers to narrow the range after too_many_rows (D15)", () => {
    setUrl("/campaigns", "preset=custom&from=2025-09-01&to=2026-09-01&sort=name");
    failure = apiError("INVALID_ARGUMENT", "Too many rows.", {
      reason: "too_many_rows",
      maxRows: 8000,
      budget: "metrics",
    });
    render(
      <QueryBoundary resetKey="a">
        <Region />
      </QueryBoundary>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Show last 7 days" }));
    expect(lastReplacedQuery().toString()).toBe("sort=name&preset=last_7_days");
  });

  it("names the invalid field for other INVALID_ARGUMENT errors", () => {
    failure = apiError("INVALID_ARGUMENT", "bad", { field: "filters.accountIds" });
    render(
      <QueryBoundary resetKey="a">
        <Region />
      </QueryBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Check the account filters");
  });

  it("offers a retry for unexpected errors without showing their message", () => {
    failure = new Error("internal stack detail");
    render(
      <QueryBoundary resetKey="a">
        <Region />
      </QueryBoundary>,
    );
    expect(screen.getByRole("alert")).not.toHaveTextContent("internal stack detail");
    failure = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(screen.getByText("region content")).toBeInTheDocument();
  });
});
