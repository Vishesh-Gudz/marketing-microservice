import { describe, expect, it } from "vitest";
import type { AdsProviderCapabilities } from "../providers/capabilities";
import { GOOGLE_MOCK_CAPABILITIES } from "../providers/mock/google";
import { META_MOCK_CAPABILITIES } from "../providers/mock/meta";
import { SYNC_LIMITS } from "./config";
import {
  buildRunPlan,
  dueKind,
  failureBackoffMs,
  mergeCoverage,
  metricWindow,
  nextDueAt,
  syncableLevels,
  validateManualWindow,
  windowChunks,
  type PlanState,
} from "./plan";

const NOW = Date.parse("2026-04-10T20:00:00Z");
const HOUR = 3_600_000;

const fresh: PlanState = { structureStale: true, backfillHorizon: "2025-03-12" };
const synced: PlanState = {
  initialDoneAt: NOW - HOUR,
  nextIncrementalAt: NOW + HOUR,
  nextLookbackAt: NOW + 24 * HOUR,
  lastStructureStartedAt: NOW - HOUR,
  structureStale: false,
  coveredFrom: "2026-03-12",
  coveredThrough: "2026-04-10",
  backfillHorizon: "2025-03-12",
};

describe("due kinds", () => {
  it("prioritizes initial > lookback > incremental > backfill", () => {
    expect(dueKind(fresh, NOW)).toBe("initial");
    expect(dueKind({ ...synced, nextLookbackAt: NOW, nextIncrementalAt: NOW }, NOW)).toBe(
      "lookback",
    );
    expect(dueKind({ ...synced, nextIncrementalAt: NOW }, NOW)).toBe("incremental");
    expect(dueKind(synced, NOW)).toBe("backfill");
    expect(dueKind({ ...synced, coveredFrom: synced.backfillHorizon }, NOW)).toBeUndefined();
  });

  it("computes the next due instant", () => {
    expect(nextDueAt(fresh, NOW)).toBe(NOW);
    expect(nextDueAt(synced, NOW)).toBe(NOW); // backfill pending
    expect(nextDueAt({ ...synced, coveredFrom: synced.backfillHorizon }, NOW)).toBe(NOW + HOUR);
  });

  it("backs off after failures, capped", () => {
    expect(failureBackoffMs(0)).toBe(0);
    expect(failureBackoffMs(1)).toBe(15 * 60_000);
    expect(failureBackoffMs(2)).toBe(30 * 60_000);
    expect(failureBackoffMs(50)).toBe(SYNC_LIMITS.maxFailureBackoffMs);
  });
});

describe("windows in the account timezone", () => {
  const caps = META_MOCK_CAPABILITIES;
  const window = (kind: Parameters<typeof metricWindow>[0]["kind"], state: PlanState, tz: string) =>
    metricWindow({ kind, state, capabilities: caps, timezone: tz, now: NOW });

  it("uses each account's own 'today' at the same instant", () => {
    // 20:00Z is already April 11 in Jakarta (+7) but still April 10 in Los Angeles.
    expect(window("initial", fresh, "Asia/Jakarta")).toEqual({
      from: "2026-03-13",
      to: "2026-04-11",
    });
    expect(window("initial", fresh, "America/Los_Angeles")).toEqual({
      from: "2026-03-12",
      to: "2026-04-10",
    });
  });

  it("incremental re-pulls yesterday and today, catching up after gaps (bounded)", () => {
    expect(window("incremental", synced, "UTC")).toEqual({ from: "2026-04-09", to: "2026-04-10" });
    expect(window("incremental", { ...synced, coveredThrough: "2026-04-01" }, "UTC")).toEqual({
      from: "2026-04-02",
      to: "2026-04-10",
    });
    const farBehind = window("incremental", { ...synced, coveredThrough: "2025-01-01" }, "UTC")!;
    expect(farBehind.from).toBe("2026-02-08"); // 62 days, older gap is backfilled
  });

  it("lookback uses the provider restatement window, capped at 30 days", () => {
    expect(window("lookback", synced, "UTC")).toEqual({ from: "2026-03-13", to: "2026-04-10" });
    const google = metricWindow({
      kind: "lookback",
      state: synced,
      capabilities: { ...GOOGLE_MOCK_CAPABILITIES, restatementLookbackDays: 90 },
      timezone: "UTC",
      now: NOW,
    });
    expect(google).toEqual({ from: "2026-03-11", to: "2026-04-10" });
  });

  it("backfills one month older than coverage, down to the horizon", () => {
    expect(window("backfill", synced, "UTC")).toEqual({ from: "2026-03-01", to: "2026-03-11" });
    expect(window("backfill", { ...synced, coveredFrom: "2026-03-01" }, "UTC")).toEqual({
      from: "2026-02-01",
      to: "2026-02-28",
    });
    expect(
      window(
        "backfill",
        { ...synced, coveredFrom: "2025-03-20", backfillHorizon: "2025-03-12" },
        "UTC",
      ),
    ).toEqual({ from: "2025-03-12", to: "2025-03-19" });
    expect(window("backfill", { ...synced, coveredFrom: "2025-03-12" }, "UTC")).toBeUndefined();
  });

  it("validates manual windows", () => {
    expect(validateManualWindow({ from: "2026-01-10", to: "2026-04-10" }, "UTC", NOW)).toBe(
      undefined,
    );
    expect(validateManualWindow({ from: "2026-01-01", to: "2026-04-10" }, "UTC", NOW)).toMatch(
      /exceeds/,
    );
    expect(validateManualWindow({ from: "2026-04-10", to: "2026-04-01" }, "UTC", NOW)).toMatch(
      /after/,
    );
    expect(validateManualWindow({ from: "2026-04-10", to: "2026-04-12" }, "UTC", NOW)).toMatch(
      /future/,
    );
  });

  it("chunks at month boundaries and max length, newest first", () => {
    expect(windowChunks({ from: "2026-02-20", to: "2026-04-03" }, 31)).toEqual([
      { from: "2026-04-01", to: "2026-04-03" },
      { from: "2026-03-01", to: "2026-03-31" },
      { from: "2026-02-20", to: "2026-02-28" },
    ]);
    expect(windowChunks({ from: "2026-03-01", to: "2026-03-31" }, 10)).toEqual([
      { from: "2026-03-31", to: "2026-03-31" },
      { from: "2026-03-21", to: "2026-03-30" },
      { from: "2026-03-11", to: "2026-03-20" },
      { from: "2026-03-01", to: "2026-03-10" },
    ]);
  });
});

describe("capability-driven task plans", () => {
  const plan = (
    caps: AdsProviderCapabilities,
    state: PlanState = fresh,
    kind = dueKind(state, NOW)!,
  ) => buildRunPlan({ kind, state, capabilities: caps, timezone: "UTC", now: NOW });

  it("orders getAccount -> campaigns -> adGroups -> creatives -> ads -> daily metrics -> action metrics", () => {
    const { tasks } = plan(META_MOCK_CAPABILITIES);
    const ops = tasks.map((t) => t.operation);
    expect(ops.slice(0, 5)).toEqual([
      "getAccount",
      "listCampaigns",
      "listAdGroups",
      "listCreatives",
      "listAds",
    ]);
    const firstAction = ops.indexOf("fetchActionMetrics");
    const lastDaily = ops.lastIndexOf("fetchDailyMetrics");
    expect(lastDaily).toBeLessThan(firstAction);
    expect(tasks.filter((t) => t.operation === "fetchDailyMetrics")).toHaveLength(2 * 4);
    for (const t of tasks.filter((t) => t.operation === "fetchDailyMetrics")) {
      expect(t.breakdown).toBe("placement");
    }
    for (const t of tasks.filter((t) => t.operation === "fetchActionMetrics")) {
      expect(t.breakdown).toBe("none");
    }
    expect(tasks.filter((t) => t.fullListing).map((t) => t.operation)).toEqual([
      "listCampaigns",
      "listAdGroups",
      "listCreatives",
      "listAds",
    ]);
  });

  it("never plans an unsupported level, breakdown, entity listing or action metric", () => {
    const limited: AdsProviderCapabilities = {
      ...META_MOCK_CAPABILITIES,
      entities: { campaigns: true, adGroups: true, ads: false, creatives: false },
      metricLevels: ["account", "campaign", "ad"],
      placementBreakdown: false,
      actionMetrics: false,
    };
    const { tasks } = plan(limited);
    const ops = new Set(tasks.map((t) => t.operation));
    expect(ops.has("listAds")).toBe(false);
    expect(ops.has("listCreatives")).toBe(false);
    expect(ops.has("fetchActionMetrics")).toBe(false);
    // "ad" is a supported metric level, but ads cannot be stored: never requested.
    expect(new Set(tasks.map((t) => t.level).filter(Boolean))).toEqual(
      new Set(["account", "campaign"]),
    );
    expect(tasks.every((t) => t.breakdown !== "placement")).toBe(true);
    expect(syncableLevels(limited)).toEqual(["account", "campaign"]);
  });

  it("chunks metric windows by the provider's maximum range", () => {
    const { tasks } = plan({ ...META_MOCK_CAPABILITIES, maxMetricsRangeDays: 7 });
    for (const t of tasks.filter((t) => t.from !== undefined)) {
      expect(Date.parse(t.to!) - Date.parse(t.from!)).toBeLessThan(7 * 86_400_000);
    }
  });

  it("chooses structure modes per kind and capability", () => {
    const due = { ...synced, nextIncrementalAt: NOW };
    const metaInc = plan(META_MOCK_CAPABILITIES, due, "incremental");
    expect(metaInc.structureMode).toBe("incremental");
    expect(metaInc.updatedSince).toBe(synced.lastStructureStartedAt! - HOUR);
    expect(metaInc.tasks.every((t) => !t.fullListing)).toBe(true);
    expect(plan(GOOGLE_MOCK_CAPABILITIES, due, "incremental").structureMode).toBe("none");
    expect(
      plan(GOOGLE_MOCK_CAPABILITIES, { ...due, structureStale: true }, "incremental").structureMode,
    ).toBe("full");
    expect(plan(GOOGLE_MOCK_CAPABILITIES, due, "lookback").structureMode).toBe("full");
    expect(plan(META_MOCK_CAPABILITIES, synced, "backfill").structureMode).toBe("none");
  });

  it("stays within the task limit for the largest (manual, 93-day) window", () => {
    const result = buildRunPlan({
      kind: "manual",
      state: synced,
      capabilities: META_MOCK_CAPABILITIES,
      timezone: "UTC",
      now: NOW,
      manualWindow: { from: "2026-01-08", to: "2026-04-10" },
    });
    expect(result.tasks.length).toBeLessThanOrEqual(SYNC_LIMITS.maxTasksPerRun);
  });
});

describe("coverage", () => {
  it("extends with adjacent or overlapping windows", () => {
    expect(
      mergeCoverage(undefined, [
        { from: "2026-03-12", to: "2026-03-31" },
        { from: "2026-04-01", to: "2026-04-10" },
      ]),
    ).toEqual({ from: "2026-03-12", through: "2026-04-10" });
    expect(
      mergeCoverage({ from: "2026-03-12", through: "2026-04-10" }, [
        { from: "2026-03-01", to: "2026-03-11" },
      ]),
    ).toEqual({ from: "2026-03-01", through: "2026-04-10" });
  });

  it("restarts on a newer window after a gap and ignores older ones behind a gap", () => {
    const covered = { from: "2026-03-01", through: "2026-03-10" };
    expect(mergeCoverage(covered, [{ from: "2026-04-01", to: "2026-04-10" }])).toEqual({
      from: "2026-04-01",
      through: "2026-04-10",
    });
    expect(mergeCoverage(covered, [{ from: "2026-01-01", to: "2026-01-31" }])).toEqual(covered);
  });

  it("does not bridge a failed (missing) middle window", () => {
    // Newest and oldest chunks succeeded, the middle one did not.
    expect(
      mergeCoverage(undefined, [
        { from: "2026-04-01", to: "2026-04-10" },
        { from: "2026-02-01", to: "2026-02-28" },
      ]),
    ).toEqual({ from: "2026-04-01", through: "2026-04-10" });
  });
});
