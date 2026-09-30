import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  lastArgs,
  queryResults,
  renderWithOrg,
  resetHarness,
  routerReplace,
  setUrl,
} from "@/tests/unit/dashboard-harness";
import { postSnapshot, SOCIAL_ACCOUNT_ID, socialPost } from "@/tests/unit/organic-fixtures";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { SocialPostsTable } from "./social-posts-table";

// Posts show LIFETIME totals of the latest capture (never daily values or deltas), the
// validated permalink as a safe external link, and never any media URL.

const RANGE = { from: "2026-09-01", to: "2026-09-30" };
const page = (posts: ReturnType<typeof socialPost>[], isDone = true) => ({
  page: posts,
  isDone,
  continueCursor: "next-cursor",
});

function renderTable(postOrder: "desc" | "asc" = "desc") {
  return renderWithOrg(
    <SocialPostsTable socialAccountId={SOCIAL_ACCOUNT_ID} range={RANGE} postOrder={postOrder} />,
  );
}

describe("SocialPostsTable", () => {
  beforeEach(() => {
    resetHarness();
    setUrl("/social", "preset=last_7_days");
  });

  it("lists posts with caption, type, latest lifetime metrics, state and the Instagram link", () => {
    queryResults.set("v1/socialPosts:list", page([socialPost()]));
    renderTable();
    expect(screen.getByRole("heading", { name: "Posts — lifetime totals" })).toBeInTheDocument();
    expect(screen.getByText(/not daily performance/)).toBeInTheDocument();
    const row = screen.getByText("Hello from the mock account").closest("tr")!;
    expect(within(row).getByText("Image")).toBeInTheDocument();
    expect(within(row).getByText("900")).toBeInTheDocument(); // views
    expect(within(row).getByText("15.50%")).toBeInTheDocument(); // API engagement rate
    expect(within(row).getByText("2026-09-28")).toBeInTheDocument(); // capture day
    const link = within(row).getByRole("link", { name: /View on Instagram/ });
    expect(link).toHaveAttribute("href", "https://www.instagram.com/p/mock17900000000000001/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(row).getByRole("link", { name: "Hello from the mock account" })).toHaveAttribute(
      "href",
      `/social/posts/post_1?preset=last_7_days&account=${SOCIAL_ACCOUNT_ID}`,
    );
    // No media, thumbnail or other URLs, no images.
    expect(row.querySelector("img")).toBeNull();
    expect(row.innerHTML).not.toMatch(/scontent|cdninstagram|thumbnail/);
    expect(screen.queryByText(/delta/i)).toBeNull();
  });

  it("unavailable metrics show — with their reason; uncaptured posts are unknown", () => {
    queryResults.set(
      "v1/socialPosts:list",
      page([
        socialPost({
          id: "p2",
          caption: "Partial one",
          dataState: "partial",
          latest: postSnapshot({
            dataState: "partial",
            metrics: {
              likes: 3,
              unavailableMetrics: [{ metric: "views", reason: "not_reported" }],
            },
            kpis: {
              unavailableKpis: [{ kpi: "engagementRate", reason: "denominator_unavailable" }],
            },
          }),
        }),
        socialPost({ id: "p3", caption: "Old one", dataState: "unknown", latest: undefined }),
      ]),
    );
    renderTable();
    const partial = screen.getByText("Partial one").closest("tr")!;
    expect(
      within(partial).getByText(/Not available: Not reported by Instagram/),
    ).toBeInTheDocument();
    expect(within(partial).getByText("Partial data")).toBeInTheDocument();
    const old = screen.getByText("Old one").closest("tr")!;
    expect(within(old).getByText("Not synced")).toBeInTheDocument();
    expect(within(old).getAllByText("—").length).toBeGreaterThan(0);
    expect(old).not.toHaveTextContent(/\b0\b/);
  });

  it("no link without a valid permalink; removed posts are marked", () => {
    queryResults.set(
      "v1/socialPosts:list",
      page([
        socialPost({ id: "p4", caption: "No link", permalink: undefined }),
        socialPost({
          id: "p5",
          caption: "Bad link",
          permalink: "javascript:alert(1)",
          removedAt: "2026-09-20T00:00:00.000Z",
        }),
      ]),
    );
    renderTable();
    expect(screen.queryByRole("link", { name: /View on Instagram/ })).toBeNull();
    expect(
      within(screen.getByText("Bad link").closest("tr")!).getByText("Removed"),
    ).toBeInTheDocument();
  });

  it("empty state; server-side order toggle; cursor pagination", () => {
    queryResults.set("v1/socialPosts:list", page([]));
    const { unmount } = renderTable();
    expect(screen.getByText("No posts published in this range")).toBeInTheDocument();
    unmount();

    queryResults.set("v1/socialPosts:list", (args: Record<string, unknown>) =>
      page(
        [
          socialPost({
            id: `p-${String((args.paginationOpts as { cursor: string | null }).cursor)}`,
          }),
        ],
        false,
      ),
    );
    renderTable();
    fireEvent.click(screen.getByRole("button", { name: /Post \(published\)/ }));
    expect(routerReplace).toHaveBeenCalledWith("/social?preset=last_7_days&pdir=asc", {
      scroll: false,
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(lastArgs("v1/socialPosts:list")).toMatchObject({
      paginationOpts: { numItems: 25, cursor: "next-cursor" },
    });
    expect(screen.getByText("Page 2")).toBeInTheDocument();
  });
});
