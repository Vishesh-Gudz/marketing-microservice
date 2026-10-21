import { afterEach, describe, expect, it, vi } from "vitest";
import { createMetaAdsProvider, META_CAPABILITIES } from ".";
import { expectProviderError } from "../contract.suite";
import type { MetricsRequest, ProviderActionRow } from "../types";
import type { MetaCredential } from "./credential";
import {
  createFakeGraph,
  FAKE_APP_ID,
  FAKE_APP_SECRET,
  FAKE_RANGE,
  fakeMetaDatasetWithConversions,
  installFakeGraph,
} from "./fakeGraph.fixtures";

// Conversion paging regression: one insights row becomes one action row per conversion type
// and window, so a full Graph page can normalize to more records than one sync page holds
// (the engine fails such a page as page_too_large and never retries it). The provider must
// re-request fewer rows instead, without skipping or repeating a record, and must fail
// closed when a single row cannot fit. Uses only the public provider API and the fake Graph.

const credential: MetaCredential = {
  kind: "meta",
  v: 1,
  accessToken: "test-long-u1",
  tokenType: "user",
  appId: FAKE_APP_ID,
  issuedAt: 1,
};
const ctx = { credential, attempt: 1 };
const PAGE = META_CAPABILITIES.maxPageSize;

afterEach(() => {
  vi.unstubAllGlobals();
});

function provider(conversions: number, pageCap?: number) {
  const graph = installFakeGraph(
    createFakeGraph({
      dataset: fakeMetaDatasetWithConversions(conversions),
      ...(pageCap !== undefined ? { pageCap } : {}),
    }),
  );
  return {
    graph,
    provider: createMetaAdsProvider({ appId: FAKE_APP_ID, appSecret: FAKE_APP_SECRET }),
  };
}

const request = (level: MetricsRequest["level"], breakdown: "none" | "placement") => ({
  accountExternalId: "1001",
  level,
  breakdown,
  ...FAKE_RANGE,
});

/** Every page of the request, in order (sizes kept). */
async function pages(p: ReturnType<typeof provider>["provider"], req: MetricsRequest) {
  const out: ProviderActionRow[][] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 1_000; i++) {
    const page = await p.fetchActionMetrics(ctx, { ...req, ...(cursor ? { cursor } : {}) });
    out.push(page.items);
    cursor = page.nextCursor;
    if (cursor === undefined) return out;
  }
  throw new Error("runaway paging");
}

const sorted = (rows: ProviderActionRow[]) =>
  rows.map((row) => JSON.stringify(row, (_k, v) => (typeof v === "bigint" ? `${v}n` : v))).sort();

const actionRequests = (graph: ReturnType<typeof provider>["graph"]) =>
  graph.log.filter((e) => e.path === "act_1001/insights" && e.params.action_attribution_windows);

describe("Meta action rows: every page fits one sync page", () => {
  // Extra custom conversions per case: the fewest that still make one full Graph page
  // normalize to more than one sync page (the original failure) with several output pages.
  // Record validation dominates the runtime (about 0.3 ms per record), so the fixtures are
  // kept as small as that allows; the account level has only 7 rows and needs more.
  it.each([
    ["ad", "placement", 10],
    ["ad", "none", 10],
    ["campaign", "placement", 10],
    ["account", "none", 30],
  ] as const)(
    "%s level (%s): pages hold at most one sync page and together equal the one-row-per-page reference",
    async (level, breakdown, conversions) => {
      // Reference: Graph returns one row per page, so no page can overflow and the provider
      // never re-requests fewer rows (an oracle independent of the page-fit logic).
      const reference = provider(conversions, 1);
      const expected = (await pages(reference.provider, request(level, breakdown))).flat();
      expect(actionRequests(reference.graph).every((e) => Number(e.params.limit) === PAGE)).toBe(
        true,
      );
      // The original failure condition: the expected rows do not fit one sync page.
      expect(expected.length).toBeGreaterThan(PAGE);

      const { graph, provider: p } = provider(conversions);
      const result = await pages(p, request(level, breakdown));
      expect(result.every((items) => items.length <= PAGE)).toBe(true);
      expect(result.length).toBeGreaterThan(1);
      const rows = result.flat();
      expect(rows.length).toBe(expected.length);
      expect(sorted(rows)).toEqual(sorted(expected));
      expect(new Set(sorted(rows)).size).toBe(rows.length);
      // A full Graph page overflowed, so fewer Graph rows were requested.
      expect(Math.min(...actionRequests(graph).map((e) => Number(e.params.limit)))).toBeLessThan(
        PAGE,
      );
    },
  );

  it("keeps the row count that fits for the stage's next page (no full-size retry per page)", async () => {
    const { graph, provider: p } = provider(10);
    const result = await pages(p, request("ad", "placement"));
    expect(result.length).toBeGreaterThan(3);
    const limits = actionRequests(graph).map((e) => Number(e.params.limit));
    // Each of the 2 stages starts at the page size once and shrinks; later pages of the
    // stage start at the smaller row count carried in the cursor.
    expect(limits.filter((limit) => limit === PAGE)).toHaveLength(2);
    // Every Graph request beyond the shrinking ones produced a page.
    expect(limits.length).toBeLessThan(result.length + 2 * 4);
  });

  it("fails closed when one insights row alone has more records than one page", async () => {
    // 170 custom conversions × 3 windows: one account-level row has more than 500 records.
    const { provider: p } = provider(170);
    const call = p.fetchActionMetrics(ctx, request("account", "none"));
    await expectProviderError(call, "data");
    await expect(call).rejects.toMatchObject({ providerCode: "insights_row_too_large" });
  });
});
