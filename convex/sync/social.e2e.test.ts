import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  createFakeInstagram,
  FAKE_IG_TOKEN_MARKER,
  type FakeInstagram,
} from "../providers/instagram/fakeInstagram.fixtures";
import { mockInstagramAccountId } from "../providers/social/mock";
import { subjectOf } from "./subject";
import {
  as,
  connectInstagramFake,
  connectMock,
  connectMockInstagram,
  drainScheduler,
  ISSUER_CRM,
  linkMock,
  linkSocial,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  stubLiveInstagram,
  type Backend,
} from "../test.helpers";

// Phase 10 Stage A: organic social subjects run through the EXISTING Phase 5 engine
// (planner -> run -> task -> lease -> claim -> "use node" social worker -> failure policy)
// without being confused with ad accounts. Every social operation fails closed in Stage A,
// so a social run is the preflight alone and fails with *_mapping_pending, before any
// platform request. Ad syncs are unaffected.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-09-28T12:00:00Z");

let fake: FakeInstagram;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = createFakeInstagram();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function state(t: Backend) {
  return await t.run(async (ctx) => ({
    accounts: await ctx.db.query("syncAccounts").collect(),
    runs: await ctx.db.query("syncRuns").collect(),
    tasks: await ctx.db.query("syncTasks").collect(),
    connections: await ctx.db.query("connections").collect(),
    social: {
      posts: await ctx.db.query("socialPosts").collect(),
      snapshots: await ctx.db.query("socialPostMetricSnapshots").collect(),
      daily: await ctx.db.query("socialAccountMetricsDaily").collect(),
    },
  }));
}

async function linkedInstagram(t: Backend, who = {}) {
  await setupSyncOrg(t, who);
  const connectionId = (await connectInstagramFake(t, fake, "business", who)).get("connection")!;
  const [account] = await linkSocial(t, connectionId, [fake.users.business!.userId], who);
  return { connectionId, socialAccountId: account!.id as Id<"socialAccounts"> };
}

describe("social subject through the sync engine (live, fake API)", () => {
  it("plans a preflight-only run, executes it in the social worker, and fails closed", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    const { socialAccountId, connectionId } = await linkedInstagram(t);
    fake.reset();

    const tick = await planAndDrain(t);
    expect(tick.started).toBe(1);

    const db = await state(t);
    expect(db.runs).toHaveLength(1);
    const run = db.runs[0]!;
    expect(run).toMatchObject({
      socialAccountId,
      connectionId,
      platform: "instagram",
      providerId: "instagram-login/v25.0",
      kind: "initial",
      trigger: "link",
      status: "failed",
      structureMode: "none",
      taskCount: 1,
      error: { kind: "unknown", code: "instagram_mapping_pending" },
    });
    expect(run.adAccountId).toBeUndefined();
    expect(db.tasks.map((task) => [task.operation, task.status, task.socialAccountId])).toEqual([
      ["getSocialAccount", "failed", socialAccountId],
    ]);
    expect(db.tasks[0]!.adAccountId).toBeUndefined();

    // Account-level failure policy: backoff, no block, no reauth; nothing written.
    const syncAccount = db.accounts[0]!;
    expect(syncAccount).toMatchObject({
      state: "idle",
      consecutiveFailures: 1,
      lastRunId: run._id,
    });
    expect(syncAccount.activeRunId).toBeUndefined();
    expect(syncAccount.nextPlanAt).toBeGreaterThanOrEqual(NOW.getTime() + 15 * 60_000);
    expect(db.connections[0]!.status).toBe("active");
    expect(db.social).toEqual({ posts: [], snapshots: [], daily: [] });
    // Fail closed BEFORE the network: the sync made no platform request at all.
    expect(fake.requests).toEqual([]);
  });

  it("an auth failure moves the Instagram connection to needs_reauth", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    await linkedInstagram(t);
    // The configured app no longer matches the token's app: the provider reports "auth".
    vi.stubEnv("INSTAGRAM_APP_ID", "1790000000000999");
    await planAndDrain(t);
    const db = await state(t);
    expect(db.connections[0]!.status).toBe("needs_reauth");
    expect(db.runs[0]!.error).toMatchObject({ kind: "auth", code: "app_id_mismatch" });
    const audit = await t.run((ctx) => ctx.db.query("auditLog").collect());
    expect(audit.find((e) => e.action === "connection.needs_reauth")?.changes).toMatchObject({
      reason: { to: "provider_auth_error" },
    });
    expect(JSON.stringify(db)).not.toContain(FAKE_IG_TOKEN_MARKER);
  });

  it("disconnecting cancels an active social run and parks the account", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    const { connectionId } = await linkedInstagram(t);
    await t.mutation(internal.sync.planner.tick, {}); // run created, worker not yet executed
    await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    await drainScheduler(t);
    const db = await state(t);
    expect(db.runs[0]!.status).toBe("cancelled");
    expect(["account_unlinked", "connection_inactive"]).toContain(db.runs[0]!.cancelReason);
    expect(fake.requests.filter((r) => r.path.startsWith("/v25.0/1784"))).toEqual([]);
  });
});

describe("ad and social subjects never mix (mock mode)", () => {
  async function both(t: Backend) {
    await setupSyncOrg(t);
    const metaConnection = await connectMock(t, "meta");
    const [adAccount] = await linkMock(t, metaConnection, ["1001"]);
    const igConnection = (await connectMockInstagram(t, "1")).get("connection")!;
    const [socialAccount] = await linkSocial(t, igConnection, [mockInstagramAccountId("1")]);
    return {
      adAccountId: adAccount!.id as Id<"adAccounts">,
      socialAccountId: socialAccount!.id as Id<"socialAccounts">,
    };
  }

  it("syncs the ad account as before while the social run fails closed", async () => {
    const t = newBackend();
    const { adAccountId, socialAccountId } = await both(t);
    const tick = await planAndDrain(t);
    expect(tick.started).toBe(2);
    const db = await state(t);
    const adRun = db.runs.find((r) => r.adAccountId === adAccountId)!;
    const socialRun = db.runs.find((r) => r.socialAccountId === socialAccountId)!;
    expect(adRun.status).toBe("succeeded");
    expect(adRun.socialAccountId).toBeUndefined();
    expect(adRun.counts.metricRows).toBeGreaterThan(0);
    expect(socialRun).toMatchObject({
      status: "failed",
      platform: "instagram",
      providerId: "mock-social",
      error: { kind: "unknown", code: "social_mapping_pending" },
    });
    // The subject invariant on every sync row: exactly one subject, and the right one.
    const rows = [...db.accounts, ...db.runs, ...db.tasks];
    expect(rows).toHaveLength(2 + 2 + adRun.taskCount + socialRun.taskCount);
    for (const row of rows) {
      expect([row.adAccountId, row.socialAccountId].filter((id) => id !== undefined)).toHaveLength(
        1,
      );
      expect(subjectOf(row)).toEqual(
        row.adAccountId === adAccountId
          ? { kind: "ad", adAccountId }
          : { kind: "social", socialAccountId },
      );
    }
    // Organic data never enters ad metrics (and Stage A writes none).
    const metrics = await t.run((ctx) => ctx.db.query("metricsDaily").collect());
    expect(metrics.every((m) => m.adAccountId === adAccountId)).toBe(true);
    expect(db.social).toEqual({ posts: [], snapshots: [], daily: [] });
  });

  it("the ads worker refuses a social task and the social worker refuses an ad task", async () => {
    const t = newBackend();
    const { adAccountId, socialAccountId } = await both(t);
    await t.mutation(internal.sync.planner.tick, {});
    const tasks = await t.run((ctx) => ctx.db.query("syncTasks").collect());
    const socialTask = tasks.find((task) => task.socialAccountId === socialAccountId)!;
    const adTask = tasks.find((task) => task.adAccountId === adAccountId)!;

    await t.action(internal.sync.worker.runTask, { taskId: socialTask._id });
    await t.action(internal.sync.socialWorker.runTask, { taskId: adTask._id });

    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    for (const run of runs) {
      expect(run.status).toBe("failed");
      expect(run.error?.kind).toBe("internal");
    }
  });

  it("a social task can never commit an ad page", async () => {
    const t = newBackend();
    const { socialAccountId } = await both(t);
    await t.mutation(internal.sync.planner.tick, {});
    const task = (await t.run((ctx) => ctx.db.query("syncTasks").collect())).find(
      (row) => row.socialAccountId === socialAccountId,
    )!;
    const claim = await t.mutation(internal.sync.runs.claimTask, { taskId: task._id });
    if (claim.status !== "fetch") throw new Error("expected a claim");
    expect(claim.subject).toBe("social");
    const result = await t.mutation(internal.sync.runs.commitPage, {
      taskId: task._id,
      claimSeq: claim.claimSeq,
      page: {
        kind: "adAccount",
        items: [
          {
            platform: "meta",
            externalId: "1001",
            name: "x",
            currency: "USD",
            timezone: "UTC",
            status: "active",
            isManager: false,
          },
        ],
      },
    });
    expect(result).toEqual({ ok: false, reason: "invalid_record" });
    const adAccounts = await t.run((ctx) => ctx.db.query("adAccounts").collect());
    expect(adAccounts).toHaveLength(1); // nothing written through the social task
  });

  it("rows naming neither or both subjects fail closed", async () => {
    const t = newBackend();
    const { adAccountId, socialAccountId } = await both(t);
    await t.mutation(internal.sync.planner.tick, {});
    const task = (await t.run((ctx) => ctx.db.query("syncTasks").collect())).find(
      (row) => row.socialAccountId === socialAccountId,
    )!;
    await t.run((ctx) => ctx.db.patch(task._id, { adAccountId }));
    await expect(t.mutation(internal.sync.runs.claimTask, { taskId: task._id })).rejects.toThrow(
      /exactly one subject/,
    );

    // A malformed state row read through the global planner index is parked, never planned.
    const orgId = task.orgId;
    const rowId = await t.run((ctx) =>
      ctx.db.insert("syncAccounts", {
        orgId,
        state: "idle",
        nextPlanAt: 0,
        structureStale: false,
        backfillHorizon: "2026-07-01",
        consecutiveFailures: 0,
        createdAt: 0,
        updatedAt: 0,
      }),
    );
    await t.mutation(internal.sync.planner.tick, {});
    const parked = await t.run((ctx) => ctx.db.get(rowId));
    expect((parked as Doc<"syncAccounts">).state).toBe("parked");
  });

  it("the planner re-verifies social rows from the global index (tenant isolation)", async () => {
    const t = newBackend();
    const { socialAccountId } = await both(t);
    await setupSyncOrg(t, { issuer: ISSUER_CRM });
    const foreignOrg = await t.run(
      async (ctx) => (await ctx.db.query("organizations").collect())[1]!._id,
    );
    const row = await t.run(async (ctx) =>
      (await ctx.db.query("syncAccounts").collect()).find(
        (r) => r.socialAccountId === socialAccountId,
      )!,
    );
    await t.run((ctx) => ctx.db.patch(row._id, { orgId: foreignOrg }));
    await planAndDrain(t);
    const after = await t.run((ctx) => ctx.db.get(row._id));
    expect(after!.state).toBe("parked");
    const socialRuns = (await t.run((ctx) => ctx.db.query("syncRuns").collect())).filter(
      (run) => run.socialAccountId !== undefined,
    );
    expect(socialRuns).toEqual([]);
  });
});
