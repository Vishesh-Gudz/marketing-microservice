import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isProviderError } from "../../errors";
import { socialRecordIssues } from "../validate";
import { mockMedia } from "./data";
import { createMockSocialProvider, mockInstagramAccountId } from ".";

// Phase 10 Stage B (F15): the mock social provider serves deterministic data through the
// real Instagram mapping, with the same exclusions, unresolved counts and edge cases.

const NOW = new Date("2026-09-28T12:00:00Z");
const provider = createMockSocialProvider();
const ctx = (user = "1") => ({
  credential: { kind: "mock_social", token: `mock-ig-token-${user}`, user },
  attempt: 1,
});
const account = (user = "1") => ({ accountExternalId: mockInstagramAccountId(user) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

async function allPosts(user = "1") {
  const posts = [];
  let cursor: string | undefined;
  let unresolved = 0;
  do {
    const page = await provider.listPosts(ctx(user), {
      ...account(user),
      ...(cursor ? { cursor } : {}),
    });
    posts.push(...page.items);
    unresolved += page.unresolved ?? 0;
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return { posts, unresolved };
}

describe("mock social provider", () => {
  it("is deterministic for the same instant", async () => {
    const a = await allPosts();
    const b = await allPosts();
    expect(b).toEqual(a);
    const days1 = await provider.fetchAccountMetrics(ctx(), {
      ...account(),
      from: "2026-09-01",
      to: "2026-09-10",
    });
    const days2 = await provider.fetchAccountMetrics(ctx(), {
      ...account(),
      from: "2026-09-01",
      to: "2026-09-10",
    });
    expect(days2).toEqual(days1);
  });

  it("covers every post type; AD and STORY are listed by the platform but never ingested", async () => {
    const media = mockMedia("1", "2026-09-28");
    const products = new Set(media.map((m) => m.mediaProductType));
    expect(products).toEqual(new Set(["FEED", "REELS", "AD", "STORY"]));
    const { posts, unresolved } = await allPosts();
    expect(new Set(posts.map((p) => p.type))).toEqual(
      new Set(["image", "video", "reel", "carousel"]),
    );
    const excluded = media.filter(
      (m) => m.mediaProductType === "AD" || m.mediaProductType === "STORY",
    );
    expect(excluded.length).toBeGreaterThan(0);
    for (const m of excluded) expect(posts.map((p) => p.externalId)).not.toContain(m.id);
    expect(unresolved).toBe(0);
    for (const post of posts) {
      expect(socialRecordIssues("socialPost", post)).toEqual([]);
      expect(post.permalink).toMatch(/^https:\/\/www\.instagram\.com\/p\//);
    }
    // Stable ids: a post keeps its id when the listing moves forward a day.
    const tomorrow = mockMedia("1", "2026-09-29");
    expect(tomorrow.map((m) => m.id)).toEqual(
      expect.arrayContaining(media.slice(0, 5).map((m) => m.id)),
    );
  });

  it("user 'edge' has a media item without a product type (unresolved, R3)", async () => {
    const { unresolved } = await allPosts("edge");
    expect(unresolved).toBeGreaterThan(0);
  });

  it("snapshots: in-window organic posts only; missing stays absent, zeros stay zero", async () => {
    const snapshots = [];
    let cursor: string | undefined;
    do {
      const page = await provider.fetchPostMetrics(ctx(), {
        ...account(),
        publishedFrom: "2026-07-01",
        ...(cursor ? { cursor } : {}),
      });
      expect(page.items.length).toBeLessThanOrEqual(10);
      snapshots.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    const media = mockMedia("1", "2026-09-28");
    const inWindow = media.filter(
      (m) =>
        m.timestamp! >= "2026-07-01" &&
        m.mediaProductType !== "AD" &&
        m.mediaProductType !== "STORY",
    );
    expect(snapshots.map((s) => s.postExternalId)).toEqual(inWindow.map((m) => m.id));
    for (const s of snapshots) {
      expect(socialRecordIssues("socialPostSnapshot", s)).toEqual([]);
      expect(s.capturedDate).toBe("2026-09-28");
    }
    expect(snapshots.some((s) => s.shares === 0 && s.comments === 0 && s.views === undefined)).toBe(
      true,
    );
    // A post published today has nothing reported yet.
    const today = snapshots.find((s) => s.postExternalId === media[0]!.id);
    if (media[0]!.timestamp!.startsWith("2026-09-28") && today !== undefined) {
      expect(today.likes).toBeUndefined();
    }
  });

  it("account days: one record per day, empty days, explicit zeros, 15 days per page", async () => {
    const first = await provider.fetchAccountMetrics(ctx(), {
      ...account(),
      from: "2026-09-01",
      to: "2026-09-28",
    });
    expect(first.items).toHaveLength(15);
    expect(first.nextCursor).toBeDefined();
    const second = await provider.fetchAccountMetrics(ctx(), {
      ...account(),
      from: "2026-09-01",
      to: "2026-09-28",
      cursor: first.nextCursor!,
    });
    const days = [...first.items, ...second.items];
    expect(days.map((d) => d.date)).toHaveLength(28);
    expect(second.nextCursor).toBeUndefined();
    const keys = (d: object) => Object.keys(d).sort().join(",");
    expect(days.some((d) => keys(d) === "accountExternalId,date,platform")).toBe(true); // empty
    expect(days.some((d) => d.totalInteractions === 0)).toBe(true);
    expect(days.some((d) => d.followerDelta !== undefined)).toBe(true);
    for (const d of days) expect(socialRecordIssues("socialAccountDay", d)).toEqual([]);
  });

  it("user 'small' (under 100 followers) never has a followerDelta", async () => {
    const page = await provider.fetchAccountMetrics(ctx("small"), {
      ...account("small"),
      from: "2026-09-01",
      to: "2026-09-15",
    });
    expect(page.items.every((d) => d.followerDelta === undefined)).toBe(true);
    expect((await provider.getAccount(ctx("small"), account("small"))).followersCount).toBeLessThan(
      100,
    );
  });

  it("fails like the real provider: revoked token, foreign account, unsupported type", async () => {
    const codes = async (promise: Promise<unknown>) => {
      const error = await promise.catch((e: unknown) => e);
      if (!isProviderError(error)) throw new Error("expected ProviderError");
      return [error.kind, error.providerCode];
    };
    expect(
      await codes(
        provider.getAccount(
          { credential: { kind: "mock_social", token: "revoked", user: "revoked" }, attempt: 1 },
          account("revoked"),
        ),
      ),
    ).toEqual(["auth", "190"]);
    expect(await codes(provider.listPosts(ctx("1"), account("2")))).toEqual([
      "permission",
      "account_mismatch",
    ]);
    expect(await codes(provider.getAccount(ctx("personal"), account("personal")))).toEqual([
      "permission",
      "account_type_unsupported",
    ]);
    expect(
      await codes(provider.listPosts(ctx(), { ...account(), cursor: "mocks1.100.x" })),
    ).toEqual(["invalid_request", "cursor_invalid"]);
  });
});
