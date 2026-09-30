import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Doc, Id } from "../_generated/dataModel";
import { socialAccountScopeFromDoc } from "../mapping/scope";
import { mockInstagramAccountId } from "../providers/social/mock";
import {
  connectMockInstagram,
  linkSocial,
  newBackend,
  setupSyncOrg,
  type Backend,
} from "../test.helpers";
import { SYNC_LIMITS } from "./config";
import {
  markRemovedSocialPostsBatch,
  writeSocialPostPage,
  type SocialRemovalCursor,
} from "./upsert";

// Phase 10 Stage B (I-D13): bounded removal of posts after a complete full listing. Only
// posts newer than the oldest post the listing ingested can be marked; nothing is marked
// when the listing ingested nothing; the mass-removal veto applies; rows are never deleted.

vi.setConfig({ testTimeout: 60_000 });
const LISTING = Date.UTC(2026, 8, 28, 12); // fetchStartedAt of the full listing
const EARLIER = LISTING - 86_400_000;
const EXTERNAL = mockInstagramAccountId("1");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(LISTING);
});
afterEach(() => vi.useRealTimers());

async function linked(t: Backend): Promise<Doc<"socialAccounts">> {
  await setupSyncOrg(t);
  const connectionId = (await connectMockInstagram(t, "1")).get("connection")!;
  const [account] = await linkSocial(t, connectionId, [EXTERNAL]);
  return (await t.run((ctx) => ctx.db.get(account!.id as Id<"socialAccounts">)))!;
}

const id = (n: number) => `179000000000${String(n).padStart(5, "0")}`;
const day = (n: number) => Date.UTC(2026, 5, 1) + n * 86_400_000;

/** Stores posts 1..count (post n published on day n), all last seen EARLIER. */
async function seedPosts(t: Backend, account: Doc<"socialAccounts">, count: number) {
  const scope = socialAccountScopeFromDoc(account);
  const posts = Array.from({ length: count }, (_, i) => ({
    platform: "instagram" as const,
    accountExternalId: EXTERNAL,
    externalId: id(i + 1),
    type: "image" as const,
    publishedAt: day(i + 1),
  }));
  await t.run((ctx) => writeSocialPostPage(ctx.db, scope, posts, EARLIER));
}

/** The listing of this run saw exactly these posts. */
async function seen(t: Backend, account: Doc<"socialAccounts">, ns: number[]) {
  const scope = socialAccountScopeFromDoc(account);
  await t.run(async (ctx) => {
    for (const n of ns) {
      await writeSocialPostPage(
        ctx.db,
        scope,
        [
          {
            platform: "instagram",
            accountExternalId: EXTERNAL,
            externalId: id(n),
            type: "image",
            publishedAt: day(n),
          },
        ],
        LISTING,
      );
    }
  });
}

async function finalize(t: Backend, account: Doc<"socialAccounts">, limit = 3) {
  const scope = socialAccountScopeFromDoc(account);
  let cursor: SocialRemovalCursor | undefined;
  let removed = 0;
  for (let i = 0; i < 100; i++) {
    const result = await t.run((ctx) =>
      markRemovedSocialPostsBatch(ctx.db, {
        scope,
        before: LISTING,
        now: LISTING + 1,
        cursor,
        limit,
        maxShare: SYNC_LIMITS.massRemovalMaxShare,
        minCount: SYNC_LIMITS.massRemovalMinCount,
      }),
    );
    if (result.status === "vetoed") return { vetoed: true, removed, ...result };
    removed += result.removed;
    if (result.status === "done") return { vetoed: false, removed };
    cursor = result.next;
  }
  throw new Error("finalize did not terminate");
}

async function removedIds(t: Backend) {
  const rows = await t.run((ctx) => ctx.db.query("socialPosts").collect());
  return rows
    .filter((r) => r.removedAt !== undefined)
    .map((r) => r.externalId)
    .sort();
}

describe("bounded post removal", () => {
  it("marks only unseen posts newer than the oldest post the listing ingested", async () => {
    const t = newBackend();
    const account = await linked(t);
    await seedPosts(t, account, 10);
    // The listing (newest first, limited) saw posts 4..10 except 7: 1..3 are beyond its reach.
    await seen(t, account, [4, 5, 6, 8, 9, 10]);
    const result = await finalize(t, account);
    expect(result).toMatchObject({ vetoed: false, removed: 1 });
    expect(await removedIds(t)).toEqual([id(7)]);
    // Never hard-deleted.
    expect(await t.run((ctx) => ctx.db.query("socialPosts").collect())).toHaveLength(10);
  });

  it("marks nothing when the listing ingested nothing", async () => {
    const t = newBackend();
    const account = await linked(t);
    await seedPosts(t, account, 5);
    expect(await finalize(t, account)).toMatchObject({ vetoed: false, removed: 0 });
    expect(await removedIds(t)).toEqual([]);
  });

  it("vetoes a mass removal (more than 20 posts and more than half)", async () => {
    const t = newBackend();
    const account = await linked(t);
    await seedPosts(t, account, 30);
    await seen(t, account, [1, 2, 3, 30]); // bound = post 1: 26 of the 29 newer posts unseen
    const result = await finalize(t, account, 50);
    expect(result).toMatchObject({ vetoed: true, candidates: 26, alive: 29 });
    expect(await removedIds(t)).toEqual([]);
  });

  it("does not veto a small removal and keeps already-removed rows as they are", async () => {
    const t = newBackend();
    const account = await linked(t);
    await seedPosts(t, account, 6);
    const [first] = await t.run((ctx) => ctx.db.query("socialPosts").collect());
    await t.run((ctx) => ctx.db.patch(first!._id, { removedAt: EARLIER }));
    await seen(t, account, [2, 3, 6]);
    const result = await finalize(t, account);
    expect(result).toMatchObject({ vetoed: false, removed: 2 });
    expect(await removedIds(t)).toEqual([id(1), id(4), id(5)]);
    const rows = await t.run((ctx) => ctx.db.query("socialPosts").collect());
    expect(rows.find((r) => r.externalId === id(1))!.removedAt).toBe(EARLIER);
  });
});
