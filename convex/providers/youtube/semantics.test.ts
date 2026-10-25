import { describe, expect, it } from "vitest";
import { YOUTUBE_CAPABILITIES } from "./capabilities";
import {
  CHANNEL_PARTS,
  isAllowedRequest,
  MAX_RESULTS,
  PLAYLIST_ITEM_PARTS,
  VIDEO_PARTS,
} from "./client";
import { isAllowedYouTubePermalink, LISTING_PAGE_SIZE, youtubePermalink } from "./semantics";

// ADR 0016: the semantics table, the capabilities and the client allowlist agree.

describe("YouTube semantics", () => {
  it("lists in pages the Data API and the allowlist accept", () => {
    expect(LISTING_PAGE_SIZE).toBeLessThanOrEqual(MAX_RESULTS);
    expect(YOUTUBE_CAPABILITIES.maxPageSize).toBe(LISTING_PAGE_SIZE);
    expect(
      isAllowedRequest(
        "GET",
        `https://www.googleapis.com/youtube/v3/playlistItems?part=${PLAYLIST_ITEM_PARTS}&playlistId=UU1&maxResults=${LISTING_PAGE_SIZE}`,
      ),
    ).toBe(true);
  });

  it("reads metadata parts only: no statistics, no content owner data", () => {
    for (const parts of [CHANNEL_PARTS, PLAYLIST_ITEM_PARTS, VIDEO_PARTS]) {
      expect(parts.split(",")).not.toContain("contentOwnerDetails");
      expect(parts.split(",")).not.toContain("brandingSettings");
    }
    expect(VIDEO_PARTS.split(",")).not.toContain("statistics");
    // Checkpoint 1 declares no metric; Checkpoint 3 adds them with their requests.
    expect(YOUTUBE_CAPABILITIES.postMetrics).toEqual([]);
    expect(YOUTUBE_CAPABILITIES.accountMetrics).toEqual([]);
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
