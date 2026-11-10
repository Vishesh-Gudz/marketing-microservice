import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { INSTAGRAM_CAPABILITIES } from "../providers/instagram/capabilities";
import { YOUTUBE_CAPABILITIES } from "../providers/youtube/capabilities";
import type { SocialProviderCapabilities } from "../providers/social/capabilities";
import type { PlanState } from "./plan";
import {
  buildSocialRunPlan,
  resolveVideoWindow,
  socialMetricWindow,
  videoAnalyticsLatestDay,
} from "./socialPlan";
import {
  isAdOperation,
  isPreflightOperation,
  isSocialOperation,
  operationMatchesSubject,
  sameSubject,
  subjectOf,
  SyncSubjectInvariantError,
} from "./subject";

// Phase 10: the sync subject invariant and the (pure, capability-driven) social plan.

const ad = "ad1" as Id<"adAccounts">;
const social = "so1" as Id<"socialAccounts">;

describe("sync subject", () => {
  it("names exactly one subject", () => {
    expect(subjectOf({ adAccountId: ad })).toEqual({ kind: "ad", adAccountId: ad });
    expect(subjectOf({ socialAccountId: social })).toEqual({
      kind: "social",
      socialAccountId: social,
    });
    expect(() => subjectOf({})).toThrow(SyncSubjectInvariantError);
    expect(() => subjectOf({ adAccountId: ad, socialAccountId: social })).toThrow(
      SyncSubjectInvariantError,
    );
  });

  it("never confuses an ad account with a social account", () => {
    const sameId = "x1";
    expect(
      sameSubject(
        subjectOf({ adAccountId: sameId as Id<"adAccounts"> }),
        subjectOf({ socialAccountId: sameId as Id<"socialAccounts"> }),
      ),
    ).toBe(false);
  });

  it("ad and social operations are disjoint and bound to their subject kind", () => {
    for (const op of [
      "getAccount",
      "listCampaigns",
      "fetchDailyMetrics",
      "fetchActionMetrics",
    ] as const) {
      expect(isAdOperation(op) && !isSocialOperation(op)).toBe(true);
      expect(operationMatchesSubject("ad", op)).toBe(true);
      expect(operationMatchesSubject("social", op)).toBe(false);
    }
    for (const op of [
      "getSocialAccount",
      "listSocialPosts",
      "fetchPostMetrics",
      "fetchAccountMetrics",
    ] as const) {
      expect(isSocialOperation(op) && !isAdOperation(op)).toBe(true);
      expect(operationMatchesSubject("social", op)).toBe(true);
      expect(operationMatchesSubject("ad", op)).toBe(false);
    }
    expect(isPreflightOperation("getAccount")).toBe(true);
    expect(isPreflightOperation("getSocialAccount")).toBe(true);
    expect(isPreflightOperation("listSocialPosts")).toBe(false);
  });
});

const NOW = Date.UTC(2026, 8, 28, 23, 30); // late evening UTC: "today" is 2026-09-28 in UTC
const state: PlanState = { structureStale: false, backfillHorizon: "2026-07-01" };

/** Synthetic Stage-B-like capabilities: exercises the plan machinery only. */
const FULL: SocialProviderCapabilities = {
  ...INSTAGRAM_CAPABILITIES,
  posts: true,
  postMetrics: ["likes", "reach"],
  accountMetrics: ["reach", "views"],
};

describe("buildSocialRunPlan", () => {
  it("Stage B Instagram capabilities plan every operation, preflight first, listing before snapshots", () => {
    const operations = (kind: "initial" | "incremental" | "lookback" | "backfill" | "manual") =>
      buildSocialRunPlan({ kind, state, capabilities: INSTAGRAM_CAPABILITIES, now: NOW }).tasks.map(
        (t) => t.operation,
      );
    expect(operations("initial")).toEqual([
      "getSocialAccount",
      "listSocialPosts",
      "fetchPostMetrics",
      "fetchAccountMetrics",
      "fetchAccountMetrics",
    ]);
    expect(operations("incremental")).toEqual([
      "getSocialAccount",
      "listSocialPosts",
      "fetchAccountMetrics",
    ]);
    expect(operations("manual")).toEqual(operations("incremental"));
    expect(operations("lookback")).toEqual([
      "getSocialAccount",
      "listSocialPosts",
      "fetchPostMetrics",
      "fetchAccountMetrics",
    ]);
    // No coverage yet: nothing to backfill beyond the preflight.
    expect(operations("backfill")).toEqual(["getSocialAccount"]);
    const initial = buildSocialRunPlan({
      kind: "initial",
      state,
      capabilities: INSTAGRAM_CAPABILITIES,
      now: NOW,
    });
    expect(initial.structureMode).toBe("none");
    expect(initial.tasks[1]).toMatchObject({ fullListing: true });
    expect(initial.tasks[2]).toMatchObject({ from: "2026-07-01", to: "2026-09-28" });
  });

  it("plans only declared operations, in order, on UTC days", () => {
    const initial = buildSocialRunPlan({ kind: "initial", state, capabilities: FULL, now: NOW });
    expect(initial.tasks.map((t) => t.operation)).toEqual([
      "getSocialAccount",
      "listSocialPosts",
      "fetchPostMetrics",
      "fetchAccountMetrics",
      "fetchAccountMetrics",
    ]);
    expect(initial.tasks[1]).toMatchObject({ fullListing: true });
    expect(initial.tasks[2]).toMatchObject({ from: "2026-07-01", to: "2026-09-28" }); // 90-day window
    expect(initial.window).toEqual({ from: "2026-08-30", to: "2026-09-28" });
    // Chunks never cross a month and are newest first.
    expect(initial.tasks.slice(3).map((t) => [t.from, t.to])).toEqual([
      ["2026-09-01", "2026-09-28"],
      ["2026-08-30", "2026-08-31"],
    ]);

    const incremental = buildSocialRunPlan({
      kind: "incremental",
      state,
      capabilities: FULL,
      now: NOW,
    });
    expect(incremental.tasks.map((t) => t.operation)).toEqual([
      "getSocialAccount",
      "listSocialPosts",
      "fetchAccountMetrics",
    ]);
    expect(incremental.tasks[1]).toMatchObject({ fullListing: false });
    expect(incremental.window).toEqual({ from: "2026-09-27", to: "2026-09-28" });

    const lookback = buildSocialRunPlan({ kind: "lookback", state, capabilities: FULL, now: NOW });
    expect(lookback.window).toEqual({ from: "2026-09-26", to: "2026-09-28" }); // 3-day buffer
    expect(lookback.tasks.map((t) => t.operation)).toContain("fetchPostMetrics");
  });

  it("never plans account metrics beyond the 90-day platform horizon", () => {
    const covered: PlanState = {
      ...state,
      coveredFrom: "2026-07-05",
      coveredThrough: "2026-09-28",
    };
    expect(
      socialMetricWindow({ kind: "backfill", state: covered, capabilities: FULL, now: NOW }),
    ).toEqual({
      from: "2026-07-01",
      to: "2026-07-04",
    });
    const atHorizon: PlanState = { ...state, coveredFrom: "2026-07-01" };
    expect(
      socialMetricWindow({ kind: "backfill", state: atHorizon, capabilities: FULL, now: NOW }),
    ).toBeUndefined();
    const backfill = buildSocialRunPlan({
      kind: "backfill",
      state: covered,
      capabilities: FULL,
      now: NOW,
    });
    expect(backfill.tasks.map((t) => t.operation)).toEqual([
      "getSocialAccount",
      "fetchAccountMetrics",
    ]);
  });
});

describe("reporting delay (ADR 0016, YouTube)", () => {
  const YT = YOUTUBE_CAPABILITIES;
  const window = (kind: "initial" | "incremental" | "lookback" | "manual", capabilities = YT) =>
    socialMetricWindow({ kind, state: youtubeState, capabilities, now: NOW });
  // today 2026-09-28 (UTC) - 394 days: the 395-day horizon starts on 2025-08-30.
  const youtubeState: PlanState = { structureStale: false, backfillHorizon: "2025-08-30" };

  it("ends every account-metric window accountMetricsDelayDays before today", () => {
    expect(YT.accountMetricsDelayDays).toBe(3);
    // today (UTC) is 2026-09-28: the newest day requested is 2026-09-25.
    expect(window("initial")).toEqual({ from: "2026-08-27", to: "2026-09-25" });
    expect(window("incremental")).toEqual({ from: "2026-09-24", to: "2026-09-25" });
    expect(window("manual")).toEqual(window("incremental"));
    expect(window("lookback")).toEqual({ from: "2026-09-19", to: "2026-09-25" }); // 7 days
  });

  it("chunks YouTube windows by month into single-report tasks, newest first", () => {
    const initial = buildSocialRunPlan({
      kind: "initial",
      state: youtubeState,
      capabilities: YT,
      now: NOW,
    });
    expect(initial.tasks.map((t) => [t.operation, t.from, t.to])).toEqual([
      ["getSocialAccount", undefined, undefined],
      ["listSocialPosts", undefined, undefined],
      ["fetchPostMetrics", "2026-07-01", "2026-09-28"], // the 90-day snapshot window, not delayed
      ["fetchAccountMetrics", "2026-09-01", "2026-09-25"],
      ["fetchAccountMetrics", "2026-08-27", "2026-08-31"],
      // Checkpoint 8: the per-video windows (lifetime's first day is resolved at claim time).
      ["fetchVideoAnalytics", "2026-08-29", "2026-09-25"],
      ["fetchVideoAnalytics", undefined, "2026-09-25"],
    ]);
    const backfill = buildSocialRunPlan({
      kind: "backfill",
      state: { ...youtubeState, coveredFrom: "2026-08-27", coveredThrough: "2026-09-25" },
      capabilities: YT,
      now: NOW,
    });
    // One 31-day window before coverage, split at the month boundary.
    expect(backfill.tasks.slice(1).map((t) => [t.operation, t.from, t.to])).toEqual([
      ["fetchAccountMetrics", "2026-08-01", "2026-08-26"],
      ["fetchAccountMetrics", "2026-07-27", "2026-07-31"],
    ]);
  });

  it("never requests a day before the 395-day horizon", () => {
    const atHorizon = socialMetricWindow({
      kind: "backfill",
      state: { ...youtubeState, coveredFrom: "2025-08-30" },
      capabilities: YT,
      now: NOW,
    });
    expect(atHorizon).toBeUndefined();
    const nearHorizon = socialMetricWindow({
      kind: "backfill",
      state: { ...youtubeState, coveredFrom: "2025-09-10" },
      capabilities: YT,
      now: NOW,
    });
    expect(nearHorizon).toEqual({ from: "2025-08-30", to: "2025-09-09" });
  });

  it("leaves Instagram (no delay declared) exactly as before", () => {
    expect(INSTAGRAM_CAPABILITIES.accountMetricsDelayDays).toBeUndefined();
    expect(window("incremental", FULL)).toEqual({ from: "2026-09-27", to: "2026-09-28" });
    expect(window("lookback", FULL)).toEqual({ from: "2026-09-26", to: "2026-09-28" });
    expect(window("initial", FULL)).toEqual({ from: "2026-08-30", to: "2026-09-28" });
    // An explicit 0 is the same as no delay.
    expect(window("lookback", { ...FULL, accountMetricsDelayDays: 0 })).toEqual(
      window("lookback", FULL),
    );
  });
});

describe("report scope (ADR 0016, open question 13)", () => {
  const youtubeState: PlanState = { structureStale: false, backfillHorizon: "2025-08-30" };
  const operations = (input: Partial<Parameters<typeof buildSocialRunPlan>[0]>) =>
    buildSocialRunPlan({
      kind: "initial",
      state: youtubeState,
      capabilities: YOUTUBE_CAPABILITIES,
      now: NOW,
      ...input,
    }).tasks.map((t) => t.operation);

  it("YouTube names yt-analytics.readonly as the scope its day reports need", () => {
    expect(YOUTUBE_CAPABILITIES.accountMetricsScope).toBe(
      "https://www.googleapis.com/auth/yt-analytics.readonly",
    );
    expect(INSTAGRAM_CAPABILITIES.accountMetricsScope).toBeUndefined();
  });

  it("without the scope: no day-report or video-report task, and nothing else changes", () => {
    for (const kind of ["initial", "lookback", "incremental", "manual"] as const) {
      const granted = operations({ kind });
      const missing = operations({ kind, accountMetricsGranted: false });
      expect(missing).toEqual(
        granted.filter((op) => op !== "fetchAccountMetrics" && op !== "fetchVideoAnalytics"),
      );
      expect(missing[0]).toBe("getSocialAccount");
    }
    expect(operations({ accountMetricsGranted: false })).toEqual([
      "getSocialAccount",
      "listSocialPosts",
      "fetchPostMetrics",
    ]);
    // No account-metric window: the plan claims no day as covered.
    expect(
      buildSocialRunPlan({
        kind: "initial",
        state: youtubeState,
        capabilities: YOUTUBE_CAPABILITIES,
        now: NOW,
        accountMetricsGranted: false,
      }).window,
    ).toBeUndefined();
  });

  it("with the scope (or by default) the plan is exactly as before", () => {
    expect(operations({ accountMetricsGranted: true })).toEqual(operations({}));
    expect(operations({})).toContain("fetchAccountMetrics");
    expect(operations({})).toContain("fetchVideoAnalytics");
  });
});

describe("per-video analytics windows (ADR 0016 Checkpoint 8)", () => {
  const youtubeState: PlanState = { structureStale: false, backfillHorizon: "2025-08-30" };
  const plan = (
    kind: "initial" | "incremental" | "lookback" | "backfill" | "manual",
    now = NOW,
    capabilities: SocialProviderCapabilities = YOUTUBE_CAPABILITIES,
    state: PlanState = youtubeState,
  ) => buildSocialRunPlan({ kind, state, capabilities, now });
  const videoTasks = (result: ReturnType<typeof plan>) =>
    result.tasks.filter((task) => task.operation === "fetchVideoAnalytics");

  it("plans last28 and lifetime on initial and lookback runs, after every other task", () => {
    for (const kind of ["initial", "lookback"] as const) {
      const result = plan(kind);
      expect(videoTasks(result)).toEqual([
        {
          operation: "fetchVideoAnalytics",
          videoWindow: "last28",
          from: "2026-08-29",
          to: "2026-09-25",
          fullListing: false,
        },
        {
          operation: "fetchVideoAnalytics",
          videoWindow: "lifetime",
          to: "2026-09-25",
          fullListing: false,
        },
      ]);
      // The listing (and so the stored videos) always comes first; the windows come last.
      const operations = result.tasks.map((task) => task.operation);
      expect(operations.indexOf("listSocialPosts")).toBeLessThan(
        operations.indexOf("fetchVideoAnalytics"),
      );
      expect(operations.slice(-2)).toEqual(["fetchVideoAnalytics", "fetchVideoAnalytics"]);
    }
  });

  it("never on incremental, manual or backfill runs", () => {
    const covered = { ...youtubeState, coveredFrom: "2026-08-27", coveredThrough: "2026-09-25" };
    for (const kind of ["incremental", "manual", "backfill"] as const) {
      expect(videoTasks(plan(kind, NOW, YOUTUBE_CAPABILITIES, covered))).toEqual([]);
    }
  });

  it("never without the report scope, and never for a platform that declares no video analytics", () => {
    expect(
      videoTasks(
        buildSocialRunPlan({
          kind: "initial",
          state: youtubeState,
          capabilities: YOUTUBE_CAPABILITIES,
          now: NOW,
          accountMetricsGranted: false,
        }),
      ),
    ).toEqual([]);
    expect(INSTAGRAM_CAPABILITIES.videoAnalytics).toBeUndefined();
    expect(videoTasks(plan("initial", NOW, INSTAGRAM_CAPABILITIES, state))).toEqual([]);
    expect(videoTasks(plan("lookback", NOW, FULL, state))).toEqual([]);
  });

  it("ends both windows at today in Pacific Time minus the reporting delay", () => {
    expect(YOUTUBE_CAPABILITIES.videoAnalytics).toEqual({
      dayTimeZone: "America/Los_Angeles",
      recentWindowDays: 28,
      maxVideosPerWindow: 200,
    });
    // 2026-09-29 03:00 UTC is still 2026-09-28 in Pacific Time: latest = 2026-09-25 (UTC would
    // give 2026-09-26).
    const lateUtc = Date.UTC(2026, 8, 29, 3, 0);
    expect(videoAnalyticsLatestDay(YOUTUBE_CAPABILITIES, lateUtc)).toBe("2026-09-25");
    expect(videoTasks(plan("lookback", lateUtc)).map((t) => [t.videoWindow, t.from, t.to])).toEqual(
      [
        ["last28", "2026-08-29", "2026-09-25"],
        ["lifetime", undefined, "2026-09-25"],
      ],
    );
    expect(videoAnalyticsLatestDay(INSTAGRAM_CAPABILITIES, lateUtc)).toBeUndefined();
  });

  describe("resolveVideoWindow (at claim time)", () => {
    const base = { to: "2026-09-25", dayTimeZone: "America/Los_Angeles" };
    // 2024-03-01 06:00 UTC is 2024-02-29 in Pacific Time.
    const oldest = Date.UTC(2024, 2, 1, 6, 0);

    it("lifetime starts on the oldest stored upload's Pacific Time publish day", () => {
      expect(
        resolveVideoWindow({ ...base, window: "lifetime", oldestPublishedAt: oldest }),
      ).toEqual({ from: "2024-02-29", to: "2026-09-25" });
      // A retry keeps the day an earlier claim resolved.
      expect(
        resolveVideoWindow({
          ...base,
          window: "lifetime",
          plannedFrom: "2024-01-01",
          oldestPublishedAt: oldest,
        }),
      ).toEqual({ from: "2024-01-01", to: "2026-09-25" });
    });

    it("last28 keeps its planned days", () => {
      expect(
        resolveVideoWindow({
          ...base,
          window: "last28",
          plannedFrom: "2026-08-29",
          oldestPublishedAt: oldest,
        }),
      ).toEqual({ from: "2026-08-29", to: "2026-09-25" });
    });

    it("skips a window when the channel has no stored video", () => {
      for (const window of ["last28", "lifetime"] as const) {
        expect(
          resolveVideoWindow({
            ...base,
            window,
            plannedFrom: "2026-08-29",
            oldestPublishedAt: undefined,
          }),
        ).toBeUndefined();
      }
    });

    it("skips lifetime when every stored video is newer than the window's last day", () => {
      expect(
        resolveVideoWindow({
          ...base,
          window: "lifetime",
          oldestPublishedAt: Date.UTC(2026, 8, 27, 12),
        }),
      ).toBeUndefined();
      // A malformed last28 task (no planned days) is never requested.
      expect(
        resolveVideoWindow({ ...base, window: "last28", oldestPublishedAt: oldest }),
      ).toBeUndefined();
    });
  });
});
