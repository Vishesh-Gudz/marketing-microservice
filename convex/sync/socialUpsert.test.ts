import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { socialAccountScopeFromDoc } from "../mapping/scope";
import { mockInstagramAccountId } from "../providers/social/mock";
import type {
  ProviderSocialAccount,
  ProviderSocialAccountDay,
  ProviderSocialPost,
  ProviderSocialPostSnapshot,
} from "../providers/social/types";
import {
  connectMockInstagram,
  linkSocial,
  newBackend,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";
import {
  refreshSocialAccount,
  SOCIAL_DAY_COLUMN_GROUPS,
  socialAccountDrift,
  writeSocialAccountDayPage,
  writeSocialPostPage,
  writeSocialSnapshotPage,
} from "./upsert";

// Phase 10 Stage B: the social canonical write path (sync/upsert.ts), exercised directly:
// column-group replacement both ways with provenance (F7), follower capture into today's UTC
// row, post upserts / reappearance, snapshots of unknown posts (F8), idempotent reruns,
// and no URL other than the permalink ever stored.

vi.setConfig({ testTimeout: 60_000 });
const NOW = Date.UTC(2026, 8, 28, 12);
const EXTERNAL = mockInstagramAccountId("1");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function linked(t: Backend): Promise<Doc<"socialAccounts">> {
  await setupSyncOrg(t);
  const connectionId = (await connectMockInstagram(t, "1")).get("connection")!;
  const [account] = await linkSocial(t, connectionId, [EXTERNAL]);
  return (await t.run((ctx) => ctx.db.get(account!.id as Id<"socialAccounts">)))!;
}

const profile = (overrides: Partial<ProviderSocialAccount> = {}): ProviderSocialAccount => ({
  platform: "instagram",
  externalId: EXTERNAL,
  username: "mock_1",
  name: "Mock One",
  accountType: "business",
  followersCount: 1_500,
  status: "active",
  ...overrides,
});

const day = (date: string, values: Partial<ProviderSocialAccountDay> = {}) =>
  ({
    platform: "instagram",
    accountExternalId: EXTERNAL,
    date,
    ...values,
  }) as ProviderSocialAccountDay;

const post = (id: string, values: Partial<ProviderSocialPost> = {}): ProviderSocialPost => ({
  platform: "instagram",
  accountExternalId: EXTERNAL,
  externalId: id,
  type: "image",
  publishedAt: Date.UTC(2026, 8, 20),
  ...values,
});

async function days(t: Backend) {
  return await t.run((ctx) => ctx.db.query("socialAccountMetricsDaily").collect());
}

function strip<T extends { _id: unknown; _creationTime: unknown }>(row: T) {
  const { _id, _creationTime, ...rest } = row;
  return rest;
}

describe("preflight refresh + follower capture (profile column group)", () => {
  it("replaces provider fields, clears any picture URL, captures followers into today's UTC row", async () => {
    const t = newBackend();
    const account = await linked(t);
    await t.run((ctx) =>
      ctx.db.patch(account._id, { profilePictureUrl: "https://scontent.example.test/x.jpg" }),
    );
    const counts = await t.run(async (ctx) =>
      refreshSocialAccount(ctx.db, account, socialAccountScopeFromDoc(account), profile(), NOW),
    );
    expect(counts).toMatchObject({ updated: 1, inserted: 1, metricRows: 1 });
    const stored = (await t.run((ctx) => ctx.db.get(account._id)))!;
    expect(stored).toMatchObject({
      name: "Mock One",
      username: "mock_1",
      followersCount: 1_500,
      accountType: "business",
      lastSeenAt: NOW,
    });
    expect(stored.profilePictureUrl).toBeUndefined();
    const [row] = await days(t);
    expect(strip(row!)).toEqual({
      orgId: account.orgId,
      socialAccountId: account._id,
      platform: "instagram",
      date: "2026-09-28",
      followers: 1_500,
      followersCapturedAt: NOW,
      syncedAt: NOW,
    });
  });

  it("an unknown follower count clears the value but keeps the capture time", async () => {
    const t = newBackend();
    const account = await linked(t);
    const scope = socialAccountScopeFromDoc(account);
    await t.run((ctx) => refreshSocialAccount(ctx.db, account, scope, profile(), NOW));
    const { followersCount: _omit, ...unknown } = profile();
    await t.run((ctx) => refreshSocialAccount(ctx.db, account, scope, unknown, NOW + 60_000));
    const [row] = await days(t);
    expect(row!.followers).toBeUndefined();
    expect(row!.followersCapturedAt).toBe(NOW + 60_000);
    expect((await t.run((ctx) => ctx.db.get(account._id)))!.followersCount).toBeUndefined();
  });

  it("detects account-type drift (never applied by the write path)", async () => {
    const t = newBackend();
    const account = await linked(t);
    expect(socialAccountDrift(account, profile())).toBeUndefined();
    expect(socialAccountDrift(account, profile({ accountType: "creator" }))).toBe("account_type");
  });
});

describe("account days (insights column group)", () => {
  it("replaces only the insights group; absent metrics are cleared, zeros kept", async () => {
    const t = newBackend();
    const account = await linked(t);
    const scope = socialAccountScopeFromDoc(account);
    await t.run((ctx) =>
      writeSocialAccountDayPage(
        ctx.db,
        scope,
        [
          day("2026-09-27", {
            reach: 10,
            views: 20,
            totalInteractions: 0,
            followerDelta: -2,
            extras: { likes: 3, replies: 0 },
          }),
        ],
        NOW,
      ),
    );
    await t.run((ctx) =>
      writeSocialAccountDayPage(ctx.db, scope, [day("2026-09-27", { reach: 11 })], NOW + 1_000),
    );
    const [row] = await days(t);
    expect(strip(row!)).toEqual({
      orgId: account.orgId,
      socialAccountId: account._id,
      platform: "instagram",
      date: "2026-09-27",
      reach: 11,
      insightsSyncedAt: NOW + 1_000,
      syncedAt: NOW + 1_000,
    });
  });

  it("an empty synced day is a row with insightsSyncedAt and no metrics (not reported != unknown)", async () => {
    const t = newBackend();
    const account = await linked(t);
    await t.run((ctx) =>
      writeSocialAccountDayPage(
        ctx.db,
        socialAccountScopeFromDoc(account),
        [day("2026-09-26")],
        NOW,
      ),
    );
    const [row] = await days(t);
    expect(strip(row!)).toEqual({
      orgId: account.orgId,
      socialAccountId: account._id,
      platform: "instagram",
      date: "2026-09-26",
      insightsSyncedAt: NOW,
      syncedAt: NOW,
    });
  });

  it("column groups never clobber each other, in both directions", async () => {
    const t = newBackend();
    const account = await linked(t);
    const scope = socialAccountScopeFromDoc(account);
    // insights first, then the profile capture of the same day
    await t.run((ctx) =>
      writeSocialAccountDayPage(ctx.db, scope, [day("2026-09-28", { reach: 5, views: 7 })], NOW),
    );
    await t.run((ctx) => refreshSocialAccount(ctx.db, account, scope, profile(), NOW + 1));
    let [row] = await days(t);
    expect(row).toMatchObject({
      reach: 5,
      views: 7,
      insightsSyncedAt: NOW,
      followers: 1_500,
      followersCapturedAt: NOW + 1,
      syncedAt: NOW + 1,
    });
    // insights rewrite (now empty) keeps the profile group
    await t.run((ctx) => writeSocialAccountDayPage(ctx.db, scope, [day("2026-09-28")], NOW + 2));
    [row] = await days(t);
    expect(row).toMatchObject({ followers: 1_500, followersCapturedAt: NOW + 1 });
    expect(row!.reach).toBeUndefined();
    expect(row!.views).toBeUndefined();
    expect(row!.insightsSyncedAt).toBe(NOW + 2);
    // profile rewrite keeps the (empty) insights group and its provenance
    await t.run((ctx) =>
      refreshSocialAccount(ctx.db, account, scope, profile({ followersCount: 1_501 }), NOW + 3),
    );
    [row] = await days(t);
    expect(row).toMatchObject({
      followers: 1_501,
      followersCapturedAt: NOW + 3,
      insightsSyncedAt: NOW + 2,
    });
    expect(await days(t)).toHaveLength(1);
  });

  it("deprecated columns are never kept (profileViews / websiteClicks)", async () => {
    const t = newBackend();
    const account = await linked(t);
    const scope = socialAccountScopeFromDoc(account);
    await t.run((ctx) => writeSocialAccountDayPage(ctx.db, scope, [day("2026-09-25")], NOW));
    const [seeded] = await days(t);
    await t.run((ctx) => ctx.db.patch(seeded!._id, { profileViews: 4, websiteClicks: 2 }));
    await t.run((ctx) => writeSocialAccountDayPage(ctx.db, scope, [day("2026-09-25")], NOW + 1));
    const [row] = await days(t);
    expect(row!.profileViews).toBeUndefined();
    expect(row!.websiteClicks).toBeUndefined();
  });

  it("rerunning the same page gives identical rows", async () => {
    const t = newBackend();
    const account = await linked(t);
    const scope = socialAccountScopeFromDoc(account);
    const page = [day("2026-09-20", { reach: 1 }), day("2026-09-21", { views: 0 })];
    await t.run((ctx) => writeSocialAccountDayPage(ctx.db, scope, page, NOW));
    const first = (await days(t)).map(strip);
    await t.run((ctx) => writeSocialAccountDayPage(ctx.db, scope, page, NOW));
    expect((await days(t)).map(strip)).toEqual(first);
  });

  it("the groups partition the metric columns", () => {
    const all = [...SOCIAL_DAY_COLUMN_GROUPS.profile, ...SOCIAL_DAY_COLUMN_GROUPS.insights];
    expect(new Set(all).size).toBe(all.length);
    expect(all).not.toContain("profileViews");
    expect(all).not.toContain("websiteClicks");
  });
});

describe("posts", () => {
  it("inserts, updates, reports known posts and clears a removal", async () => {
    const t = newBackend();
    const account = await linked(t);
    const scope = socialAccountScopeFromDoc(account);
    const first = await t.run((ctx) =>
      writeSocialPostPage(
        ctx.db,
        scope,
        [post("17900000000000001", { caption: "a", permalink: "https://www.instagram.com/p/A/" })],
        NOW,
      ),
    );
    expect(first).toMatchObject({ known: 0, counts: { inserted: 1 } });
    const [row] = await t.run((ctx) => ctx.db.query("socialPosts").collect());
    await t.run((ctx) => ctx.db.patch(row!._id, { removedAt: NOW, mediaUrl: "https://x.test/m" }));
    const again = await t.run((ctx) =>
      writeSocialPostPage(ctx.db, scope, [post("17900000000000001", { caption: "b" })], NOW + 1),
    );
    expect(again).toMatchObject({ known: 0, counts: { updated: 1, reappeared: 1 } });
    const third = await t.run((ctx) =>
      writeSocialPostPage(ctx.db, scope, [post("17900000000000001", { caption: "b" })], NOW + 2),
    );
    expect(third).toMatchObject({ known: 1, counts: { updated: 1, reappeared: 0 } });
    const [stored] = await t.run((ctx) => ctx.db.query("socialPosts").collect());
    expect(strip(stored!)).toEqual({
      orgId: account.orgId,
      socialAccountId: account._id,
      platform: "instagram",
      externalId: "17900000000000001",
      type: "image",
      caption: "b",
      publishedAt: Date.UTC(2026, 8, 20),
      lastSeenAt: NOW + 2,
      createdAt: NOW,
      updatedAt: NOW + 2,
    });
  });
});

describe("snapshots", () => {
  const snapshot = (
    postId: string,
    capturedAt: number,
    values = {},
  ): ProviderSocialPostSnapshot => ({
    platform: "instagram",
    accountExternalId: EXTERNAL,
    postExternalId: postId,
    capturedDate: new Date(capturedAt).toISOString().slice(0, 10),
    capturedAt,
    ...values,
  });

  it("skips snapshots of posts not stored yet (F8) and never creates the post", async () => {
    const t = newBackend();
    const account = await linked(t);
    const counts = await t.run((ctx) =>
      writeSocialSnapshotPage(ctx.db, socialAccountScopeFromDoc(account), [
        snapshot("17900000000000009", NOW, { likes: 1 }),
      ]),
    );
    expect(counts).toMatchObject({ unresolved: 1, metricRows: 0 });
    expect(await t.run((ctx) => ctx.db.query("socialPosts").collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query("socialPostMetricSnapshots").collect())).toEqual([]);
  });

  it("one row per post per UTC capture day; the last capture of a day wins", async () => {
    const t = newBackend();
    const account = await linked(t);
    const scope = socialAccountScopeFromDoc(account);
    await t.run((ctx) => writeSocialPostPage(ctx.db, scope, [post("17900000000000001")], NOW));
    await t.run((ctx) =>
      writeSocialSnapshotPage(ctx.db, scope, [
        snapshot("17900000000000001", NOW, { likes: 1, reach: 0 }),
      ]),
    );
    await t.run((ctx) =>
      writeSocialSnapshotPage(ctx.db, scope, [
        snapshot("17900000000000001", NOW + 1_000, { likes: 2 }),
      ]),
    );
    await t.run((ctx) =>
      writeSocialSnapshotPage(ctx.db, scope, [
        snapshot("17900000000000001", NOW + 86_400_000, { likes: 3 }),
      ]),
    );
    const rows = await t.run((ctx) => ctx.db.query("socialPostMetricSnapshots").collect());
    expect(rows.map((r) => [r.capturedDate, r.likes, r.reach])).toEqual([
      ["2026-09-28", 2, undefined],
      ["2026-09-29", 3, undefined],
    ]);
  });
});
