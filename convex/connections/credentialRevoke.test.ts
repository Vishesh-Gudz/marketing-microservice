import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  createFakeYouTube,
  FAKE_CHANNEL_ID,
  fakeVideos,
  type FakeYouTube,
} from "../providers/youtube/fakeYouTube.fixtures";
import {
  as,
  connectYouTubeFake,
  drainScheduler,
  newBackend,
  setupSyncOrg,
  stubLiveYouTube,
  type Backend,
} from "../test.helpers";

// IM7.0: a disconnect's credential cleanup (revokeAtPlatform -> deleteForConnection) touches
// only the authorization it disconnected. YouTube is used because it really revokes at Google,
// and the fake (like Google) revokes the user's whole grant: a wrong revoke would also kill a
// newer token. Jobs without a credential version (scheduled before versions existed) never
// revoke or delete.

vi.setConfig({ testTimeout: 120_000 });
const NOW = new Date("2026-10-30T12:00:00Z");

let fake: FakeYouTube;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = createFakeYouTube({
    channels: {
      brand: {
        channelId: FAKE_CHANNEL_ID,
        title: "Fake Brand",
        customUrl: "@fakebrand",
        subscriberCount: "12300",
        videos: fakeVideos(1, "2026-10-29T10:00:00Z"),
      },
    },
  });
  stubLiveYouTube(fake);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function connect(t: Backend): Promise<Id<"connections">> {
  const params = await connectYouTubeFake(t, fake, "brand");
  expect(params.get("status"), params.get("error") ?? "").toBe("connected");
  return params.get("connection")! as Id<"connections">;
}

async function disconnect(t: Backend, connectionId: Id<"connections">) {
  await as(t).mutation(api.v1.connections.disconnect, { connectionId });
}

async function state(t: Backend, connectionId: Id<"connections">) {
  return await t.run(async (ctx) => {
    const connection = (await ctx.db.get(connectionId))!;
    const credentials = (await ctx.db.query("credentials").collect()).filter(
      (c) => c.connectionId === connectionId,
    );
    const audit = (await ctx.db.query("auditLog").collect()).filter(
      (e) => e.targetId === connectionId,
    );
    return {
      status: connection.status,
      credentialVersion: connection.credentialVersion,
      credentials: credentials.length,
      revokes: audit
        .filter((e) => e.action === "connection.platform_revoke")
        .map((e) => e.changes?.failureKind?.to ?? e.changes?.outcome?.to),
      deletions: audit.filter((e) => e.action === "credential.deleted").length,
    };
  });
}

/** The refresh tokens sent to Google's revocation endpoint, in order. */
function revokedTokens(): string[] {
  return fake.requests
    .filter((r) => r.path === "/revoke")
    .map((r) => new URLSearchParams(r.body).get("token")!);
}

const legacyJob = (t: Backend, connectionId: Id<"connections">) =>
  t.action(internal.connections.oauthFlow.revokeAtPlatform, {
    connectionId,
    actorSubject: "legacy",
  });

describe("disconnect cleanup with credential versions", () => {
  it("revokes and deletes the disconnected credential, as before", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const id = await connect(t);
    await disconnect(t, id);
    await drainScheduler(t);
    expect(revokedTokens()).toHaveLength(1);
    expect(await state(t, id)).toMatchObject({
      status: "revoked",
      credentials: 0,
      revokes: ["revoked"],
      deletions: 1,
    });
  });

  it("leaves a reconnect made before the job ran untouched", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const id = await connect(t);
    await disconnect(t, id);
    expect(await connect(t)).toBe(id); // same identity: the connection row is reused
    await drainScheduler(t);
    expect(revokedTokens()).toEqual([]);
    expect(fake.revokedUsers).toEqual([]);
    expect(await state(t, id)).toMatchObject({
      status: "active",
      credentialVersion: 2,
      credentials: 1,
      revokes: ["superseded"],
      deletions: 0,
    });
  });

  it("disconnect -> reconnect -> disconnect: the first job never reaches the second authorization", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const id = await connect(t);
    await disconnect(t, id); // job for version 1
    await connect(t); // version 2
    await disconnect(t, id); // job for version 2
    await drainScheduler(t);
    // Exactly one revocation, of the second authorization's token, by its own job.
    expect(revokedTokens()).toHaveLength(1);
    expect(revokedTokens()[0]).toMatch(/-refresh-brand-2$/);
    expect(await state(t, id)).toMatchObject({
      status: "revoked",
      credentials: 0,
      revokes: ["superseded", "revoked"],
      deletions: 1,
    });
  });
});

describe("jobs scheduled before credential versions existed", () => {
  it("never revoke or delete, even after disconnect -> reconnect -> disconnect", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const id = await connect(t);
    await disconnect(t, id);
    await connect(t);
    await disconnect(t, id);

    await legacyJob(t, id);
    expect(revokedTokens()).toEqual([]);
    expect(await state(t, id)).toMatchObject({ credentials: 1, revokes: ["legacy_job"] });

    // The versioned jobs then do exactly what they do without the legacy one.
    await drainScheduler(t);
    expect(revokedTokens()).toHaveLength(1);
    expect(await state(t, id)).toMatchObject({
      credentials: 0,
      revokes: ["legacy_job", "superseded", "revoked"],
      deletions: 1,
    });
  });

  it("leave a still-revoked connection's credential to the hourly sweep", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const id = await connect(t);
    await disconnect(t, id);
    await legacyJob(t, id);
    expect((await state(t, id)).credentials).toBe(1);
    expect(await t.mutation(internal.connections.maintenance.sweep, {})).toMatchObject({
      credentialsDeleted: 1,
    });
    expect((await state(t, id)).credentials).toBe(0);
    expect(revokedTokens()).toEqual([]); // nothing was revoked at Google by either
  });

  it("change nothing on a connection that was reconnected", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const id = await connect(t);
    await legacyJob(t, id);
    expect(revokedTokens()).toEqual([]);
    expect(await state(t, id)).toMatchObject({ status: "active", credentials: 1, deletions: 0 });
  });
});

describe("deleteForConnection", () => {
  const remove = (t: Backend, connectionId: Id<"connections">, credentialVersion?: number) =>
    t.mutation(internal.connections.credentialStore.deleteForConnection, {
      connectionId,
      actorSubject: "test",
      ...(credentialVersion !== undefined ? { credentialVersion } : {}),
    });

  it("deletes only a revoked connection's credential of the named version", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const id = await connect(t);
    expect(await remove(t, id, 1)).toBe(false); // still active
    await t.run((ctx) => ctx.db.patch(id, { status: "revoked" }));
    expect(await remove(t, id)).toBe(false); // no version: never
    expect(await remove(t, id, 2)).toBe(false); // another authorization
    expect((await state(t, id)).credentials).toBe(1);
    expect(await remove(t, id, 1)).toBe(true);
    expect((await state(t, id)).credentials).toBe(0);
  });
});
