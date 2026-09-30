import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetaAdsProvider } from ".";
import { expectProviderError } from "../contract.suite";
import { collectAll } from "../pagination";
import type { MetricsRequest, ProviderMetricRow } from "../types";
import type { MetaCredential } from "./credential";
import {
  createFakeGraph,
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  FAKE_RANGE,
  fakeMetaDataset,
  installFakeGraph,
  type FakeDataset,
} from "./fakeGraph.fixtures";

// Phase 8 R9 regression: placement rows whose canonical key collects several raw Graph
// rows (unknown publisher_platform values → "other") must be accumulated across ALL pages
// of the staged insights request — never overwritten per page, never double counted, and
// with missing vs zero preserved. Uses only the public provider API and the fake Graph.
//
// Fixture (fakeGraph.fixtures.ts): ad 4004 on 2026-03-02 delivered on two unrecognized
// platforms, "unknown" and "oculus":
//   spend 0.37 + 0.52, impressions 41 + 60, clicks "0" + "0", inline_link_clicks omitted on
//   both, post_reaction 1 on "unknown" only, post_engagement 1 + 2.
// With pageCap 1 every Graph page holds one row, so the two contributions are on different
// Graph pages by construction.

const credential: MetaCredential = {
  kind: "meta",
  v: 1,
  accessToken: "test-long-u1",
  tokenType: "user",
  appId: FAKE_APP_ID,
  issuedAt: 1,
};
const ctx = { credential, attempt: 1 };

afterEach(() => {
  vi.unstubAllGlobals();
});

function provider(options: { pageCap?: number; dataset?: FakeDataset } = {}) {
  const graph = installFakeGraph(createFakeGraph(options));
  return {
    graph,
    provider: createMetaAdsProvider({ appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET }),
  };
}

const request = (level: MetricsRequest["level"], range = FAKE_RANGE): MetricsRequest => ({
  accountExternalId: "1001",
  level,
  breakdown: "placement",
  ...range,
});

async function rows(
  p: ReturnType<typeof provider>["provider"],
  req: MetricsRequest,
  pageSize?: number,
) {
  return (
    await collectAll(
      (cursor) =>
        p.fetchDailyMetrics(ctx, {
          ...req,
          ...(pageSize !== undefined ? { pageSize } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      { maxPages: 5_000 },
    )
  ).items;
}

/** The expected accumulated "other" row of 2026-03-02 (every level reports ad 4004 only). */
const EXPECTED_OTHER = {
  date: "2026-03-02",
  placement: "other",
  rawPlacement: "oculus,unknown",
  currency: "USD",
  spendMicros: 890_000n, // 0.37 + 0.52
  impressions: 101, // 41 + 60
  clicks: 0, // explicit "0" on both: stays 0
  engagements: 3, // 1 + 2
};

function otherRows(list: ProviderMetricRow[], date = "2026-03-02") {
  return list.filter((r) => r.placement === "other" && r.date === date);
}

const keyOf = (r: ProviderMetricRow) => `${r.entityExternalId}|${r.date}|${r.placement}`;

describe("placement 'other' accumulated across pages (R9)", () => {
  it.each([
    ["one row per Graph page", 1],
    ["two rows per Graph page", 2],
    ["three rows per Graph page", 3],
    ["one Graph page", undefined],
  ])("%s: one canonical row holding the sum of all contributions", async (_label, pageCap) => {
    for (const level of ["account", "campaign", "ad_group", "ad"] as const) {
      const { provider: p } = provider(pageCap !== undefined ? { pageCap } : {});
      const found = otherRows(await rows(p, request(level)));
      expect(found, level).toHaveLength(1);
      expect(found[0], level).toMatchObject(EXPECTED_OTHER);
      // Missing stays missing: omitted on both / reported by one only → absent, never 0.
      expect(found[0], level).not.toHaveProperty("linkClicks");
      expect(found[0], level).not.toHaveProperty("reactions");
      expect(found[0], level).not.toHaveProperty("videoPlays");
      expect(found[0], level).not.toHaveProperty("reach");
    }
  });

  it("stored data does not depend on page boundaries (Graph page cap or requested page size)", async () => {
    const reference = await rows(provider().provider, request("ad"));
    const byKey = (list: ProviderMetricRow[]) => new Map(list.map((r) => [keyOf(r), r] as const));
    const expected = byKey(reference);
    expect(expected.size).toBe(reference.length);
    for (const [pageCap, pageSize] of [
      [1, undefined],
      [2, 3],
      [7, 1],
      [undefined, 2],
    ] as const) {
      const { provider: p } = provider(pageCap !== undefined ? { pageCap } : {});
      const list = await rows(p, request("ad"), pageSize);
      expect(list.length, `${pageCap}/${pageSize}`).toBe(reference.length);
      expect(byKey(list), `${pageCap}/${pageSize}`).toEqual(expected);
    }
  });

  it("a replayed page (same cursor) returns the same page and never double counts", async () => {
    const { provider: p } = provider({ pageCap: 1 });
    const req = request("account");
    const collected: ProviderMetricRow[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 1_000; page++) {
      const call = () =>
        p.fetchDailyMetrics(ctx, { ...req, pageSize: 1, ...(cursor ? { cursor } : {}) });
      const first = await call();
      const replay = await call();
      expect(replay).toEqual(first);
      collected.push(...first.items);
      cursor = first.nextCursor;
      if (cursor === undefined) break;
    }
    expect(cursor).toBeUndefined();
    expect(otherRows(collected)).toEqual([expect.objectContaining(EXPECTED_OTHER)]);
    expect(new Set(collected.map(keyOf)).size).toBe(collected.length);
  });

  it("'all' rows are unaffected and equal the sum of their breakdown rows", async () => {
    const { provider: p } = provider({ pageCap: 2 });
    const list = await rows(p, request("account"));
    const all = list.filter((r) => r.placement === "all");
    const reference = await rows(provider().provider, request("account"));
    expect(all).toEqual(reference.filter((r) => r.placement === "all"));
    expect(all.map((r) => r.date)).toEqual([
      "2026-03-01",
      "2026-03-02",
      "2026-03-03",
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
    ]);
    for (const row of all) {
      const parts = list.filter((r) => r.date === row.date && r.placement !== "all");
      expect(
        parts.reduce((t, r) => t + r.spendMicros!, 0n),
        row.date,
      ).toBe(row.spendMicros);
      expect(
        parts.reduce((t, r) => t + r.impressions!, 0),
        row.date,
      ).toBe(row.impressions);
      expect(
        parts.reduce((t, r) => t + r.clicks!, 0),
        row.date,
      ).toBe(row.clicks);
      expect(typeof row.reach).toBe("number");
    }
  });

  it("fails closed (data error) instead of dropping rows when the carry outgrows the cursor", async () => {
    // 60 extra ads, each delivering on an unrecognized platform every day of March.
    const dataset = fakeMetaDataset();
    const days = Array.from({ length: 31 }, (_, i) => `2026-03-${String(i + 1).padStart(2, "0")}`);
    for (let i = 0; i < 60; i++) {
      const id = String(4100 + i);
      dataset.ads["1001"]!.push({
        id,
        name: `Bulk ${id}`,
        campaign_id: "2001",
        adset_id: "3001",
        status: "ACTIVE",
        effective_status: "ACTIVE",
      });
      for (const date of days) {
        dataset.cells["1001"]!.push({
          adId: id,
          date,
          platform: "unknown",
          spendCents: 10,
          impressions: 5,
          clicks: 0,
          linkClicks: 0,
          actions: {},
          values: {},
        });
      }
    }
    const { provider: p } = provider({ dataset, pageCap: 500 });
    const march = { from: "2026-03-01", to: "2026-03-31" };
    await expectProviderError(rows(p, request("ad", march)), "data");
    await expect(rows(p, request("ad", march))).rejects.toMatchObject({
      providerCode: "placement_carry_limit",
      retryable: false,
    });
  });
});
