import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdPlatform } from "../../domain/types";
import { collectAll } from "../pagination";
import type { AdsProvider, ProviderContext } from "../types";
import { createMockAdsProvider, mockCredential, type MockCredential } from ".";

const ctx = (attempt = 1): ProviderContext<MockCredential> => ({
  credential: mockCredential(),
  attempt,
});

async function snapshot(p: AdsProvider<MockCredential>, account: string) {
  const all = <T>(fetch: (c: string | undefined) => Promise<{ items: T[]; nextCursor?: string }>) =>
    collectAll(fetch).then((r) => r.items);
  const req = (cursor?: string) => ({ accountExternalId: account, ...(cursor ? { cursor } : {}) });
  const metrics = (cursor?: string) => ({
    accountExternalId: account,
    level: "ad" as const,
    breakdown: "placement" as const,
    from: "2026-03-01",
    to: "2026-03-10",
    ...(cursor ? { cursor } : {}),
  });
  return {
    accounts: await all((c) => p.listAccounts(ctx(), c ? { cursor: c } : {})),
    campaigns: await all((c) => p.listCampaigns(ctx(), req(c))),
    adGroups: await all((c) => p.listAdGroups(ctx(), req(c))),
    ads: await all((c) => p.listAds(ctx(), req(c))),
    creatives: await all((c) => p.listCreatives(ctx(), req(c))),
    metrics: await all((c) => p.fetchDailyMetrics(ctx(), metrics(c))),
    actions: await all((c) => p.fetchActionMetrics(ctx(), metrics(c))),
  };
}

const CASES = [
  ["meta", "1001"],
  ["google_ads", "1112223333"],
] as const satisfies readonly (readonly [AdPlatform, string])[];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("determinism", () => {
  it.each(CASES)("%s: independent instances return identical data", async (platform, account) => {
    const a = await snapshot(createMockAdsProvider({ platform }), account);
    const b = await snapshot(createMockAdsProvider({ platform }), account);
    expect(a.metrics.length).toBeGreaterThan(0);
    expect(a.actions.length).toBeGreaterThan(0);
    expect(b).toEqual(a);
  });

  it.each(CASES)(
    "%s: output does not depend on the clock or Math.random",
    async (platform, account) => {
      const baseline = await snapshot(createMockAdsProvider({ platform }), account);
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2031-07-04T12:00:00Z"));
      vi.spyOn(Math, "random").mockImplementation(() => {
        throw new Error("Math.random must not be used");
      });
      expect(await snapshot(createMockAdsProvider({ platform }), account)).toEqual(baseline);
    },
  );

  it.each(CASES)("%s: a variant restates values on the same keys", async (platform, account) => {
    const base = await snapshot(createMockAdsProvider({ platform }), account);
    const restated = await snapshot(createMockAdsProvider({ platform, variant: 1 }), account);
    const keys = (rows: typeof base.metrics) =>
      rows.map((r) => `${r.entityExternalId}|${r.date}|${r.placement}`);
    // Entities never change; metric values do. Keys overlap heavily (zero-delivery days may differ).
    expect(restated.campaigns).toEqual(base.campaigns);
    const shared = keys(base.metrics).filter((k) => keys(restated.metrics).includes(k));
    expect(shared.length).toBeGreaterThan(base.metrics.length * 0.7);
    const changed = shared.filter((k) => {
      const a = base.metrics.find((r) => keys([r])[0] === k)!;
      const b = restated.metrics.find((r) => keys([r])[0] === k)!;
      return a.spendMicros !== b.spendMicros;
    });
    expect(changed.length).toBeGreaterThan(0);
  });

  it("retry outcomes depend only on ctx.attempt (no hidden state)", async () => {
    const p = createMockAdsProvider({ platform: "meta", scenario: "transient" });
    const request = { accountExternalId: "1001" };
    for (let i = 0; i < 3; i++) {
      await expect(p.listCampaigns(ctx(1), request)).rejects.toMatchObject({ kind: "transient" });
    }
    const first = await p.listCampaigns(ctx(2), request);
    expect(await p.listCampaigns(ctx(2), request)).toEqual(first);
    await expect(p.listCampaigns(ctx(1), request)).rejects.toMatchObject({ kind: "transient" });
  });
});
