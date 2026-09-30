import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { RATE_LIMIT_RETRY_AFTER_MS } from "../providers/mock";
import {
  as,
  connectMock,
  drainScheduler,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";

// Every deterministic mock failure scenario, end to end. The scenario travels
// on the mock credential (user "<id>--<scenario>"), i.e. through the real
// connect flow and encrypted credential store.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-04-10T15:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function snapshot(t: Backend) {
  return await t.run(async (ctx) => ({
    runs: await ctx.db.query("syncRuns").collect(),
    tasks: await ctx.db.query("syncTasks").collect(),
    states: await ctx.db.query("syncAccounts").collect(),
    connections: await ctx.db.query("connections").collect(),
    campaigns: await ctx.db.query("campaigns").collect(),
    metrics: await ctx.db.query("metricsDaily").collect(),
    audit: await ctx.db.query("auditLog").collect(),
  }));
}

/**
 * Connects the default mock user, links accounts, then RECONNECTS the same
 * identity with the scenario credential (discovery at connect time would
 * otherwise see the scenario too), and runs the planner.
 */
async function syncWith(
  t: Backend,
  platform: "meta" | "google_ads",
  user: string,
  externalIds: string[],
) {
  await setupSyncOrg(t);
  const connectionId = await connectMock(t, platform, "1");
  const accounts = await linkMock(t, connectionId, externalIds);
  if (user !== "1") expect(await connectMock(t, platform, user)).toBe(connectionId);
  await planAndDrain(t);
  return { connectionId, accountIds: accounts.map((a) => a.id as Id<"adAccounts">) };
}

describe("retryable scenarios", () => {
  it("transient: first pages fail once, are retried with backoff and the sync completes", async () => {
    const t = newBackend();
    await syncWith(t, "google_ads", "1--transient", ["4445556666"]);
    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("succeeded");
    // Every task's first page failed once (attempt 1) and succeeded on attempt 2.
    for (const task of db.tasks) {
      expect(task.totalAttempts, task.operation).toBeGreaterThanOrEqual(2);
      expect(task.lastError, task.operation).toBeUndefined();
    }
    const clean = newBackend();
    await syncWith(clean, "google_ads", "1", ["4445556666"]);
    const reference = await snapshot(clean);
    expect(db.metrics.length).toBe(reference.metrics.length);
    expect(db.runs[0]!.counts.metricRows).toBe(reference.runs[0]!.counts.metricRows);
  });

  it("rate_limited: later pages are throttled, retried after retryAfter, and complete", async () => {
    const t = newBackend();
    await syncWith(t, "google_ads", "1--rate_limited", ["1112223333"]);
    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("succeeded");
    // Every page after the first was throttled once and retried. Since Phase 8 (D34a) the
    // rate-limit budget is per page: it resets at each commit, so it ends at 0.
    const throttled = db.tasks.filter((task) => task.pages > 1);
    expect(throttled.length).toBeGreaterThan(0);
    for (const task of db.tasks) {
      expect(task.rateLimitHits, task.operation).toBe(0);
      expect(task.totalAttempts, task.operation).toBe(2 * task.pages - 1);
    }
    expect(db.states[0]!.throttledUntil).toBeGreaterThanOrEqual(
      NOW.getTime() + RATE_LIMIT_RETRY_AFTER_MS,
    );
  });
});

describe("permanent scenarios", () => {
  it("auth_revoked: connection -> needs_reauth, no retry, no canonical writes", async () => {
    const t = newBackend();
    await syncWith(t, "meta", "1--auth_revoked", ["1001", "1002"]);
    const db = await snapshot(t);
    expect(db.connections[0]!.status).toBe("needs_reauth");
    expect(db.runs).toHaveLength(2);
    // One run hit the auth error; the sibling run of the same connection was cancelled or failed too.
    expect(db.runs.map((r) => r.status).sort()).toEqual(expect.arrayContaining(["failed"]));
    for (const run of db.runs) expect(["failed", "cancelled"]).toContain(run.status);
    expect(db.runs.some((r) => r.error?.kind === "auth")).toBe(true);
    for (const task of db.tasks) expect(task.totalAttempts).toBeLessThanOrEqual(1);
    expect(db.campaigns).toHaveLength(0);
    const reauth = db.audit.filter((a) => a.action === "connection.needs_reauth");
    expect(reauth).toHaveLength(1);
    expect(reauth[0]!.subject).toBe("system:sync");
    // Rechecked hourly, not hammered.
    for (const state of db.states) {
      expect(state.nextPlanAt).toBeGreaterThanOrEqual(NOW.getTime() + 60 * 60_000);
    }

    // Planner does not start new runs while the connection needs re-authorization.
    vi.advanceTimersByTime(2 * 60 * 60_000);
    await planAndDrain(t);
    expect((await snapshot(t)).runs).toHaveLength(2);
  });

  it("permission_denied: only the affected account is blocked", async () => {
    const t = newBackend();
    const { accountIds } = await syncWith(t, "meta", "1--permission_denied", ["1001", "1002"]);
    const db = await snapshot(t);
    const byAccount = new Map(db.runs.map((r) => [r.adAccountId, r]));
    expect(byAccount.get(accountIds[0]!)!.status).toBe("succeeded");
    expect(byAccount.get(accountIds[1]!)!.status).toBe("failed");
    const blocked = db.states.find((s) => s.adAccountId === accountIds[1])!;
    expect(blocked).toMatchObject({ state: "blocked", lastError: { kind: "permission" } });
    expect(blocked.nextPlanAt).toBe(NOW.getTime() + 24 * 60 * 60_000);
    expect(db.states.find((s) => s.adAccountId === accountIds[0])!.state).toBe("idle");
    expect(db.connections[0]!.status).toBe("active");
    expect(db.audit.filter((a) => a.action === "sync.account_blocked")).toHaveLength(1);
  });

  it("not_found: an account that disappeared is blocked", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "meta");
    const [account] = await linkMock(t, connectionId, ["1001"]);
    // Test-only: point the account at an id the platform does not know.
    await t.run((ctx) => ctx.db.patch(account!.id as Id<"adAccounts">, { externalId: "4242" }));
    await planAndDrain(t);
    const db = await snapshot(t);
    expect(db.runs[0]).toMatchObject({ status: "failed", error: { kind: "not_found" } });
    expect(db.states[0]).toMatchObject({ state: "blocked" });
  });

  it("malformed: the bad page fails without retry; earlier rows stay intact", async () => {
    const t = newBackend();
    const { accountIds } = await syncWith(t, "meta", "1", ["1001"]);
    const before = await snapshot(t);
    expect(before.campaigns.length).toBeGreaterThan(0);

    await connectMock(t, "meta", "1--malformed"); // reconnect: same identity, new credential
    vi.advanceTimersByTime(20 * 60_000);
    await t.mutation(internal.sync.admin.requestSync, {
      adAccountId: accountIds[0]!,
      kind: "lookback",
    });
    await drainScheduler(t);

    const db = await snapshot(t);
    const run = db.runs.find((r) => r.kind === "lookback")!;
    expect(run.status).toBe("partial");
    const failed = db.tasks.filter((task) => task.runId === run._id && task.status === "failed");
    expect(failed.map((task) => task.operation)).toEqual(["listCampaigns"]);
    expect(failed[0]!.totalAttempts).toBe(1);
    expect(failed[0]!.lastError).toMatchObject({ kind: "data" });
    // No removal marking after a failed listing; nothing was deleted.
    expect(db.campaigns.every((c) => c.removedAt === undefined)).toBe(true);
    expect(db.campaigns).toHaveLength(before.campaigns.length);
    expect(db.metrics.length).toBe(before.metrics.length);
  });

  it("empty: a sync of an empty listing completes without rows", async () => {
    const t = newBackend();
    await syncWith(t, "meta", "1--empty", ["1001"]);
    const db = await snapshot(t);
    expect(db.runs[0]!.status).toBe("succeeded");
    expect(db.campaigns).toHaveLength(0);
    expect(db.metrics).toHaveLength(0);
  });

  it("slow_pages: page size 1 checkpoints every record and yields the same rows", async () => {
    const t = newBackend();
    await syncWith(t, "google_ads", "1--slow_pages", ["4445556666"]);
    const db = await snapshot(t);
    const reference = newBackend();
    await syncWith(reference, "google_ads", "1", ["4445556666"]);
    const ref = await snapshot(reference);
    expect(db.runs[0]!.status).toBe("succeeded");
    expect(db.runs[0]!.counts.pages).toBeGreaterThan(ref.runs[0]!.counts.pages * 3);
    expect(db.metrics.length).toBe(ref.metrics.length);
    expect(db.campaigns.length).toBe(ref.campaigns.length);
  });
});

describe("account drift", () => {
  it("blocks the account instead of silently changing currency/timezone semantics", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "meta");
    const [account] = await linkMock(t, connectionId, ["1001"]);
    await t.run((ctx) =>
      ctx.db.patch(account!.id as Id<"adAccounts">, { timezone: "Europe/Berlin" }),
    );
    await planAndDrain(t);
    const db = await snapshot(t);
    expect(db.runs[0]).toMatchObject({ status: "failed", error: { kind: "account_changed" } });
    expect(db.states[0]).toMatchObject({ state: "blocked" });
    expect(db.campaigns).toHaveLength(0);
    expect(db.audit.map((a) => a.action)).toEqual(
      expect.arrayContaining(["sync.account_attributes_changed", "sync.account_blocked"]),
    );
    const stored = await as(t).query(api.v1.adAccounts.list, {});
    expect(stored[0]!.timezone).toBe("Europe/Berlin");
  });
});
