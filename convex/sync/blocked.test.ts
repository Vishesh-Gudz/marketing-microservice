import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  connectMock,
  drainScheduler,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";
import { SYNC_LIMITS } from "./config";

// Regression: a blocking reason (permission / not_found / account_changed) must
// survive inactive-connection rechecks, cancellations and non-blocking failures,
// and is cleared only by a successful run (audited sync.account_unblocked) or
// replaced by a newer blocking reason.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-04-10T15:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

const state = (t: Backend) => t.run(async (ctx) => (await ctx.db.query("syncAccounts").first())!);
const runs = (t: Backend) => t.run((ctx) => ctx.db.query("syncRuns").order("asc").collect());
const auditActions = async (t: Backend) =>
  (await t.run((ctx) => ctx.db.query("auditLog").collect())).map((a) => a.action);
const count = (actions: string[], action: string) => actions.filter((a) => a === action).length;

/** Meta account 1002 blocked by `permission` (the mock denies it in permission_denied). */
async function blockedAccount(t: Backend) {
  await setupSyncOrg(t);
  const connectionId = await connectMock(t, "meta", "1");
  const [account] = await linkMock(t, connectionId, ["1002"]);
  await connectMock(t, "meta", "1--permission_denied"); // same identity, new credential
  await planAndDrain(t);

  const blocked = await state(t);
  expect(blocked).toMatchObject({ state: "blocked", lastError: { kind: "permission" } });
  expect(blocked.nextPlanAt).toBe(NOW.getTime() + SYNC_LIMITS.blockedRecheckMs);
  expect(count(await auditActions(t), "sync.account_blocked")).toBe(1);
  return {
    connectionId: connectionId as Id<"connections">,
    adAccountId: account!.id as Id<"adAccounts">,
    blockingError: blocked.lastError!,
  };
}

const markNeedsReauth = (t: Backend, connectionId: Id<"connections">) =>
  t.mutation(internal.connections.lifecycle.markNeedsReauth, {
    connectionId,
    reason: "test",
    actorSubject: "test",
  });

/** Reconnect the same identity with a healthy credential, then let the planner run. */
async function recover(t: Backend) {
  await connectMock(t, "meta", "1");
  vi.advanceTimersByTime(HOUR + MIN);
  await planAndDrain(t);
}

async function expectUnblocked(t: Backend) {
  const last = (await runs(t)).at(-1)!;
  expect(last.status).toBe("succeeded");
  const row = await state(t);
  expect(row.state).toBe("idle");
  expect(row.lastError).toBeUndefined();
  const actions = await auditActions(t);
  expect(count(actions, "sync.account_unblocked")).toBe(1);
  expect(count(actions, "sync.account_blocked")).toBe(1);
  const unblocked = (await t.run((ctx) => ctx.db.query("auditLog").collect())).find(
    (a) => a.action === "sync.account_unblocked",
  )!;
  expect(unblocked.changes).toEqual({ reason: { from: "permission", to: null } });
  expect(unblocked.subject).toBe("system:sync");
}

describe("blocked accounts keep their blocking reason", () => {
  it("through inactive-connection rechecks, until a successful run unblocks them", async () => {
    const t = newBackend();
    const { connectionId, blockingError } = await blockedAccount(t);
    await markNeedsReauth(t, connectionId);

    // Daily recheck of the blocked account finds the connection inactive.
    vi.advanceTimersByTime(SYNC_LIMITS.blockedRecheckMs + MIN);
    await planAndDrain(t);
    let row = await state(t);
    expect(row.state).toBe("blocked");
    expect(row.lastError).toEqual(blockingError); // same kind, message AND original timestamp
    expect(row.nextPlanAt).toBe(Date.now() + SYNC_LIMITS.inactiveRecheckMs);
    expect(await runs(t)).toHaveLength(1);

    // Repeated hourly rechecks change nothing either.
    vi.advanceTimersByTime(HOUR + MIN);
    await planAndDrain(t);
    row = await state(t);
    expect(row).toMatchObject({ state: "blocked", lastError: blockingError });
    expect(await runs(t)).toHaveLength(1);

    // Legitimate recovery: healthy credential -> successful run -> unblocked (audited once).
    await recover(t);
    await expectUnblocked(t);
  });

  it("when a recheck run is cancelled because the connection became inactive", async () => {
    const t = newBackend();
    const { connectionId, blockingError } = await blockedAccount(t);
    await connectMock(t, "meta", "1"); // healthy credential again
    vi.advanceTimersByTime(SYNC_LIMITS.blockedRecheckMs + MIN);
    await t.mutation(internal.sync.planner.tick, {}); // recheck run created
    await markNeedsReauth(t, connectionId); // ...and the connection goes inactive mid-run
    await drainScheduler(t);

    const cancelled = (await runs(t)).at(-1)!;
    expect(cancelled).toMatchObject({ status: "cancelled", cancelReason: "connection_inactive" });
    expect(await state(t)).toMatchObject({ state: "blocked", lastError: blockingError });

    await recover(t);
    await expectUnblocked(t);
  });

  it("when a recheck run fails with a non-blocking error (auth), which is still recorded", async () => {
    const t = newBackend();
    const { connectionId, blockingError } = await blockedAccount(t);
    await connectMock(t, "meta", "1--auth_revoked");
    vi.advanceTimersByTime(SYNC_LIMITS.blockedRecheckMs + MIN);
    await planAndDrain(t);

    const failed = (await runs(t)).at(-1)!;
    expect(failed).toMatchObject({ status: "failed", error: { kind: "auth" } });
    const connection = await t.run((ctx) => ctx.db.get(connectionId));
    expect(connection).toMatchObject({ status: "needs_reauth" });
    expect(await auditActions(t)).toContain("connection.needs_reauth");
    expect(await state(t)).toMatchObject({ state: "blocked", lastError: blockingError });

    await recover(t);
    await expectUnblocked(t);
  });

  it("but a newer blocking reason replaces the older one (and is audited)", async () => {
    const t = newBackend();
    const { adAccountId } = await blockedAccount(t);
    await connectMock(t, "meta", "1");
    // The stored timezone no longer matches the platform: account drift (blocking).
    await t.run((ctx) => ctx.db.patch(adAccountId, { timezone: "Europe/Berlin" }));
    vi.advanceTimersByTime(SYNC_LIMITS.blockedRecheckMs + MIN);
    await planAndDrain(t);

    expect(await state(t)).toMatchObject({
      state: "blocked",
      lastError: { kind: "account_changed" },
    });
    const actions = await auditActions(t);
    expect(count(actions, "sync.account_blocked")).toBe(2);
    expect(actions).toContain("sync.account_attributes_changed");
    expect(count(actions, "sync.account_unblocked")).toBe(0);
  });
});

describe("accounts that are not blocked", () => {
  it("still record connection_inactive on recheck, keeping the first observation's timestamp", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "meta", "1");
    await linkMock(t, connectionId, ["1002"]);
    await markNeedsReauth(t, connectionId as Id<"connections">);
    await planAndDrain(t);
    const first = await state(t);
    expect(first).toMatchObject({ state: "idle", lastError: { kind: "connection_inactive" } });
    expect(first.lastError!.at).toBe(NOW.getTime());

    vi.advanceTimersByTime(HOUR + MIN);
    await planAndDrain(t);
    expect((await state(t)).lastError).toEqual(first.lastError);
    expect(await runs(t)).toHaveLength(0);
  });
});
