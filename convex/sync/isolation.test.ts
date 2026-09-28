/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  adSubjectOf,
  connectMock,
  drainScheduler,
  ISSUER_CRM,
  linkMock,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";

// Tenant isolation of the sync engine: the org always comes from stored rows,
// rows read through the global planner index are re-verified, and no
// credential material reaches sync tables or scheduled-function arguments.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-04-10T15:00:00Z");
const ERP = {};
const CRM = { issuer: ISSUER_CRM };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

async function all(t: Backend) {
  return await t.run(async (ctx) => ({
    orgs: await ctx.db.query("organizations").collect(),
    accounts: await ctx.db.query("adAccounts").collect(),
    states: await ctx.db.query("syncAccounts").collect(),
    runs: await ctx.db.query("syncRuns").collect(),
    tasks: await ctx.db.query("syncTasks").collect(),
    campaigns: await ctx.db.query("campaigns").collect(),
    adGroups: await ctx.db.query("adGroups").collect(),
    ads: await ctx.db.query("ads").collect(),
    creatives: await ctx.db.query("creatives").collect(),
    metrics: await ctx.db.query("metricsDaily").collect(),
    actions: await ctx.db.query("actionMetricsDaily").collect(),
  }));
}

describe("tenant isolation", () => {
  it("two orgs syncing the same external account get fully separate rows", async () => {
    const t = newBackend();
    for (const who of [ERP, CRM]) {
      await setupSyncOrg(t, who);
      const connectionId = await connectMock(t, "google_ads", "1", who);
      await linkMock(t, connectionId, ["4445556666"], who);
    }
    await planAndDrain(t);
    const db = await all(t);
    expect(db.orgs).toHaveLength(2);
    expect(db.runs.map((r) => r.status)).toEqual(["succeeded", "succeeded"]);

    const accountOrg = new Map(db.accounts.map((a) => [a._id, a.orgId]));
    for (const table of [
      "campaigns",
      "adGroups",
      "ads",
      "creatives",
      "metrics",
      "actions",
    ] as const) {
      const rows = db[table] as { orgId: Id<"organizations">; adAccountId: Id<"adAccounts"> }[];
      for (const row of rows) expect(row.orgId, table).toBe(accountOrg.get(row.adAccountId));
      const perOrg = db.orgs.map((o) => rows.filter((r) => r.orgId === o._id).length);
      expect(perOrg[0], table).toBe(perOrg[1]);
      expect(perOrg[0], table).toBeGreaterThan(0);
    }
    for (const run of db.runs) {
      expect(run.orgId).toBe(accountOrg.get(adSubjectOf(run)));
    }
    for (const task of db.tasks) expect(task.orgId).toBe(accountOrg.get(adSubjectOf(task)));
  });

  it("the planner re-verifies rows from the global index and never crosses orgs", async () => {
    const t = newBackend();
    await setupSyncOrg(t, ERP);
    const erpConnection = await connectMock(t, "google_ads", "1", ERP);
    await linkMock(t, erpConnection, ["4445556666"], ERP);
    await setupSyncOrg(t, CRM);
    const crmConnection = await connectMock(t, "google_ads", "1", CRM);
    const [crmAccount] = await linkMock(t, crmConnection, ["4445556666"], CRM);

    // Corrupt the ERP state row so it points at the CRM org's account.
    await t.run(async (ctx) => {
      const erpOrg = (await ctx.db.query("organizations").first())!;
      const row = (await ctx.db
        .query("syncAccounts")
        .filter((q) => q.eq(q.field("orgId"), erpOrg._id))
        .first())!;
      await ctx.db.patch(row._id, { adAccountId: crmAccount!.id as Id<"adAccounts"> });
    });
    await t.mutation(internal.sync.planner.tick, {});
    const db = await all(t);
    const erpRow = db.states.find((s) => s.orgId === db.orgs[0]!._id)!;
    expect(erpRow).toMatchObject({ state: "parked" });
    expect(erpRow.nextPlanAt).toBeUndefined();
    // Only the legitimate CRM run exists, owned by the CRM org.
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]!.orgId).toBe(db.orgs[1]!._id);
  });

  it("rejects task/run rows whose org does not match", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "google_ads");
    await linkMock(t, connectionId, ["4445556666"]);
    await t.mutation(internal.sync.planner.tick, {});
    const task = await t.run(async (ctx) => (await ctx.db.query("syncTasks").first())!);
    const foreign = await t.run(async (ctx) => {
      const app = (await ctx.db.query("integrationApps").first())!;
      return await ctx.db.insert("organizations", {
        issuer: ISSUER_CRM,
        externalOrgId: "x",
        appId: app._id,
        displayName: "x",
        reportingCurrency: "USD",
        timezone: "UTC",
        createdAt: 0,
        updatedAt: 0,
      });
    });
    await t.run((ctx) => ctx.db.patch(task._id, { orgId: foreign }));
    await expect(t.mutation(internal.sync.runs.claimTask, { taskId: task._id })).rejects.toThrow(
      /different organizations/,
    );
  });

  it("keeps credential material out of sync tables and scheduled-function arguments", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const connectionId = await connectMock(t, "google_ads");
    await linkMock(t, connectionId, ["4445556666"]);
    await t.mutation(internal.sync.planner.tick, {});
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    for (const fn of scheduled) {
      for (const arg of fn.args as Record<string, unknown>[]) {
        // Only ids (and a claim sequence number) are ever scheduled.
        for (const key of Object.keys(arg)) {
          expect(["taskId", "claimSeq", "continuation", "started"]).toContain(key);
        }
      }
    }
    await drainScheduler(t);
    const db = await all(t);
    const serialized = JSON.stringify(
      [
        db.runs,
        db.tasks,
        db.states,
        await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect()),
      ],
      (_k, v) => (typeof v === "bigint" ? v.toString() : v),
    );
    expect(serialized).not.toMatch(/mock-token/);
    expect(serialized).not.toMatch(/ciphertext/);
  });
});

describe("public surface", () => {
  it("exposes no public sync function (internal/admin only)", () => {
    const modules = import.meta.glob(["/convex/sync/*.ts", "!/convex/sync/*.*.ts"], {
      eager: true,
    }) as Record<string, Record<string, unknown>>;
    const exported = Object.entries(modules).flatMap(([path, mod]) =>
      Object.entries(mod)
        .filter(
          ([, fn]) =>
            typeof fn === "function" && ("isQuery" in fn || "isMutation" in fn || "isAction" in fn),
        )
        .map(([name, fn]) => ({ name: `${path}:${name}`, fn: fn as { isPublic?: boolean } })),
    );
    expect(exported.length).toBeGreaterThan(0);
    expect(exported.filter((e) => e.fn.isPublic).map((e) => e.name)).toEqual([]);
  });
});
