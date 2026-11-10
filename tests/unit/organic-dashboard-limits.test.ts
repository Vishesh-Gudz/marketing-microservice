import { describe, expect, it } from "vitest";
import { PERIOD_PRESETS } from "@/convex/analytics/periods";
import { ORGANIC_LIMITS } from "@/convex/analytics/organic/config";
import { resolveOrganicPreset } from "@/convex/analytics/organic/dates";
import { todayIn } from "@/convex/lib/dates";
import { DEFAULT_FILTERS, resolveRange } from "@/lib/analytics/filters";
import { ORGANIC_MAX_PAGE_SIZE, ORGANIC_MAX_RANGE_DAYS } from "@/lib/analytics/organic-filters";
import {
  YOUTUBE_DAY_METRICS,
  YOUTUBE_DAY_TIMEZONE,
  YOUTUBE_TOTAL_METRICS,
  YOUTUBE_TOTAL_REASONS,
  YOUTUBE_VIDEO_ANALYTICS_METRICS,
  YOUTUBE_VIDEO_METRICS,
} from "@/convex/analytics/organic/metrics";
import {
  YOUTUBE_DAY_COLUMNS,
  YOUTUBE_DAY_TIMEZONE as DASHBOARD_YOUTUBE_TIMEZONE,
  YOUTUBE_KPIS,
  YOUTUBE_TOTAL_REASON_TEXT,
  YOUTUBE_VIDEO_COLUMNS,
  YOUTUBE_WINDOW_METRICS,
} from "@/lib/analytics/youtube-values";

// The organic dashboard may not import convex/analytics/organic/* (D23), so this test (outside
// the guarded frontend directories) keeps its copies of the organic limits in sync with the
// API and proves its UTC preset resolution equals the API's (R12).
describe("organic dashboard limits and presets", () => {
  it("mirror the organic API limits", () => {
    expect(ORGANIC_MAX_RANGE_DAYS).toBe(ORGANIC_LIMITS.maxRangeDays);
    expect(ORGANIC_MAX_PAGE_SIZE).toBe(ORGANIC_LIMITS.maxPageSize);
  });

  it("resolve every preset against today in UTC exactly like resolveOrganicPreset", () => {
    const instants = [
      "2026-09-25T00:00:00.000Z",
      "2026-09-25T23:59:59.999Z",
      "2026-03-01T00:30:00.000Z",
      "2026-01-01T00:00:00.000Z",
      "2024-02-29T12:00:00.000Z",
    ].map((iso) => Date.parse(iso));
    for (const nowMs of instants) {
      for (const preset of PERIOD_PRESETS) {
        expect(
          resolveRange({ ...DEFAULT_FILTERS, preset }, todayIn("UTC", nowMs)),
          `${preset} @ ${new Date(nowMs).toISOString()}`,
        ).toEqual(resolveOrganicPreset(preset, nowMs));
      }
    }
  });
});

// ADR 0016 (Checkpoint 5): the YouTube dashboard's copies of the API's vocabulary.
describe("YouTube dashboard vocabulary", () => {
  it("mirrors the API's day metrics, video metrics and Pacific Time days", () => {
    expect([...YOUTUBE_DAY_COLUMNS]).toEqual([...YOUTUBE_DAY_METRICS]);
    expect([...YOUTUBE_VIDEO_COLUMNS]).toEqual([...YOUTUBE_VIDEO_METRICS]);
    expect(DASHBOARD_YOUTUBE_TIMEZONE).toBe(YOUTUBE_DAY_TIMEZONE);
  });

  it("mirrors the Checkpoint 8 per-video values, totals and their reasons", () => {
    expect([...YOUTUBE_WINDOW_METRICS]).toEqual([...YOUTUBE_VIDEO_ANALYTICS_METRICS]);
    // Every key metric but the subscriber count is one of the server's totals.
    for (const key of YOUTUBE_KPIS.filter((k) => k !== "subscribers")) {
      expect(YOUTUBE_TOTAL_METRICS).toContain(key);
    }
    expect(Object.keys(YOUTUBE_TOTAL_REASON_TEXT).sort()).toEqual(
      [...YOUTUBE_TOTAL_REASONS].sort(),
    );
  });
});
