import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { INSTAGRAM_CAPABILITIES } from "../providers/instagram/capabilities";
import { mockInstagramAccountId } from "../providers/social/mock";
import { dueKind, nextDueAt, type PlanState } from "./plan";
import { buildSocialRunPlan } from "./socialPlan";
import {
  connectMockInstagram,
  linkSocial,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";

// Phase 10 Stage B (mock mode): social coverage (account-metric windows on UTC days, never
// post snapshots), the backfill down to the 90-day horizon and its sliding end, and the
// commitSocialPage protocol: explicit truncation, incomplete windows, replayed pages and
// scope guards.

vi.setConfig({ testTimeout: 180_000 });
const NOW = Date.UTC(2026, 8, 28, 12);
const EXTERNAL = mockInstagramAccountId("1");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function linked(t: Backend) {
  await setupSyncOrg(t);
  const connectionId = (await connectMockInstagram(t, "1")).get("connection")!;
  const [account] = await linkSocial(t, connectionId, [EXTERNAL]);
  return account!.id as Id<"socialAccounts">;
}

async function syncAccount(t: Backend): Promise<Doc<"syncAccounts">> {
  return (await t.run((ctx) => ctx.db.query("syncAccounts").first()))!;
}

async function runs(t: Backend) {
  return await t.run((ctx) => ctx.db.query("syncRuns").collect());
}

describe("social coverage and backfill", () => {
  it("initial covers the last 30 UTC days; backfill reaches the 90-day horizon, then stops", async () => {
    const t = newBackend();
    await linked(t);
    await planAndDrain(t);
    expect(await syncAccount(t)).toMatchObject({
      coveredFrom: "2026-08-30",
      coveredThrough: "2026-09-28",
      backfillHorizon: "2026-07-01",
    });
    // Snapshots never extend coverage; only account-metric windows do.
    expect(
      (await t.run((ctx) => ctx.db.query("socialPostMetricSnapshots").collect())).length,
    ).toBeGreaterThan(0);

    for (let i = 1; i <= 4; i++) await planAndDrain(t);
    const all = await runs(t);
    expect(
      all.filter((r) => r.kind === "backfill").map((r) => [r.window?.from, r.window?.to, r.status]),
    ).toEqual([
      ["2026-07-30", "2026-08-29", "succeeded"],
      ["2026-07-01", "2026-07-29", "succeeded"],
    ]);
    expect(await syncAccount(t)).toMatchObject({
      coveredFrom: "2026-07-01",
      coveredThrough: "2026-09-28",
    });
    const days = await t.run((ctx) => ctx.db.query("socialAccountMetricsDaily").collect());
    expect(days).toHaveLength(90);
    expect(days.every((d) => d.date >= "2026-07-01")).toBe(true);
    // Nothing is due anymore: the planner starts nothing.
    expect((await planAndDrain(t)).started).toBe(0);
  });

  it("the horizon slides with the platform window: an aged-out gap never loops backfills", async () => {
    const t = newBackend();
    vi.setSystemTime(Date.UTC(2026, 8, 28, 23, 50));
    await linked(t);
    await planAndDrain(t); // initial on 2026-09-28 (UTC)
    expect((await syncAccount(t)).backfillHorizon).toBe("2026-07-01");

    vi.setSystemTime(Date.UTC(2026, 8, 29, 0, 10)); // the platform horizon is now 2026-07-02
    for (let i = 0; i < 6; i++) await planAndDrain(t);
    const backfills = (await runs(t)).filter((r) => r.kind === "backfill");
    expect(backfills.map((r) => [r.window?.from, r.window?.to])).toEqual([
      ["2026-07-30", "2026-08-29"],
      ["2026-07-02", "2026-07-29"],
    ]);
    const state = await syncAccount(t);
    expect(state).toMatchObject({ coveredFrom: "2026-07-02", backfillHorizon: "2026-07-02" });
    expect(state.nextPlanAt).toBeGreaterThan(Date.now());
    expect((await planAndDrain(t)).started).toBe(0);
  });

  // Regression (approved backfill fix): Stage A fixed the horizon at link time. Once the
  // platform window moves past it, the gap below coveredFrom can never be fetched, yet a
  // fixed horizon keeps the backfill "pending" and due immediately, forever.
  const FIXED_STAGE_A: PlanState = {
    initialDoneAt: Date.UTC(2026, 8, 28, 23, 50),
    nextIncrementalAt: Date.UTC(2026, 8, 29, 0, 50),
    nextLookbackAt: Date.UTC(2026, 8, 29, 23, 50),
    structureStale: false,
    coveredFrom: "2026-07-02",
    coveredThrough: "2026-09-28",
    backfillHorizon: "2026-07-01", // today - 89 on the link day (2026-09-28)
  };

  it("without the slide, a fixed Stage A horizon re-plans a near-empty backfill at every tick", () => {
    let now = Date.UTC(2026, 8, 29, 0, 10); // platform horizon: 2026-07-02
    for (let tick = 0; tick < 3; tick++, now += 15 * 60_000) {
      expect(dueKind(FIXED_STAGE_A, now)).toBe("backfill");
      expect(nextDueAt(FIXED_STAGE_A, now)).toBe(now); // due again immediately
      const plan = buildSocialRunPlan({
        kind: "backfill",
        state: FIXED_STAGE_A,
        capabilities: INSTAGRAM_CAPABILITIES,
        now,
      });
      // Nothing historical can be fetched (the gap is older than the 90-day window):
      // the run is the preflight alone and changes no coverage, so the state never moves.
      expect(plan.window).toBeUndefined();
      expect(plan.tasks.map((task) => task.operation)).toEqual(["getSocialAccount"]);
    }
    // With the slid horizon (what completeRun now stores), nothing is due.
    const slid: PlanState = { ...FIXED_STAGE_A, backfillHorizon: "2026-07-02" };
    expect(dueKind(slid, Date.UTC(2026, 8, 29, 0, 10))).toBeUndefined();
    expect(nextDueAt(slid, Date.UTC(2026, 8, 29, 0, 10))).toBe(slid.nextIncrementalAt);
  });

  it("with the slide, a stale Stage A horizon costs at most one near-empty run, then stops", async () => {
    const t = newBackend();
    vi.setSystemTime(Date.UTC(2026, 8, 28, 23, 50));
    await linked(t);
    await planAndDrain(t);
    // Recreate the state Stage A leaves behind: coverage down to the (moved) platform
    // horizon, the horizon still fixed at link time.
    const row = await syncAccount(t);
    await t.run((ctx) =>
      ctx.db.patch(row._id, {
        coveredFrom: "2026-07-02",
        backfillHorizon: "2026-07-01",
        nextPlanAt: 0,
      }),
    );
    // Three planner slots before the next incremental run is due (00:50).
    for (const minute of [10, 25, 40]) {
      vi.setSystemTime(Date.UTC(2026, 8, 29, 0, minute));
      await planAndDrain(t);
    }
    const backfills = (await runs(t)).filter((r) => r.kind === "backfill");
    expect(backfills).toHaveLength(1);
    expect(backfills[0]).toMatchObject({ status: "succeeded", taskCount: 1 });
    expect(backfills[0]!.window).toBeUndefined();
    const state = await syncAccount(t);
    expect(state).toMatchObject({ coveredFrom: "2026-07-02", backfillHorizon: "2026-07-02" });
    expect(state.nextPlanAt).toBe(Date.UTC(2026, 8, 29, 0, 50));
  });
});

describe("commitSocialPage protocol", () => {
  /** Plans an initial run and runs its preflight; returns the run's tasks by operation. */
  async function initialRun(t: Backend) {
    await linked(t);
    await t.mutation(internal.sync.planner.tick, {});
    const tasks = await t.run((ctx) => ctx.db.query("syncTasks").collect());
    const byOp = (operation: string) =>
      tasks.filter((task) => task.operation === operation).sort((a, b) => a.seq - b.seq);
    await t.action(internal.sync.socialWorker.runTask, {
      taskId: byOp("getSocialAccount")[0]!._id,
    });
    return byOp;
  }

  async function claim(t: Backend, taskId: Id<"syncTasks">) {
    const result = await t.mutation(internal.sync.runs.claimTask, { taskId });
    if (result.status !== "fetch") throw new Error("expected a claim");
    return result;
  }

  async function task(t: Backend, taskId: Id<"syncTasks">) {
    return (await t.run((ctx) => ctx.db.get(taskId)))!;
  }

  const post = (n: number) => ({
    platform: "instagram" as const,
    accountExternalId: EXTERNAL,
    externalId: `179000000000${String(n).padStart(5, "0")}`,
    type: "image" as const,
    publishedAt: NOW - n * 86_400_000,
  });

  it("a listing cut at maxListingPages is truncated explicitly and never marks removals", async () => {
    const t = newBackend();
    const byOp = await initialRun(t);
    const listing = byOp("listSocialPosts")[0]!;
    await t.run((ctx) => ctx.db.patch(listing._id, { pages: 99 }));
    const c = await claim(t, listing._id);
    expect(
      await t.mutation(internal.sync.runs.commitSocialPage, {
        taskId: listing._id,
        claimSeq: c.claimSeq,
        page: { kind: "socialPost", items: [post(1)], nextCursor: "more" },
      }),
    ).toEqual({ ok: true });
    const after = await task(t, listing._id);
    expect(after).toMatchObject({
      status: "succeeded",
      phase: "fetch",
      lastError: { kind: "page_limit", code: "listing_truncated" },
    });
    expect(after.cursor).toBeUndefined();
  });

  it("a snapshot task stops at maxPostsPerSnapshotTask with an explicit truncation", async () => {
    const t = newBackend();
    const byOp = await initialRun(t);
    const snapshots = byOp("fetchPostMetrics")[0]!;
    await t.run((ctx) => ctx.db.patch(snapshots._id, { pages: 99 }));
    // The listing ran first in a real run; mark it done so the snapshot task is current.
    const listing = byOp("listSocialPosts")[0]!;
    await t.run((ctx) => ctx.db.patch(listing._id, { status: "succeeded" }));
    const c = await claim(t, snapshots._id);
    await t.mutation(internal.sync.runs.commitSocialPage, {
      taskId: snapshots._id,
      claimSeq: c.claimSeq,
      page: { kind: "socialPostSnapshot", items: [], nextCursor: "more" },
    });
    expect(await task(t, snapshots._id)).toMatchObject({
      status: "succeeded",
      lastError: { kind: "page_limit", code: "snapshot_truncated" },
    });
  });

  it("an account-metric window missing days is not covered (missing days count unresolved)", async () => {
    const t = newBackend();
    const byOp = await initialRun(t);
    for (const done of [...byOp("listSocialPosts"), ...byOp("fetchPostMetrics")]) {
      await t.run((ctx) => ctx.db.patch(done._id, { status: "succeeded" }));
    }
    const window = byOp("fetchAccountMetrics")[0]!; // 2026-09-01 .. 2026-09-28
    const c = await claim(t, window._id);
    await t.mutation(internal.sync.runs.commitSocialPage, {
      taskId: window._id,
      claimSeq: c.claimSeq,
      page: {
        kind: "socialAccountDay",
        items: [
          { platform: "instagram", accountExternalId: EXTERNAL, date: "2026-09-01", reach: 1 },
          { platform: "instagram", accountExternalId: EXTERNAL, date: "2026-09-02" },
        ],
      },
    });
    const done = await task(t, window._id);
    expect(done.status).toBe("succeeded");
    expect(done.counts.unresolved).toBe(26);
  });

  it("a replayed page is discarded (stale cursor) and writes nothing", async () => {
    const t = newBackend();
    const byOp = await initialRun(t);
    const listing = byOp("listSocialPosts")[0]!;
    const first = await claim(t, listing._id);
    await t.mutation(internal.sync.runs.commitSocialPage, {
      taskId: listing._id,
      claimSeq: first.claimSeq,
      page: { kind: "socialPost", items: [post(1)], nextCursor: "page-2" },
    });
    const second = await claim(t, listing._id);
    const replay = await t.mutation(internal.sync.runs.commitSocialPage, {
      taskId: listing._id,
      claimSeq: second.claimSeq,
      page: { kind: "socialPost", items: [post(2)], nextCursor: "page-2" },
    });
    expect(replay).toEqual({ ok: false, reason: "stale_cursor" });
    const posts = await t.run((ctx) => ctx.db.query("socialPosts").collect());
    expect(posts.map((p) => p.externalId)).toEqual([post(1).externalId]);
    // A stale claim is discarded too.
    expect(
      await t.mutation(internal.sync.runs.commitSocialPage, {
        taskId: listing._id,
        claimSeq: first.claimSeq,
        requestCursor: "page-2",
        page: { kind: "socialPost", items: [post(3)] },
      }),
    ).toEqual({ ok: false, reason: "stale_claim" });
  });

  it("guards: days outside the window, stale captures and foreign accounts fail the page", async () => {
    const t = newBackend();
    const byOp = await initialRun(t);
    for (const done of [...byOp("listSocialPosts")]) {
      await t.run((ctx) => ctx.db.patch(done._id, { status: "succeeded" }));
    }
    const snapshots = byOp("fetchPostMetrics")[0]!;
    const c = await claim(t, snapshots._id);
    const stale = NOW - 3 * 86_400_000;
    expect(
      await t.mutation(internal.sync.runs.commitSocialPage, {
        taskId: snapshots._id,
        claimSeq: c.claimSeq,
        page: {
          kind: "socialPostSnapshot",
          items: [
            {
              platform: "instagram",
              accountExternalId: EXTERNAL,
              postExternalId: post(1).externalId,
              capturedDate: "2026-09-25",
              capturedAt: stale,
            },
          ],
        },
      }),
    ).toEqual({ ok: false, reason: "out_of_scope" });
    expect((await task(t, snapshots._id)).status).toBe("failed");
    // Structure the validators refuse never reaches the handler (a URL field, provenance).
    const days = byOp("fetchAccountMetrics")[0]!;
    await expect(
      t.mutation(internal.sync.runs.commitSocialPage, {
        taskId: days._id,
        claimSeq: 1,
        page: {
          kind: "socialAccountDay",
          items: [
            {
              platform: "instagram",
              accountExternalId: EXTERNAL,
              date: "2026-09-01",
              followers: 5,
            } as never,
          ],
        },
      }),
    ).rejects.toThrow();
    await expect(
      t.mutation(internal.sync.runs.commitSocialPage, {
        taskId: days._id,
        claimSeq: 1,
        page: {
          kind: "socialPost",
          items: [{ ...post(1), mediaUrl: "https://scontent.example.test/x.jpg" } as never],
        },
      }),
    ).rejects.toThrow();
    expect(await t.run((ctx) => ctx.db.query("socialPostMetricSnapshots").collect())).toEqual([]);
  });
});
