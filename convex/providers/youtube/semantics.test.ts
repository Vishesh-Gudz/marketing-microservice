import { describe, expect, it } from "vitest";
import { YOUTUBE_CAPABILITIES } from "./capabilities";
import {
  CHANNEL_PARTS,
  isAllowedRequest,
  MAX_RESULTS,
  PLAYLIST_ITEM_PARTS,
  VIDEO_PARTS,
  VIDEO_STATISTICS_PARTS,
} from "./client";
import {
  ACCOUNT_METRICS_DELAY_DAYS,
  ACCOUNT_REPORT_METRICS,
  ACCOUNT_REPORT_TARGETS,
  isAllowedYouTubePermalink,
  LISTING_PAGE_SIZE,
  POST_SNAPSHOT_WINDOW_DAYS,
  REPORT_DIMENSION,
  REPORT_IDS,
  YOUTUBE_ACCOUNT_METRICS,
  YOUTUBE_POST_METRICS,
  youtubePermalink,
} from "./semantics";

// ADR 0016: the semantics table, the capabilities and the client allowlist agree, and only
// values YouTube reports are read (Developer Policies III.E.4.h, Checkpoint 3 review).

describe("YouTube semantics", () => {
  it("lists in pages the Data API and the allowlist accept", () => {
    expect(LISTING_PAGE_SIZE).toBeLessThanOrEqual(MAX_RESULTS);
    expect(YOUTUBE_CAPABILITIES.maxPageSize).toBe(LISTING_PAGE_SIZE);
    expect(YOUTUBE_CAPABILITIES.postMetricsPageSize).toBe(LISTING_PAGE_SIZE);
    expect(
      isAllowedRequest(
        "GET",
        `https://www.googleapis.com/youtube/v3/playlistItems?part=${PLAYLIST_ITEM_PARTS}&playlistId=UU1&maxResults=${LISTING_PAGE_SIZE}`,
      ),
    ).toBe(true);
  });

  it("reads statistics only for snapshots and no content owner or branding data", () => {
    for (const parts of [CHANNEL_PARTS, PLAYLIST_ITEM_PARTS, VIDEO_PARTS, VIDEO_STATISTICS_PARTS]) {
      expect(parts.split(",")).not.toContain("contentOwnerDetails");
      expect(parts.split(",")).not.toContain("brandingSettings");
    }
    expect(VIDEO_PARTS.split(",")).not.toContain("statistics");
    expect(VIDEO_STATISTICS_PARTS.split(",")).toEqual(["snippet", "statistics"]);
  });

  it("declares exactly the metric columns the mapping fills", () => {
    expect([...YOUTUBE_CAPABILITIES.postMetrics]).toEqual([...YOUTUBE_POST_METRICS]);
    expect([...YOUTUBE_POST_METRICS]).toEqual(["views", "likes", "comments"]);
    expect([...YOUTUBE_CAPABILITIES.accountMetrics]).toEqual([...YOUTUBE_ACCOUNT_METRICS]);
    expect(YOUTUBE_CAPABILITIES.accountMetricsDelayDays).toBe(ACCOUNT_METRICS_DELAY_DAYS);
    expect(YOUTUBE_CAPABILITIES.postSnapshotWindowDays).toBe(POST_SNAPSHOT_WINDOW_DAYS);
    // The only canonical account column: no follower change (that would be our calculation).
    expect(YOUTUBE_ACCOUNT_METRICS).toEqual(["views"]);
    expect(YOUTUBE_ACCOUNT_METRICS).not.toContain("followerDelta");
  });

  it("requests one day report with the exact, reported-only metric list", () => {
    expect(
      isAllowedRequest(
        "GET",
        `https://youtubeanalytics.googleapis.com/v2/reports?ids=${REPORT_IDS}&startDate=2026-10-01&endDate=2026-10-17&metrics=${ACCOUNT_REPORT_METRICS}&dimensions=${REPORT_DIMENSION}`,
      ),
    ).toBe(true);
    const metrics = ACCOUNT_REPORT_METRICS.split(",");
    expect(metrics).toEqual(Object.keys(ACCOUNT_REPORT_TARGETS));
    for (const never of [
      "dislikes",
      "engagedViews",
      "averageViewPercentage",
      "videosAddedToPlaylists",
      "estimatedRevenue",
      "cardClickRate",
    ]) {
      expect(metrics).not.toContain(never);
    }
    // Every value lands under its own YouTube name (no renaming into a derived meaning).
    for (const [name, target] of Object.entries(ACCOUNT_REPORT_TARGETS)) {
      expect("column" in target ? target.column : target.extra).toBe(name);
    }
  });

  it("builds exactly the one permalink form that may be stored", () => {
    expect(youtubePermalink("vid00000000")).toBe("https://www.youtube.com/watch?v=vid00000000");
    expect(isAllowedYouTubePermalink(youtubePermalink("vid00000000"))).toBe(true);
    for (const other of [
      "http://www.youtube.com/watch?v=vid00000000",
      "https://youtube.com/watch?v=vid00000000",
      "https://www.youtube.com/watch?v=vid00000000&t=1",
      "https://www.youtube.com/shorts/vid00000000",
      "https://youtu.be/vid00000000",
    ]) {
      expect(isAllowedYouTubePermalink(other)).toBe(false);
    }
  });
});
