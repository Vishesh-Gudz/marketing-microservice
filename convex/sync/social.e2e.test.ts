import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import {
  createFakeInstagram,
  FAKE_IG_TOKEN_MARKER,
  type FakeInstagram,
  type FakeInstagramUser,
  type FakeMedia,
} from "../providers/instagram/fakeInstagram.fixtures";
import { NEVER_REQUESTED_METRICS } from "../providers/instagram/semantics";
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

// Phase 10 Stage B: organic Instagram data through the EXISTING Phase 5 engine (planner ->
// run -> tasks in seq order -> claim -> "use node" social worker -> provider ->
// commitSocialPage -> finalize), against the fake Instagram API (documented behavior only)
// and in mock mode. Ad syncs are unaffected and never mixed with social data.

vi.setConfig({ testTimeout: 180_000 });
const NOW = new Date("2026-09-28T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const USER_ID = "17841400000000101";

const media = (
  n: number,
  day: string,
  type = "IMAGE",
  product: string | undefined = "FEED",
  insights: Record<string, number> = {
    likes: n,
    comments: 1,
    saved: 0,
    shares: 2,
    reach: 10 * n,
    views: 20 * n,
    total_interactions: n + 3,
  },
): FakeMedia => ({
  id: `179000000000${String(n).padStart(5, "0")}`,
  media_type: type,
  ...(product !== undefined ? { media_product_type: product } : {}),
  permalink: `https://www.instagram.com/p/C${n}/`,
  caption: `Post ${n}`,
  timestamp: `${day}T10:00:00+0000`,
  insights,
});

const POSTS: FakeMedia[] = [
  media(1, "2026-09-27"),
  media(2, "2026-09-20", "VIDEO", "REELS"),
  media(3, "2026-09-18", "IMAGE", "AD", { likes: 99 }),
  media(4, "2026-09-17", "IMAGE", "STORY", { reach: 99 }),
  media(5, "2026-09-10", "CAROUSEL_ALBUM", "FEED", { likes: 0, comments: 0, reach: 0 }),
  media(6, "2026-05-01"),
];

function business(overrides: Partial<FakeInstagramUser> = {}): FakeInstagramUser {
  return {
    userId: USER_ID,
    username: "fake_brand",
    accountType: "Business",
    name: "Fake Brand",
    followers: 1234,
    permissions: "instagram_business_basic,instagram_business_manage_insights",
    media: POSTS.map((m) => ({ ...m })),
    accountInsights: {
      "2026-09-27": {
        reach: 120,
        views: 400,
        accounts_engaged: 11,
        total_interactions: 0,
        likes: 30,
        profile_links_taps: 2,
      },
      "2026-09-26": {},
    },
    follows: { "2026-09-27": { FOLLOWER: 4, NON_FOLLOWER: 1 } },
    ...overrides,
  };
}

let fake: FakeInstagram;
let user: FakeInstagramUser;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  user = business();
  fake = createFakeInstagram({ users: { business: user } });
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
    socialAccounts: await ctx.db.query("socialAccounts").collect(),
    posts: await ctx.db.query("socialPosts").collect(),
    snapshots: await ctx.db.query("socialPostMetricSnapshots").collect(),
    daily: await ctx.db.query("socialAccountMetricsDaily").collect(),
    audit: await ctx.db.query("auditLog").collect(),
  }));
}

async function linkedInstagram(t: Backend, who = {}) {
  await setupSyncOrg(t, who);
  const connectionId = (await connectInstagramFake(t, fake, "business", who)).get("connection")!;
  const [account] = await linkSocial(t, connectionId, [USER_ID], who);
  return { connectionId, socialAccountId: account!.id as Id<"socialAccounts"> };
}

const lastRun = (db: Awaited<ReturnType<typeof state>>) =>
  [...db.runs]
    .sort((a, b) => a.createdAt - b.createdAt || a._creationTime - b._creationTime)
    .at(-1)!;

const idOf = (n: number) => `179000000000${String(n).padStart(5, "0")}`;

/** Advances the clock and plans + drains once. */
async function at(t: Backend, when: number) {
  vi.setSystemTime(when);
  return await planAndDrain(t);
}

describe("initial sync (live, fake Instagram API)", () => {
  it("plans all operations in order and writes profile, posts, snapshots and days", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    const { socialAccountId } = await linkedInstagram(t);
    fake.reset();

    expect((await planAndDrain(t)).started).toBe(1);
    const db = await state(t);
    const run = db.runs[0]!;
    expect(run).toMatchObject({
      socialAccountId,
      kind: "initial",
      status: "succeeded",
      providerId: "instagram-login/v25.0",
      window: { from: "2026-08-30", to: "2026-09-28" },
    });
    expect(run.adAccountId).toBeUndefined();
    // Planner task ordering: preflight, listing, snapshots, account-metric chunks.
    const tasks = db.tasks.sort((a, b) => a.seq - b.seq);
    expect(tasks.map((task) => [task.operation, task.status, task.from, task.to])).toEqual([
      ["getSocialAccount", "succeeded", undefined, undefined],
      ["listSocialPosts", "succeeded", undefined, undefined],
      ["fetchPostMetrics", "succeeded", "2026-07-01", "2026-09-28"],
      ["fetchAccountMetrics", "succeeded", "2026-09-01", "2026-09-28"],
      ["fetchAccountMetrics", "succeeded", "2026-08-30", "2026-08-31"],
    ]);
    expect(tasks[1]!.fullListing).toBe(true);

    // Profile (preflight): no URL stored (F1).
    const account = db.socialAccounts[0]!;
    expect(account).toMatchObject({
      name: "Fake Brand",
      username: "fake_brand",
      followersCount: 1234,
      accountType: "business",
    });
    expect(account.profilePictureUrl).toBeUndefined();

    // Posts: AD and STORY never ingested; the old post is listed (outside the snapshot window).
    expect(db.posts.map((p) => [p.externalId, p.type]).sort()).toEqual(
      [
        [idOf(1), "image"],
        [idOf(2), "reel"],
        [idOf(5), "carousel"],
        [idOf(6), "image"],
      ].sort(),
    );
    for (const post of db.posts) {
      expect(post.mediaUrl).toBeUndefined();
      expect(post.thumbnailUrl).toBeUndefined();
      expect(post.permalink).toMatch(/^https:\/\/www\.instagram\.com\/p\//);
    }

    // Snapshots: in-window organic posts, today's UTC day; zeros stay zero, missing absent.
    const byPost = new Map(db.posts.map((p) => [p._id, p.externalId]));
    const snaps = new Map(db.snapshots.map((s) => [byPost.get(s.postId), s]));
    expect([...snaps.keys()].sort()).toEqual([idOf(1), idOf(2), idOf(5)].sort());
    expect(snaps.get(idOf(5))).toMatchObject({
      capturedDate: "2026-09-28",
      likes: 0,
      comments: 0,
      reach: 0,
    });
    expect(snaps.get(idOf(5))!.views).toBeUndefined();

    // Days: every requested day has insights provenance; today also has the follower capture.
    expect(db.daily).toHaveLength(30);
    expect(db.daily.every((d) => d.insightsSyncedAt === NOW.getTime())).toBe(true);
    const byDate = new Map(db.daily.map((d) => [d.date, d]));
    expect(byDate.get("2026-09-27")).toMatchObject({
      reach: 120,
      views: 400,
      accountsEngaged: 11,
      totalInteractions: 0,
      followerDelta: 3,
      extras: { likes: 30, profileLinksTaps: 2 },
    });
    expect(byDate.get("2026-09-27")!.followers).toBeUndefined();
    const empty = byDate.get("2026-09-26")!;
    expect([empty.reach, empty.views, empty.totalInteractions, empty.followers]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    expect(byDate.get("2026-09-28")).toMatchObject({
      followers: 1234,
      followersCapturedAt: NOW.getTime(),
    });

    // Coverage (account-metric windows) and schedule.
    expect(db.accounts[0]).toMatchObject({
      state: "idle",
      coveredFrom: "2026-08-30",
      coveredThrough: "2026-09-28",
    });

    // Exact request budget: preflight 2, listing 1, snapshots 1 + 3 x 3, days 30 x 2.
    expect(fake.count(`/v25.0/${USER_ID}/media`)).toBe(2);
    expect(fake.count("/v25.0/me")).toBe(1);
    expect(fake.count(`/v25.0/${USER_ID}/insights`)).toBe(60);
    expect(fake.requests).toHaveLength(2 + 1 + 1 + 9 + 60);
    for (const id of [idOf(3), idOf(4), idOf(6)]) expect(fake.count(`/v25.0/${id}`)).toBe(0);
    for (const metric of fake.requestedMetrics())
      expect(NEVER_REQUESTED_METRICS).not.toContain(metric);

    // No secret anywhere; no URL in the organic tables except post permalinks (F1).
    expect(JSON.stringify(db)).not.toContain(FAKE_IG_TOKEN_MARKER);
    const organic = JSON.stringify([db.socialAccounts, db.posts, db.snapshots, db.daily]);
    expect(organic).not.toMatch(/scontent|biography|fake-website/);
    for (const url of organic.match(/https?:\/\/[^"]+/g) ?? []) {
      expect(url).toMatch(/^https:\/\/www\.instagram\.com\/p\//);
    }
  });

  it("an auth failure mid-run (190) moves the connection to needs_reauth", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    await linkedInstagram(t);
    fake.fail("account_insights", { status: 400, body: { error: { code: 190 } } });
    await planAndDrain(t);
    const db = await state(t);
    expect(db.connections[0]!.status).toBe("needs_reauth");
    expect(db.runs[0]).toMatchObject({ status: "failed", error: { kind: "auth", code: "190" } });
    expect(db.audit.map((e) => e.action)).toContain("connection.needs_reauth");
    expect(JSON.stringify(db)).not.toContain(FAKE_IG_TOKEN_MARKER);
  });

  it("an app mismatch is an auth failure before any request", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    await linkedInstagram(t);
    fake.reset();
    vi.stubEnv("INSTAGRAM_APP_ID", "1790000000000999");
    await planAndDrain(t);
    const db = await state(t);
    expect(db.connections[0]!.status).toBe("needs_reauth");
    expect(db.runs[0]!.error).toMatchObject({ kind: "auth", code: "app_id_mismatch" });
    expect(fake.requests).toEqual([]);
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

describe("listing semantics", () => {
  it("R3: a media item without a product type makes the listing incomplete (no removal)", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    await linkedInstagram(t);
    await planAndDrain(t);

    // Post 2 disappears while an untyped media item appears: nothing may be marked removed.
    const untyped = media(7, "2026-09-28");
    delete untyped.media_product_type;
    user.media = [untyped, ...user.media!.filter((m) => m.id !== idOf(2))];
    await at(t, NOW.getTime() + DAY + HOUR);
    let db = await state(t);
    const lookback = lastRun(db);
    expect(lookback).toMatchObject({ kind: "lookback", status: "partial" });
    expect(lookback.counts.unresolved).toBeGreaterThan(0);
    expect(db.posts.map((p) => p.externalId)).not.toContain(idOf(7)); // never ingested
    expect(db.posts.every((p) => p.removedAt === undefined)).toBe(true);

    // Complete listing again: post 2 is newer than the oldest ingested post -> removed.
    user.media = user.media!.filter((m) => m.id !== idOf(7));
    await at(t, NOW.getTime() + 2 * DAY + 2 * HOUR);
    db = await state(t);
    expect(lastRun(db)).toMatchObject({ kind: "lookback", status: "succeeded" });
    expect(lastRun(db).counts.removed).toBe(1);
    const removed = db.posts.find((p) => p.externalId === idOf(2))!;
    expect(removed.removedAt).toBeDefined();
    // The post older than every listed post can never be inferred deleted.
    expect(db.posts.find((p) => p.externalId === idOf(6))!.removedAt).toBeUndefined();

    // It reappears: removedAt cleared, counted as reappeared.
    user.media = POSTS.map((m) => ({ ...m }));
    await at(t, NOW.getTime() + 3 * DAY + 3 * HOUR);
    db = await state(t);
    expect(lastRun(db).counts.reappeared).toBe(1);
    expect(db.posts.find((p) => p.externalId === idOf(2))!.removedAt).toBeUndefined();
  });

  it("the mass-removal veto skips marking and audits it", async () => {
    const dayBack = (i: number) => new Date(NOW.getTime() - i * DAY).toISOString().slice(0, 10);
    user.media = Array.from({ length: 30 }, (_, i) => media(i + 1, dayBack(i)));
    stubLiveInstagram(fake);
    const t = newBackend();
    await linkedInstagram(t);
    await planAndDrain(t);
    // 27 of 30 vanish; the oldest post stays, so all 27 are newer than the bound.
    user.media = [user.media![0]!, user.media![1]!, user.media![29]!];
    await at(t, NOW.getTime() + DAY + HOUR);
    const db = await state(t);
    const run = lastRun(db);
    expect(run.status).toBe("partial");
    expect(run.error).toMatchObject({ kind: "suspicious_empty_listing" });
    expect(db.posts.every((p) => p.removedAt === undefined)).toBe(true);
    expect(db.audit.find((e) => e.action === "sync.removal_skipped")?.changes).toMatchObject({
      table: { to: "socialPosts" },
    });
  });

  it("F9: incremental listings stop at the first page of known posts", async () => {
    user.media = Array.from({ length: 250 }, (_, i) =>
      i < 3 ? media(i + 1, "2026-09-2" + String(i + 1)) : media(i + 1, "2025-01-01"),
    );
    stubLiveInstagram(fake);
    const t = newBackend();
    await linkedInstagram(t);
    await planAndDrain(t);
    const listing = `/v25.0/${USER_ID}/media`;
    expect(fake.count(listing)).toBe(3 + 1); // full listing: 3 pages; snapshots: 1 page

    fake.reset();
    await at(t, NOW.getTime() + HOUR + 60_000); // incremental due
    let db = await state(t);
    expect(lastRun(db)).toMatchObject({ kind: "incremental", status: "succeeded" });
    expect(fake.count(listing)).toBe(1); // page 1 entirely known: stop

    user.media = [media(900, "2026-09-28"), ...user.media!];
    fake.reset();
    await at(t, NOW.getTime() + 2 * HOUR + 2 * 60_000);
    db = await state(t);
    expect(fake.count(listing)).toBe(2); // page 1 had a new post; page 2 all known: stop
    expect(db.posts.map((p) => p.externalId)).toContain(idOf(900));
    expect(db.posts).toHaveLength(251);
  });

  it("a post deleted between listing and insights is skipped and counted (never zero-filled)", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    await linkedInstagram(t);
    user.media![0]!.deleted = true;
    await planAndDrain(t);
    const db = await state(t);
    const run = db.runs[0]!;
    expect(run.status).toBe("partial");
    expect(run.counts.unresolved).toBe(1);
    const deletedPost = db.posts.find((p) => p.externalId === idOf(1))!;
    expect(db.snapshots.some((s) => s.postId === deletedPost._id)).toBe(false);
  });
});

describe("F11 account-type drift and R11 recovery", () => {
  it("blocks on Business <-> Media_Creator drift; reconnect + link + a successful sync unblocks", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    const { connectionId, socialAccountId } = await linkedInstagram(t);
    await planAndDrain(t);

    user.accountType = "Media_Creator";
    await at(t, NOW.getTime() + HOUR + 60_000);
    let db = await state(t);
    const failed = lastRun(db);
    expect(failed).toMatchObject({ status: "failed", error: { kind: "account_changed" } });
    expect(db.accounts[0]).toMatchObject({
      state: "blocked",
      lastError: { kind: "account_changed" },
    });
    expect(db.socialAccounts[0]!.accountType).toBe("business"); // never silently updated
    const changed = db.audit.find((e) => e.action === "sync.account_attributes_changed")!;
    expect(changed).toMatchObject({ targetType: "socialAccount", targetId: socialAccountId });
    expect(changed.changes).toMatchObject({
      attribute: { to: "account_type" },
      accountType: { from: "business", to: "creator" },
    });
    expect(db.audit.map((e) => e.action)).toContain("sync.account_blocked");

    // Still blocked on the next recheck while nobody re-links.
    await at(t, NOW.getTime() + HOUR + DAY + 2 * 60_000);
    db = await state(t);
    expect(db.accounts[0]!.state).toBe("blocked");
    expect(db.socialAccounts[0]!.accountType).toBe("business");

    // Admin: reconnect (fresh discovery) and link.
    await connectInstagramFake(t, fake, "business", {}, { reconnectConnectionId: connectionId });
    await linkSocial(t, connectionId, [USER_ID]);
    db = await state(t);
    expect(db.socialAccounts[0]!.accountType).toBe("creator");

    // The next successful sync unblocks (audited).
    await at(t, NOW.getTime() + HOUR + 2 * DAY + 3 * 60_000);
    db = await state(t);
    expect(lastRun(db).status).toBe("succeeded");
    expect(db.accounts[0]).toMatchObject({ state: "idle" });
    expect(db.accounts[0]!.lastError).toBeUndefined();
    expect(db.audit.map((e) => e.action)).toContain("sync.account_unblocked");
  });
});

describe("idempotency", () => {
  it("rerunning the same day rewrites identical rows; a replayed page is discarded", async () => {
    stubLiveInstagram(fake);
    const t = newBackend();
    await linkedInstagram(t);
    await planAndDrain(t);
    const values = async () => {
      const db = await state(t);
      const strip = <T extends Record<string, unknown>>(rows: T[], drop: string[]) =>
        rows
          .map((row) =>
            Object.fromEntries(
              Object.entries(row).filter(([k]) => !["_id", "_creationTime", ...drop].includes(k)),
            ),
          )
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return {
        posts: strip(db.posts, ["lastSeenAt", "updatedAt"]),
        snapshots: strip(db.snapshots, ["capturedAt"]),
        daily: strip(db.daily, ["syncedAt", "insightsSyncedAt", "followersCapturedAt"]),
      };
    };
    const first = await values();
    // Same UTC day, next planner slot: force a lookback (re-lists, re-snapshots, re-reads days).
    const row = (await state(t)).accounts[0]!;
    await t.run((ctx) => ctx.db.patch(row._id, { nextLookbackAt: 0, nextPlanAt: 0 }));
    await at(t, NOW.getTime() + 20 * 60_000);
    expect(lastRun(await state(t))).toMatchObject({ kind: "lookback", status: "succeeded" });
    expect(await values()).toEqual(first);
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

  it("syncs the ad account as before and the social account with mock data", async () => {
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
      status: "succeeded",
      platform: "instagram",
      providerId: "mock-social",
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
    // Organic data never enters ad metrics, and ad data never enters organic tables.
    const metrics = await t.run((ctx) => ctx.db.query("metricsDaily").collect());
    expect(metrics.every((m) => m.adAccountId === adAccountId)).toBe(true);
    expect(db.posts.length).toBeGreaterThan(0);
    for (const row of [...db.posts, ...db.snapshots, ...db.daily]) {
      expect(row.socialAccountId).toBe(socialAccountId);
    }
  });

  it("mock mode: a deterministic initial sync (same rows in two fresh backends)", async () => {
    const run = async () => {
      const t = newBackend();
      await setupSyncOrg(t);
      const connection = (await connectMockInstagram(t, "1")).get("connection")!;
      await linkSocial(t, connection, [mockInstagramAccountId("1")]);
      await planAndDrain(t);
      const db = await state(t);
      expect(db.runs[0]).toMatchObject({ kind: "initial", status: "succeeded" });
      const posts = new Map(db.posts.map((p) => [p._id, p.externalId]));
      const clean = (row: Record<string, unknown>) =>
        Object.fromEntries(
          Object.entries(row)
            .filter(([k]) => !["_id", "_creationTime", "orgId", "socialAccountId"].includes(k))
            .map(([k, v]) => [k, k === "postId" ? posts.get(v as Id<"socialPosts">) : v]),
        );
      return {
        posts: db.posts
          .map(clean)
          .sort((a, b) => String(a.externalId).localeCompare(String(b.externalId))),
        snapshots: db.snapshots
          .map(clean)
          .sort((a, b) => String(a.postId).localeCompare(String(b.postId))),
        daily: db.daily.map(clean).sort((a, b) => String(a.date).localeCompare(String(b.date))),
        account: clean(db.socialAccounts[0]!),
      };
    };
    const a = await run();
    const b = await run();
    expect(b).toEqual(a);
    expect(a.posts.length).toBeGreaterThan(0);
    expect(a.snapshots.length).toBeGreaterThan(0);
    expect(a.daily).toHaveLength(30);
  });

  it("the ads worker refuses a social task and the social worker refuses an ad task", async () => {
    const t = newBackend();
    const { adAccountId, socialAccountId } = await both(t);
    await t.mutation(internal.sync.planner.tick, {});
    const tasks = await t.run((ctx) => ctx.db.query("syncTasks").collect());
    const socialTask = tasks.find(
      (task) => task.socialAccountId === socialAccountId && task.seq === 0,
    )!;
    const adTask = tasks.find((task) => task.adAccountId === adAccountId && task.seq === 0)!;

    await t.action(internal.sync.worker.runTask, { taskId: socialTask._id });
    await t.action(internal.sync.socialWorker.runTask, { taskId: adTask._id });

    const runs = await t.run((ctx) => ctx.db.query("syncRuns").collect());
    for (const run of runs) {
      expect(run.status).toBe("failed");
      expect(run.error?.kind).toBe("internal");
    }
  });

  it("a social task can never commit an ad page, and an ad task never a social page", async () => {
    const t = newBackend();
    const { socialAccountId, adAccountId } = await both(t);
    await t.mutation(internal.sync.planner.tick, {});
    const tasks = await t.run((ctx) => ctx.db.query("syncTasks").collect());
    const socialTask = tasks.find(
      (row) => row.socialAccountId === socialAccountId && row.seq === 0,
    )!;
    const claim = await t.mutation(internal.sync.runs.claimTask, { taskId: socialTask._id });
    if (claim.status !== "fetch") throw new Error("expected a claim");
    expect(claim.subject).toBe("social");
    const result = await t.mutation(internal.sync.runs.commitPage, {
      taskId: socialTask._id,
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

    const adTask = tasks.find((row) => row.adAccountId === adAccountId && row.seq === 0)!;
    const adClaim = await t.mutation(internal.sync.runs.claimTask, { taskId: adTask._id });
    if (adClaim.status !== "fetch") throw new Error("expected a claim");
    const refused = await t.mutation(internal.sync.runs.commitSocialPage, {
      taskId: adTask._id,
      claimSeq: adClaim.claimSeq,
      page: {
        kind: "socialAccount",
        items: [
          {
            platform: "instagram",
            externalId: mockInstagramAccountId("1"),
            name: "x",
            accountType: "business",
            status: "active",
          },
        ],
      },
    });
    expect(refused).toEqual({ ok: false, reason: "invalid_record" });
    const db = await state(t);
    expect(db.socialAccounts[0]!.name).not.toBe("x"); // nothing written through either task
    expect(await t.run((ctx) => ctx.db.query("adAccounts").collect())).toHaveLength(1);
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
    expect(await t.run((ctx) => ctx.db.query("socialPosts").collect())).toEqual([]);
  });
});
