import { describe, expect, it } from "vitest";
import {
  aggregateOrganic,
  compareOrganic,
  postMetricsOf,
  rateOf,
  type AccountDays,
  type DayRow,
} from "./aggregate";

// Phase 10 Stage B: pure organic aggregation. Missing is never zero; synced-but-empty days are
// "not reported"; additive metrics sum over accounts and days; reach / accountsEngaged /
// engagementRate only for one account on one UTC day; followers is the latest capture per
// account (summed across accounts, never over days); reason precedence; deprecated metrics.

const SYNCED = 1_790_000_000_000;
const day = (date: string, values: Partial<DayRow> = {}, synced = true): DayRow => ({
  date,
  ...(synced ? { insightsSyncedAt: SYNCED } : {}),
  ...values,
});
const account = (accountId: string, rows: DayRow[]): AccountDays => ({ accountId, rows });
const WEEK = { from: "2026-09-01", to: "2026-09-07" };
const ONE_DAY = { from: "2026-09-03", to: "2026-09-03" };

const run = (accounts: AccountDays[], range = WEEK, supported = true) =>
  aggregateOrganic({ accounts, range, supported });

const reasonOf = (result: ReturnType<typeof run>, metric: string) =>
  result.unavailableMetrics.find((u) => u.metric === metric)?.reason;

describe("data states", () => {
  it("reported when every account-day is synced, partial when some are, unknown when none", () => {
    const all = Array.from({ length: 7 }, (_, i) => day(`2026-09-0${i + 1}`, { views: 1 }));
    expect(run([account("a", all)]).dataState).toBe("reported");
    expect(run([account("a", all.slice(0, 3))]).dataState).toBe("partial");
    expect(run([account("a", [])]).dataState).toBe("unknown");
    expect(run([]).dataState).toBe("unknown");
    expect(run([account("a", all)], WEEK, false).dataState).toBe("unsupported");
  });

  it("a row holding only a follower capture is not a synced insights day", () => {
    const result = run(
      [account("a", [day("2026-09-03", { followers: 10, followersCapturedAt: SYNCED }, false)])],
      ONE_DAY,
    );
    expect(result.dataState).toBe("unknown");
    expect(result.values.followers).toBe(10n);
    expect(result.syncedDays).toBe(0);
  });

  it("rows outside the range are ignored", () => {
    const result = run([
      account("a", [day("2026-08-31", { views: 100 }), day("2026-09-01", { views: 1 })]),
    ]);
    expect(result.values.views).toBe(1n);
  });
});

describe("additive metrics", () => {
  it("sum across days and accounts; zero stays zero; missing is never zero", () => {
    const result = run([
      account("a", [
        day("2026-09-01", {
          views: 10,
          totalInteractions: 0,
          followerDelta: -2,
          extras: { likes: 3, replies: 0 },
        }),
        day("2026-09-02", {
          views: 5,
          totalInteractions: 4,
          followerDelta: 5,
          extras: { likes: 1, replies: 0 },
        }),
      ]),
      account("b", [
        day("2026-09-01", {
          views: 1,
          totalInteractions: 0,
          followerDelta: 0,
          extras: { likes: 0, replies: 0 },
        }),
      ]),
    ]);
    expect(result.values).toMatchObject({
      views: 16n,
      totalInteractions: 4n,
      followerDelta: 3n,
      likes: 4n,
      replies: 0n,
    });
    expect(result.values.comments).toBeUndefined();
    expect(reasonOf(result, "comments")).toBe("not_reported");
    expect(reasonOf(result, "shares")).toBe("not_reported");
    expect(result.partialMetrics).toEqual([]);
  });

  it("a value missing on some synced days is summed over the others and partial", () => {
    const result = run([
      account("a", [
        day("2026-09-01", { views: 10 }),
        day("2026-09-02"),
        day("2026-09-03", { views: 0 }),
      ]),
    ]);
    expect(result.values.views).toBe(10n);
    expect(result.partialMetrics).toContain("views");
  });

  it("a synced day reporting nothing is not_reported, never unknown or zero (R8)", () => {
    const result = run([account("a", [day("2026-09-03")])], ONE_DAY);
    expect(result.dataState).toBe("reported");
    for (const metric of [
      "views",
      "totalInteractions",
      "followerDelta",
      "likes",
      "reach",
      "accountsEngaged",
    ]) {
      expect(result.values).not.toHaveProperty(metric);
      expect(reasonOf(result, metric)).toBe("not_reported");
    }
  });
});

describe("followers (snapshot)", () => {
  it("uses each account's latest capture, sums across accounts, never across days", () => {
    const result = run([
      account("a", [
        day("2026-09-01", { followers: 100, followersCapturedAt: SYNCED + 1 }),
        day("2026-09-05", { followers: 120, followersCapturedAt: SYNCED + 5 }),
      ]),
      account("b", [day("2026-09-02", { followers: 7, followersCapturedAt: SYNCED + 2 })]),
    ]);
    expect(result.values.followers).toBe(127n);
    expect(result.followersCapturedAt).toBe(SYNCED + 5);
    expect(result.partialMetrics).not.toContain("followers");
  });

  it("an account without a usable capture makes followers partial; none -> not_reported", () => {
    const partial = run([
      account("a", [day("2026-09-01", { followers: 50, followersCapturedAt: SYNCED })]),
      account("b", [day("2026-09-01", { followersCapturedAt: SYNCED })]), // captured, count unknown
    ]);
    expect(partial.values.followers).toBe(50n);
    expect(partial.partialMetrics).toContain("followers");
    const none = run([account("a", [day("2026-09-01")])]);
    expect(none.values.followers).toBeUndefined();
    expect(reasonOf(none, "followers")).toBe("not_reported");
  });
});

describe("non-additive metrics and engagement rate (R13, F12)", () => {
  it("one account, one UTC day: reach, accountsEngaged and engagementRate exist", () => {
    const result = run(
      [
        account("a", [
          day("2026-09-03", { reach: 200, accountsEngaged: 20, totalInteractions: 30 }),
        ]),
      ],
      ONE_DAY,
    );
    expect(result.values).toMatchObject({ reach: 200n, accountsEngaged: 20n });
    expect(result.engagementRate).toBe(150_000n); // 0.15
    expect(result.unavailableKpis).toEqual([]);
  });

  it("more than one day or account: non_additive, whatever is stored", () => {
    const multiDay = run([account("a", [day("2026-09-01", { reach: 1, totalInteractions: 1 })])]);
    const multiAccount = run(
      [
        account("a", [day("2026-09-03", { reach: 1, totalInteractions: 1 })]),
        account("b", [day("2026-09-03", { reach: 1, totalInteractions: 1 })]),
      ],
      ONE_DAY,
    );
    for (const result of [multiDay, multiAccount]) {
      expect(result.values.reach).toBeUndefined();
      expect(result.values.accountsEngaged).toBeUndefined();
      expect(reasonOf(result, "reach")).toBe("non_additive");
      expect(reasonOf(result, "accountsEngaged")).toBe("non_additive");
      expect(result.engagementRate).toBeUndefined();
      expect(result.unavailableKpis).toEqual([{ kpi: "engagementRate", reason: "non_additive" }]);
    }
  });

  it.each([
    [{ reach: 100 }, "numerator_unavailable"],
    [{ totalInteractions: 5 }, "denominator_unavailable"],
    [{ totalInteractions: 5, reach: 0 }, "zero_denominator"],
    [{}, "numerator_unavailable"],
  ] as const)("single day %j -> %s", (values, reason) => {
    const result = run([account("a", [day("2026-09-03", values)])], ONE_DAY);
    expect(result.engagementRate).toBeUndefined();
    expect(result.unavailableKpis).toEqual([{ kpi: "engagementRate", reason }]);
  });

  it("an unsynced single day has no numerator", () => {
    const result = run([account("a", [])], ONE_DAY);
    expect(result.unavailableKpis).toEqual([
      { kpi: "engagementRate", reason: "numerator_unavailable" },
    ]);
  });

  it("zero interactions over a positive reach is a rate of 0", () => {
    expect(rateOf(0, 10)).toEqual({ value: 0n });
  });
});

describe("reasons and precedence (R7)", () => {
  it("deprecated metrics are always deprecated_metric", () => {
    const result = run([account("a", [day("2026-09-03")])], ONE_DAY);
    expect(reasonOf(result, "profileViews")).toBe("deprecated_metric");
    expect(reasonOf(result, "websiteClicks")).toBe("deprecated_metric");
  });

  it("non_additive beats not_reported", () => {
    expect(reasonOf(run([account("a", [])]), "reach")).toBe("non_additive");
  });

  it("followerDelta under 100 followers is below_follower_threshold (IR8), else not_reported", () => {
    const small = run([
      account("a", [day("2026-09-01", { followers: 57, followersCapturedAt: SYNCED, views: 3 })]),
    ]);
    expect(reasonOf(small, "followerDelta")).toBe("below_follower_threshold");
    const mixed = run([
      account("a", [day("2026-09-01", { followers: 57, followersCapturedAt: SYNCED })]),
      account("b", [day("2026-09-01", { followers: 500, followersCapturedAt: SYNCED })]),
    ]);
    expect(reasonOf(mixed, "followerDelta")).toBe("not_reported");
    const uncaptured = run([account("a", [day("2026-09-01")])]);
    expect(reasonOf(uncaptured, "followerDelta")).toBe("not_reported");
  });

  it("lists every unavailable metric exactly once, in a stable order", () => {
    const result = run([account("a", [])]);
    const names = result.unavailableMetrics.map((u) => u.metric);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual([
      "followers",
      "followerDelta",
      "reach",
      "views",
      "accountsEngaged",
      "totalInteractions",
      "likes",
      "comments",
      "shares",
      "saves",
      "replies",
      "profileLinksTaps",
      "profileViews",
      "websiteClicks",
    ]);
  });
});

describe("comparison", () => {
  it("deltas for additive metrics and engagementRate; snapshots and unique counts never compared", () => {
    const current = run(
      [
        account("a", [
          day("2026-09-03", {
            views: 30,
            totalInteractions: 3,
            reach: 10,
            followers: 9,
            followersCapturedAt: SYNCED,
          }),
        ]),
      ],
      ONE_DAY,
    );
    const previous = run(
      [account("a", [day("2026-09-02", { views: 20, totalInteractions: 0, reach: 5 })])],
      {
        from: "2026-09-02",
        to: "2026-09-02",
      },
    );
    const deltas = compareOrganic(current, previous);
    expect(deltas.views).toEqual({ absolute: 10n, percent: 500_000n });
    expect(deltas.totalInteractions).toEqual({ absolute: 3n, reason: "previous_zero" });
    expect(deltas.engagementRate).toEqual({ absolute: 300_000n, reason: "previous_zero" });
    expect(deltas).not.toHaveProperty("followers");
    expect(deltas).not.toHaveProperty("reach");
    expect(deltas).not.toHaveProperty("accountsEngaged");
  });

  it("previous missing -> previous_unavailable; current missing -> no delta; partial flagged", () => {
    const current = run([account("a", [day("2026-09-01", { views: 5 })])]);
    const previous = run([account("a", [])]);
    const deltas = compareOrganic(current, previous);
    expect(deltas.views).toEqual({ reason: "previous_unavailable", partial: true });
    expect(deltas).not.toHaveProperty("likes");
  });
});

describe("post lifetime snapshots", () => {
  const supported = ["views", "reach", "likes", "comments", "shares", "saves", "totalInteractions"];

  it("reports values, explains missing and deprecated metrics, computes the rate", () => {
    const metrics = postMetricsOf(
      { likes: 10, reach: 200, totalInteractions: 12, shares: 0 },
      supported,
    );
    expect(metrics.values).toEqual({ likes: 10, reach: 200, totalInteractions: 12, shares: 0 });
    expect(metrics.dataState).toBe("partial");
    expect(metrics.unavailableMetrics).toEqual([
      { metric: "views", reason: "not_reported" },
      { metric: "comments", reason: "not_reported" },
      { metric: "saves", reason: "not_reported" },
      { metric: "videoViews", reason: "deprecated_metric" },
    ]);
    expect(metrics.engagementRate).toBe(60_000n);
  });

  it("complete snapshots are reported; zero reach is zero_denominator", () => {
    const full = Object.fromEntries(supported.map((m) => [m, 1]));
    expect(postMetricsOf(full, supported).dataState).toBe("reported");
    expect(postMetricsOf({ ...full, reach: 0 }, supported).unavailableKpis).toEqual([
      { kpi: "engagementRate", reason: "zero_denominator" },
    ]);
    expect(postMetricsOf({}, []).dataState).toBe("unsupported");
  });
});
