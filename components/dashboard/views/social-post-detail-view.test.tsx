import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import {
  notFoundMock,
  queryResults,
  renderWithOrg,
  resetHarness,
  setUrl,
} from "@/tests/unit/dashboard-harness";
import { SOCIAL_ACCOUNT_ID, socialPostDetail } from "@/tests/unit/organic-fixtures";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { SocialPostDetailView } from "./social-post-detail-view";

// Post page: caption as text, lifetime totals of the latest capture, and the lifetime totals
// at each capture (never differenced into daily values).

describe("SocialPostDetailView", () => {
  beforeEach(() => {
    resetHarness();
    setUrl("/social/posts/post_1", `preset=last_7_days&account=${SOCIAL_ACCOUNT_ID}`);
    queryResults.set("v1/socialPosts:get", socialPostDetail());
  });

  it("shows the post, its latest lifetime totals and the link back to /social", () => {
    renderWithOrg(<SocialPostDetailView postId="post_1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Image post" })).toBeInTheDocument();
    expect(screen.getByText("Hello from the mock account")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Lifetime totals as of 2026-09-28 (UTC capture day)" }),
    ).toBeInTheDocument();
    const views = screen.getByRole("heading", { name: "Views" }).closest("[data-kpi]")!;
    expect(views).toHaveTextContent("900");
    expect(screen.getByRole("link", { name: "Organic" })).toHaveAttribute(
      "href",
      `/social?preset=last_7_days&account=${SOCIAL_ACCOUNT_ID}`,
    );
    expect(screen.getByRole("link", { name: /View on Instagram/ })).toHaveAttribute(
      "rel",
      "noopener noreferrer",
    );
  });

  it("charts lifetime totals per capture, labelled as not daily performance", () => {
    renderWithOrg(<SocialPostDetailView postId="post_1" />);
    const section = screen.getByTestId("post-snapshots");
    expect(within(section).getByText(/not daily performance/)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole("button", { name: "View as table" }));
    const rows = within(section).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "2026-09-27500Partial data",
      "2026-09-28900Reported",
    ]);
    expect(section.textContent).not.toMatch(/delta|change/i);
  });

  it("an unknown or foreign post renders the not-found page", () => {
    queryResults.set("v1/socialPosts:get", () => {
      throw apiError("NOT_FOUND", "No socialPosts record with this id.", { table: "socialPosts" });
    });
    expect(() => renderWithOrg(<SocialPostDetailView postId="nope" />)).toThrow(/NEXT_NOT_FOUND/);
    expect(notFoundMock).toHaveBeenCalled();
  });
});
