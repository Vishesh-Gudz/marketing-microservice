import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import crons from "../crons";
import { AUDIT_ACTIONS, SYSTEM_YOUTUBE_RETENTION_SUBJECT } from "../lib/audit";
import { addDays, eachDay } from "../lib/dates";
import { mockInstagramAccountId } from "../providers/social/mock";
import { mockYouTubeChannelId } from "../providers/social/mock/youtubeData";
import {
  createFakeYouTube,
  FAKE_CHANNEL_ID,
  FAKE_YT_TOKEN_MARKER,
  fakeVideos,
  type FakeChannel,
  type FakeYouTube,
} from "../providers/youtube/fakeYouTube.fixtures";
import {
  as,
  connectMockInstagram,
  connectMockYouTube,
  connectYouTubeFake,
  drainScheduler,
  expectMarketingError,
  linkSocial,
  newBackend,
  planAndDrain,
  setupSyncOrg,
  stubLiveYouTube,
  type Backend,
  type IdentityInput,
} from "../test.helpers";
import { YOUTUBE_RETENTION } from "./config";

// ADR 0016, Checkpoint 3b: YouTube data retention. Disconnect and unlink hard-delete a
// channel's stored data (bounded, resumable, idempotent steps); the hourly sweep resumes
// interrupted purges and deletes videos no listing refreshed for 25 days; the daily check
// purges only on a CONFIRMED authorization failure. Never Instagram rows, never another org's.

vi.setConfig({ testTimeout: 180_000 });
const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const ORG_B: IdentityInput = { org: "43" };

function brand(): FakeChannel {
  return {
    channelId: FAKE_CHANNEL_ID,
    title: "Fake Brand",
    customUrl: "@fakebrand",
    subscriberCount: "12300",
    videos: fakeVideos(3, "2026-10-19T10:00:00Z").map((video, i) => ({
      ...video,
      statistics: { viewCount: String(1000 * (i + 1)), commentCount: String(i) },
    })),
    days: Object.fromEntries(
      eachDay("2026-09-15", "2026-10-19").map((day, i) => [day, { views: 100 + i }]),
    ),
  };
}

let fake: FakeYouTube;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fake = createFakeYouTube({ channels: { brand: brand() } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function allRows(t: Backend) {
  return await t.run(async (ctx) => ({
    socialAccounts: await ctx.db.query("socialAccounts").collect(),
    posts: await ctx.db.query("socialPosts").collect(),
    snapshots: await ctx.db.query("socialPostMetricSnapshots").collect(),
    daily: await ctx.db.query("socialAccountMetricsDaily").collect(),
    syncAccounts: await ctx.db.query("syncAccounts").collect(),
    runs: await ctx.db.query("syncRuns").collect(),
    tasks: await ctx.db.query("syncTasks").collect(),
    discovered: await ctx.db.query("discoveredSocialAccounts").collect(),
    connections: await ctx.db.query("connections").collect(),
    audit: await ctx.db.query("auditLog").collect(),
  }));
}
type Rows = Awaited<ReturnType<typeof allRows>>;

/** One channel's rows in every table a purge clears (tasks: of the channel's runs). */
function channelRows(db: Rows, id: Id<"socialAccounts">) {
  const runs = new Set(db.runs.filter((r) => r.socialAccountId === id).map((r) => r._id));
  return {
    account: db.socialAccounts.filter((r) => r._id === id).length,
    posts: db.posts.filter((r) => r.socialAccountId === id).length,
    snapshots: db.snapshots.filter((r) => r.socialAccountId === id).length,
    daily: db.daily.filter((r) => r.socialAccountId === id).length,
    syncAccounts: db.syncAccounts.filter((r) => r.socialAccountId === id).length,
    runs: runs.size,
    tasks: db.tasks.filter((r) => runs.has(r.runId)).length,
  };
}
const NOTHING = {
  account: 0,
  posts: 0,
  snapshots: 0,
  daily: 0,
  syncAccounts: 0,
  runs: 0,
  tasks: 0,
};

const RETENTION_ACTIONS: ReadonlySet<string> = new Set([
  AUDIT_ACTIONS.socialAccountPurgeStarted,
  AUDIT_ACTIONS.socialAccountPurged,
  AUDIT_ACTIONS.socialAccountAuthorizationInconclusive,
]);
function retentionAudit(db: Rows) {
  return db.audit.filter((entry) => RETENTION_ACTIONS.has(entry.action));
}
/** Retention entries carry row ids, reasons, kinds and counts: no YouTube data, no token. */
function expectNoChannelData(db: Rows) {
  const text = JSON.stringify(retentionAudit(db));
  for (const marker of [FAKE_CHANNEL_ID, FAKE_YT_TOKEN_MARKER, "Fake Brand", "fakebrand"]) {
    expect(text).not.toContain(marker);
  }
}

async function linkedYouTube(t: Backend, who: IdentityInput = {}) {
  await setupSyncOrg(t, who);
  const params = await connectYouTubeFake(t, fake, "brand", who);
  expect(params.get("status"), params.get("error") ?? "").toBe("connected");
  const connectionId = params.get("connection")!;
  const [account] = await linkSocial(t, connectionId, [FAKE_CHANNEL_ID], who);
  const socialAccountId = account!.id as Id<"socialAccounts">;
  const orgId = (await t.run((ctx) => ctx.db.get(socialAccountId)))!.orgId;
  return { connectionId, socialAccountId, orgId };
}

async function syncedYouTube(t: Backend, who: IdentityInput = {}) {
  const linked = await linkedYouTube(t, who);
  await planAndDrain(t);
  const rows = channelRows(await allRows(t), linked.socialAccountId);
  expect(rows).toMatchObject({ account: 1, posts: 3, snapshots: 3, syncAccounts: 1, runs: 1 });
  expect(rows.daily).toBeGreaterThan(0);
  return linked;
}

/** Direct seed (test-only): an Instagram account with a post, a snapshot and a day. */
async function seedInstagram(t: Backend, orgId: Id<"organizations">, lastSeenAt: number) {
  return await t.run(async (ctx) => {
    const now = Date.now();
    const life = { createdAt: now, updatedAt: now, lastSeenAt };
    const socialAccountId = await ctx.db.insert("socialAccounts", {
      orgId,
      platform: "instagram",
      externalId: "17841400000000001",
      name: "Seeded Instagram",
      accountType: "business",
      status: "active",
      ...life,
    });
    const postId = await ctx.db.insert("socialPosts", {
      orgId,
      socialAccountId,
      platform: "instagram",
      externalId: "18000000000000001",
      type: "image",
      publishedAt: now - 60 * DAY,
      ...life,
    });
    await ctx.db.insert("socialPostMetricSnapshots", {
      orgId,
      socialAccountId,
      postId,
      platform: "instagram",
      capturedDate: "2026-08-01",
      capturedAt: now - 60 * DAY,
      views: 5,
    });
    await ctx.db.insert("socialAccountMetricsDaily", {
      orgId,
      socialAccountId,
      platform: "instagram",
      date: "2026-08-01",
      views: 7,
      syncedAt: now - 60 * DAY,
    });
    return socialAccountId;
  });
}

const purge = internal.connections.youtubeRetention.purgeYouTubeAccount;
const sweep = internal.connections.youtubeRetention.sweepYouTubeRetention;
const planChecks = internal.connections.youtubeRetention.planYouTubeAuthorizationChecks;

describe("disconnect and unlink delete the channel's data (live, fake API)", () => {
  it("disconnect revokes the grant at Google and hard-deletes every row of the channel", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { connectionId, socialAccountId } = await syncedYouTube(t);
    const before = channelRows(await allRows(t), socialAccountId);

    await as(t).mutation(api.v1.connections.disconnect, { connectionId });
    await drainScheduler(t);

    const db = await allRows(t);
    expect(channelRows(db, socialAccountId)).toEqual(NOTHING);
    expect(db.tasks).toEqual([]);
    expect(fake.revokedUsers).toEqual(["brand"]); // the existing revoke flow
    const connection = db.connections.find((row) => row._id === connectionId)!;
    expect(connection.status).toBe("revoked");
    expect(connection).not.toHaveProperty("displayName");
    expect(db.discovered).toEqual([]);
    expect(
      retentionAudit(db).map((entry) => [entry.action, entry.subject, entry.targetId]),
    ).toEqual([
      [AUDIT_ACTIONS.socialAccountPurgeStarted, "user_1", socialAccountId],
      [AUDIT_ACTIONS.socialAccountPurged, SYSTEM_YOUTUBE_RETENTION_SUBJECT, socialAccountId],
    ]);
    const [started, purged] = retentionAudit(db);
    expect(started!.changes).toEqual({ reason: { from: null, to: "disconnected" } });
    expect(purged!.changes).toEqual({
      posts: { from: null, to: 3 },
      snapshots: { from: null, to: 3 },
      days: { from: null, to: before.daily },
      runs: { from: null, to: 1 },
    });
    expectNoChannelData(db);
  });

  it("unlink hard-deletes the channel's data; the connection and an id-only discovered row stay", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { connectionId, socialAccountId } = await syncedYouTube(t);

    await as(t).mutation(api.v1.connections.unlinkSocialAccount, { socialAccountId });
    await drainScheduler(t);

    let db = await allRows(t);
    expect(channelRows(db, socialAccountId)).toEqual(NOTHING);
    expect(db.connections[0]!.status).toBe("active");
    expect(fake.revokedUsers).toEqual([]);
    expect(db.discovered).toHaveLength(1);
    expect(db.discovered[0]).not.toHaveProperty("username");
    expect(retentionAudit(db).map((entry) => entry.action)).toEqual([
      AUDIT_ACTIONS.socialAccountPurgeStarted,
      AUDIT_ACTIONS.socialAccountPurged,
    ]);
    expect(retentionAudit(db)[0]!.changes).toEqual({ reason: { from: null, to: "unlinked" } });
    expectNoChannelData(db);

    // Relinking afterwards links a NEW channel row, backfilled from scratch.
    const [relinked] = await linkSocial(t, connectionId, [FAKE_CHANNEL_ID]);
    const fresh = relinked!.id as Id<"socialAccounts">;
    expect(fresh).not.toBe(socialAccountId);
    await planAndDrain(t);
    db = await allRows(t);
    expect(channelRows(db, fresh)).toMatchObject({ account: 1, posts: 3, snapshots: 3, runs: 1 });
    expect(db.runs.map((run) => [run.kind, run.status])).toEqual([["initial", "succeeded"]]);
  });

  it("refuses to relink while the purge is pending; a repeated unlink starts no second purge", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { connectionId, socialAccountId } = await syncedYouTube(t);

    await as(t).mutation(api.v1.connections.unlinkSocialAccount, { socialAccountId });
    await expectMarketingError(linkSocial(t, connectionId, [FAKE_CHANNEL_ID]), "CONFLICT");
    await as(t).mutation(api.v1.connections.unlinkSocialAccount, { socialAccountId });
    await drainScheduler(t);

    const db = await allRows(t);
    expect(channelRows(db, socialAccountId)).toEqual(NOTHING);
    expect(retentionAudit(db).map((entry) => entry.action)).toEqual([
      AUDIT_ACTIONS.socialAccountPurgeStarted,
      AUDIT_ACTIONS.socialAccountPurged,
    ]);
    const [relinked] = await linkSocial(t, connectionId, [FAKE_CHANNEL_ID]);
    expect(relinked!.id).not.toBe(socialAccountId);
  });

  it("deletes in bounded steps, resumes an interrupted purge and never deletes twice", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { socialAccountId, orgId } = await syncedYouTube(t);
    const video = (await allRows(t)).posts[0]!;
    await t.run(async (ctx) => {
      for (let i = 0; i < 1200; i++) {
        await ctx.db.insert("socialPostMetricSnapshots", {
          orgId,
          socialAccountId,
          postId: video._id,
          platform: "youtube",
          capturedDate: addDays("2023-01-01", i),
          capturedAt: NOW.getTime(),
          views: i,
        });
      }
    });
    const stored = (db: Rows) => db.posts.length + db.snapshots.length + db.daily.length;
    const before = stored(await allRows(t));

    await as(t).mutation(api.v1.connections.unlinkSocialAccount, { socialAccountId });
    const step = await t.mutation(purge, { orgId, socialAccountId });
    expect(step.status).toBe("continued");
    expect(before - stored(await allRows(t))).toBe(YOUTUBE_RETENTION.purgeStepDeletes);

    // The chain is interrupted: its scheduled continuations are lost.
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
    await drainScheduler(t);
    let db = await allRows(t);
    expect(channelRows(db, socialAccountId).account).toBe(1);
    expect(db.socialAccounts[0]).toMatchObject({ status: "disconnected" });

    // The hourly sweep resumes it to completion.
    expect((await t.mutation(sweep, {})).resumed).toBe(1);
    await drainScheduler(t);
    db = await allRows(t);
    expect(channelRows(db, socialAccountId)).toEqual(NOTHING);
    expect(db.snapshots).toEqual([]);

    // Repeated runs are no-ops.
    expect(await t.mutation(purge, { orgId, socialAccountId })).toMatchObject({
      status: "skipped",
    });
    expect((await t.mutation(sweep, {})).resumed).toBe(0);
    await drainScheduler(t);
    db = await allRows(t);
    expect(
      retentionAudit(db).filter((entry) => entry.action === AUDIT_ACTIONS.socialAccountPurged),
    ).toHaveLength(1);
  });

  it("never touches another org's channel, an Instagram account or a mismatched org/channel pair", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const a = await syncedYouTube(t);
    const b = await linkedYouTube(t, ORG_B);
    await planAndDrain(t);
    const instagram = await seedInstagram(t, a.orgId, NOW.getTime() - 60 * DAY);
    const initial = await allRows(t);
    const snapshot = (db: Rows) => ({
      a: channelRows(db, a.socialAccountId),
      b: channelRows(db, b.socialAccountId),
      instagram: channelRows(db, instagram),
      statuses: db.socialAccounts.map((row) => [row._id, row.status, row.connectionId]),
    });
    const start = { reason: "authorization_invalid" as const, staleBefore: NOW.getTime() + DAY };

    // Mismatched org: org B's id with org A's channel, and the other way round.
    for (const args of [
      { orgId: b.orgId, socialAccountId: a.socialAccountId },
      { orgId: a.orgId, socialAccountId: b.socialAccountId, start },
      // An Instagram account is never purged, whatever the reason.
      { orgId: a.orgId, socialAccountId: instagram, start },
      // A channel whose authorization was confirmed since (lastSeenAt >= staleBefore).
      { orgId: a.orgId, socialAccountId: a.socialAccountId, start: { ...start, staleBefore: 0 } },
    ]) {
      expect((await t.mutation(purge, args)).status).toBe("skipped");
    }
    await t.mutation(internal.connections.youtubeRetention.recordInconclusiveCheck, {
      orgId: b.orgId,
      socialAccountId: a.socialAccountId,
      failureKind: "transient",
    });
    await drainScheduler(t);
    let db = await allRows(t);
    expect(snapshot(db)).toEqual(snapshot(initial));
    expect(retentionAudit(db)).toEqual([]);

    // Org A unlinks the channel: only org A's channel goes.
    await as(t).mutation(api.v1.connections.unlinkSocialAccount, {
      socialAccountId: a.socialAccountId,
    });
    await drainScheduler(t);
    db = await allRows(t);
    expect(channelRows(db, a.socialAccountId)).toEqual(NOTHING);
    expect(channelRows(db, b.socialAccountId)).toEqual(snapshot(initial).b);
    expect(channelRows(db, instagram)).toEqual(snapshot(initial).instagram);
    expect(retentionAudit(db).every((entry) => entry.orgId === a.orgId)).toBe(true);
  });

  it("a sync page that arrives after the unlink is refused and recreates nothing (late commit)", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { socialAccountId } = await linkedYouTube(t);
    // The unlink lands while the worker waits for YouTube: between its fetch and its commit.
    let unlink: (() => Promise<unknown>) | undefined = () =>
      as(t).mutation(api.v1.connections.unlinkSocialAccount, { socialAccountId });
    vi.stubGlobal("fetch", (async (input: RequestInfo | URL, init?: RequestInit) => {
      const hook = unlink;
      if (hook !== undefined && String(input).includes("/youtube/v3/channels")) {
        unlink = undefined;
        await hook();
      }
      return await fake.fetch(input, init);
    }) as typeof fetch);

    await planAndDrain(t);

    expect(unlink).toBeUndefined(); // the unlink ran mid-fetch
    const db = await allRows(t);
    expect(channelRows(db, socialAccountId)).toEqual(NOTHING);
    expect([db.posts, db.snapshots, db.daily, db.runs, db.tasks]).toEqual([[], [], [], [], []]);
  });

  it("a purge that completes before the queued worker runs leaves nothing for it to write", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { socialAccountId, orgId } = await linkedYouTube(t);
    expect((await t.mutation(internal.sync.planner.tick, {})).started).toBe(1);
    await as(t).mutation(api.v1.connections.unlinkSocialAccount, { socialAccountId });
    let status = "continued";
    while (status === "continued") {
      status = (await t.mutation(purge, { orgId, socialAccountId })).status;
    }
    expect(status).toBe("done");

    await drainScheduler(t); // the worker, the duplicate purge step

    const db = await allRows(t);
    expect(channelRows(db, socialAccountId)).toEqual(NOTHING);
    expect([db.posts, db.snapshots, db.daily, db.runs, db.tasks]).toEqual([[], [], [], [], []]);
  });
});

describe("authorization checks (live, fake API)", () => {
  async function age(t: Backend, id: Id<"socialAccounts">, days: number) {
    await t.run((ctx) => ctx.db.patch(id, { lastSeenAt: NOW.getTime() - days * DAY }));
  }
  async function check(t: Backend) {
    const result = await t.mutation(planChecks, {});
    await drainScheduler(t);
    return result;
  }

  it("checks only after 25 days; a confirmed authorization keeps the data and restarts the clock", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { socialAccountId } = await syncedYouTube(t);
    const initial = channelRows(await allRows(t), socialAccountId);
    fake.requests.length = 0;

    await age(t, socialAccountId, 24);
    expect(await check(t)).toMatchObject({ checks: 0, marked: 0 });
    expect(fake.requests).toEqual([]);

    await age(t, socialAccountId, 26);
    expect(await check(t)).toMatchObject({ checks: 1, marked: 0 });
    expect(fake.requests.map((r) => r.path)).toEqual(["/token", "/youtube/v3/channels"]);
    const db = await allRows(t);
    expect(channelRows(db, socialAccountId)).toEqual(initial);
    expect(db.socialAccounts[0]).toMatchObject({ status: "active", lastSeenAt: NOW.getTime() });
    expect(retentionAudit(db)).toEqual([]);
    expect(await check(t)).toMatchObject({ checks: 0 });
  });

  it.each([
    ["an active connection", "active" as const],
    ["a connection that needs re-authorization", "needs_reauth" as const],
  ])(
    "invalid_grant (the grant was revoked in Google's settings) purges, with %s",
    async (_, status) => {
      stubLiveYouTube(fake);
      const t = newBackend();
      const { socialAccountId, connectionId } = await syncedYouTube(t);
      await t.run((ctx) => ctx.db.patch(connectionId as Id<"connections">, { status }));
      fake.revoke("brand");
      await age(t, socialAccountId, 26);

      expect(await check(t)).toMatchObject({ checks: 1 });

      const db = await allRows(t);
      expect(channelRows(db, socialAccountId)).toEqual(NOTHING);
      const [started] = retentionAudit(db);
      expect(started).toMatchObject({
        action: AUDIT_ACTIONS.socialAccountPurgeStarted,
        subject: SYSTEM_YOUTUBE_RETENTION_SUBJECT,
        changes: { reason: { from: null, to: "authorization_invalid" } },
      });
      expectNoChannelData(db);
    },
  );

  it("purges when the authorization no longer owns the channel (channel_not_authorized)", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { socialAccountId } = await syncedYouTube(t);
    fake.failNext("channels", { status: 200, body: { items: [] } });
    await age(t, socialAccountId, 26);

    await check(t);

    const db = await allRows(t);
    expect(channelRows(db, socialAccountId)).toEqual(NOTHING);
    expect(retentionAudit(db)[0]!.changes).toEqual({
      reason: { from: null, to: "channel_not_authorized" },
    });
  });

  it("purges when no stored credential exists (credential_missing)", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { socialAccountId } = await syncedYouTube(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("credentials").collect()) await ctx.db.delete(row._id);
    });
    await age(t, socialAccountId, 26);
    fake.requests.length = 0;

    await check(t);

    const db = await allRows(t);
    expect(channelRows(db, socialAccountId)).toEqual(NOTHING);
    expect(retentionAudit(db)[0]!.changes).toEqual({
      reason: { from: null, to: "credential_missing" },
    });
    expect(fake.requests).toEqual([]); // decided without asking Google
  });

  it.each([
    [
      "a Google outage at the token endpoint",
      () => fake.failNext("token", { status: 503 }),
      { failureKind: { from: null, to: "transient" }, failureCode: { from: null, to: "http_503" } },
    ],
    [
      "a backend error on channels.list",
      () =>
        fake.failNext("channels", {
          status: 500,
          body: { error: { code: 500, errors: [{ reason: "backendError" }] } },
        }),
      {
        failureKind: { from: null, to: "transient" },
        failureCode: { from: null, to: "backendError" },
      },
    ],
    [
      "an exhausted quota",
      () =>
        fake.failNext("channels", {
          status: 403,
          body: { error: { code: 403, errors: [{ reason: "quotaExceeded" }] } },
        }),
      {
        failureKind: { from: null, to: "rate_limited" },
        failureCode: { from: null, to: "quotaExceeded" },
      },
    ],
    [
      "a 401 on channels.list right after a fresh token (not invalid_grant)",
      () =>
        fake.failNext("channels", {
          status: 401,
          body: {
            error: { code: 401, status: "UNAUTHENTICATED", errors: [{ reason: "authError" }] },
          },
        }),
      { failureKind: { from: null, to: "auth" }, failureCode: { from: null, to: "authError" } },
    ],
    [
      "our own OAuth client misconfigured (invalid_client)",
      () => vi.stubEnv("YOUTUBE_CLIENT_SECRET", "not-the-client-secret"),
      {
        failureKind: { from: null, to: "unknown" },
        failureCode: { from: null, to: "invalid_client" },
      },
    ],
  ])("is inconclusive on %s: the data is kept and checked again", async (_, inject, changes) => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { socialAccountId } = await syncedYouTube(t);
    const initial = channelRows(await allRows(t), socialAccountId);
    await age(t, socialAccountId, 26);
    inject();

    expect(await check(t)).toMatchObject({ checks: 1 });

    const db = await allRows(t);
    expect(channelRows(db, socialAccountId)).toEqual(initial);
    expect(db.socialAccounts[0]).toMatchObject({
      status: "active",
      lastSeenAt: NOW.getTime() - 26 * DAY,
    });
    expect(db.socialAccounts[0]!.connectionId).toBeDefined();
    expect(retentionAudit(db).map((entry) => [entry.action, entry.subject, entry.changes])).toEqual(
      [
        [
          AUDIT_ACTIONS.socialAccountAuthorizationInconclusive,
          SYSTEM_YOUTUBE_RETENTION_SUBJECT,
          changes,
        ],
      ],
    );
    expectNoChannelData(db);
    // Still unconfirmed: the next daily run checks it again.
    expect((await t.mutation(planChecks, {})).checks).toBe(1);
  });

  it("a sync that confirmed the authorization before the check ran wins over a stale check", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { socialAccountId } = await syncedYouTube(t);
    await age(t, socialAccountId, 26);
    expect((await t.mutation(planChecks, {})).checks).toBe(1);
    // A preflight succeeds (lastSeenAt = now) before the scheduled check runs; then Google
    // answers invalid_grant. The check targets only a still-unconfirmed channel: skipped.
    await t.run((ctx) => ctx.db.patch(socialAccountId, { lastSeenAt: NOW.getTime() }));
    fake.revoke("brand");
    fake.requests.length = 0;

    await drainScheduler(t);

    const db = await allRows(t);
    expect(channelRows(db, socialAccountId).account).toBe(1);
    expect(fake.requests).toEqual([]);
    expect(retentionAudit(db)).toEqual([]);
  });

  it("purges a channel unlinked before retention existed (unlinked)", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { socialAccountId } = await syncedYouTube(t);
    await t.run((ctx) =>
      ctx.db.patch(socialAccountId, { connectionId: undefined, linkedAt: undefined }),
    );
    await age(t, socialAccountId, 26);

    expect(await check(t)).toMatchObject({ checks: 0, marked: 1 });

    const db = await allRows(t);
    expect(channelRows(db, socialAccountId)).toEqual(NOTHING);
    expect(retentionAudit(db)[0]).toMatchObject({
      subject: SYSTEM_YOUTUBE_RETENTION_SUBJECT,
      changes: { reason: { from: null, to: "unlinked" } },
    });
  });
});

describe("stale videos (live, fake API)", () => {
  it("deletes videos no listing refreshed for 25 days with their snapshots, never Instagram's", async () => {
    stubLiveYouTube(fake);
    const t = newBackend();
    const { socialAccountId, orgId } = await syncedYouTube(t);
    await setupSyncOrg(t, ORG_B);
    const orgB = (await t.run((ctx) =>
      ctx.db
        .query("organizations")
        .collect()
        .then((orgs) => orgs.find((org) => org._id !== orgId)!._id),
    ))!;
    const instagram = await seedInstagram(t, orgId, NOW.getTime() - 60 * DAY);
    const [stale, recent, fresh] = (await allRows(t)).posts
      .filter((post) => post.platform === "youtube")
      .sort((x, y) => x.externalId.localeCompare(y.externalId));
    const mismatched = await t.run(async (ctx) => {
      await ctx.db.patch(stale!._id, { lastSeenAt: NOW.getTime() - 26 * DAY });
      await ctx.db.patch(recent!._id, { lastSeenAt: NOW.getTime() - 24 * DAY });
      // A YouTube row of org B naming org A's channel: never deleted through org A's channel.
      return await ctx.db.insert("socialPosts", {
        orgId: orgB,
        socialAccountId,
        platform: "youtube",
        externalId: "vidMismatch",
        type: "video",
        publishedAt: NOW.getTime() - 90 * DAY,
        createdAt: NOW.getTime(),
        updatedAt: NOW.getTime(),
        lastSeenAt: NOW.getTime() - 90 * DAY,
      });
    });
    const before = await allRows(t);

    expect(await t.mutation(sweep, {})).toMatchObject({ videosDeleted: 1, resumed: 0 });
    await drainScheduler(t);

    const db = await allRows(t);
    expect(db.posts.map((post) => post._id).sort()).toEqual(
      [
        recent!._id,
        fresh!._id,
        mismatched,
        ...before.posts.filter((p) => p.platform === "instagram").map((p) => p._id),
      ].sort(),
    );
    expect(db.snapshots.some((s) => s.postId === stale!._id)).toBe(false);
    expect(db.snapshots).toHaveLength(before.snapshots.length - 1);
    expect(channelRows(db, instagram)).toEqual(channelRows(before, instagram));
    expect(db.daily).toHaveLength(before.daily.length); // days are kept
    expect(db.socialAccounts).toHaveLength(before.socialAccounts.length);
    expect(retentionAudit(db)).toEqual([]); // nothing claims a deletion on YouTube
    expect((await t.mutation(sweep, {})).videosDeleted).toBe(0);
  });
});

describe("mock mode", () => {
  it("disconnect purges a mock channel; the org's Instagram account and data are untouched", async () => {
    const t = newBackend();
    await setupSyncOrg(t);
    const ig = (await connectMockInstagram(t, "1")).get("connection")!;
    const [instagram] = await linkSocial(t, ig, [mockInstagramAccountId("1")]);
    const yt = (await connectMockYouTube(t, "1")).get("connection")!;
    const [youtube] = await linkSocial(t, yt, [mockYouTubeChannelId("1")]);
    await planAndDrain(t);
    const before = await allRows(t);
    const instagramId = instagram!.id as Id<"socialAccounts">;
    const youtubeId = youtube!.id as Id<"socialAccounts">;
    expect(channelRows(before, instagramId).posts).toBeGreaterThan(0);
    expect(channelRows(before, youtubeId).posts).toBeGreaterThan(0);

    await as(t).mutation(api.v1.connections.disconnect, { connectionId: yt });
    await drainScheduler(t);

    const db = await allRows(t);
    expect(channelRows(db, youtubeId)).toEqual(NOTHING);
    expect(channelRows(db, instagramId)).toEqual(channelRows(before, instagramId));
    expect(db.socialAccounts.find((row) => row._id === instagramId)).toEqual(
      before.socialAccounts.find((row) => row._id === instagramId),
    );
  });
});

describe("schedules", () => {
  it("runs the sweep hourly and the authorization check daily", () => {
    expect(crons.crons["youtube retention sweep"]).toMatchObject({
      name: "connections/youtubeRetention:sweepYouTubeRetention",
      schedule: { type: "hourly", minuteUTC: 47 },
    });
    expect(crons.crons["youtube authorization check"]).toMatchObject({
      name: "connections/youtubeRetention:planYouTubeAuthorizationChecks",
      schedule: { type: "daily", hourUTC: 4, minuteUTC: 27 },
    });
  });
});
