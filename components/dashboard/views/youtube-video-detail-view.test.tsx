import { fireEvent, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiError } from "@/convex/lib/errors";
import {
  lastArgs,
  notFoundMock,
  queryResults,
  renderWithOrg,
  resetHarness,
  setUrl,
} from "@/tests/unit/dashboard-harness";
import {
  CHANNEL_ID,
  videoStatistics,
  videoWindow,
  youtubeVideoDetail,
} from "@/tests/unit/youtube-fixtures";

vi.mock("convex/react", async () => (await import("@/tests/unit/dashboard-harness")).convexReact);
vi.mock("next/navigation", async () => (await import("@/tests/unit/dashboard-harness")).navigation);

import { YouTubeVideoDetailView } from "./youtube-video-detail-view";

// The YouTube video page (ADR 0016 Checkpoint 8): YouTube Analytics' last 28 days and lifetime
// side by side, each value as reported (or why there is none, never 0), the public counts and
// their captures (lifetime counts, never differenced), and the way back to the same list.

const LIST_QUERY = `preset=last_7_days&account=${CHANNEL_ID}&pdir=asc&vwin=lifetime`;

describe("YouTubeVideoDetailView", () => {
  beforeEach(() => {
    resetHarness();
    setUrl("/social/youtube/videos/post_yt_1", LIST_QUERY);
    queryResults.set("v1/youtubeAnalytics:video", youtubeVideoDetail());
  });

  it("shows the video, both periods side by side and the links out and back", () => {
    renderWithOrg(<YouTubeVideoDetailView videoId="post_yt_1" />);
    expect(lastArgs("v1/youtubeAnalytics:video")).toEqual({ videoId: "post_yt_1" });
    expect(screen.getByRole("heading", { level: 1, name: "Launch video" })).toBeInTheDocument();
    expect(screen.getByText(/^Published Oct 19, 2026/)).toBeInTheDocument();
    // Back to the YouTube list it was opened from (filters, channel, order and period).
    expect(screen.getByRole("link", { name: "YouTube" })).toHaveAttribute(
      "href",
      `/social?preset=last_7_days&platform=youtube&account=${CHANNEL_ID}&pdir=asc&vwin=lifetime`,
    );
    const watch = screen.getByRole("link", { name: /Watch on YouTube/ });
    expect(watch).toHaveAttribute("href", "https://www.youtube.com/watch?v=vid00000000");
    expect(watch).toHaveAttribute("rel", "noopener noreferrer");

    const windows = screen.getByTestId("youtube-video-windows");
    const last28 = within(windows).getByRole("region", { name: "Last 28 days" });
    expect(last28).toHaveTextContent("Sep 20, 2026 – Oct 17, 2026 (Pacific Time)");
    const value = (region: HTMLElement, metric: string) =>
      region.querySelector(`[data-metric="${metric}"]`)!;
    expect(
      [...last28.querySelectorAll("[data-metric] h4")].map((heading) => heading.textContent),
    ).toEqual([
      "Views",
      "Watch time (hours)",
      "Avg. view duration",
      "Avg. % viewed",
      "Likes",
      "Comments",
      "Shares",
      "Subscribers gained",
      "Subscribers lost",
    ]);
    expect(value(last28, "views")).toHaveTextContent("4,321");
    expect(value(last28, "estimatedMinutesWatched")).toHaveTextContent("164.6");
    expect(value(last28, "averageViewDuration")).toHaveTextContent("2:17");
    expect(value(last28, "averageViewPercentage")).toHaveTextContent("45.3%");
    expect(value(last28, "comments")).toHaveTextContent(/^Comments0$/);
    expect(value(last28, "subscribersLost")).toHaveTextContent("2");
    const lifetime = within(windows).getByRole("region", { name: "Lifetime" });
    expect(lifetime).toHaveTextContent("Mar 12, 2024 – Oct 17, 2026 (Pacific Time)");
    expect(value(lifetime, "views")).toHaveTextContent("48,210");
  });

  it("says when a period is outside YouTube's top 200 or not synced, never 0", () => {
    queryResults.set(
      "v1/youtubeAnalytics:video",
      youtubeVideoDetail({
        analytics: { last28: videoWindow({ status: "not_in_top", metrics: {} }) },
      }),
    );
    renderWithOrg(<YouTubeVideoDetailView videoId="post_yt_1" />);
    const windows = screen.getByTestId("youtube-video-windows");
    const last28 = within(windows).getByRole("region", { name: "Last 28 days" });
    expect(last28).toHaveAttribute("data-window-state", "not_in_top");
    expect(last28).toHaveTextContent("Not in YouTube's top 200");
    expect(last28).toHaveTextContent("Its values are unknown, not zero.");
    expect(last28.querySelector("[data-metric]")).toBeNull();
    const lifetime = within(windows).getByRole("region", { name: "Lifetime" });
    expect(lifetime).toHaveAttribute("data-window-state", "not_synced");
    expect(lifetime).toHaveTextContent("Not synced yet");
    expect(lifetime).toHaveTextContent("Pacific Time days");
    expect(lifetime.textContent).not.toMatch(/\d/);
  });

  it("shows the public counts as of the latest capture and charts each capture", () => {
    renderWithOrg(<YouTubeVideoDetailView videoId="post_yt_1" />);
    expect(
      screen.getByRole("heading", { name: "Public counts as of 2026-10-20 (UTC capture day)" }),
    ).toBeInTheDocument();
    const counts = [...document.querySelectorAll("[data-public-count]")];
    expect(counts.map((cell) => cell.textContent)).toEqual([
      "Views9,876",
      "Likes321",
      "Comments12",
    ]);
    const captures = screen.getByTestId("youtube-captures");
    expect(within(captures).getByText(/not daily performance/)).toBeInTheDocument();
    fireEvent.click(within(captures).getByRole("button", { name: "View as table" }));
    const rows = within(captures).getAllByRole("row").slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      "2026-10-199,500Reported",
      "2026-10-209,876Reported",
    ]);
  });

  it("a hidden count is explained, and a never-captured video has no counts or chart", () => {
    queryResults.set(
      "v1/youtubeAnalytics:video",
      youtubeVideoDetail({
        dataState: "partial",
        latest: videoStatistics({
          dataState: "partial",
          metrics: { views: 50, comments: 0 },
          unavailableMetrics: [{ metric: "likes", reason: "not_reported" }],
        }),
      }),
    );
    const { unmount } = renderWithOrg(<YouTubeVideoDetailView videoId="post_yt_1" />);
    expect(document.querySelector('[data-public-count="likes"]')).toHaveTextContent(
      "Not available: Not reported by YouTube (hidden or disabled by the channel owner)",
    );
    unmount();

    queryResults.set(
      "v1/youtubeAnalytics:video",
      youtubeVideoDetail({
        dataState: "unknown",
        latest: undefined,
        captures: [],
        title: undefined,
        removedAt: "2026-10-20T00:00:00.000Z",
      }),
    );
    renderWithOrg(<YouTubeVideoDetailView videoId="post_yt_1" />);
    expect(screen.getByRole("heading", { level: 1, name: "Untitled video" })).toBeInTheDocument();
    expect(screen.getByText("Removed from YouTube")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Not captured yet" })).toBeInTheDocument();
    expect(screen.queryByTestId("youtube-captures")).toBeNull();
  });

  it("an unknown or foreign video renders the not-found page", () => {
    queryResults.set("v1/youtubeAnalytics:video", () => {
      throw apiError("NOT_FOUND", "No socialPosts record with this id.", { table: "socialPosts" });
    });
    expect(() => renderWithOrg(<YouTubeVideoDetailView videoId="nope" />)).toThrow(
      /NEXT_NOT_FOUND/,
    );
    expect(notFoundMock).toHaveBeenCalled();
  });
});
