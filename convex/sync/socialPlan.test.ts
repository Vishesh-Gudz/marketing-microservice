import { describe, expect, it } from "vitest";
import type { Id } from "../_generated/dataModel";
import { INSTAGRAM_CAPABILITIES } from "../providers/instagram/capabilities";
import type { SocialProviderCapabilities } from "../providers/social/capabilities";
import type { PlanState } from "./plan";
import { buildSocialRunPlan, socialMetricWindow } from "./socialPlan";
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
