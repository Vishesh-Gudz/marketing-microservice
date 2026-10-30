import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { drainScheduler, newBackend, seedOrg, type Backend } from "../test.helpers";
import { CREDENTIAL_SWEEP_LEASE_MS } from "./config";

// IM7.0: the revoked-credential backstop of the hourly connection sweep visits EVERY revoked
// connection (more than one page), resuming from its persisted cursor across hourly runs, one
// run at a time, and deletes a credential only while its connection is revoked.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-10-30T12:00:00Z").getTime();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * `revoked` revoked connections with a credential, ordered by tokenExpiresAt = 1..n (the sweep's
 * index order), plus active connections with a credential and revoked ones without.
 */
async function seed(t: Backend, revoked: number, options = { active: 5, bare: 3 }) {
  const orgId = await seedOrg(t);
  return await t.run(async (ctx) => {
    const ids: Id<"connections">[] = [];
    const add = async (n: number, status: "active" | "revoked", credential: boolean) => {
      const connectionId = await ctx.db.insert("connections", {
        orgId,
        provider: "meta",
        externalUserId: `ext-${status}-${credential}-${n}`,
        status,
        grantedScopes: [],
        credentialVersion: 1,
        tokenExpiresAt: n,
        connectedBySubject: "user",
        connectedAt: NOW,
        ...(status === "revoked" ? { revokedAt: NOW } : {}),
        createdAt: NOW,
        updatedAt: NOW,
      });
      if (credential) await addCredential(ctx, orgId, connectionId);
      return connectionId;
    };
    for (let n = 1; n <= revoked; n++) ids.push(await add(n, "revoked", true));
    for (let n = 1; n <= options.active; n++) await add(n, "active", true);
    for (let n = 1; n <= options.bare; n++) await add(10_000 + n, "revoked", false);
    return { orgId, ids };
  });
}

type RunCtx = Parameters<Parameters<Backend["run"]>[0]>[0];
async function addCredential(
  ctx: RunCtx,
  orgId: Id<"organizations">,
  connectionId: Id<"connections">,
) {
  await ctx.db.insert("credentials", {
    orgId,
    connectionId,
    ciphertext: new Uint8Array([1, 2, 3]).buffer,
    iv: new Uint8Array(12).buffer,
    keyVersion: 1,
    algorithm: "AES-256-GCM",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function credentialsOf(t: Backend) {
  const result = await t.run(async (ctx) => {
    const rows = await ctx.db.query("credentials").collect();
    const statuses = await Promise.all(rows.map(async (r) => (await ctx.db.get(r.connectionId))!));
    return {
      total: rows.length,
      revoked: statuses.filter((c) => c.status === "revoked").length,
      ids: rows.map((r) => r.connectionId),
    };
  });
  return { ...result, ids: new Set(result.ids) };
}

async function cursorRow(t: Backend) {
  return await t.run(async (ctx) => (await ctx.db.query("maintenanceCursors").collect())[0]!);
}

async function deletionAudits(t: Backend) {
  return await t.run(
    async (ctx) =>
      (await ctx.db.query("auditLog").collect()).filter((e) => e.action === "credential.deleted")
        .length,
  );
}

const sweep = (t: Backend, credentialPageLimit?: number) =>
  t.mutation(
    internal.connections.maintenance.sweep,
    credentialPageLimit !== undefined ? { credentialPageLimit } : {},
  );
const step = internal.connections.credentialSweep.sweepRevokedCredentials;

describe("revoked-credential backstop", () => {
  it("visits every revoked connection, resuming page by page across hourly runs", async () => {
    const t = newBackend();
    await seed(t, 450);

    expect(await sweep(t, 1)).toMatchObject({
      credentialsDeleted: 200,
      credentialSweep: "started",
    });
    await drainScheduler(t); // nothing: the run paused after its one page
    expect(await cursorRow(t)).toMatchObject({ pagesInPass: 1 });
    expect((await cursorRow(t)).chainId).toBeUndefined();
    expect((await cursorRow(t)).cursor).not.toBeNull();

    expect(await sweep(t, 1)).toMatchObject({ credentialsDeleted: 200 }); // resumed, not restarted
    expect(await sweep(t, 1)).toMatchObject({ credentialsDeleted: 50 });
    const row = await cursorRow(t);
    expect(row).toMatchObject({ cursor: null, pagesInPass: 0, lastPassCompletedAt: NOW });
    expect(row.chainId).toBeUndefined();
    expect(await credentialsOf(t)).toMatchObject({ total: 5, revoked: 0 }); // active ones kept
    expect(await deletionAudits(t)).toBe(450);

    // A later pass finds nothing left and changes nothing.
    expect(await sweep(t, 1)).toMatchObject({ credentialsDeleted: 0 });
  });

  it("finishes the pass through scheduled steps and releases the lease", async () => {
    const t = newBackend();
    await seed(t, 450);
    expect(await sweep(t)).toMatchObject({ credentialsDeleted: 200 });
    expect((await cursorRow(t)).chainId).toBeDefined(); // the run holds the lease
    await drainScheduler(t);
    expect(await credentialsOf(t)).toMatchObject({ revoked: 0 });
    const row = await cursorRow(t);
    expect(row.cursor).toBeNull();
    expect(row.chainId).toBeUndefined();
    expect(row.leaseUntil).toBeUndefined();
  });

  it("runs one chain at a time; a stale step changes nothing; an expired run is resumed", async () => {
    const t = newBackend();
    await seed(t, 450);
    await sweep(t); // chain 1: page 1, page 2 scheduled (not run)
    const first = await cursorRow(t);
    expect(await sweep(t)).toMatchObject({ credentialSweep: "busy", credentialsDeleted: 0 });

    // A step of another chain, then of chain 1 after its lease expired: both stale.
    expect(await t.mutation(step, { chainId: "other", pagesThisRun: 1, pageLimit: 5000 })).toEqual({
      status: "stale",
      deleted: 0,
    });
    vi.setSystemTime(NOW + CREDENTIAL_SWEEP_LEASE_MS + 1);
    expect(
      await t.mutation(step, { chainId: first.chainId!, pagesThisRun: 1, pageLimit: 5000 }),
    ).toEqual({ status: "stale", deleted: 0 });
    expect((await cursorRow(t)).cursor).toBe(first.cursor);

    // The next hourly run resumes from the stored cursor; chain 1's step stays stale.
    expect(await sweep(t)).toMatchObject({ credentialSweep: "started", credentialsDeleted: 200 });
    await drainScheduler(t);
    expect(await credentialsOf(t)).toMatchObject({ revoked: 0 });
    expect(await deletionAudits(t)).toBe(450);
  });

  it("keeps a reconnected credential, deletes a re-revoked one, and catches up behind the cursor", async () => {
    const t = newBackend();
    const { orgId, ids } = await seed(t, 450);
    await sweep(t, 1); // page 1: tokenExpiresAt 1..200

    const ahead = ids[299]!; // page 2, reconnected
    const aheadAgain = ids[309]!; // page 2, reconnected and revoked again
    const behind = ids[19]!; // page 1 (done), reconnected and revoked again with a new token
    await t.run(async (ctx) => {
      await ctx.db.patch(ahead, { status: "active", credentialVersion: 2 });
      await ctx.db.patch(aheadAgain, { status: "revoked", credentialVersion: 2 });
      await ctx.db.patch(behind, { status: "revoked", credentialVersion: 2 });
      await addCredential(ctx, orgId, behind);
    });

    await sweep(t, 1);
    await sweep(t, 1); // the pass completes
    let left = await credentialsOf(t);
    expect(left.ids.has(ahead)).toBe(true); // active: never touched
    expect(left.ids.has(aheadAgain)).toBe(false);
    expect(left.ids.has(behind)).toBe(true); // behind the cursor: the next pass

    expect(await sweep(t, 1)).toMatchObject({ credentialsDeleted: 1 });
    left = await credentialsOf(t);
    expect(left.ids.has(behind)).toBe(false);
    expect(left.ids.has(ahead)).toBe(true);
  });

  it("starts a new pass when the stored cursor can no longer be read", async () => {
    const t = newBackend();
    await seed(t, 450);
    await sweep(t, 1);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("maintenanceCursors").collect())[0]!;
      await ctx.db.patch(row._id, { cursor: "not-a-cursor" });
    });
    expect(await sweep(t)).toMatchObject({ credentialsDeleted: 0, credentialSweep: "started" });
    expect(await cursorRow(t)).toMatchObject({ cursor: null, cursorResets: 1 });
    await drainScheduler(t);
    expect(await credentialsOf(t)).toMatchObject({ revoked: 0 });
    expect((await cursorRow(t)).lastPassCompletedAt).toBeDefined();
  });
});
