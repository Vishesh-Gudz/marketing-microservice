import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { EntityLevel } from "../domain/types";
import { createMockAdsProvider, mockCredential } from "../providers/mock";
import { collectAll } from "../providers/pagination";
import type { ProviderMetricRow } from "../providers/types";
import {
  connectMock,
  drainScheduler,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";
import { windowChunks } from "./plan";

// Metric semantics end to end: whole-row replacement of restated data plus
// pruning of rows that vanished, missing vs zero, account timezones, and
// exact money beyond 2^53 micros.

vi.setConfig({ testTimeout: 180_000 });
const NOW = new Date("2026-04-10T20:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function synced(t: Backend, platform: "meta" | "google_ads", externalId: string) {
  await setupSyncOrg(t);
  const connectionId = await connectMock(t, platform);
  const [account] = await linkMock(t, connectionId, [externalId]);
  await planAndDrain(t);
  return account!.id as Id<"adAccounts">;
}

async function providerRows(
  platform: "meta" | "google_ads",
  accountExternalId: string,
  window: { from: string; to: string },
  variant = 0,
) {
  const provider = createMockAdsProvider({ platform, variant });
  const ctx = { credential: mockCredential(), attempt: 1 };
  const rows: ProviderMetricRow[] = [];
  for (const chunk of windowChunks(window, 31)) {
    for (const level of ["account", "campaign", "ad_group", "ad"] as EntityLevel[]) {
      const { items } = await collectAll(
        (cursor) =>
          provider.fetchDailyMetrics(ctx, {
            accountExternalId,
            level,
            ...chunk,
            breakdown: "placement",
            ...(cursor ? { cursor } : {}),
          }),
        { maxPages: 1000 },
      );
      rows.push(...items);
    }
  }
  return rows;
}

const key = (r: { level: string; date: string; placement: string; spendMicros?: bigint }) =>
  `${r.level}|${r.date}|${r.placement}`;

describe("restatement", () => {
  it("replaces restated rows in place and prunes rows that vanished", async () => {
    const t = newBackend();
    const adAccountId = await synced(t, "google_ads", "4445556666");
    const window = (await t.run(async (ctx) => (await ctx.db.query("syncRuns").first())!)).window!;
    const before = await t.run((ctx) => ctx.db.query("metricsDaily").collect());
    const actionsBefore = await t.run((ctx) => ctx.db.query("actionMetricsDaily").collect());

    // Same identity reconnects; the platform now reports restated values (variant 1).
    await connectMock(t, "google_ads", "1--default--v1");
    vi.advanceTimersByTime(20 * 60_000);
    await t.mutation(internal.sync.admin.requestSync, {
      adAccountId,
      kind: "manual",
      ...window,
    });
    await drainScheduler(t);
    const run = await t.run(async (ctx) => (await ctx.db.query("syncRuns").order("desc").first())!);
    expect(run.status).toBe("succeeded");

    const after = await t.run((ctx) => ctx.db.query("metricsDaily").collect());
    const expected = await providerRows("google_ads", "4445556666", window, 1);
    // Exactly the restated provider data: no leftovers, no duplicates, exact values.
    expect(after).toHaveLength(expected.length);
    const stored = new Map(after.map((r) => [`${key(r)}|${r.entityId}`, r] as const));
    expect(stored.size).toBe(after.length);
    const expectedAccount = new Map(
      expected.filter((r) => r.level === "account").map((r) => [key(r), r.spendMicros]),
    );
    for (const row of after.filter((r) => r.level === "account")) {
      expect(row.spendMicros).toBe(expectedAccount.get(key(row)));
    }
    // Rows that survived kept their document id (replaced, not re-inserted).
    const beforeIds = new Set(before.map((r) => r._id));
    const kept = after.filter((r) => beforeIds.has(r._id));
    expect(kept.length).toBeGreaterThan(0);
    const actionsAfter = await t.run((ctx) => ctx.db.query("actionMetricsDaily").collect());
    const actionIds = new Set(actionsAfter.map((r) => r._id));
    const actionsPruned = actionsBefore.filter((r) => !actionIds.has(r._id)).length;
    expect(run.counts.pruned).toBe(before.length - kept.length + actionsPruned);
    expect(after.some((r, i) => r.spendMicros !== before[i]?.spendMicros)).toBe(true);
  });
});

describe("missing vs zero", () => {
  it("keeps unreported metrics absent (never 0)", async () => {
    const t = newBackend();
    await synced(t, "google_ads", "4445556666");
    const google = await t.run((ctx) => ctx.db.query("metricsDaily").collect());
    expect(google.length).toBeGreaterThan(0);
    for (const row of google) {
      expect(row).not.toHaveProperty("reach"); // Google does not report reach
      expect(row).not.toHaveProperty("linkClicks");
    }
  });

  it("reports reach only on 'all' rows (non-additive), absent on placement rows", async () => {
    const t = newBackend();
    await synced(t, "meta", "1002");
    const meta = await t.run((ctx) => ctx.db.query("metricsDaily").collect());
    const all = meta.filter((r) => r.placement === "all");
    const placements = meta.filter((r) => r.placement !== "all");
    expect(all.length).toBeGreaterThan(0);
    expect(placements.length).toBeGreaterThan(0);
    expect(all.every((r) => typeof r.reach === "number")).toBe(true);
    expect(placements.every((r) => r.reach === undefined)).toBe(true);
  });
});

describe("timezones and money", () => {
  it("windows follow each account's own day at the same instant", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const meta = await connectMock(t, "meta");
    await linkMock(t, meta, ["1002"]); // Asia/Jakarta (+7): already April 11 at 20:00Z
    const google = await connectMock(t, "google_ads");
    await linkMock(t, google, ["1112223333"]); // America/Los_Angeles: still April 10
    await t.mutation(internal.sync.planner.tick, {});
    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    const windows = Object.fromEntries(runs.map((r) => [r.platform, r.window]));
    expect(windows).toEqual({
      meta: { from: "2026-03-13", to: "2026-04-11" },
      google_ads: { from: "2026-03-12", to: "2026-04-10" },
    });
  });

  it("stores IDR amounts beyond 2^53 micros exactly", async () => {
    // 90 days of the high-denomination IDR fixture exceed 2^53 micros in total.
    vi.setSystemTime(new Date("2026-05-02T00:00:00Z"));
    const t = newBackend();
    const adAccountId = await synced(t, "meta", "1002");
    const window = { from: "2026-02-01", to: "2026-05-01" };
    vi.advanceTimersByTime(20 * 60_000);
    await t.mutation(internal.sync.admin.requestSync, { adAccountId, kind: "manual", ...window });
    await drainScheduler(t);
    const stored = (
      await t.run((ctx) =>
        ctx.db
          .query("metricsDaily")
          .filter((q) =>
            q.and(q.eq(q.field("level"), "account"), q.eq(q.field("placement"), "all")),
          )
          .collect(),
      )
    ).filter((r) => r.date >= window.from && r.date <= window.to);
    const expected = (await providerRows("meta", "1002", window)).filter(
      (r) => r.level === "account" && r.placement === "all",
    );
    const sum = (rows: { spendMicros?: bigint }[]) =>
      rows.reduce((total, r) => total + (r.spendMicros ?? 0n), 0n);
    expect(stored).toHaveLength(expected.length);
    expect(sum(stored)).toBe(sum(expected));
    expect(sum(stored) > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(stored.every((r) => r.currency === "IDR")).toBe(true);
  });
});
